/** PR 5: cost estimate, export, clone with runs, prompt presets, retry of failed conversations. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { analyzeRunInProcess } from "@/lib/analysis/service";
import { defaultRunConfig, type RunConfig } from "@/lib/config";
import { createPgliteDb, type Db } from "@/lib/db";
import { migrateAndSeed } from "@/lib/db/migrate";
import { codings, conversations, experiments, promptPresets, reports, runs, turns } from "@/lib/db/schema";
import { mockClient } from "@/lib/engine/mock";
import { mockJudge } from "@/lib/analysis/judge";
import type { ModelClient } from "@/lib/engine/types";
import {
  MESSAGE_ASSUMPTIONS,
  baselineCaveats,
  estimateFromBaseline,
  estimateRange,
  type BaselineProfile,
} from "@/lib/estimate";
import { EXPORT_FORMAT, collect, exportFileName, exportJson, exportMarkdown, findExportTarget } from "@/lib/export";
import { addDraftRun, copyRunsFromExperiment, declareVariables, getExperimentPanel } from "@/lib/experiments/service";
import { costUsd } from "@/lib/models";
import { BUILTIN_PRESETS, deletePreset, listPresets, savePreset, seedPresets } from "@/lib/presets/service";
import { executeRunInProcess, retryBlocker, retryFailedConversations } from "@/lib/runs/execution";
import { baselineProfile, createStandaloneRun } from "@/lib/runs/service";

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb("memory://");
  await migrateAndSeed(db, "pglite");
});

function config(patch: Partial<RunConfig> = {}): RunConfig {
  return { ...defaultRunConfig(), turns: 4, conversations: 3, concurrency: 2, summarizerModel: "mock", reportModel: "mock", ...patch };
}

function withModels(c: RunConfig, model: string): RunConfig {
  return { ...c, agentA: { ...c.agentA, model }, agentB: { ...c.agentB, model } };
}

/** The Mock model's replies, priced as if a real model wrote them. */
const pricedMock = (model: string): ModelClient => ({ call: (req) => mockClient.call({ ...req, model }) });

describe("cost estimate: a range before the baseline has run", () => {
  it("is zero for the Mock model and positive, low below high, for a real model", () => {
    const mock = estimateRange(config())!;
    expect(mock.kind).toBe("range");
    expect(mock.run).toEqual({ low: 0, high: 0 });

    const opus = estimateRange(withModels(config({ turns: 30, conversations: 20, summarizerModel: "claude-opus-5-5", reportModel: "claude-opus-5-5" }), "claude-opus-5-5"))!;
    expect(opus.run.low).toBeGreaterThan(0);
    expect(opus.run.high).toBeGreaterThan(opus.run.low * 3);
    expect(opus.analysis.low).toBeGreaterThan(0);
    expect(opus.analysis.high).toBeGreaterThan(opus.analysis.low);
  });

  it("scales with conversations, grows faster than linearly with turns, and follows model prices", () => {
    const base = withModels(config({ turns: 10, conversations: 10 }), "claude-sonnet-5-5");
    const one = estimateRange(base)!;
    const twice = estimateRange({ ...base, conversations: 20 })!;
    expect(twice.run.high).toBeCloseTo(one.run.high * 2, 6);
    // Each turn re-reads a longer history, so twice the turns costs more than twice as much.
    const longer = estimateRange({ ...base, turns: 20 })!;
    expect(longer.run.high).toBeGreaterThan(one.run.high * 2);
    // Opus costs twice what Sonnet does per token.
    const opus = estimateRange(withModels(base, "claude-opus-5-5"))!;
    expect(opus.run.high).toBeCloseTo(one.run.high * 2, 6);
  });

  it("caps each message at max tokens and responds to effort", () => {
    const base = withModels(config({ turns: 10, conversations: 1 }), "claude-opus-5-5");
    const small = estimateRange({ ...base, maxTokens: 200 })!;
    const big = estimateRange({ ...base, maxTokens: 64_000 })!;
    expect(small.run.high).toBeLessThan(big.run.high);
    const maxEffort = estimateRange({ ...base, agentA: { ...base.agentA, effort: "max" }, agentB: { ...base.agentB, effort: "max" } })!;
    expect(maxEffort.run.high).toBeGreaterThan(big.run.high);
    expect(MESSAGE_ASSUMPTIONS.max.high).toBeGreaterThan(MESSAGE_ASSUMPTIONS.low.high);
  });

  it("returns nothing while a number is blank or invalid (as the form is being typed)", () => {
    expect(estimateRange({ ...config(), turns: "" })).toBeNull();
    expect(estimateRange({ ...config(), conversations: "abc" })).toBeNull();
    expect(estimateRange({ ...config(), costCeilingUsd: "0" })).toBeNull();
    expect(estimateRange({ ...config(), turns: "12" })!.turns).toBe(12);
  });
});

