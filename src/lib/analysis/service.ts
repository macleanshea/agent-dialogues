/**
 * Analysis, one model call at a time: coding each conversation with the
 * summarizer, then writing the run report. Like src/lib/runs/execution.ts,
 * every function takes the database and the model client as arguments, so the
 * Workflow (src/workflows/analysis.ts) and the tests run the same code.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { RunConfigSnapshot } from "../config";
import type { Db } from "../db";
import {
  analysisVersions,
  codings,
  conversations,
  experiments,
  fieldDefinitions,
  reports,
  runs,
  turns,
  type FieldDefinitionSnapshot,
  type OpenedTranscript,
} from "../db/schema";
import { visibleText } from "../engine/history";
import { isTransientModelError, type AgentMessage, type ContentBlock } from "../engine/types";
import { conversationId, runId } from "../ids";
import { addUsage, costUsd, type TokenUsage } from "../models";
import { checkCitations } from "./citations";
import {
  aggregateFields,
  codingSchema,
  customFieldSchema,
  describeFields,
  normalizeCoding,
  optionsForCustomField,
  type CodingOutput,
  type FieldDef,
} from "./fields";
import { formatAggregates, formatCodingForReport, formatMeasuresLine, formatTranscript, promptOrNone } from "./format";
import type { JudgeClient } from "./judge";
import { conversationMeasures, type MeasuredTurn } from "./measures";
import {
  OPEN_TRANSCRIPT_TOOL,
  PROMPT_VERSIONS,
  RUN_REPORT_NUDGE,
  RUN_REPORT_PROMPT,
  SUMMARIZER_PROMPT,
  fillTemplate,
} from "./prompts";

export const SUMMARIZER_MAX_TOKENS = 32_000;
export const REPORT_MAX_TOKENS = 64_000;
/** The report writer must open this many transcripts, or all of them if there are fewer. */
export const MIN_TRANSCRIPTS = 3;
/** Reminders sent if the report writer finishes before opening enough transcripts. */
export const MAX_NUDGES = 2;
/** A safety stop for the report writer's loop. */
export const MAX_REPORT_CALLS = 25;

// ---------- Field library ----------

export type FieldRow = typeof fieldDefinitions.$inferSelect;

/** Built-in fields in library order, then custom fields in the order they were made. */
export async function listFieldLibrary(db: Db): Promise<FieldRow[]> {
  return db
    .select()
    .from(fieldDefinitions)
    .orderBy(desc(fieldDefinitions.builtin), asc(fieldDefinitions.sortOrder), asc(fieldDefinitions.createdAt));
}

export type CreateFieldResult = { ok: true; field: FieldRow } | { ok: false; errors: Record<string, string> };

/** Saves a custom field to the library. It is then listed and used exactly like a built-in one. */
export async function createCustomField(db: Db, input: unknown): Promise<CreateFieldResult> {
  const parsed = customFieldSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[i.path.join(".") || "form"] ??= i.message;
    return { ok: false, errors };
  }
  const f = parsed.data;
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${fieldDefinitions.sortOrder}), 0)` }).from(fieldDefinitions);
  const inserted = await db
    .insert(fieldDefinitions)
    .values({
      name: f.name,
      type: f.type,
      scope: f.scope,
      options: optionsForCustomField(f),
      definition: f.definition,
      builtin: false,
      group: f.group,
      presets: [],
      sortOrder: Number(max) + 1,
    })
    .onConflictDoNothing({ target: fieldDefinitions.name })
    .returning();
  if (inserted.length === 0) return { ok: false, errors: { name: "A field with this name already exists" } };
  return { ok: true, field: inserted[0] };
}

/** Copies the named fields from the library, in library order. Throws on an unknown name. */
export async function snapshotFields(db: Db, names: string[]): Promise<FieldDefinitionSnapshot[]> {
  if (names.length === 0) return [];
  const rows = await listFieldLibrary(db);
  const wanted = new Set(names);
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length) throw new Error(`Unknown field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  return rows
    .filter((r) => wanted.has(r.name))
    .map((r) => ({ id: r.id, name: r.name, type: r.type, scope: r.scope, options: r.options, definition: r.definition }));
}

// ---------- Analysis versions ----------

export type AnalysisVersionRow = typeof analysisVersions.$inferSelect;

