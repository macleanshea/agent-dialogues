/**
 * The comparison report (PR 4): two or more runs of one experiment,
 * contrasted by a report writer that sees the runs only as Run X, Run Y, ...
 * (assigned at random) and never sees a model name.
 *
 * Blinding works in two layers:
 *   1. Run identities: every run ID is replaced by its random letter, in the
 *      setups, codings, measures, and transcripts.
 *   2. Model names: every text the writer receives goes through
 *      maskModelNames (mask.ts), and model settings are written as [model].
 * The prompt template itself names no model or maker. A test checks every
 * message the writer receives.
 *
 * Like service.ts, each function takes the database and model client as
 * arguments; the workflow (src/workflows/comparison.ts) and tests share it.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { RunConfigSnapshot } from "../config";
import type { Db } from "../db";
import {
  analysisVersions,
  codings,
  comparisons,
  conversations,
  experiments,
  runs,
  turns,
  type ComparisonLabel,
  type OpenedTranscript,
} from "../db/schema";
import { visibleText } from "../engine/history";
import { isTransientModelError, type AgentMessage, type ContentBlock } from "../engine/types";
import { normalizeVariables, pathsFor, variableLabel, variableValue, VARIABLES, type VariableKey } from "../experiments/variables";
import { conversationId, runId } from "../ids";
import { EFFORT_LABELS, addUsage, costUsd, type TokenUsage } from "../models";
import { checkCitations, type CitationCheckResult } from "./citations";
import { aggregateFields, describeFields, type FieldDef } from "./fields";
import { formatAggregates, formatCodingForReport, formatMeasuresLine, formatTranscript, promptOrNone } from "./format";
import type { JudgeClient } from "./judge";
import { MODEL_MASK, maskModelNames } from "./mask";
import { conversationMeasures, type ConversationMeasures, type MeasuredTurn } from "./measures";
import { COMPARISON_NUDGE, COMPARISON_PROMPT, COMPARISON_TRANSCRIPT_TOOL, fillTemplate } from "./prompts";
import { loadMeasuredTurns, loadRunCodings } from "./service";

/** Letters for the runs, in the order they are handed out (then shuffled). */
export const RUN_LETTERS = ["X", "Y", "Z", "W", "V", "U", "T", "S"] as const;
export const MAX_COMPARED_RUNS = RUN_LETTERS.length;
/** Transcripts the writer must open from each run (or all of a run's coded conversations, if fewer). */
export const MIN_PER_RUN = 2;
export const MAX_COMPARISON_NUDGES = 2;
export const MAX_COMPARISON_CALLS = 30;
export const COMPARISON_MAX_TOKENS = 64_000;

const FINISHED = ["done", "stopped", "failed"] as const;

export type ComparisonRow = typeof comparisons.$inferSelect;

/** Hands each run a letter at random. Exported for tests. */
export function assignLabels<T extends { runNumber: number }>(items: T[], rng: () => number = Math.random): Array<T & { label: string }> {
  const letters: string[] = RUN_LETTERS.slice(0, items.length);
  // Fisher–Yates shuffle.
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return items.map((it, i) => ({ ...it, label: letters[i] }));
}

export type CreateComparisonResult = { ok: true; id: string; number: number } | { ok: false; message: string };

/**
 * Creates a comparison of the given runs (by number) under the experiment's
 * latest analysis version. Every run must have finished and been coded.
 */
