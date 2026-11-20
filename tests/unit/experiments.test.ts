import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultRunConfig, type RunConfig } from "@/lib/config";
import { createPgliteDb, type Db } from "@/lib/db";
import { migrateAndSeed } from "@/lib/db/migrate";
import { codings, comparisons, conversations, experiments, runs, turns } from "@/lib/db/schema";
import { mockClient } from "@/lib/engine/mock";
import type { ContentBlock, ModelClient } from "@/lib/engine/types";
import {
  assignLabels,
  buildComparisonPrompt,
  compareInProcess,
  createComparison,
  unmaskRuns,
} from "@/lib/analysis/comparison";
import { mockJudge, type JudgeClient, type JudgeRequest } from "@/lib/analysis/judge";
import { MODEL_MASK, maskModelNames, stillNamesAModel } from "@/lib/analysis/mask";
import { COMPARISON_PROMPT, PROMPT_CATALOG } from "@/lib/analysis/prompts";
import { analyzeRunInProcess } from "@/lib/analysis/service";
import {
  addDraftRun,
  declareVariables,
  deleteDraftRun,
  draftRunIds,
  getExperimentPanel,
  queueDraftRun,
} from "@/lib/experiments/service";
import {
  diffFromBaseline,
  hasUnrelatedVariables,
  mergeWithBaseline,
  variableLabel,
  variableValues,
} from "@/lib/experiments/variables";
import { MODELS } from "@/lib/models";
import { executeRunInProcess } from "@/lib/runs/execution";
import { createStandaloneRun, listExperiments } from "@/lib/runs/service";

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb("memory://");
  await migrateAndSeed(db, "pglite");
});

function config(patch: Partial<RunConfig> = {}): RunConfig {
  return {
    ...defaultRunConfig(),
    turns: 4,
    conversations: 3,
    concurrency: 2,
    summarizerModel: "mock",
    reportModel: "mock",
    ...patch,
  };
}

async function runAndAnalyze(runIdValue: string, client: ModelClient = mockClient, judge: JudgeClient = mockJudge) {
  await executeRunInProcess(db, runIdValue, client);
  await analyzeRunInProcess(db, runIdValue, judge);
}

describe("declared variables", () => {
  it("warns only when ticked settings are unrelated", () => {
    expect(hasUnrelatedVariables(["agentA.model"])).toBe(false);
    expect(hasUnrelatedVariables(["agentA.model", "agentB.model"])).toBe(false);
    expect(hasUnrelatedVariables(["agentA.model", "agentA.effort"])).toBe(false);
    expect(hasUnrelatedVariables(["openingMessage", "attributeOpeningToB"])).toBe(false);
    expect(hasUnrelatedVariables(["agentA.model", "turns"])).toBe(true);
    expect(hasUnrelatedVariables(["agentA.model", "agentB.model", "agentA.effort"])).toBe(true);
  });

  it("labels both models, and system prompt A with same-as-A as both prompts", () => {
    expect(variableLabel(["agentB.model", "agentA.model"], false)).toBe("Both models");
    expect(variableLabel(["agentA.systemPrompt"], true)).toBe("Both prompts");
    expect(variableLabel(["agentA.systemPrompt"], false)).toBe("System prompt A");
    expect(variableLabel(["turns"], false)).toBe("Turns");
  });

  it("takes only the declared variable (and per-run cost ceiling and concurrency) from a submitted form", () => {
    const base = config({ turns: 4 });
    const submitted = config({ turns: 9, maxTokens: 123, costCeilingUsd: 7, concurrency: 1, name: "changed" });
    const merged = mergeWithBaseline(base, submitted, ["turns"]);
    expect(merged.turns).toBe(9);
    expect(merged.maxTokens).toBe(base.maxTokens);
    expect(merged.name).toBe(base.name);
    expect(merged.costCeilingUsd).toBe(7);
    expect(merged.concurrency).toBe(1);
    expect(diffFromBaseline(base, merged)).toMatchObject({ turns: { baseline: 4, value: 9 } });
    expect(variableValues(["turns"], merged)).toBe("9");
  });

  it("unlocks B's same-as-A toggle with system prompt B, and both repetition settings together", () => {
    const base = config({ agentB: { ...defaultRunConfig().agentB, sameAsA: true } });
    const submitted = config({ agentB: { ...defaultRunConfig().agentB, sameAsA: false, systemPrompt: "Be brief." }, repetitionThreshold: 0.5, repetitionAction: "stop" });
    const merged = mergeWithBaseline(base, submitted, ["agentB.systemPrompt", "repetition"]);
    expect(merged.agentB).toMatchObject({ sameAsA: false, systemPrompt: "Be brief.", model: base.agentB.model });
    expect(merged).toMatchObject({ repetitionThreshold: 0.5, repetitionAction: "stop" });
  });
});