export async function listVersions(db: Db, experimentId: string): Promise<AnalysisVersionRow[]> {
  return db.select().from(analysisVersions).where(eq(analysisVersions.experimentId, experimentId)).orderBy(asc(analysisVersions.version));
}

export interface AnalysisSettings {
  focus: string;
  fields: string[];
  summarizerModel: string;
  reportModel: string;
  judgeReadsThinking: boolean;
}

/**
 * Re-analysis: a new analysis version for the whole experiment. Earlier
 * versions and their codings are kept. The caller then re-codes every run.
 */
export async function createAnalysisVersion(db: Db, experimentId: string, s: AnalysisSettings): Promise<AnalysisVersionRow> {
  const fields = await snapshotFields(db, s.fields);
  return db.transaction(async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${analysisVersions.version}), 0)` })
      .from(analysisVersions)
      .where(eq(analysisVersions.experimentId, experimentId));
    const [row] = await tx
      .insert(analysisVersions)
      .values({
        experimentId,
        version: Number(max) + 1,
        focus: s.focus,
        fieldDefinitions: fields,
        summarizerModel: s.summarizerModel,
        reportModel: s.reportModel,
        judgeReadsThinking: s.judgeReadsThinking,
        promptVersions: { ...PROMPT_VERSIONS },
      })
      .returning();
    await tx.update(experiments).set({ analysisFocus: s.focus, updatedAt: sql`now()` }).where(eq(experiments.id, experimentId));
    return row;
  });
}

// ---------- Preparing a run's analysis ----------

export interface AnalysisPlan {
  versionId: string;
  codingIds: string[];
  reportId: string | null;
  concurrency: number;
}

/**
 * Creates the coding rows (one per conversation that has at least one turn)
 * and the report row for a run under an analysis version (the latest, if none
 * is given). Safe to repeat: existing rows are kept, and only work not yet
 * done is returned.
 */
export async function prepareAnalysis(db: Db, runIdValue: string, versionId: string | null = null): Promise<AnalysisPlan> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runIdValue));
  if (!run) throw new Error(`Run not found: ${runIdValue}`);
  const [version] = versionId
    ? await db.select().from(analysisVersions).where(eq(analysisVersions.id, versionId))
    : await db
        .select()
        .from(analysisVersions)
        .where(eq(analysisVersions.experimentId, run.experimentId))
        .orderBy(desc(analysisVersions.version))
        .limit(1);
  if (!version) throw new Error(`No analysis version for run ${runIdValue}`);

  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.runId, run.id), sql`${conversations.turnsCompleted} > 0`))
    .orderBy(asc(conversations.index));
  if (convs.length === 0) return { versionId: version.id, codingIds: [], reportId: null, concurrency: 1 };

  await db
    .insert(codings)
    .values(convs.map((c) => ({ analysisVersionId: version.id, conversationId: c.id, model: version.summarizerModel })))
    .onConflictDoNothing({ target: [codings.analysisVersionId, codings.conversationId] });
  await db
    .insert(reports)
    .values({ analysisVersionId: version.id, runId: run.id, model: version.reportModel })
    .onConflictDoNothing({ target: [reports.analysisVersionId, reports.runId] });

  const todo = await db
    .select({ id: codings.id })
    .from(codings)
    .innerJoin(conversations, eq(conversations.id, codings.conversationId))
    .where(and(eq(codings.analysisVersionId, version.id), eq(conversations.runId, run.id), inArray(codings.status, ["pending", "running"])))
    .orderBy(asc(conversations.index));
  const [report] = await db
    .select({ id: reports.id, status: reports.status })
    .from(reports)
    .where(and(eq(reports.analysisVersionId, version.id), eq(reports.runId, run.id)));
  return {
    versionId: version.id,
    codingIds: todo.map((t) => t.id),
    reportId: report && (report.status === "pending" || report.status === "running") ? report.id : null,
    concurrency: run.config.concurrency,
  };
}

// ---------- Summarizer ----------

const turnColumns = {
  turnNumber: turns.turnNumber,
  speaker: turns.speaker,
  text: turns.text,
  thinkingSummary: turns.thinkingSummary,
};

async function loadTranscript(db: Db, conversationIdValue: string) {
  return db.select(turnColumns).from(turns).where(eq(turns.conversationId, conversationIdValue)).orderBy(asc(turns.turnNumber));
}

/** The summarizer prompt for one conversation, assembled from the selected field definitions. */
export function buildSummarizerPrompt(
  config: RunConfigSnapshot,
  version: Pick<AnalysisVersionRow, "focus" | "fieldDefinitions" | "judgeReadsThinking">,
  transcript: Awaited<ReturnType<typeof loadTranscript>>,
): string {
  return fillTemplate(SUMMARIZER_PROMPT, {
    analysis_focus: version.focus.trim() || "(none given)",
    system_prompt_a: promptOrNone(config.resolved.systemPromptA),
    system_prompt_b: promptOrNone(config.resolved.systemPromptB),
    opening_message: config.openingMessage,
    transcript: formatTranscript(transcript, { includeThinking: version.judgeReadsThinking }),
    field_definitions: describeFields(version.fieldDefinitions as FieldDef[]),
  });
}

/** The first JSON object in a reply's text. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("The reply was not JSON.");
  }
}

function usageColumns(model: string, u: TokenUsage) {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    thinkingTokens: u.thinkingTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    costUsd: costUsd(model, u),
  };
}

/**
 * Codes one conversation: one summarizer call. Safe to repeat; a coding that
 * is already done is left alone. Rate limits and server errors are thrown
 * (TransientModelError) so the caller can retry; anything else marks the
 * coding errored.
 */
export async function codeConversation(db: Db, codingIdValue: string, judge: JudgeClient): Promise<"done" | "errored"> {
  const [row] = await db
    .select({ coding: codings, version: analysisVersions, conv: conversations, config: runs.config })
    .from(codings)
    .innerJoin(analysisVersions, eq(analysisVersions.id, codings.analysisVersionId))
    .innerJoin(conversations, eq(conversations.id, codings.conversationId))
    .innerJoin(runs, eq(runs.id, conversations.runId))
    .where(eq(codings.id, codingIdValue));
  if (!row) throw new Error(`Coding not found: ${codingIdValue}`);
  if (row.coding.status === "done" || row.coding.status === "errored") return row.coding.status;

  await db.update(codings).set({ status: "running", updatedAt: sql`now()` }).where(eq(codings.id, codingIdValue));
  const transcript = await loadTranscript(db, row.conv.id);
  const defs = row.version.fieldDefinitions as FieldDef[];
  const prompt = buildSummarizerPrompt(row.config, row.version, transcript);

  const fail = async (message: string, usage?: TokenUsage) => {
    await db
      .update(codings)
      .set({ status: "errored", error: message, ...(usage ? usageColumns(row.coding.model, usage) : {}), updatedAt: sql`now()` })
      .where(eq(codings.id, codingIdValue));
    return "errored" as const;
  };

  let res;
  try {
    res = await judge.call({
      model: row.coding.model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens: SUMMARIZER_MAX_TOKENS,
      effort: "medium",
      outputSchema: codingSchema(defs),
      purpose: "summarizer",
    });
  } catch (err) {
    if (isTransientModelError(err)) throw err;
    return fail(`Summarizer call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.stopReason !== "end_turn") {
    return fail(`The summarizer stopped with "${res.stopReason}" instead of finishing its JSON.`, res.usage);
  }
  let raw: unknown;
  try {
    raw = parseJson(visibleText(res.content));
  } catch (err) {
    return fail(`The summarizer's reply could not be read: ${err instanceof Error ? err.message : String(err)}`, res.usage);
  }
  const maxTurn = transcript.length ? transcript[transcript.length - 1].turnNumber : 0;
  const output = normalizeCoding(defs, raw, maxTurn);
  await db
    .update(codings)
    .set({ status: "done", output, rawOutput: raw as object, error: null, ...usageColumns(row.coding.model, res.usage), updatedAt: sql`now()` })
    .where(eq(codings.id, codingIdValue));
  return "done";
}

