import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultRunConfig, type RunConfig } from "@/lib/config";
import { createPgliteDb, type Db } from "@/lib/db";
import { migrateAndSeed } from "@/lib/db/migrate";
import { conversations, runs, turns } from "@/lib/db/schema";
import { mockClient, mockReply } from "@/lib/engine/mock";
import { TransientModelError, type ModelClient } from "@/lib/engine/types";
import {
  advanceConversation,
  beginRun,
  executeRunInProcess,
  failConversation,
  finalizeRun,
  requestStop,
  saveTurn,
  splitIntoLanes,
} from "@/lib/runs/execution";
import { createStandaloneRun } from "@/lib/runs/service";

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb("memory://");
  await migrateAndSeed(db, "pglite");
});

function config(patch: Partial<RunConfig> = {}): RunConfig {
  return { ...defaultRunConfig(), turns: 4, conversations: 3, concurrency: 2, ...patch };
}

/** The mock's replies, billed as if a real model (Haiku) had produced them. */
const pricedMock: ModelClient = { call: async (req) => mockReply({ ...req, model: "mock" }) };
const haiku = (c: RunConfig): RunConfig => ({
  ...c,
  agentA: { ...c.agentA, model: "claude-haiku-5-5" },
  agentB: { ...c.agentB, model: "claude-haiku-5-5" },
});

async function convs(runId: string) {
  return db.select().from(conversations).where(eq(conversations.runId, runId)).orderBy(conversations.index);
}

describe("lanes", () => {
  it("splits conversations round-robin into at most `concurrency` lanes", () => {
    expect(splitIntoLanes([1, 2, 3, 4, 5], 2)).toEqual([[1, 3, 5], [2, 4]]);
    expect(splitIntoLanes([1, 2], 4)).toEqual([[1], [2]]);
    expect(splitIntoLanes([], 4)).toEqual([]);
  });
});

describe("running a run", () => {
  it("runs conversations in parallel, never more than the concurrency setting", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 5, concurrency: 2, turns: 2 }));
    let inFlight = 0;
    let peak = 0;
    const slow: ModelClient = {
      call: async (req) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return mockClient.call(req);
      },
    };
    expect(await executeRunInProcess(db, created.runId, slow)).toBe("done");
    expect(peak).toBe(2);
    expect((await convs(created.runId)).every((c) => c.status === "done" && c.turnsCompleted === 2)).toBe(true);
  });

  it("tracks cost on every turn and keeps the run total in step", async () => {
    const created = await createStandaloneRun(db, haiku(config()));
    await executeRunInProcess(db, created.runId, pricedMock);
    const [run] = await db.select().from(runs).where(eq(runs.id, created.runId));
    const all = await db.select().from(turns);
    expect(all.length).toBe(12);
    expect(all.every((t) => t.costUsd > 0)).toBe(true);
    const sum = all.reduce((s, t) => s + t.costUsd, 0);
    expect(run.costUsd).toBeCloseTo(sum, 10);
    expect(run.status).toBe("done");
  });

  it("stops every conversation at the cost ceiling, checked before each call", async () => {
    // One Haiku mock turn costs a few hundredths of a cent, so a tiny ceiling trips quickly.
    const created = await createStandaloneRun(db, haiku(config({ turns: 30, conversations: 3, concurrency: 1, costCeilingUsd: 0.0002 })));
    await executeRunInProcess(db, created.runId, pricedMock);
    const cs = await convs(created.runId);
    expect(cs.every((c) => c.stopReason === "cost_ceiling" && c.status === "done")).toBe(true);
    // The first conversation ran until the ceiling; later ones never made a call.
    expect(cs[0].turnsCompleted).toBeGreaterThan(0);
    expect(cs[0].turnsCompleted).toBeLessThan(30);
    expect(cs[2].turnsCompleted).toBe(0);
    const [run] = await db.select().from(runs).where(eq(runs.id, created.runId));
    expect(run.costUsd).toBeGreaterThanOrEqual(0.0002);
  });

  it("records the repetition flag on the conversation and keeps going", async () => {
    const c = config({ turns: 6, conversations: 1 });
    c.agentA.systemPrompt = "[mock:repeat]";
    c.agentB.systemPrompt = "[mock:repeat]";
    const created = await createStandaloneRun(db, c);
    await executeRunInProcess(db, created.runId, mockClient);
    const [conv] = await convs(created.runId);
    expect(conv).toMatchObject({ repetitionFlagTurn: 4, stopReason: "turn_cap", turnsCompleted: 6 });
    const ts = await db.select().from(turns).where(eq(turns.conversationId, conv.id)).orderBy(turns.turnNumber);
    expect(ts[2].repetition).toBe(1);
    expect(ts[0].repetition).toBeNull();
  });

  it("stores the sign-off stop", async () => {
    const c = config({ turns: 6, conversations: 1, signOff: true });
    c.agentA.systemPrompt = "[mock:end]";
    const created = await createStandaloneRun(db, c);
    await executeRunInProcess(db, created.runId, mockClient);
    const [conv] = await convs(created.runId);
    expect(conv).toMatchObject({ stopReason: "sign_off", turnsCompleted: 1, status: "done" });
    const [t1] = await db.select().from(turns).where(eq(turns.conversationId, conv.id));
    expect(t1.signedOff).toBe(true);
  });

  it("marks a conversation errored after transient errors run out, without failing the run", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 2, concurrency: 1, turns: 2 }));
    let n = 0;
    const firstConvDown: ModelClient = {
      call: async (req) => {
        if (req.meta.conversationIndex === 1) throw new TransientModelError("overloaded (529)");
        n++;
        return mockClient.call(req);
      },
    };
    expect(await executeRunInProcess(db, created.runId, firstConvDown)).toBe("done");
    const cs = await convs(created.runId);
    expect(cs[0]).toMatchObject({ status: "errored", stopReason: "error" });
    expect(cs[0].error).toContain("API error after retries");
    expect(cs[1]).toMatchObject({ status: "done", turnsCompleted: 2 });
    expect(n).toBe(2);
  });
});