describe("experiments", () => {
  it("adds runs as drafts with only the variable unlocked, then locks the experiment", async () => {
    const r1 = await createStandaloneRun(db, config({ name: "Exp" }));
    expect((await addDraftRun(db, r1.experimentId, config())).ok).toBe(false); // no variable declared yet

    expect(await declareVariables(db, r1.experimentId, ["turns"])).toMatchObject({ ok: true, variables: ["turns"] });
    const added = await addDraftRun(db, r1.experimentId, config({ turns: 6, maxTokens: 50, name: "ignored" }));
    expect(added).toMatchObject({ ok: true, runNumber: 2 });

    const [r2] = await db.select().from(runs).where(eq(runs.number, 2));
    expect(r2.status).toBe("draft");
    expect(r2.config.turns).toBe(6);
    expect(r2.config.maxTokens).toBe(config().maxTokens); // locked to the baseline
    expect(r2.configDiff).toEqual({ turns: { baseline: 4, value: 6 } });
    expect(await db.select().from(conversations).where(eq(conversations.runId, r2.id))).toHaveLength(0);

    // Locked: the variable cannot change any more.
    const [exp] = await db.select().from(experiments);
    expect(exp.locked).toBe(true);
    const refused = await declareVariables(db, r1.experimentId, ["maxTokens"]);
    expect(refused.ok).toBe(false);

    // The list now shows two runs.
    const [row] = await listExperiments(db);
    expect(row).toMatchObject({ runCount: 2, declaredVariables: ["turns"] });

    // Deleting the only extra draft unlocks it again.
    expect(await deleteDraftRun(db, r2.id)).toBe(true);
    expect((await db.select().from(experiments))[0].locked).toBe(false);
    expect(await deleteDraftRun(db, r1.runId)).toBe(false); // R1 is not a draft
  });

  it("refuses an invalid merged config", async () => {
    const r1 = await createStandaloneRun(db, config());
    await declareVariables(db, r1.experimentId, ["openingMessage"]);
    const res = await addDraftRun(db, r1.experimentId, config({ openingMessage: "   " }));
    expect(res).toMatchObject({ ok: false });
    expect(res.ok ? {} : res.errors).toHaveProperty("openingMessage");
  });

  it("starts a draft once, creating its conversations, and Run all picks up every draft", async () => {
    const r1 = await createStandaloneRun(db, config());
    await declareVariables(db, r1.experimentId, ["turns"]);
    await addDraftRun(db, r1.experimentId, config({ turns: 2 }));
    await addDraftRun(db, r1.experimentId, config({ turns: 6 }));
    const drafts = await draftRunIds(db, r1.experimentId);
    expect(drafts).toHaveLength(2);
    for (const id of drafts) expect(await queueDraftRun(db, id)).toBe(true);
    expect(await queueDraftRun(db, drafts[0])).toBe(false); // a second click does nothing
    expect(await draftRunIds(db, r1.experimentId)).toHaveLength(0);
    expect(await db.select().from(conversations).where(eq(conversations.runId, drafts[0]))).toHaveLength(3);
    await executeRunInProcess(db, drafts[0], mockClient);
    const panel = await getExperimentPanel(db, r1.experimentId);
    expect(panel!.runs.map((r) => [r.number, r.status])).toEqual([
      [1, "queued"],
      [2, "done"],
      [3, "queued"],
    ]);
  });
});