export async function createComparison(
  db: Db,
  experimentIdValue: string,
  runNumbers: number[],
  rng: () => number = Math.random,
): Promise<CreateComparisonResult> {
  const wanted = [...new Set(runNumbers)].sort((a, b) => a - b);
  if (wanted.length < 2) return { ok: false, message: "Tick two or more runs to compare." };
  if (wanted.length > MAX_COMPARED_RUNS) return { ok: false, message: `At most ${MAX_COMPARED_RUNS} runs can be compared at once.` };

  const [version] = await db
    .select()
    .from(analysisVersions)
    .where(eq(analysisVersions.experimentId, experimentIdValue))
    .orderBy(desc(analysisVersions.version))
    .limit(1);
  if (!version) return { ok: false, message: "This experiment has no analysis version." };

  const rows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.experimentId, experimentIdValue), inArray(runs.number, wanted)))
    .orderBy(asc(runs.number));
  const missing = wanted.filter((n) => !rows.some((r) => r.number === n));
  if (missing.length) return { ok: false, message: `${missing.map(runId).join(", ")} is not in this experiment.` };

  const items: Array<{ runId: string; runNumber: number; required: number }> = [];
  for (const r of rows) {
    if (!FINISHED.includes(r.status as (typeof FINISHED)[number])) {
      return { ok: false, message: `${runId(r.number)} has not finished yet (${r.status}). Compare runs once they are done.` };
    }
    const [c] = await db
      .select({
        done: sql<number>`count(*) filter (where ${codings.status} = 'done')::int`,
        waiting: sql<number>`count(*) filter (where ${codings.status} in ('pending', 'running'))::int`,
      })
      .from(codings)
      .innerJoin(conversations, eq(conversations.id, codings.conversationId))
      .where(and(eq(codings.analysisVersionId, version.id), eq(conversations.runId, r.id)));
    if (Number(c?.waiting ?? 0) > 0) {
      return { ok: false, message: `${runId(r.number)} is still being coded under analysis v${version.version}. Compare once its coding finishes.` };
    }
    const done = Number(c?.done ?? 0);
    if (done === 0) return { ok: false, message: `${runId(r.number)} has no coded conversations under analysis v${version.version}.` };
    items.push({ runId: r.id, runNumber: r.number, required: Math.min(MIN_PER_RUN, done) });
  }
  const labels: ComparisonLabel[] = assignLabels(items, rng);

  return db.transaction(async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${comparisons.number}), 0)` })
      .from(comparisons)
      .where(eq(comparisons.experimentId, experimentIdValue));
    const [row] = await tx
      .insert(comparisons)
      .values({
        experimentId: experimentIdValue,
        number: Number(max) + 1,
        analysisVersionId: version.id,
        labels,
        model: version.reportModel,
        minPerRun: MIN_PER_RUN,
      })
      .returning({ id: comparisons.id, number: comparisons.number });
    await tx.update(experiments).set({ updatedAt: sql`now()` }).where(eq(experiments.id, experimentIdValue));
    return { ok: true as const, id: row.id, number: row.number };
  });
}

// ---------- What the writer sees (all masked) ----------

const MODEL_KEYS: VariableKey[] = ["agentA.model", "agentB.model"];

function maskedValue(key: VariableKey, c: RunConfigSnapshot): string {
  if (MODEL_KEYS.includes(key)) return MODEL_MASK;
  return maskModelNames(variableValue(key, c, { short: false }));
}

/**
 * The settings every compared run shares. Model settings are always [model];
 * settings that vary are pointed to each run's own setup.
 */
export function describeSharedSetup(c: RunConfigSnapshot, variables: VariableKey[]): string {
  const varies = new Set(variables.flatMap(pathsFor));
  const v = (path: string, text: string) => (varies.has(path) ? "(differs between runs; see each run)" : maskModelNames(text));
  const sysB = c.agentB.sameAsA ? `${promptOrNone(c.resolved.systemPromptB)} (same as A)` : promptOrNone(c.resolved.systemPromptB);
  return [
    `Conversations per run: ${c.conversations}. Turns per conversation: up to ${v("turns", String(c.turns))}.`,
    `Agent A: model ${MODEL_MASK}, effort ${v("agentA.effort", EFFORT_LABELS[c.agentA.effort])}.`,
    `Agent B: model ${MODEL_MASK}, effort ${v("agentB.effort", EFFORT_LABELS[c.agentB.effort])}.`,
    `System prompt given to A: ${v("agentA.systemPrompt", promptOrNone(c.resolved.systemPromptA))}`,
    `System prompt given to B: ${varies.has("agentA.systemPrompt") && c.agentB.sameAsA ? "(same as A; differs between runs)" : v("agentB.systemPrompt", sysB)}`,
    `Opening message given to A: ${v("openingMessage", c.openingMessage)}`,
    `Opening message attributed to B: ${v("attributeOpeningToB", c.attributeOpeningToB ? "yes (B's history starts as if B had written it)" : "no")}`,
    `Sign-off: ${v("signOff", c.signOff ? "on" : "off")}. Repetition rule: ${v("repetitionThreshold", `threshold ${c.repetitionThreshold}, action ${c.repetitionAction}`)}. Max tokens per message: ${v("maxTokens", String(c.maxTokens))}.`,
    "A spoke first. Turns are numbered from 1; odd turns are A, even turns are B.",
  ].join("\n");
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round = (x: number, digits: number) => Number(x.toFixed(digits));

/** One measure's median and range across a run's conversations, e.g. "median 18 (range 12 to 30)". */
export function spreadLine(label: string, values: number[], digits = 0): string {
  if (values.length === 0) return `${label}: no values.`;
  const m = median(values)!;
  return `${label}: median ${round(m, digits)} (range ${round(Math.min(...values), digits)} to ${round(Math.max(...values), digits)}; ${values.length} conversations).`;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The within-run spread of the computed measures, one line per measure. */
export function measureSpread(convs: Array<{ measures: ConversationMeasures; turns: MeasuredTurn[] }>): string {
  const per = <T>(f: (c: (typeof convs)[number]) => T | null) => convs.map(f).filter((x): x is T => x !== null);
  const avgOf = (ts: MeasuredTurn[], f: (t: MeasuredTurn) => number | null) => mean(ts.map(f).filter((x): x is number => x !== null));
  return [
    spreadLine("Turns completed", per((c) => c.measures.turnsCompleted)),
    spreadLine("Mean visible length per turn (characters)", per((c) => avgOf(c.turns, (t) => t.text.length))),
    spreadLine("Mean self-repetition per turn (0 to 1)", per((c) => avgOf(c.turns, (t) => t.repetition)), 2),
    spreadLine("Mean cross-speaker similarity per turn (0 to 1)", per((c) => avgOf(c.turns, (t) => t.crossSimilarity)), 2),
    spreadLine("Mean emoji and symbol count per turn", per((c) => avgOf(c.turns, (t) => t.emojiCount)), 1),
    spreadLine("Share of turns naming a model or maker", per((c) => avgOf(c.turns, (t) => (t.modelMentions?.length ? 1 : 0))), 2),
    spreadLine("Truncated messages", per((c) => c.measures.truncatedCount)),
    spreadLine("Empty replies", per((c) => c.measures.emptyReplyCount)),
    spreadLine("Thinking tokens, A", per((c) => c.measures.bySpeaker.A.thinkingTokens)),
    spreadLine("Thinking tokens, B", per((c) => c.measures.bySpeaker.B.thinkingTokens)),
  ].join("\n");
}

async function loadComparison(db: Db, comparisonIdValue: string) {
  const [row] = await db
    .select({ comparison: comparisons, version: analysisVersions, experiment: experiments })
    .from(comparisons)
    .innerJoin(analysisVersions, eq(analysisVersions.id, comparisons.analysisVersionId))
    .innerJoin(experiments, eq(experiments.id, comparisons.experimentId))
    .where(eq(comparisons.id, comparisonIdValue));
  if (!row) throw new Error(`Comparison not found: ${comparisonIdValue}`);
  return row;
}

/** The first message of the comparison writer's conversation. Every inserted value is masked. */
export async function buildComparisonPrompt(db: Db, comparisonIdValue: string): Promise<string> {
  const { comparison, version, experiment } = await loadComparison(db, comparisonIdValue);
  const defs = version.fieldDefinitions as FieldDef[];
  const variables = normalizeVariables(experiment.declaredVariables);
  const runRows = await db
    .select()
    .from(runs)
    .where(inArray(runs.id, comparison.labels.map((l) => l.runId)));
  // Shown to the writer in letter order, so the order says nothing about run numbers.
  const ordered = [...comparison.labels].sort((a, b) => a.label.localeCompare(b.label));
  const baseline = runRows.find((r) => r.number === 1) ?? runRows.sort((a, b) => a.number - b.number)[0];
  const sameAsA = baseline.config.agentB.sameAsA;

  const blocks: string[] = [];
  for (const l of ordered) {
    const run = runRows.find((r) => r.id === l.runId)!;
    const coded = (await loadRunCodings(db, run.id, version.id)).filter((c) => c.coding.status === "done" && c.coding.output);
    const measured = await loadMeasuredTurns(db, run.id);
    const aggs = aggregateFields(
      defs,
      coded.map((c) => ({ conversation: c.conversation.index, turnsCompleted: c.conversation.turnsCompleted, fields: c.coding.output!.fields })),
    );
    const convs = coded.map((c) => {
      const ts = measured.get(c.conversation.id) ?? [];
      return { index: c.conversation.index, measures: conversationMeasures(c.conversation, ts), turns: ts };
    });
    const setup = variables.length
      ? variables.map((k) => `${VARIABLES.find((v) => v.key === k)!.label}: ${maskedValue(k, run.config)}`).join("\n")
      : "(No declared variable.)";
    blocks.push(
      [
        `<run name="Run ${l.label}">`,
        `<setup>\n${setup}\n</setup>`,
        `<aggregates>\nN = ${coded.length} coded conversations.\n${formatAggregates(aggs)}\n</aggregates>`,
        `<measure_spread>\n${measureSpread(convs)}\n</measure_spread>`,
        `<computed_measures>\n${convs.map((c) => formatMeasuresLine(l.label, c.index, c.measures)).join("\n")}\n</computed_measures>`,
        `<codings>\n${coded
          .map((c) => formatCodingForReport(l.label, c.conversation.index, c.conversation.turnsCompleted, c.conversation.stopReason, c.coding.output!))
          .join("\n\n")}\n</codings>`,
        `</run>`,
      ].join("\n"),
    );
  }

  const vars = {
    run_count: ordered.length,
    run_names: ordered.map((l) => `Run ${l.label}`).join(", "),
    analysis_focus: version.focus.trim() || "(none given)",
    declared_variable: variables.length ? variableLabel(variables, sameAsA) : "(none declared)",
    shared_setup: describeSharedSetup(baseline.config, variables),
    field_definitions: describeFields(defs),
    runs: blocks.join("\n\n"),
    min_per_run: comparison.minPerRun,
    min_transcripts: comparison.labels.reduce((s, l) => s + l.required, 0),
  };
  // Mask every inserted value, whatever it is, as a last layer.
  const masked = Object.fromEntries(Object.entries(vars).map(([k, val]) => [k, typeof val === "string" ? maskModelNames(val) : val]));
  return fillTemplate(COMPARISON_PROMPT, masked);
}

/**
 * The comparison's open_transcript tool: opens a conversation in one of the
 * compared runs only, by its letter, masked.
 */
export async function openMaskedTranscript(
  db: Db,
  comparison: Pick<ComparisonRow, "labels">,
  input: unknown,
  includeThinking: boolean,
): Promise<{ ok: true; text: string; opened: OpenedTranscript } | { ok: false; text: string }> {
  const i = (input ?? {}) as Record<string, unknown>;
  const letter = String(i.run ?? "")
    .trim()
    .replace(/^run\s+/i, "")
    .toUpperCase();
  const convN = Number(i.conversation);
  const label = comparison.labels.find((l) => l.label === letter);
  const names = comparison.labels.map((l) => l.label).sort().join(", ");
  if (!label) return { ok: false, text: `There is no Run ${letter || "?"}. The runs are ${names}.` };
  if (!Number.isInteger(convN)) return { ok: false, text: 'Give the conversation as a whole number, for example {"run": "X", "conversation": 7}.' };
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.runId, label.runId), eq(conversations.index, convN)));
  if (!conv) return { ok: false, text: `There is no conversation ${label.label}·${conversationId(convN)}.` };
  const rows = await db
    .select({ turnNumber: turns.turnNumber, speaker: turns.speaker, text: turns.text, thinkingSummary: turns.thinkingSummary })
    .from(turns)
    .where(eq(turns.conversationId, conv.id))
    .orderBy(asc(turns.turnNumber));
  const header = `Transcript ${label.label}·${conversationId(convN)}: ${rows.length} turns, status ${conv.status}${
    conv.stopReason ? `, stop reason ${conv.stopReason}` : ""
  }.`;
  return {
    ok: true,
    text: maskModelNames(`${header}\n\n${formatTranscript(rows, { includeThinking })}`),
    opened: { run: label.runNumber, conversation: convN },
  };
}

/**
 * Unmasks the run labels once the report is written: "Run X" becomes "R2",
 * and citations X·C07·T12 become R2·C07·T12. Model names inside quotes stay
 * as [model], since that is what the writer saw.
 */
export function unmaskRuns(markdown: string, labels: Pick<ComparisonLabel, "label" | "runNumber">[]): string {
  const by = new Map(labels.map((l) => [l.label, l.runNumber]));
  return markdown
    .replace(/\bRuns? ([A-Z])\b/g, (m, l: string) => (by.has(l) ? runId(by.get(l)!) : m))
    .replace(/\b([A-Z])·C(\d+)/g, (m, l: string, c: string) => (by.has(l) ? `${runId(by.get(l)!)}·C${c}` : m));
}

/**
 * The citation check for a comparison: citations must point at turns of the
 * compared runs, and quotes are checked against the masked text the writer saw.
 */
export async function checkComparisonCitations(db: Db, labels: ComparisonLabel[], markdown: string): Promise<CitationCheckResult> {
  const rows = await db
    .select({ run: runs.number, conv: conversations.index, turn: turns.turnNumber, text: turns.text })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .innerJoin(runs, eq(runs.id, conversations.runId))
    .where(inArray(runs.id, labels.map((l) => l.runId)));
  const texts = new Map(rows.map((r) => [`${r.run}|${r.conv}|${r.turn}`, r.text]));
  return checkCitations(markdown, (r, c, t) => {
    const text = texts.get(`${r}|${c}|${t}`);
    return text === undefined ? undefined : maskModelNames(text);
  });
}

/** Which runs still need transcripts opened, as "Run X (1 more)". */
export function stillNeeded(labels: ComparisonLabel[], opened: OpenedTranscript[]): string[] {
  return [...labels]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((l) => ({ l, missing: l.required - opened.filter((o) => o.run === l.runNumber).length }))
    .filter((x) => x.missing > 0)
    .map((x) => `Run ${x.l.label} (${x.missing} more)`);
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
 * One step of the comparison writer: exactly one model call, then any
 * transcripts it asked for, all saved before returning. Returns true when the
 * comparison is finished (done or errored).
 */
export async function comparisonStep(db: Db, comparisonIdValue: string, judge: JudgeClient): Promise<boolean> {
  const { comparison: c, version } = await loadComparison(db, comparisonIdValue);
  if (c.status === "done" || c.status === "errored") return true;

  const save = (patch: Partial<typeof comparisons.$inferInsert>) =>
    db.update(comparisons).set({ ...patch, updatedAt: sql`now()` }).where(eq(comparisons.id, comparisonIdValue));
  const fail = async (message: string, extra: Partial<typeof comparisons.$inferInsert> = {}) => {
    await save({ ...extra, status: "errored", error: message, finishedAt: sql`now()` as unknown as Date });
    return true;
  };

  let messages = c.messages;
  if (messages.length === 0) {
    messages = [{ role: "user", content: [{ type: "text", text: await buildComparisonPrompt(db, comparisonIdValue) }] }];
    await save({ status: "running", messages });
  }
  if (c.calls >= MAX_COMPARISON_CALLS) return fail(`The comparison writer made ${c.calls} calls without finishing.`);

  let res;
  try {
    res = await judge.call({
      model: c.model,
      messages,
      maxTokens: COMPARISON_MAX_TOKENS,
      effort: "high",
      tools: [COMPARISON_TRANSCRIPT_TOOL],
      purpose: "comparison",
    });
  } catch (err) {
    if (isTransientModelError(err)) throw err;
    return fail(`Comparison call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const total = addUsage(
    {
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      thinkingTokens: c.thinkingTokens,
      cacheReadTokens: c.cacheReadTokens,
      cacheWriteTokens: c.cacheWriteTokens,
    },
    res.usage,
  );
  const usage = { ...usageColumns(c.model, total), costUsd: c.costUsd + costUsd(c.model, res.usage), calls: c.calls + 1 };
  const assistant: AgentMessage = { role: "assistant", content: res.content };

  if (res.stopReason === "tool_use") {
    const results: ContentBlock[] = [];
    const opened = [...c.opened];
    for (const block of res.content.filter((b) => b.type === "tool_use")) {
      const call = block as unknown as { id: string; name: string; input: unknown };
      const r =
        call.name === COMPARISON_TRANSCRIPT_TOOL.name
          ? await openMaskedTranscript(db, c, call.input, version.judgeReadsThinking)
          : { ok: false as const, text: `Unknown tool: ${call.name}` };
      if (r.ok && !opened.some((o) => o.run === r.opened.run && o.conversation === r.opened.conversation)) opened.push(r.opened);
      results.push({ type: "tool_result", tool_use_id: call.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
    }
    if (results.length === 0) return fail("The comparison writer asked for a tool but sent no tool call.", usage);
    await save({ ...usage, messages: [...messages, assistant, { role: "user", content: results }], opened });
    return false;
  }

  if (res.stopReason !== "end_turn") return fail(`The comparison writer stopped with "${res.stopReason}".`, usage);

  const text = visibleText(res.content).trim();
  const needed = stillNeeded(c.labels, c.opened);
  if (needed.length && c.nudges < MAX_COMPARISON_NUDGES) {
    const nudge = fillTemplate(COMPARISON_NUDGE, { min_per_run: c.minPerRun, still_needed: needed.join(", ") });
    await save({ ...usage, nudges: c.nudges + 1, messages: [...messages, assistant, { role: "user", content: [{ type: "text", text: nudge }] }] });
    return false;
  }
  if (!text) return fail("The comparison writer finished without writing a report.", usage);

  const content = unmaskRuns(text, c.labels);
  const check = await checkComparisonCitations(db, c.labels, content);
  await save({
    ...usage,
    messages: [...messages, assistant],
    status: "done",
    maskedContent: text,
    content,
    warning: needed.length
      ? `The writer did not open enough transcripts, even after ${MAX_COMPARISON_NUDGES} reminders. Still missing: ${needed.join(", ")}.`
      : null,
    citationCheck: check,
    error: null,
    finishedAt: sql`now()` as unknown as Date,
  });
  return true;
}

export async function failComparison(db: Db, comparisonIdValue: string, message: string, opts: { raw?: boolean } = {}): Promise<void> {
  await db
    .update(comparisons)
    .set({ status: "errored", error: opts.raw ? message : `API error after retries: ${message}`, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(comparisons.id, comparisonIdValue), inArray(comparisons.status, ["pending", "running"])));
}

/** Writes a comparison in this process, one call per iteration. For tests. */
export async function compareInProcess(db: Db, comparisonIdValue: string, judge: JudgeClient): Promise<void> {
  try {
    while (!(await comparisonStep(db, comparisonIdValue, judge))) {
      /* one model call per iteration */
    }
  } catch (err) {
    await failComparison(db, comparisonIdValue, err instanceof Error ? err.message : String(err));
  }
}

export async function getComparisonPage(db: Db, experimentNumber: number, comparisonNumber: number) {
  const [row] = await db
    .select({ comparison: comparisons, experiment: experiments, version: analysisVersions })
    .from(comparisons)
    .innerJoin(experiments, eq(experiments.id, comparisons.experimentId))
    .innerJoin(analysisVersions, eq(analysisVersions.id, comparisons.analysisVersionId))
    .where(and(eq(experiments.number, experimentNumber), eq(comparisons.number, comparisonNumber)));
  if (!row) return null;
  const runRows = await db
    .select()
    .from(runs)
    .where(inArray(runs.id, row.comparison.labels.map((l) => l.runId)))
    .orderBy(asc(runs.number));
  return { ...row, runs: runRows };
}