describe("one step at a time (as Workflow runs it)", () => {
  it("never duplicates a turn when a step is repeated", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 1, turns: 3 }));
    await beginRun(db, created.runId);
    const [conv] = await convs(created.runId);
    await advanceConversation(db, conv.id, mockClient);
    // A crashed step is retried: it simply continues from the stored turns.
    await advanceConversation(db, conv.id, mockClient);
    const ts = await db.select().from(turns).where(eq(turns.conversationId, conv.id)).orderBy(turns.turnNumber);
    expect(ts.map((t) => t.turnNumber)).toEqual([1, 2]);
    const r3 = await advanceConversation(db, conv.id, mockClient);
    expect(r3).toEqual({ kind: "finished", end: { status: "done", stopReason: "turn_cap", error: null } });
    // A step after the end changes nothing.
    expect((await advanceConversation(db, conv.id, mockClient)).kind).toBe("finished");
    expect(await db.select().from(turns).where(eq(turns.conversationId, conv.id))).toHaveLength(3);
  });

  it("adds a turn's cost to the run only once, even if the save is repeated", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 1 }));
    const [conv] = await convs(created.runId);
    const turn = {
      turnNumber: 1, speaker: "A" as const, model: "mock", text: "hi", thinkingSummary: null, content: [],
      stopReason: "end_turn", rawUsage: null, costUsd: 0.5, truncated: false, placeholderUsed: false, attempts: 1,
      maxTokensUsed: 100, repetition: null, repetitionTriggered: false, signedOff: false, measures: { crossSimilarity: null, emojiCount: 0, modelMentions: [] },
      usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    expect(await saveTurn(db, conv.id, turn)).toBe(true);
    expect(await saveTurn(db, conv.id, turn)).toBe(false);
    const [run] = await db.select().from(runs).where(eq(runs.id, created.runId));
    expect(run.costUsd).toBe(0.5);
  });

  it("stops at the Stop button: pending conversations at once, running ones before their next call", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 3, turns: 6 }));
    await beginRun(db, created.runId);
    const [c1] = await convs(created.runId);
    await advanceConversation(db, c1.id, mockClient); // C01 is mid-conversation.
    await requestStop(db, created.runId);

    let cs = await convs(created.runId);
    expect(cs.map((c) => c.status)).toEqual(["running", "stopped", "stopped"]);
    expect(cs[1].stopReason).toBe("stopped_by_user");

    const r = await advanceConversation(db, c1.id, mockClient);
    expect(r).toEqual({ kind: "finished", end: { status: "stopped", stopReason: "stopped_by_user", error: null } });
    cs = await convs(created.runId);
    expect(cs[0]).toMatchObject({ status: "stopped", turnsCompleted: 1 });
    expect(await finalizeRun(db, created.runId)).toBe("stopped");
  });

  it("does not overwrite how a conversation ended", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 1 }));
    await requestStop(db, created.runId);
    const [conv] = await convs(created.runId);
    await failConversation(db, conv.id, "late error");
    const [after] = await convs(created.runId);
    expect(after).toMatchObject({ status: "stopped", error: null });
  });

  it("does not let Stop change a run that already finished", async () => {
    const created = await createStandaloneRun(db, config({ conversations: 1, turns: 1 }));
    await executeRunInProcess(db, created.runId, mockClient);
    await requestStop(db, created.runId);
    const [run] = await db.select().from(runs).where(eq(runs.id, created.runId));
    expect(run).toMatchObject({ status: "done", stopRequested: false });
  });
});
