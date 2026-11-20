/**
 * Experiments (PR 4): declaring the variable, adding runs as drafts,
 * starting drafts, locking, and the queries behind the expandable list.
 * Every function takes the database as an argument, so tests drive it with
 * PGlite.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { runConfigSchema, snapshotConfig, type RunConfig, type RunConfigSnapshot } from "../config";
import type { Db } from "../db";
import { analysisVersions, codings, comparisons, conversations, experiments, reports, runs } from "../db/schema";
import { diffFromBaseline, mergeWithBaseline, normalizeVariables, type VariableKey } from "./variables";

export type ExperimentRow = typeof experiments.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

export async function getExperimentByNumber(db: Db, n: number): Promise<ExperimentRow | null> {
  const [exp] = await db.select().from(experiments).where(eq(experiments.number, n));
  return exp ?? null;
}

/** The baseline run (R1). */
export async function getBaseline(db: Db, experimentId: string): Promise<RunRow | null> {
  const [r] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.experimentId, experimentId), eq(runs.number, 1)));
  return r ?? null;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string; errors?: Record<string, string> };

/**
 * The run-page toggle: which settings may vary between runs. An empty list
 * turns the experiment back into a standalone run. Refused once the
 * experiment is locked (a second run exists).
 */
export async function declareVariables(db: Db, experimentId: string, keys: readonly string[]): Promise<Result<{ variables: VariableKey[] }>> {
  const unknown = keys.filter((k) => !normalizeVariables([k]).length);
  if (unknown.length) return { ok: false, message: `Unknown setting: ${unknown.join(", ")}` };
  const variables = normalizeVariables(keys);
  const updated = await db
    .update(experiments)
    .set({ declaredVariables: variables, updatedAt: sql`now()` })
    .where(and(eq(experiments.id, experimentId), eq(experiments.locked, false)))
    .returning({ id: experiments.id });
  if (updated.length === 0) {
    return {
      ok: false,
      message: "This experiment is locked because it has more than one run. To change the variable, clone the experiment.",
    };
  }
  return { ok: true, variables };
}

/**
 * "+ Add run": saves a new run as a draft. Only the declared variable (and
 * the per-run cost ceiling and concurrency) comes from what was submitted;
 * every other setting is copied from the baseline. Locks the experiment.
 */