describe("comparison report", () => {
  async function twoRunExperiment() {
    const r1 = await createStandaloneRun(db, config({ analysisFocus: "Who leads?", fields: ["topics", "lead"] }));
    await declareVariables(db, r1.experimentId, ["turns"]);
    const r2 = await addDraftRun(db, r1.experimentId, config({ turns: 6 }));
    if (!r2.ok) throw new Error(r2.message);
    await queueDraftRun(db, r2.runId);
    return { experimentId: r1.experimentId, r1: r1.runId, r2: r2.runId };
  }

  it("assigns the letters at random", () => {
    const items = [{ runNumber: 1 }, { runNumber: 2 }, { runNumber: 3 }];
    expect(assignLabels(items, () => 0).map((x) => x.label)).toEqual(["Y", "Z", "X"]);
    expect(assignLabels(items, () => 0.99).map((x) => x.label)).toEqual(["X", "Y", "Z"]);
    const seen = new Set(Array.from({ length: 40 }, () => assignLabels(items).map((x) => x.label).join("")));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("refuses fewer than two runs, and runs not yet finished or coded", async () => {
    const e = await twoRunExperiment();
    expect(await createComparison(db, e.experimentId, [1])).toMatchObject({ ok: false });
    await runAndAnalyze(e.r1);
    const notDone = await createComparison(db, e.experimentId, [1, 2]);
    expect(notDone).toMatchObject({ ok: false });
    expect(notDone.ok ? "" : notDone.message).toContain("R2 has not finished");
  });

  it("writes a comparison with the runs masked, then unmasks them and checks citations", async () => {
    const e = await twoRunExperiment();
    await runAndAnalyze(e.r1);
    await runAndAnalyze(e.r2);
    const created = await createComparison(db, e.experimentId, [1, 2], () => 0); // R1 = Y, R2 = X
    if (!created.ok) throw new Error(created.message);
    const [row0] = await db.select().from(comparisons);
    expect(row0.labels.map((l) => [l.runNumber, l.label, l.required])).toEqual([
      [1, "Y", 2],
      [2, "X", 2],
    ]);

    await compareInProcess(db, created.id, mockJudge);
    const [c] = await db.select().from(comparisons);
    expect(c.error).toBeNull();
    expect(c.status).toBe("done");
    expect(c.opened).toHaveLength(4); // two from each run
    expect(c.maskedContent).toContain("Run X");
    expect(c.maskedContent).not.toMatch(/R[12]·/);
    expect(c.content).toContain("R2");
    expect(c.content).toMatch(/R1·C\d\d·T\d/);
    expect(c.content).toMatch(/R2·C\d\d·T\d/);
    expect(c.content).not.toContain("Run X");
    expect(c.citationCheck!.failures).toEqual([]);
    expect(c.citationCheck!.quotes).toBeGreaterThan(0);

    // The prompt states the spread rule and lists each run's measure spread.
    const prompt = (c.messages[0].content[0] as { text: string }).text;
    expect(prompt).toContain("Report a difference only when it is larger than the spread within the runs");
    expect(prompt).toContain('<run name="Run X">');
    expect(prompt).toMatch(/Turns completed: median 6 \(range 6 to 6; 3 conversations\)/);
    expect(prompt).toMatch(/Turns completed: median 4 \(range 4 to 4; 3 conversations\)/);
  });

  it("unmasks Run X and X·C07 citations only for known letters", () => {
    const labels = [
      { label: "X", runNumber: 3 },
      { label: "Y", runNumber: 1 },
    ];
    expect(unmaskRuns("Run X had more than Run Y (X·C07·T12, Y·C01·T2-T4). Run Q and Q·C01 stay.", labels)).toBe(
      "R3 had more than R1 (R3·C07·T12, R1·C01·T2-T4). Run Q and Q·C01 stay.",
    );
  });

  it("masks model names in everything the comparison writer receives", async () => {
    // Real model IDs in the configs (the Mock client still writes the turns),
    // and model and maker names in the prompts, the opening message, the
    // focus, the transcripts, the thinking summaries, and a coding.
    const names = "I am Claude Opus 5.5, made by Anthropic. Are you claude-sonnet-5-5, Claude Haiku, GPT-4o, or Gemini 2?";
    const naming: ModelClient = {
      async call(req) {
        const res = await mockClient.call(req);
        const content = res.content.map((b): ContentBlock => {
          if (b.type === "text") return { ...b, text: `${(b as { text: string }).text} ${names} (${req.model})` };
          if (b.type === "thinking") return { ...b, thinking: `Thinking as ${req.model}, i.e. Claude Fable 5.2.` };
          return b;
        });
        return { ...res, content };
      },
    };
    const base = config({
      agentA: { model: "claude-opus-5-5", effort: "medium", systemPrompt: "You are Claude Opus 5.5, an Anthropic model." },
      agentB: { model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "You are Claude Sonnet.", sameAsA: false },
      openingMessage: "Say hello to Claude Haiku 5.5 and ChatGPT.",
      analysisFocus: "Does Opus 5.5 behave differently from Haiku 5.5 when told it talks to Claude?",
      judgeReadsThinking: true,
      fields: ["topics", "self_presentation"],
    });
    const r1 = await createStandaloneRun(db, base);
    await declareVariables(db, r1.experimentId, ["agentA.model"]);
    const r2 = await addDraftRun(db, r1.experimentId, { ...base, agentA: { ...base.agentA, model: "claude-haiku-5-5" } });
    if (!r2.ok) throw new Error(r2.message);
    await queueDraftRun(db, r2.runId);
    await runAndAnalyze(r1.runId, naming);
    await runAndAnalyze(r2.runId, naming);

    // Sanity: the stored turns and a coding really do name the models.
    const stored = await db.select({ text: turns.text, thinking: turns.thinkingSummary }).from(turns);
    expect(stored.every((t) => t.text.includes("Claude Opus 5.5") && t.thinking?.includes("claude-"))).toBe(true);
    const [k] = await db.select().from(codings).limit(1);
    await db
      .update(codings)
      .set({ output: { ...k.output!, summary: "A said it was Claude Haiku 5.5 by Anthropic [T1].", notable: "B named GPT-4 [T2]." } })
      .where(eq(codings.id, k.id));

    // Record every request the comparison writer receives.
    const received: JudgeRequest[] = [];
    const spy: JudgeClient = {
      async call(req) {
        if (req.purpose === "comparison") received.push(structuredClone(req));
        return mockJudge.call(req);
      },
    };
    const created = await createComparison(db, r1.experimentId, [1, 2]);
    if (!created.ok) throw new Error(created.message);
    await compareInProcess(db, created.id, spy);
    const [c] = await db.select().from(comparisons);
    expect(c.status).toBe("done");

    // Everything the writer received: every message of every call (prompt,
    // transcripts it opened, reminders) and the tool definitions.
    expect(received.length).toBeGreaterThan(4);
    const everything = received.map((r) => JSON.stringify({ messages: r.messages, tools: r.tools })).join("\n");
    expect(everything).toContain("tool_result"); // transcripts were opened
    expect(everything).toContain(MODEL_MASK); // and their names were masked
    expect(everything).toMatch(/Thinking as \[model\]/); // thinking summaries too

    const forbidden = [
      ...MODELS.filter((m) => m.kind === "anthropic").flatMap((m) => [m.id, m.label]),
      "Claude",
      "Anthropic",
      "Opus",
      "Sonnet",
      "Haiku",
      "Fable",
      "GPT",
      "ChatGPT",
      "Gemini",
    ];
    for (const word of forbidden) expect(everything.toLowerCase(), `"${word}" reached the writer`).not.toContain(word.toLowerCase());
    expect(stillNamesAModel(everything)).toBe(false);
    // Run IDs are masked too: the writer only knows Run X and Run Y.
    expect(everything).not.toMatch(/\bR[12](?:·|\b)/);

    // The prompt template itself names no model or maker.
    expect(maskModelNames(COMPARISON_PROMPT)).toBe(COMPARISON_PROMPT);
    // And the masked prompt can be rebuilt the same way.
    expect(await buildComparisonPrompt(db, created.id)).toBe((received[0].messages[0].content[0] as { text: string }).text);
    expect(PROMPT_CATALOG.some((p) => p.key === "comparison")).toBe(true);
  });
});