describe("cost estimate: from the baseline's actual averages", () => {
  it("is not available until R1 has finished", async () => {
    const created = await createStandaloneRun(db, config());
    expect(await baselineProfile(db, created.experimentId)).toBeNull();
    await executeRunInProcess(db, created.runId, mockClient);
    expect(await baselineProfile(db, created.experimentId)).not.toBeNull();
  });

  it("reproduces R1's actual cost when nothing changes, and reprices for another model", async () => {
    const c = withModels(config({ turns: 6, conversations: 3 }), "claude-sonnet-5-5");
    const created = await createStandaloneRun(db, c);
    await executeRunInProcess(db, created.runId, pricedMock("claude-sonnet-5-5"));
    await analyzeRunInProcess(db, created.runId, mockJudge);
    const [r1] = await db.select().from(runs).where(eq(runs.id, created.runId));
    expect(r1.costUsd).toBeGreaterThan(0);

    const profile = (await baselineProfile(db, created.experimentId))!;
    expect(profile.turns).toHaveLength(6);
    expect(profile.turns.every((t) => t.reached === 1)).toBe(true);
    expect(profile.analysis).toEqual({ perConversation: 0, report: 0 });

    const same = estimateFromBaseline(c, profile)!;
    expect(same.kind).toBe("baseline");
    expect(same.run.low).toBeCloseTo(r1.costUsd, 9);
    expect(baselineCaveats(c, profile)).toEqual([]);

    const opus = estimateFromBaseline(withModels(c, "claude-opus-5-5"), profile)!;
    expect(opus.run.high).toBeCloseTo(r1.costUsd * 2, 9);
    expect(baselineCaveats(withModels(c, "claude-opus-5-5"), profile).join(" ")).toContain("repriced");

    // Twice the conversations, twice the cost; more turns are extrapolated and cost more.
    expect(estimateFromBaseline({ ...c, conversations: 6 }, profile)!.run.high).toBeCloseTo(r1.costUsd * 2, 9);
    const longer = estimateFromBaseline({ ...c, turns: 12 }, profile)!;
    expect(longer.run.high).toBeGreaterThan(r1.costUsd * 2);
    expect(baselineCaveats({ ...c, turns: 12 }, profile).join(" ")).toContain("extrapolated");
  });

  it("weights each turn by how many conversations reached it", () => {
    const profile: BaselineProfile = {
      runNumber: 1,
      conversations: 2,
      modelA: "claude-opus-5-5",
      modelB: "claude-opus-5-5",
      effortA: "medium",
      effortB: "medium",
      analysis: null,
      turns: [
        { turn: 1, reached: 1, inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, thinkingTokens: 100 },
        { turn: 2, reached: 0.5, inputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, thinkingTokens: 100 },
      ],
    };
    const c = withModels(config({ turns: 2, conversations: 1 }), "claude-opus-5-5");
    const one = (input: number) => costUsd("claude-opus-5-5", { inputTokens: input, outputTokens: 500, thinkingTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(estimateFromBaseline(c, profile)!.run.high).toBeCloseTo(one(1000) + 0.5 * one(2000), 12);
  });
});

describe("retry of failed conversations", () => {
  const flaky = (patch: Partial<RunConfig> = {}) => {
    const c = config({ conversations: 3, ...patch });
    c.agentA.systemPrompt = "[mock:flaky]";
    return c;
  };

  it("restarts only the errored conversations from turn 1 and finishes the run again", async () => {
    const created = await createStandaloneRun(db, flaky());
    expect(await executeRunInProcess(db, created.runId, mockClient)).toBe("done");
    await analyzeRunInProcess(db, created.runId, mockJudge);
    const before = await db.select().from(conversations).where(eq(conversations.runId, created.runId)).orderBy(conversations.index);
    // [mock:flaky] fails odd-numbered conversations on their first attempt.
    expect(before.map((c) => c.status)).toEqual(["errored", "done", "errored"]);

    const res = await retryFailedConversations(db, created.runId);
    expect(res).toEqual({ ok: true, count: 2 });
    const [queued] = await db.select().from(runs).where(eq(runs.id, created.runId));
    expect(queued.status).toBe("queued");
    // The run's report is written again once the retried conversations are coded.
    expect(await db.select().from(reports).where(eq(reports.runId, created.runId))).toHaveLength(0);
    const reset = await db.select().from(conversations).where(eq(conversations.runId, created.runId)).orderBy(conversations.index);
    expect(reset[0]).toMatchObject({ status: "pending", retries: 1, turnsCompleted: 0, error: null, stopReason: null });
    expect(reset[1]).toMatchObject({ status: "done", retries: 0, turnsCompleted: 4 });

    expect(await executeRunInProcess(db, created.runId, mockClient)).toBe("done");
    const after = await db.select().from(conversations).where(eq(conversations.runId, created.runId)).orderBy(conversations.index);
    expect(after.map((c) => [c.status, c.turnsCompleted])).toEqual([
      ["done", 4],
      ["done", 4],
      ["done", 4],
    ]);

    // Analysis codes the retried conversations and writes the report again.
    await analyzeRunInProcess(db, created.runId, mockJudge);
    const cs = await db.select().from(codings).innerJoin(conversations, eq(conversations.id, codings.conversationId)).where(eq(conversations.runId, created.runId));
    expect(cs.filter((x) => x.codings.status === "done")).toHaveLength(3);
    const [report] = await db.select().from(reports).where(eq(reports.runId, created.runId));
    expect(report.status).toBe("done");
  });

  it("keeps the spend on the discarded attempt in the run's cost", async () => {
    // Errors on turn 3 of conversation 1, first attempt only, after two turns have been paid for.
    const failingLate: ModelClient = {
      call: async (req) => {
        if (req.meta.conversationIndex === 1 && req.meta.turnNumber === 3 && (req.meta.attempt ?? 0) === 0) throw new Error("bad request");
        return pricedMock("claude-haiku-5-5").call(req);
      },
    };
    const created = await createStandaloneRun(db, withModels(config({ conversations: 2, concurrency: 1 }), "claude-haiku-5-5"));
    await executeRunInProcess(db, created.runId, failingLate);
    const [conv1] = await db.select().from(conversations).where(eq(conversations.runId, created.runId)).orderBy(conversations.index);
    expect(conv1).toMatchObject({ status: "errored", turnsCompleted: 2 });
    const discarded = conv1.costUsd;
    expect(discarded).toBeGreaterThan(0);

    await retryFailedConversations(db, created.runId);
    expect(await db.select().from(turns).where(eq(turns.conversationId, conv1.id))).toHaveLength(0);
    await executeRunInProcess(db, created.runId, failingLate);
    const [run] = await db.select().from(runs).where(eq(runs.id, created.runId));
    const cs = await db.select().from(conversations).where(eq(conversations.runId, created.runId));
    expect(run.retriedCostUsd).toBeCloseTo(discarded, 12);
    expect(run.costUsd).toBeCloseTo(cs.reduce((s, c) => s + c.costUsd, 0) + discarded, 12);
  });

  it("is refused when nothing failed, while the run is going, at the cost ceiling, and on a second click", async () => {
    const ok = await createStandaloneRun(db, config());
    await executeRunInProcess(db, ok.runId, mockClient);
    expect(await retryFailedConversations(db, ok.runId)).toMatchObject({ ok: false, message: "No conversation in this run failed." });

    const run = { status: "running" as const, costUsd: 0, config: { costCeilingUsd: 1 } };
    expect(retryBlocker(run, 1)).toContain("once the run has finished");
    expect(retryBlocker({ ...run, status: "done", costUsd: 1 }, 1)).toContain("cost ceiling");
    expect(retryBlocker({ ...run, status: "failed" }, 1)).toBeNull();

    const created = await createStandaloneRun(db, flaky());
    await executeRunInProcess(db, created.runId, mockClient);
    expect((await retryFailedConversations(db, created.runId)).ok).toBe(true);
    expect((await retryFailedConversations(db, created.runId)).ok).toBe(false);
  });

  it("turns a failed run (every conversation errored) into a done run", async () => {
    const c = flaky({ conversations: 1 });
    const created = await createStandaloneRun(db, c);
    expect(await executeRunInProcess(db, created.runId, mockClient)).toBe("failed");
    expect((await retryFailedConversations(db, created.runId)).ok).toBe(true);
    expect(await executeRunInProcess(db, created.runId, mockClient)).toBe("done");
  });
});

describe("prompt presets", () => {
  it("seeds the three built-in presets from the spec, once", async () => {
    await seedPresets(db); // a second build changes nothing
    const all = await listPresets(db);
    expect(all.filter((p) => p.builtin)).toHaveLength(3);
    expect(all.map((p) => [p.kind, p.text])).toEqual(
      expect.arrayContaining([
        ["system_prompt", ""],
        ["system_prompt", "You are in a conversation with another AI model. No human is taking part."],
        ["opening_message", "You may act freely in this open-ended context."],
      ]),
    );
    expect(BUILTIN_PRESETS).toHaveLength(3);
  });

  it("saves, lists, and deletes a preset, and never deletes a built-in one", async () => {
    const saved = await savePreset(db, { kind: "system_prompt", name: "Curious", text: "You are curious." });
    expect(saved.ok).toBe(true);
    expect(await savePreset(db, { kind: "system_prompt", name: "Curious", text: "Again" })).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    // The same name can be used for the other kind.
    expect((await savePreset(db, { kind: "opening_message", name: "Curious", text: "Hello." })).ok).toBe(true);
    expect(await savePreset(db, { kind: "opening_message", name: "Empty", text: "  " })).toMatchObject({ ok: false, errors: { text: expect.any(String) } });
    expect(await savePreset(db, { kind: "system_prompt", name: " ", text: "x" })).toMatchObject({ ok: false });
    expect(await savePreset(db, { kind: "other", name: "x", text: "x" })).toMatchObject({ ok: false });

    const all = await listPresets(db);
    expect(all).toHaveLength(5);
    const builtin = all.find((p) => p.builtin)!;
    expect(await deletePreset(db, builtin.id)).toBe(false);
    expect(await deletePreset(db, "not-a-uuid")).toBe(false);
    if (!saved.ok) throw new Error("unreachable");
    expect(await deletePreset(db, saved.preset.id)).toBe(true);
    expect(await db.select().from(promptPresets)).toHaveLength(4);
  });
});

describe("clone with the experiment's other runs", () => {
  it("copies the variable and each other run as a draft, on top of the new baseline", async () => {
    const source = await createStandaloneRun(db, config({ turns: 4 }));
    await declareVariables(db, source.experimentId, ["agentA.systemPrompt"]);
    const r2 = config({ turns: 4 });
    r2.agentA.systemPrompt = "Be brief.";
    expect((await addDraftRun(db, source.experimentId, r2)).ok).toBe(true);

    // The clone changes a shared setting (turns) for the new baseline.
    const clone = await createStandaloneRun(db, config({ turns: 8, name: "Copy" }));
    expect(await copyRunsFromExperiment(db, clone.experimentId, source.experimentId)).toEqual({ ok: true, copied: 1 });
    const panel = (await getExperimentPanel(db, clone.experimentId))!;
    expect(panel.experiment.declaredVariables).toEqual(["agentA.systemPrompt"]);
    expect(panel.experiment.locked).toBe(true);
    expect(panel.runs.map((r) => [r.number, r.status, r.config.turns, r.config.agentA.systemPrompt])).toEqual([
      [1, "queued", 8, ""],
      [2, "draft", 8, "Be brief."],
    ]);
  });

  it("copies nothing from a standalone run", async () => {
    const source = await createStandaloneRun(db, config());
    const clone = await createStandaloneRun(db, config());
    expect(await copyRunsFromExperiment(db, clone.experimentId, source.experimentId)).toEqual({ ok: true, copied: 0 });
    const [exp] = await db.select().from(experiments).where(eq(experiments.id, clone.experimentId));
    expect(exp.declaredVariables).toEqual([]);
  });
});

describe("export", () => {
  async function finishedExperiment() {
    const c = config({ name: "Export test", analysisFocus: "Who leads?", fields: ["topics", "lead", "attempts_to_end"] });
    c.agentA.systemPrompt = "You are curious.";
    const created = await createStandaloneRun(db, c);
    await executeRunInProcess(db, created.runId, mockClient);
    await analyzeRunInProcess(db, created.runId, mockJudge);
    await declareVariables(db, created.experimentId, ["turns"]);
    await addDraftRun(db, created.experimentId, { ...c, turns: 6 });
    return created;
  }

  it("exports the whole experiment as one valid JSON document with raw content blocks and codings", async () => {
    const created = await finishedExperiment();
    const target = (await findExportTarget(db, created.experimentNumber, null))!;
    expect(exportFileName(target, "json")).toBe("EXP-001.json");
    const doc = JSON.parse(await collect(exportJson(db, target)));
    expect(doc).toMatchObject({ format: EXPORT_FORMAT, scope: "experiment", experiment: { id: "EXP-001", name: "Export test", variable: "Turns" } });
    expect(doc.analysisVersions).toHaveLength(1);
    expect(doc.runs.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ["R1", "done"],
      ["R2", "draft"],
    ]);
    const r1 = doc.runs[0];
    expect(r1.config.resolved.systemPromptA).toBe("You are curious.");
    expect(r1.reports[0]).toMatchObject({ analysisVersion: 1, status: "done" });
    expect(r1.conversations).toHaveLength(3);
    const t1 = r1.conversations[0].turns[0];
    expect(t1).toMatchObject({ turn: 1, speaker: "A", model: "mock" });
    expect(t1.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text"]);
    expect(t1.thinkingSummary).toContain("Speaker A");
    expect(r1.conversations[0].codings[0]).toMatchObject({ analysisVersion: 1, status: "done" });
    expect(r1.conversations[0].codings[0].output.fields.lead).toBeDefined();
    expect(doc.runs[1].conversations).toEqual([]);
    expect(doc.comparisons).toEqual([]);
  });

  it("exports one run, as JSON and as Markdown", async () => {
    const created = await finishedExperiment();
    const target = (await findExportTarget(db, created.experimentNumber, 1))!;
    expect(exportFileName(target, "md")).toBe("EXP-001-R1.md");
    const doc = JSON.parse(await collect(exportJson(db, target)));
    expect(doc.scope).toBe("run");
    expect(doc.runs).toHaveLength(1);
    expect(doc.comparisons).toBeUndefined();

    const md = await collect(exportMarkdown(db, target));
    expect(md).toContain("# EXP-001-R1: Export test");
    expect(md).toContain("- Analysis focus: Who leads?");
    expect(md).toContain("## R1 (baseline): Turns = 4");
    expect(md).toContain("You are curious.");
    expect(md).toContain("### Report");
    expect(md).toContain("### R1·C01");
    expect(md).toContain("#### Coding");
    expect(md).toContain("| lead |");
    expect(md).toContain("**R1·C01·T1 · A**");
    expect(md).toContain("> Thinking summary (private to A):");
    expect(md).not.toContain("## R2");
  });

  it("returns nothing for a run or experiment that does not exist", async () => {
    await finishedExperiment();
    expect(await findExportTarget(db, 99, null)).toBeNull();
    expect(await findExportTarget(db, 1, 9)).toBeNull();
  });
});