export async function addDraftRun(db: Db, experimentId: string, submitted: RunConfig): Promise<Result<{ runId: string; runNumber: number }>> {
  const [exp] = await db.select().from(experiments).where(eq(experiments.id, experimentId));
  if (!exp) return { ok: false, message: "This experiment no longer exists." };
  if (exp.declaredVariables.length === 0) {
    return { ok: false, message: "Declare which setting varies (on the run page) before adding runs." };
  }
  const baseline = await getBaseline(db, experimentId);
  if (!baseline) return { ok: false, message: "This experiment has no baseline run." };

  const merged = runConfigSchema.safeParse(mergeWithBaseline(baseline.config, submitted, exp.declaredVariables));
  if (!merged.success) {
    const errors: Record<string, string> = {};
    for (const i of merged.error.issues) errors[i.path.join(".")] ??= i.message;
    return { ok: false, message: "Some settings need fixing. See the messages next to each field.", errors };
  }
  const snapshot = snapshotConfig(merged.data);

  return db.transaction(async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${runs.number}), 0)` })
      .from(runs)
      .where(eq(runs.experimentId, experimentId));
    const [run] = await tx
      .insert(runs)
      .values({
        experimentId,
        number: Number(max) + 1,
        config: snapshot,
        modelA: snapshot.agentA.model,
        modelB: snapshot.agentB.model,
        configDiff: diffFromBaseline(baseline.config, snapshot),
        status: "draft",
      })
      .returning({ id: runs.id, number: runs.number });
    // Once a second run exists, the shared settings and the variable are locked.
    await tx.update(experiments).set({ locked: true, updatedAt: sql`now()` }).where(eq(experiments.id, experimentId));
    return { ok: true as const, runId: run.id, runNumber: run.number };
  });
}

/**
 * Moves a draft to queued and creates its conversations. Returns false if
 * the run was not a draft (so a double click starts it only once).
 */
export async function queueDraftRun(db: Db, runIdValue: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({ status: "queued", updatedAt: sql`now()` })
      .where(and(eq(runs.id, runIdValue), eq(runs.status, "draft")))
      .returning({ id: runs.id, config: runs.config, experimentId: runs.experimentId });
    if (!run) return false;
    await tx
      .insert(conversations)
      .values(Array.from({ length: run.config.conversations }, (_, i) => ({ runId: run.id, index: i + 1 })))
      .onConflictDoNothing({ target: [conversations.runId, conversations.index] });
    await tx.update(experiments).set({ updatedAt: sql`now()` }).where(eq(experiments.id, run.experimentId));
    return true;
  });
}

/** Deletes a draft run. Refuses anything that has started. */
export async function deleteDraftRun(db: Db, runIdValue: string): Promise<boolean> {
  const deleted = await db
    .delete(runs)
    .where(and(eq(runs.id, runIdValue), eq(runs.status, "draft")))
    .returning({ experimentId: runs.experimentId });
  if (deleted.length === 0) return false;
  const expId = deleted[0].experimentId;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(runs).where(eq(runs.experimentId, expId));
  // The lock follows "a second run exists".
  await db.update(experiments).set({ locked: Number(n) >= 2, updatedAt: sql`now()` }).where(eq(experiments.id, expId));
  return true;
}

export async function draftRunIds(db: Db, experimentId: string): Promise<string[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.experimentId, experimentId), eq(runs.status, "draft")))
    .orderBy(asc(runs.number));
  return rows.map((r) => r.id);
}

export async function findRun(db: Db, experimentNumber: number, runNumber: number): Promise<RunRow | null> {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .where(and(eq(experiments.number, experimentNumber), eq(runs.number, runNumber)));
  return row?.run ?? null;
}

// ---------- The expanded panel on the main list ----------

export interface PanelRun {
  number: number;
  status: RunRow["status"];
  costUsd: number;
  config: RunConfigSnapshot;
  reportStatus: (typeof reports.$inferSelect)["status"] | null;
  /** Conversations coded under the latest analysis version, and how many are still waiting. */
  coded: number;
  codingWaiting: number;
}

export interface ExperimentPanel {
  experiment: ExperimentRow;
  runs: PanelRun[];
  comparisons: Array<{ number: number; status: string; runNumbers: number[] }>;
  latestVersion: number | null;
}

export async function getExperimentPanel(db: Db, experimentId: string): Promise<ExperimentPanel | null> {
  const [experiment] = await db.select().from(experiments).where(eq(experiments.id, experimentId));
  if (!experiment) return null;
  const [version] = await db
    .select()
    .from(analysisVersions)
    .where(eq(analysisVersions.experimentId, experimentId))
    .orderBy(desc(analysisVersions.version))
    .limit(1);
  const runRows = await db.select().from(runs).where(eq(runs.experimentId, experimentId)).orderBy(asc(runs.number));
  const reportRows = version
    ? await db
        .select({ runId: reports.runId, status: reports.status })
        .from(reports)
        .where(eq(reports.analysisVersionId, version.id))
    : [];
  const codingList = version
    ? await db
        .select({
          runId: conversations.runId,
          done: sql<number>`count(*) filter (where ${codings.status} = 'done')::int`,
          waiting: sql<number>`count(*) filter (where ${codings.status} in ('pending', 'running'))::int`,
        })
        .from(codings)
        .innerJoin(conversations, eq(conversations.id, codings.conversationId))
        .where(eq(codings.analysisVersionId, version.id))
        .groupBy(conversations.runId)
    : [];
  const comps = await db
    .select({ number: comparisons.number, status: comparisons.status, labels: comparisons.labels })
    .from(comparisons)
    .where(eq(comparisons.experimentId, experimentId))
    .orderBy(asc(comparisons.number));
  return {
    experiment,
    latestVersion: version?.version ?? null,
    runs: runRows.map((r) => {
      const c = codingList.find((x) => x.runId === r.id);
      return {
        number: r.number,
        status: r.status,
        costUsd: r.costUsd,
        config: r.config,
        reportStatus: reportRows.find((x) => x.runId === r.id)?.status ?? null,
        coded: Number(c?.done ?? 0),
        codingWaiting: Number(c?.waiting ?? 0),
      };
    }),
    comparisons: comps.map((c) => ({ number: c.number, status: c.status, runNumbers: c.labels.map((l) => l.runNumber).sort((a, b) => a - b) })),
  };
}

/** Experiment ids by number, for the panels the URL asks to expand. */
export async function experimentIdsByNumber(db: Db, numbers: number[]): Promise<Map<number, string>> {
  if (numbers.length === 0) return new Map();
  const rows = await db
    .select({ id: experiments.id, number: experiments.number })
    .from(experiments)
    .where(inArray(experiments.number, numbers));
  return new Map(rows.map((r) => [r.number, r.id]));
}

/** The experiment's latest analysis version, or null. */
export async function latestVersion(db: Db, experimentId: string) {
  const [v] = await db
    .select()
    .from(analysisVersions)
    .where(eq(analysisVersions.experimentId, experimentId))
    .orderBy(desc(analysisVersions.version))
    .limit(1);
  return v ?? null;
}

/** A stored snapshot as form values (without the resolved prompts). */
export function formValuesFrom(snapshot: RunConfigSnapshot): RunConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { resolved, ...config } = snapshot;
  return config;
}