/** Marks a coding failed after its model call kept failing (or, with raw, with the message as given). */
export async function failCoding(db: Db, codingIdValue: string, message: string, opts: { raw?: boolean } = {}): Promise<void> {
  await db
    .update(codings)
    .set({ status: "errored", error: opts.raw ? message : `API error after retries: ${message}`, updatedAt: sql`now()` })
    .where(and(eq(codings.id, codingIdValue), inArray(codings.status, ["pending", "running"])));
}

// ---------- Run report ----------

const measuredTurnColumns = {
  conversationId: turns.conversationId,
  turnNumber: turns.turnNumber,
  speaker: turns.speaker,
  text: turns.text,
  truncated: turns.truncated,
  placeholderUsed: turns.placeholderUsed,
  signedOff: turns.signedOff,
  outputTokens: turns.outputTokens,
  thinkingTokens: turns.thinkingTokens,
  inputTokens: turns.inputTokens,
  cacheReadTokens: turns.cacheReadTokens,
  cacheWriteTokens: turns.cacheWriteTokens,
  repetition: turns.repetition,
  crossSimilarity: turns.crossSimilarity,
  emojiCount: turns.emojiCount,
  modelMentions: turns.modelMentions,
};

/** Every turn of a run with the fields the computed measures read, grouped by conversation id. */
export async function loadMeasuredTurns(db: Db, runIdValue: string): Promise<Map<string, MeasuredTurn[]>> {
  const rows = await db
    .select(measuredTurnColumns)
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(eq(conversations.runId, runIdValue))
    .orderBy(asc(turns.conversationId), asc(turns.turnNumber));
  const out = new Map<string, MeasuredTurn[]>();
  for (const r of rows) {
    const list = out.get(r.conversationId) ?? [];
    list.push(r);
    out.set(r.conversationId, list);
  }
  return out;
}

