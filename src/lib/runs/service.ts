import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  defaultExperimentName,
  snapshotConfig,
  type RunConfig,
  type RunConfigSnapshot,
} from "../config";
import type { Db } from "../db";
import { analysisVersions, conversations, experiments, runs, turns, type RunStatus } from "../db/schema";
import { runConversation, type ConversationSetup, type NewTurn } from "../engine/engine";
import { mockClient } from "../engine/mock";
import type { ConversationStopReason, ModelClient, TurnRecord } from "../engine/types";
import { getModel } from "../models";

export const PROMPT_VERSIONS = { summarizer: "v1", runReport: "v1", comparisonReport: "v1" };

export interface CreatedRun {
  experimentId: string;
  experimentNumber: number;
  runId: string;
  runNumber: number;
}

/**
 * Creates a standalone run: a new experiment with one run (R1, the baseline)
 * and no declared variable, plus analysis version 1 and the pending
 * conversations.
 */
export async function createStandaloneRun(db: Db, config: RunConfig): Promise<CreatedRun> {
  const snapshot = snapshotConfig(config);
  return db.transaction(async (tx) => {
    const [exp] = await tx
      .insert(experiments)
      .values({
        name: defaultExperimentName(config),
        analysisFocus: config.analysisFocus,
        declaredVariables: [],
        sharedSettings: snapshot,
      })
      .returning({ id: experiments.id, number: experiments.number });

    await tx.insert(analysisVersions).values({
      experimentId: exp.id,
      version: 1,
      focus: config.analysisFocus,
      // The field picker arrives in PR 3; until then no fields are selected.
      fieldDefinitions: [],
      summarizerModel: config.summarizerModel,
      reportModel: config.reportModel,
      judgeReadsThinking: config.judgeReadsThinking,
      promptVersions: PROMPT_VERSIONS,
    });

    const [run] = await tx
      .insert(runs)
      .values({
        experimentId: exp.id,
        number: 1,
        config: snapshot,
        modelA: config.agentA.model,
        modelB: config.agentB.model,
        configDiff: {},
        status: "queued",
      })
      .returning({ id: runs.id, number: runs.number });

    await tx.insert(conversations).values(
      Array.from({ length: config.conversations }, (_, i) => ({ runId: run.id, index: i + 1 })),
    );

    return { experimentId: exp.id, experimentNumber: exp.number, runId: run.id, runNumber: run.number };
  });
}

function setupFromConfig(c: RunConfigSnapshot): ConversationSetup {
  return {
    agentA: { model: c.agentA.model, effort: c.agentA.effort, systemPrompt: c.resolved.systemPromptA },
    agentB: { model: c.agentB.model, effort: c.agentB.effort, systemPrompt: c.resolved.systemPromptB },
    openingMessage: c.openingMessage,
    attributeOpeningToB: c.attributeOpeningToB,
    turns: c.turns,
    maxTokens: c.maxTokens,
  };
}

/** Picks the model client for a run. PR 1 only has the mock. */
export function clientForRun(c: RunConfigSnapshot): ModelClient {
  for (const id of [c.agentA.model, c.agentB.model]) {
    if (getModel(id)?.kind !== "mock") {
      throw new Error(`Model ${id} cannot run yet. Only the Mock model is available in this version.`);
    }
  }
  return mockClient;
}

/** Saves a turn once. A retried save of the same turn number does nothing. */
export async function saveTurn(db: Db, conversationId: string, t: NewTurn): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(turns)
      .values({
        conversationId,
        turnNumber: t.turnNumber,
        speaker: t.speaker,
        model: t.model,
        text: t.text,
        thinkingSummary: t.thinkingSummary,
        content: t.content,
        stopReason: t.stopReason,
        usage: t.rawUsage as object | null,
        inputTokens: t.usage.inputTokens,
        outputTokens: t.usage.outputTokens,
        thinkingTokens: t.usage.thinkingTokens,
        cacheReadTokens: t.usage.cacheReadTokens,
        cacheWriteTokens: t.usage.cacheWriteTokens,
        costUsd: t.costUsd,
        truncated: t.truncated,
        placeholderUsed: t.placeholderUsed,
        attempts: t.attempts,
        maxTokensUsed: t.maxTokensUsed,
      })
      .onConflictDoNothing({ target: [turns.conversationId, turns.turnNumber] })
      .returning({ id: turns.id });
    if (inserted.length === 0) return false;

    // Only count usage for a turn that was actually inserted.
    await tx
      .update(conversations)
      .set({
        turnsCompleted: sql`${conversations.turnsCompleted} + 1`,
        inputTokens: sql`${conversations.inputTokens} + ${t.usage.inputTokens}`,
        outputTokens: sql`${conversations.outputTokens} + ${t.usage.outputTokens}`,
        thinkingTokens: sql`${conversations.thinkingTokens} + ${t.usage.thinkingTokens}`,
        cacheReadTokens: sql`${conversations.cacheReadTokens} + ${t.usage.cacheReadTokens}`,
        cacheWriteTokens: sql`${conversations.cacheWriteTokens} + ${t.usage.cacheWriteTokens}`,
        costUsd: sql`${conversations.costUsd} + ${t.costUsd}`,
        updatedAt: sql`now()`,
      })
      .where(eq(conversations.id, conversationId));
    return true;
  });
}

