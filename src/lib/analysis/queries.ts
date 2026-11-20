/** Queries behind the analysis parts of the run and conversation pages. */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { codings, conversations, reports, turns } from "../db/schema";
import { aggregateFields, type FieldDef } from "./fields";
import type { PerTurnMeasureKey, SeriesPoint } from "./measures";
import { listVersions, loadRunCodings, type AnalysisVersionRow } from "./service";

/** Per-turn computed measures averaged across a run's conversations, turn by turn (computed in the database). */
export async function perTurnSeries(db: Db, runId: string): Promise<Record<PerTurnMeasureKey, SeriesPoint[]>> {
  const rows = await db
    .select({
      turn: turns.turnNumber,
      n: sql<number>`count(*)::int`,
      visibleLength: sql<number>`avg(length(${turns.text}))::float8`,
      selfRepetition: sql<number | null>`avg(${turns.repetition})::float8`,
      selfN: sql<number>`count(${turns.repetition})::int`,
      crossSimilarity: sql<number | null>`avg(${turns.crossSimilarity})::float8`,
      crossN: sql<number>`count(${turns.crossSimilarity})::int`,
      emojiCount: sql<number | null>`avg(${turns.emojiCount})::float8`,
      modelNamed: sql<number | null>`avg(case when ${turns.modelMentions} is null then null when jsonb_array_length(${turns.modelMentions}) > 0 then 1 else 0 end)::float8`,
    })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(eq(conversations.runId, runId))
    .groupBy(turns.turnNumber)
    .orderBy(asc(turns.turnNumber));
  const series = (key: PerTurnMeasureKey, nOf: (r: (typeof rows)[number]) => number) =>
    rows
      .filter((r) => r[key] !== null && nOf(r) > 0)
      .map((r) => ({ turn: r.turn, value: Number(r[key]), n: nOf(r) }));
  return {
    visibleLength: series("visibleLength", (r) => r.n),
    selfRepetition: series("selfRepetition", (r) => r.selfN),
    crossSimilarity: series("crossSimilarity", (r) => r.crossN),
    emojiCount: series("emojiCount", (r) => r.n),
    modelNamed: series("modelNamed", (r) => r.n),
  };
}

export interface ConversationCounts {
  truncated: number;
  empty: number;
  signOffs: Array<{ speaker: string; turn: number }>;
}

/** Truncated and empty-reply counts and sign-offs per conversation of a run (computed in the database). */
export async function conversationCounts(db: Db, runId: string): Promise<Map<string, ConversationCounts>> {
  const rows = await db
    .select({
      id: turns.conversationId,
      truncated: sql<number>`sum(case when ${turns.truncated} then 1 else 0 end)::int`,
      empty: sql<number>`sum(case when ${turns.placeholderUsed} then 1 else 0 end)::int`,
      signOffs: sql<Array<{ speaker: string; turn: number }> | null>`jsonb_agg(jsonb_build_object('speaker', ${turns.speaker}, 'turn', ${turns.turnNumber}) order by ${turns.turnNumber}) filter (where ${turns.signedOff})`,
    })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(eq(conversations.runId, runId))
    .groupBy(turns.conversationId);
  return new Map(rows.map((r) => [r.id, { truncated: r.truncated, empty: r.empty, signOffs: r.signOffs ?? [] }]));
}

/** Per-speaker computed measures across a run. */
export async function speakerTotals(db: Db, runId: string) {
  return db
    .select({
      speaker: turns.speaker,
      turns: sql<number>`count(*)::int`,
      tokens: sql<number>`sum(${turns.inputTokens} + ${turns.cacheReadTokens} + ${turns.cacheWriteTokens} + ${turns.outputTokens})::float8`,
      thinkingTokens: sql<number>`sum(${turns.thinkingTokens})::float8`,
      meanLength: sql<number>`avg(length(${turns.text}))::float8`,
    })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(eq(conversations.runId, runId))
    .groupBy(turns.speaker)
    .orderBy(asc(turns.speaker));
}

export function pickVersion(versions: AnalysisVersionRow[], requested: number | null): AnalysisVersionRow | null {
  if (versions.length === 0) return null;
  return versions.find((v) => v.version === requested) ?? versions[versions.length - 1];
}

/** Everything the run page shows about analysis, for one analysis version. */
export async function getRunAnalysis(db: Db, run: { id: string; experimentId: string }, requestedVersion: number | null) {
  const versions = await listVersions(db, run.experimentId);
  const version = pickVersion(versions, requestedVersion);
  const series = await perTurnSeries(db, run.id);
  const counts = await conversationCounts(db, run.id);
  const speakers = await speakerTotals(db, run.id);
  if (!version) return { versions, version: null, series, counts, speakers, codings: [], aggregates: [], report: null, status: null };

  const rows = await loadRunCodings(db, run.id, version.id);
  const defs = version.fieldDefinitions as FieldDef[];
  const done = rows.filter((r) => r.coding.status === "done" && r.coding.output);
  const aggregates = aggregateFields(
    defs,
    done.map((r) => ({ conversation: r.conversation.index, turnsCompleted: r.conversation.turnsCompleted, fields: r.coding.output!.fields })),
  );
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.analysisVersionId, version.id), eq(reports.runId, run.id)));
  const by = (s: string) => rows.filter((r) => r.coding.status === s).length;
  const status = {
    total: rows.length,
    done: by("done"),
    errored: by("errored"),
    waiting: by("pending") + by("running"),
    costUsd: rows.reduce((s, r) => s + r.coding.costUsd, 0) + (report?.costUsd ?? 0),
    active: by("pending") + by("running") > 0 || report?.status === "pending" || report?.status === "running",
  };
  return {
    versions,
    version,
    series,
    counts,
    speakers,
    codings: rows.map((r) => ({ conversationIndex: r.conversation.index, coding: r.coding })),
    aggregates,
    report: report ?? null,
    status,
  };
}

/** The coding of one conversation under one analysis version. */
export async function getConversationCoding(db: Db, conversation: { id: string }, experimentId: string, requestedVersion: number | null) {
  const versions = await listVersions(db, experimentId);
  const version = pickVersion(versions, requestedVersion);
  if (!version) return { versions, version: null, coding: null };
  const [coding] = await db
    .select()
    .from(codings)
    .where(and(eq(codings.analysisVersionId, version.id), eq(codings.conversationId, conversation.id)));
  return { versions, version, coding: coding ?? null };
}