/** The codings of a run under a version, with their conversations. */
export async function loadRunCodings(db: Db, runIdValue: string, versionId: string) {
  return db
    .select({ coding: codings, conversation: conversations })
    .from(codings)
    .innerJoin(conversations, eq(conversations.id, codings.conversationId))
    .where(and(eq(codings.analysisVersionId, versionId), eq(conversations.runId, runIdValue)))
    .orderBy(asc(conversations.index));
}

function describeRunSetup(runNumber: number, config: RunConfigSnapshot): string {
  return [
    `Run: ${runId(runNumber)}. Conversations: ${config.conversations}. Turns per conversation: up to ${config.turns}.`,
    `Agent A: model ${config.agentA.model}, effort ${config.agentA.effort}.`,
    `Agent B: model ${config.agentB.model}, effort ${config.agentB.effort}.`,
    `System prompt given to A: ${promptOrNone(config.resolved.systemPromptA)}`,
    `System prompt given to B: ${promptOrNone(config.resolved.systemPromptB)}`,
    `Opening message given to A: ${config.openingMessage}${
      config.attributeOpeningToB ? " (B's history starts as if B had written this message)" : ""
    }`,
    `Sign-off: ${config.signOff ? "on" : "off"}. Repetition: threshold ${config.repetitionThreshold}, action ${config.repetitionAction}. Max tokens per message: ${config.maxTokens}.`,
    "A spoke first. Turns are numbered from 1; odd turns are A, even turns are B.",
  ].join("\n");
}

/** The first message of the report writer's conversation. */
export async function buildReportPrompt(db: Db, reportIdValue: string): Promise<{ prompt: string; codedCount: number }> {
  const [row] = await db
    .select({ report: reports, version: analysisVersions, run: runs })
    .from(reports)
    .innerJoin(analysisVersions, eq(analysisVersions.id, reports.analysisVersionId))
    .innerJoin(runs, eq(runs.id, reports.runId))
    .where(eq(reports.id, reportIdValue));
  if (!row) throw new Error(`Report not found: ${reportIdValue}`);
  const { version, run } = row;
  const defs = version.fieldDefinitions as FieldDef[];
  const coded = (await loadRunCodings(db, run.id, version.id)).filter((c) => c.coding.status === "done" && c.coding.output);
  const measured = await loadMeasuredTurns(db, run.id);
  const aggs = aggregateFields(
    defs,
    coded.map((c) => ({ conversation: c.conversation.index, turnsCompleted: c.conversation.turnsCompleted, fields: c.coding.output!.fields })),
  );
  const prompt = fillTemplate(RUN_REPORT_PROMPT, {
    conversation_count: coded.length,
    analysis_focus: version.focus.trim() || "(none given)",
    run_setup: describeRunSetup(run.number, run.config),
    field_definitions: describeFields(defs),
    aggregates: `N = ${coded.length} coded conversations.\n${formatAggregates(aggs)}`,
    computed_measures: coded
      .map((c) => formatMeasuresLine(run.number, c.conversation.index, conversationMeasures(c.conversation, measured.get(c.conversation.id) ?? [])))
      .join("\n"),
    codings: coded
      .map((c) => formatCodingForReport(run.number, c.conversation.index, c.conversation.turnsCompleted, c.conversation.stopReason, c.coding.output!))
      .join("\n\n"),
    min_transcripts: Math.min(MIN_TRANSCRIPTS, coded.length),
  });
  return { prompt, codedCount: coded.length };
}