async function loadTurnRecords(db: Db, conversationId: string): Promise<TurnRecord[]> {
  const rows = await db
    .select({ turnNumber: turns.turnNumber, speaker: turns.speaker, content: turns.content })
    .from(turns)
    .where(eq(turns.conversationId, conversationId))
    .orderBy(asc(turns.turnNumber));
  return rows;
}

/** Runs async tasks with at most `limit` in flight. */
export async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function executeConversation(
  db: Db,
  conv: { id: string; index: number },
  setup: ConversationSetup,
  client: ModelClient,
) {
  await db
    .update(conversations)
    .set({ status: "running", startedAt: sql`coalesce(${conversations.startedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(conversations.id, conv.id));

  let result: { status: "done" | "errored" | "stopped" | "pending" | "running"; stopReason: ConversationStopReason; error: string | null };
  try {
    const existingTurns = await loadTurnRecords(db, conv.id);
    result = await runConversation({
      setup,
      client,
      conversationIndex: conv.index,
      existingTurns,
      saveTurn: async (t) => {
        await saveTurn(db, conv.id, t);
      },
    });
  } catch (err) {
    result = { status: "errored", stopReason: "error", error: err instanceof Error ? err.message : String(err) };
  }

  await db
    .update(conversations)
    .set({
      status: result.status,
      stopReason: result.stopReason,
      error: result.error,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(conversations.id, conv.id));
}

/**
 * Executes every unfinished conversation of a run inside the current request.
 * PR 2 replaces this with Vercel Workflow.
 */
export async function executeRun(db: Db, runId: string, client?: ModelClient): Promise<RunStatus> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`Run not found: ${runId}`);
  const modelClient = client ?? clientForRun(run.config);
  const setup = setupFromConfig(run.config);

  await db
    .update(runs)
    .set({ status: "running", startedAt: sql`coalesce(${runs.startedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(runs.id, runId));

  const todo = await db
    .select({ id: conversations.id, index: conversations.index })
    .from(conversations)
    .where(and(eq(conversations.runId, runId), inArray(conversations.status, ["pending", "running"])))
    .orderBy(asc(conversations.index));

  await withConcurrency(todo, run.config.concurrency, (conv) => executeConversation(db, conv, setup, modelClient));

  const all = await db
    .select({ status: conversations.status, cost: conversations.costUsd })
    .from(conversations)
    .where(eq(conversations.runId, runId));
  const cost = all.reduce((s, c) => s + c.cost, 0);
  // One failed conversation does not fail the run; all of them failing does.
  const status: RunStatus = all.length > 0 && all.every((c) => c.status === "errored") ? "failed" : "done";

  await db
    .update(runs)
    .set({ status, costUsd: cost, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(runs.id, runId));
  await db.update(experiments).set({ updatedAt: sql`now()` }).where(eq(experiments.id, run.experimentId));
  return status;
}

// ---------- Queries for the pages ----------

export interface ExperimentListRow {
  number: number;
  name: string;
  declaredVariables: string[];
  runCount: number;
  /** Status of the single run, or a summary across runs. */
  status: RunStatus | "mixed";
  totalCostUsd: number;
  updatedAt: Date;
  firstRunNumber: number | null;
}

export async function listExperiments(db: Db): Promise<ExperimentListRow[]> {
  const exps = await db.select().from(experiments).orderBy(desc(experiments.updatedAt), desc(experiments.number));
  if (exps.length === 0) return [];
  const runRows = await db
    .select({
      experimentId: runs.experimentId,
      number: runs.number,
      status: runs.status,
      costUsd: runs.costUsd,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .where(inArray(runs.experimentId, exps.map((e) => e.id)))
    .orderBy(asc(runs.number));

  return exps.map((e) => {
    const rs = runRows.filter((r) => r.experimentId === e.id);
    const statuses = new Set(rs.map((r) => r.status));
    const latest = rs.reduce((d, r) => (r.updatedAt > d ? r.updatedAt : d), e.updatedAt);
    return {
      number: e.number,
      name: e.name,
      declaredVariables: e.declaredVariables,
      runCount: rs.length,
      status: statuses.size === 1 ? rs[0].status : rs.length === 0 ? "draft" : "mixed",
      totalCostUsd: rs.reduce((s, r) => s + r.costUsd, 0),
      updatedAt: latest,
      firstRunNumber: rs[0]?.number ?? null,
    };
  });
}

export async function getRunPage(db: Db, experimentNumber: number, runNumber: number) {
  const [exp] = await db.select().from(experiments).where(eq(experiments.number, experimentNumber));
  if (!exp) return null;
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.experimentId, exp.id), eq(runs.number, runNumber)));
  if (!run) return null;
  const convs = await db
    .select()
    .from(conversations)
    .where(eq(conversations.runId, run.id))
    .orderBy(asc(conversations.index));
  return { experiment: exp, run, conversations: convs };
}

export async function getConversationPage(
  db: Db,
  experimentNumber: number,
  runNumber: number,
  conversationIndex: number,
) {
  const page = await getRunPage(db, experimentNumber, runNumber);
  if (!page) return null;
  const conv = page.conversations.find((c) => c.index === conversationIndex);
  if (!conv) return null;
  const rows = await db
    .select()
    .from(turns)
    .where(eq(turns.conversationId, conv.id))
    .orderBy(asc(turns.turnNumber));
  return {
    experiment: page.experiment,
    run: page.run,
    conversation: conv,
    conversationCount: page.conversations.length,
    turns: rows,
  };
}
