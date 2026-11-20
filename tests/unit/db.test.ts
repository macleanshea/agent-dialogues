import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createPgliteDb, type Db } from "@/lib/db";
import { migrateAndSeed, seedFieldLibrary } from "@/lib/db/migrate";
import { analysisVersions, conversations, experiments, fieldDefinitions, runs, turns } from "@/lib/db/schema";
import { defaultRunConfig } from "@/lib/config";
import { mockClient } from "@/lib/engine/mock";
import { executeRunInProcess, saveTurn } from "@/lib/runs/execution";
import { createStandaloneRun, getConversationPage, getRunPage, listExperiments } from "@/lib/runs/service";

const executeRun = (d: Db, runId: string, client: Parameters<typeof executeRunInProcess>[2] = mockClient) =>
  executeRunInProcess(d, runId, client);

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb("memory://");
  await migrateAndSeed(db, "pglite");
});

function smallConfig() {
  return { ...defaultRunConfig(), turns: 4, conversations: 3, concurrency: 2, analysisFocus: "Watch for sign-offs." };
}

describe("database", () => {
  it("seeds the field library idempotently", async () => {
    await seedFieldLibrary(db);
    await seedFieldLibrary(db);
    const rows = await db.select().from(fieldDefinitions);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.builtin)).toBe(true);
  });

  it("never overwrites a custom field with the same name", async () => {
    await db.delete(fieldDefinitions).where(eq(fieldDefinitions.name, "topics"));
    await db.insert(fieldDefinitions).values({
      name: "topics", type: "short_text", scope: "conversation", definition: "Mine.", builtin: false, group: "Content",
    });
    await seedFieldLibrary(db);
    const [row] = await db.select().from(fieldDefinitions).where(eq(fieldDefinitions.name, "topics"));
    expect(row).toMatchObject({ builtin: false, definition: "Mine." });
  });

  it("creates a standalone run as a one-run experiment", async () => {
    const created = await createStandaloneRun(db, smallConfig());
    expect(created.runNumber).toBe(1);
    const [exp] = await db.select().from(experiments);
    expect(exp).toMatchObject({ ownerId: "owner", declaredVariables: [], locked: false, analysisFocus: "Watch for sign-offs." });
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ status: "queued", modelA: "mock", modelB: "mock", configDiff: {} });
    expect(run.config.resolved).toEqual({ systemPromptA: "", systemPromptB: "" });
    expect(await db.select().from(conversations)).toHaveLength(3);
    const [av] = await db.select().from(analysisVersions);
    expect(av).toMatchObject({ version: 1, summarizerModel: "claude-opus-5-5", judgeReadsThinking: false });
  });

  it("executes a mock run end to end", async () => {
    const created = await createStandaloneRun(db, smallConfig());
    expect(await executeRun(db, created.runId)).toBe("done");

    const convs = await db.select().from(conversations);
    expect(convs.every((c) => c.status === "done" && c.stopReason === "turn_cap" && c.turnsCompleted === 4)).toBe(true);
    expect(convs.every((c) => c.outputTokens > 0 && c.thinkingTokens > 0)).toBe(true);
    expect(await db.select().from(turns)).toHaveLength(12);

    const page = await getConversationPage(db, created.experimentNumber, 1, 2);
    expect(page?.turns.map((t) => `${t.turnNumber}${t.speaker}`)).toEqual(["1A", "2B", "3A", "4B"]);
    expect(page?.turns[0].content[0].type).toBe("thinking");
    expect(page?.turns[0].thinkingSummary).toContain("turn 1");

    const list = await listExperiments(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ runCount: 1, status: "done", totalCostUsd: 0, firstRunNumber: 1 });
  });

  it("does not duplicate a turn when a save is retried", async () => {
    const created = await createStandaloneRun(db, smallConfig());
    await executeRun(db, created.runId, mockClient);
    const page = await getConversationPage(db, created.experimentNumber, 1, 1);
    const t1 = page!.turns[0];
    const again = await saveTurn(db, page!.conversation.id, {
      turnNumber: 1, speaker: "A", model: "mock", text: "dupe", thinkingSummary: null, content: [],
      stopReason: "end_turn", rawUsage: null, costUsd: 0, truncated: false, placeholderUsed: false, attempts: 1, maxTokensUsed: 1,
      repetition: null, repetitionTriggered: false, signedOff: false, measures: { crossSimilarity: null, emojiCount: 0, modelMentions: [] },
      usage: { inputTokens: 999, outputTokens: 999, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(again).toBe(false);
    const after = await getConversationPage(db, created.experimentNumber, 1, 1);
    expect(after!.turns).toHaveLength(4);
    expect(after!.turns[0].text).toBe(t1.text);
    expect(after!.conversation.inputTokens).toBe(page!.conversation.inputTokens);
  });

  it("keeps the run done when one conversation fails", async () => {
    const created = await createStandaloneRun(db, { ...smallConfig(), concurrency: 1 });
    let calls = 0;
    const flaky = {
      call: async (req: Parameters<typeof mockClient.call>[0]) => {
        if (++calls === 1) throw new Error("boom");
        return mockClient.call(req);
      },
    };
    expect(await executeRun(db, created.runId, flaky)).toBe("done");
    const page = await getRunPage(db, created.experimentNumber, 1);
    expect(page?.conversations.map((c) => c.status)).toEqual(["errored", "done", "done"]);
    expect(page?.conversations[0].error).toContain("boom");
  });

  it("fails the run when every conversation fails", async () => {
    const cfg = { ...smallConfig(), agentB: { ...defaultRunConfig().agentB, systemPrompt: "[mock:error]" } };
    const created = await createStandaloneRun(db, cfg);
    expect(await executeRun(db, created.runId)).toBe("failed");
    const page = await getRunPage(db, created.experimentNumber, 1);
    expect(page?.conversations.every((c) => c.status === "errored" && c.error)).toBe(true);
  });

  it("returns null for missing pages", async () => {
    expect(await getRunPage(db, 99, 1)).toBeNull();
    const created = await createStandaloneRun(db, smallConfig());
    expect(await getConversationPage(db, created.experimentNumber, 1, 99)).toBeNull();
  });
});