/**
 * The open_transcript tool. It only opens conversations in the given
 * experiment: anything else returns an error to the model.
 */
export async function openTranscript(
  db: Db,
  experimentIdValue: string,
  input: unknown,
  includeThinking: boolean,
): Promise<{ ok: true; text: string; opened: OpenedTranscript } | { ok: false; text: string }> {
  const i = (input ?? {}) as Record<string, unknown>;
  const runN = Number(i.run);
  const convN = Number(i.conversation);
  if (!Number.isInteger(runN) || !Number.isInteger(convN)) {
    return { ok: false, text: "Give run and conversation as whole numbers, for example {\"run\": 1, \"conversation\": 7}." };
  }
  const [conv] = await db
    .select({ conv: conversations })
    .from(conversations)
    .innerJoin(runs, eq(runs.id, conversations.runId))
    .where(and(eq(runs.experimentId, experimentIdValue), eq(runs.number, runN), eq(conversations.index, convN)));
  if (!conv) return { ok: false, text: `There is no conversation ${runId(runN)}·${conversationId(convN)} in this experiment.` };
  const transcript = await loadTranscript(db, conv.conv.id);
  const header = `Transcript ${runId(runN)}·${conversationId(convN)}: ${transcript.length} turns, status ${conv.conv.status}${
    conv.conv.stopReason ? `, stop reason ${conv.conv.stopReason}` : ""
  }.`;
  return {
    ok: true,
    text: `${header}\n\n${formatTranscript(transcript, { includeThinking })}`,
    opened: { run: runN, conversation: convN },
  };
}

type ReportRow = typeof reports.$inferSelect;

/** Runs the citation check against the experiment's stored turns. */
export async function checkReportCitations(db: Db, experimentIdValue: string, markdown: string) {
  const runRows = await db.select({ id: runs.id, number: runs.number }).from(runs).where(eq(runs.experimentId, experimentIdValue));
  const texts = new Map<string, string>();
  if (runRows.length) {
    const rows = await db
      .select({ run: runs.number, conv: conversations.index, turn: turns.turnNumber, text: turns.text })
      .from(turns)
      .innerJoin(conversations, eq(conversations.id, turns.conversationId))
      .innerJoin(runs, eq(runs.id, conversations.runId))
      .where(eq(runs.experimentId, experimentIdValue));
    for (const r of rows) texts.set(`${r.run}|${r.conv}|${r.turn}`, r.text);
  }
  return checkCitations(markdown, (r, c, t) => texts.get(`${r}|${c}|${t}`));
}

/**
 * One step of the report writer: exactly one model call, then any tool calls
 * it asked for (database reads only), all saved before returning. Returns
 * true when the report is finished (done or errored).
 */
