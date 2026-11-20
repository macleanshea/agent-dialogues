import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { defaultExperimentName, snapshotConfig, type RunConfig } from "../config";
import type { Db } from "../db";
import { analysisVersions, codings, conversations, experiments, reports, runs, turns, type RunStatus } from "../db/schema";
import type { BaselineProfile } from "../estimate";

import { PROMPT_VERSIONS } from "../analysis/prompts";
import { variableLabel } from "../experiments/variables";
import { snapshotFields } from "../analysis/service";

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
  // Copies the selected field definitions now, so later edits to the library never change this analysis.
  const fields = await snapshotFields(db, config.fields);
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
      fieldDefinitions: fields,
      summarizerModel: config.summarizerModel,
      reportModel: config.reportModel,
      judgeReadsThinking: config.judgeReadsThinking,
      promptVersions: { ...PROMPT_VERSIONS },
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

// ---------- Queries for the pages ----------

export interface ExperimentListRow {
  number: number;
  name: string;
  declaredVariables: string[];
  /** The declared variable as shown ("Both models", "Turns", ...), or "" for a standalone run. */
  variable: string;
  /** An experiment can be expanded unless it is a standalone run (one run, no declared variable). */
  expandable: boolean;
  locked: boolean;
  /** B's "same as A" in the shared settings, for the variable label. */
  sameAsA: boolean;
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
      variable: variableLabel(e.declaredVariables, e.sharedSettings?.agentB.sameAsA ?? false),
      expandable: rs.length > 1 || e.declaredVariables.length > 0,
      locked: e.locked,
      sameAsA: e.sharedSettings?.agentB.sameAsA ?? false,
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

// ---------- Cost estimate (PR 5) ----------

/**
 * What a finished baseline run actually used, for the cost estimate: per turn
 * number, the share of its conversations that reached that turn and their
 * average tokens there, plus its actual analysis spend. Null while the run
 * has not finished or has no turns.
 */
export async function baselineProfile(db: Db, experimentIdValue: string): Promise<BaselineProfile | null> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.experimentId, experimentIdValue), eq(runs.number, 1)));
  if (!run || !["done", "stopped", "failed"].includes(run.status)) return null;
  // Conversations that never started (stopped before their first call) say nothing about cost per conversation.
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(eq(conversations.runId, run.id), sql`${conversations.turnsCompleted} > 0`));
  const started = Number(n);
  if (started === 0) return null;
  const rows = await db
    .select({
      turn: turns.turnNumber,
      count: sql<number>`count(*)::int`,
      inputTokens: sql<number>`avg(${turns.inputTokens})::float8`,
      cacheReadTokens: sql<number>`avg(${turns.cacheReadTokens})::float8`,
      cacheWriteTokens: sql<number>`avg(${turns.cacheWriteTokens})::float8`,
      outputTokens: sql<number>`avg(${turns.outputTokens})::float8`,
      thinkingTokens: sql<number>`avg(${turns.thinkingTokens})::float8`,
    })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(eq(conversations.runId, run.id))
    .groupBy(turns.turnNumber)
    .orderBy(asc(turns.turnNumber));

  // Analysis spend under the latest version with finished codings for this run.
  const analysis = await db
    .select({
      versionId: codings.analysisVersionId,
      version: analysisVersions.version,
      coded: sql<number>`count(*) filter (where ${codings.status} = 'done')::int`,
      cost: sql<number>`coalesce(sum(${codings.costUsd}), 0)::float8`,
    })
    .from(codings)
    .innerJoin(conversations, eq(conversations.id, codings.conversationId))
    .innerJoin(analysisVersions, eq(analysisVersions.id, codings.analysisVersionId))
    .where(eq(conversations.runId, run.id))
    .groupBy(codings.analysisVersionId, analysisVersions.version)
    .orderBy(desc(analysisVersions.version));
  const coded = analysis.find((a) => Number(a.coded) > 0);
  let analysisSpend: BaselineProfile["analysis"] = null;
  if (coded) {
    const [report] = await db
      .select({ cost: reports.costUsd })
      .from(reports)
      .where(and(eq(reports.runId, run.id), eq(reports.analysisVersionId, coded.versionId)));
    analysisSpend = { perConversation: Number(coded.cost) / Number(coded.coded), report: report?.cost ?? 0 };
  }

  return {
    runNumber: run.number,
    conversations: started,
    modelA: run.config.agentA.model,
    modelB: run.config.agentB.model,
    effortA: run.config.agentA.effort,
    effortB: run.config.agentB.effort,
    analysis: analysisSpend,
    turns: rows.map((r) => ({
      turn: r.turn,
      reached: Number(r.count) / started,
      inputTokens: Number(r.inputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      outputTokens: Number(r.outputTokens),
      thinkingTokens: Number(r.thinkingTokens),
    })),
  };
}