export async function reportStep(db: Db, reportIdValue: string, judge: JudgeClient): Promise<boolean> {
  const [row] = await db
    .select({ report: reports, version: analysisVersions, experimentId: runs.experimentId })
    .from(reports)
    .innerJoin(analysisVersions, eq(analysisVersions.id, reports.analysisVersionId))
    .innerJoin(runs, eq(runs.id, reports.runId))
    .where(eq(reports.id, reportIdValue));
  if (!row) throw new Error(`Report not found: ${reportIdValue}`);
  const report: ReportRow = row.report;
  if (report.status === "done" || report.status === "errored") return true;

  const save = (patch: Partial<typeof reports.$inferInsert>) =>
    db.update(reports).set({ ...patch, updatedAt: sql`now()` }).where(eq(reports.id, reportIdValue));
  const fail = async (message: string, extra: Partial<typeof reports.$inferInsert> = {}) => {
    await save({ ...extra, status: "errored", error: message, finishedAt: sql`now()` as unknown as Date });
    return true;
  };

  let messages = report.messages;
  let minTranscripts = report.minTranscripts;
  if (messages.length === 0) {
    const { prompt, codedCount } = await buildReportPrompt(db, reportIdValue);
    if (codedCount === 0) return fail("No conversation was coded, so there is nothing to report.");
    messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    minTranscripts = Math.min(MIN_TRANSCRIPTS, codedCount);
    await save({ status: "running", messages, minTranscripts });
  }
  if (report.calls >= MAX_REPORT_CALLS) return fail(`The report writer made ${report.calls} calls without finishing.`);

  let res;
  try {
    res = await judge.call({
      model: report.model,
      messages,
      maxTokens: REPORT_MAX_TOKENS,
      effort: "high",
      tools: [OPEN_TRANSCRIPT_TOOL],
      purpose: "report",
    });
  } catch (err) {
    if (isTransientModelError(err)) throw err;
    return fail(`Report call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const total = addUsage(
    {
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      thinkingTokens: report.thinkingTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
    },
    res.usage,
  );
  const usage = { ...usageColumns(report.model, total), costUsd: report.costUsd + costUsd(report.model, res.usage), calls: report.calls + 1 };
  const assistant: AgentMessage = { role: "assistant", content: res.content };

  if (res.stopReason === "tool_use") {
    const results: ContentBlock[] = [];
    const opened = [...report.opened];
    for (const block of res.content.filter((b) => b.type === "tool_use")) {
      const call = block as unknown as { id: string; name: string; input: unknown };
      const r =
        call.name === OPEN_TRANSCRIPT_TOOL.name
          ? await openTranscript(db, row.experimentId, call.input, row.version.judgeReadsThinking)
          : { ok: false as const, text: `Unknown tool: ${call.name}` };
      if (r.ok && !opened.some((o) => o.run === r.opened.run && o.conversation === r.opened.conversation)) opened.push(r.opened);
      results.push({ type: "tool_result", tool_use_id: call.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
    }
    if (results.length === 0) return fail("The report writer asked for a tool but sent no tool call.", usage);
    await save({ ...usage, messages: [...messages, assistant, { role: "user", content: results }], opened });
    return false;
  }

  if (res.stopReason !== "end_turn") {
    return fail(`The report writer stopped with "${res.stopReason}".`, usage);
  }

  const text = visibleText(res.content).trim();
  const openedCount = report.opened.length;
  if (openedCount < minTranscripts && report.nudges < MAX_NUDGES) {
    const nudge = fillTemplate(RUN_REPORT_NUDGE, {
      opened: openedCount,
      min_transcripts: minTranscripts,
      remaining: minTranscripts - openedCount,
    });
    await save({ ...usage, nudges: report.nudges + 1, messages: [...messages, assistant, { role: "user", content: [{ type: "text", text: nudge }] }] });
    return false;
  }
  if (!text) return fail("The report writer finished without writing a report.", usage);

  const check = await checkReportCitations(db, row.experimentId, text);
  await save({
    ...usage,
    messages: [...messages, assistant],
    status: "done",
    content: text,
    warning:
      openedCount < minTranscripts
        ? `The report writer opened ${openedCount} of the ${minTranscripts} transcripts required, even after ${MAX_NUDGES} reminders.`
        : null,
    citationCheck: check,
    error: null,
    finishedAt: sql`now()` as unknown as Date,
  });
  return true;
}

export async function failReport(db: Db, reportIdValue: string, message: string, opts: { raw?: boolean } = {}): Promise<void> {
  await db
    .update(reports)
    .set({ status: "errored", error: opts.raw ? message : `API error after retries: ${message}`, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(reports.id, reportIdValue), inArray(reports.status, ["pending", "running"])));
}

/**
 * Analyzes a run in this process, with the same steps and lanes the workflow
 * uses. For tests and local tooling.
 */
export async function analyzeRunInProcess(
  db: Db,
  runIdValue: string,
  judge: JudgeClient,
  versionId: string | null = null,
): Promise<AnalysisPlan> {
  const plan = await prepareAnalysis(db, runIdValue, versionId);
  const lanes: string[][] = Array.from({ length: Math.max(1, Math.min(plan.concurrency, plan.codingIds.length)) }, () => []);
  plan.codingIds.forEach((id, i) => lanes[i % lanes.length].push(id));
  await Promise.all(
    lanes.map(async (lane) => {
      for (const id of lane) {
        try {
          await codeConversation(db, id, judge);
        } catch (err) {
          await failCoding(db, id, err instanceof Error ? err.message : String(err));
        }
      }
    }),
  );
  if (plan.reportId) {
    try {
      while (!(await reportStep(db, plan.reportId, judge))) {
        /* one model call per iteration */
      }
    } catch (err) {
      await failReport(db, plan.reportId, err instanceof Error ? err.message : String(err));
    }
  }
  return plan;
}

export type { CodingOutput };
