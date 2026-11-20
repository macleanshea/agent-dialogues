/**
 * Export to JSON and Markdown (PR 5), for one experiment or one run.
 *
 * Both formats are produced as a sequence of text chunks, one conversation at
 * a time, so a large run never has to sit in memory at once and the download
 * can be streamed (see the route handlers under src/app/experiments/[exp]/).
 *
 * - JSON is the complete record: every setting, every analysis version, and
 *   for every turn the raw content blocks exactly as returned, the usage, and
 *   the computed measures; codings and reports under every analysis version.
 * - Markdown is for reading: the settings, the run report, and each
 *   transcript with its coding, under one analysis version (the latest, or
 *   the one asked for).
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db";
import {
  analysisVersions,
  codings,
  comparisons,
  conversations,
  experiments,
  reports,
  runs,
  turns,
} from "./db/schema";
import { formatValue, slotsFor, type CodingOutput, type FieldDef } from "./analysis/fields";
import { STOP_REASON_TEXT } from "./analysis/labels";
import { variableLabel, variableValues } from "./experiments/variables";
import { conversationId, experimentId, runId } from "./ids";
import { EFFORT_LABELS, modelLabel } from "./models";
import type { ConversationStopReason } from "./engine/types";

export const EXPORT_FORMAT = "agent-dialogues-export";
export const EXPORT_VERSION = 1;

export type ExportFormat = "json" | "md";

type ExperimentRow = typeof experiments.$inferSelect;
type RunRow = typeof runs.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type VersionRow = typeof analysisVersions.$inferSelect;

export interface ExportTarget {
  experiment: ExperimentRow;
  /** One run, or every run in the experiment. */
  runs: RunRow[];
  versions: VersionRow[];
  scope: "experiment" | "run";
  /** "EXP-004" or "EXP-004-R2", for the file name. */
  baseName: string;
}

/** Finds what to export: an experiment, or one run of it. Null if it does not exist. */
export async function findExportTarget(db: Db, experimentNumber: number, runNumber: number | null): Promise<ExportTarget | null> {
  const [experiment] = await db.select().from(experiments).where(eq(experiments.number, experimentNumber));
  if (!experiment) return null;
  const runRows = await db
    .select()
    .from(runs)
    .where(runNumber ? and(eq(runs.experimentId, experiment.id), eq(runs.number, runNumber)) : eq(runs.experimentId, experiment.id))
    .orderBy(asc(runs.number));
  if (runNumber && runRows.length === 0) return null;
  const versions = await db
    .select()
    .from(analysisVersions)
    .where(eq(analysisVersions.experimentId, experiment.id))
    .orderBy(asc(analysisVersions.version));
  const baseName = runNumber ? `${experimentId(experiment.number)}-${runId(runNumber)}` : experimentId(experiment.number);
  return { experiment, runs: runRows, versions, baseName, scope: runNumber ? "run" : "experiment" };
}

/** The file to download, e.g. "EXP-004-R2.json". */
export function exportFileName(t: ExportTarget, format: ExportFormat): string {
  return `${t.baseName}.${format}`;
}

async function conversationsOf(db: Db, runIdValue: string): Promise<ConversationRow[]> {
  return db.select().from(conversations).where(eq(conversations.runId, runIdValue)).orderBy(asc(conversations.index));
}

async function turnsOf(db: Db, conversationIdValue: string) {
  return db.select().from(turns).where(eq(turns.conversationId, conversationIdValue)).orderBy(asc(turns.turnNumber));
}

async function codingsOf(db: Db, conversationIdValue: string) {
  return db.select().from(codings).where(eq(codings.conversationId, conversationIdValue));
}

const versionNumber = (versions: VersionRow[], id: string) => versions.find((v) => v.id === id)?.version ?? null;

// ---------- JSON ----------

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** The export as JSON, in chunks. Concatenated, the chunks are one JSON document. */
export async function* exportJson(db: Db, t: ExportTarget, exportedAt = new Date()): AsyncGenerator<string> {
  const e = t.experiment;
  const head = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    scope: t.scope,
    experiment: {
      id: experimentId(e.number),
      number: e.number,
      name: e.name,
      analysisFocus: e.analysisFocus,
      declaredVariables: e.declaredVariables,
      variable: variableLabel(e.declaredVariables, e.sharedSettings?.agentB.sameAsA ?? false) || null,
      locked: e.locked,
      sharedSettings: e.sharedSettings,
      createdAt: iso(e.createdAt),
      updatedAt: iso(e.updatedAt),
    },
    analysisVersions: t.versions.map((v) => ({
      version: v.version,
      focus: v.focus,
      fields: v.fieldDefinitions,
      summarizerModel: v.summarizerModel,
      reportModel: v.reportModel,
      judgeReadsThinking: v.judgeReadsThinking,
      promptVersions: v.promptVersions,
      createdAt: iso(v.createdAt),
    })),
  };
  // Open the document, leaving the runs array open.
  yield `${JSON.stringify(head, null, 2).replace(/\n}$/, "")},\n  "runs": [`;

  for (const [ri, r] of t.runs.entries()) {
    const runReports = await db.select().from(reports).where(eq(reports.runId, r.id));
    const runHead = {
      id: runId(r.number),
      number: r.number,
      status: r.status,
      variableValue: e.declaredVariables.length ? variableValues(e.declaredVariables, r.config) : null,
      modelA: r.modelA,
      modelB: r.modelB,
      config: r.config,
      configDiff: r.configDiff,
      costUsd: r.costUsd,
      retriedCostUsd: r.retriedCostUsd,
      error: r.error,
      createdAt: iso(r.createdAt),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      reports: runReports
        .map((rep) => ({
          analysisVersion: versionNumber(t.versions, rep.analysisVersionId),
          status: rep.status,
          model: rep.model,
          content: rep.content,
          warning: rep.warning,
          error: rep.error,
          opened: rep.opened,
          citationCheck: rep.citationCheck,
          costUsd: rep.costUsd,
          finishedAt: iso(rep.finishedAt),
        }))
        .sort((a, b) => (a.analysisVersion ?? 0) - (b.analysisVersion ?? 0)),
    };
    yield `${ri > 0 ? "," : ""}\n    ${JSON.stringify(runHead).replace(/}$/, "")},"conversations":[`;

    for (const [ci, c] of (await conversationsOf(db, r.id)).entries()) {
      const rows = await turnsOf(db, c.id);
      const codingRows = await codingsOf(db, c.id);
      const conv = {
        id: conversationId(c.index),
        index: c.index,
        status: c.status,
        stopReason: c.stopReason,
        error: c.error,
        turnsCompleted: c.turnsCompleted,
        retries: c.retries,
        repetitionFlagTurn: c.repetitionFlagTurn,
        usage: {
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          thinkingTokens: c.thinkingTokens,
          cacheReadTokens: c.cacheReadTokens,
          cacheWriteTokens: c.cacheWriteTokens,
        },
        costUsd: c.costUsd,
        startedAt: iso(c.startedAt),
        finishedAt: iso(c.finishedAt),
        turns: rows.map((x) => ({
          turn: x.turnNumber,
          speaker: x.speaker,
          model: x.model,
          text: x.text,
          thinkingSummary: x.thinkingSummary,
          content: x.content,
          stopReason: x.stopReason,
          usage: x.usage,
          costUsd: x.costUsd,
          truncated: x.truncated,
          placeholderUsed: x.placeholderUsed,
          attempts: x.attempts,
          maxTokensUsed: x.maxTokensUsed,
          signedOff: x.signedOff,
          measures: {
            repetition: x.repetition,
            crossSimilarity: x.crossSimilarity,
            emojiCount: x.emojiCount,
            modelMentions: x.modelMentions,
            visibleLength: x.text.length,
          },
          createdAt: iso(x.createdAt),
        })),
        codings: codingRows
          .map((k) => ({
            analysisVersion: versionNumber(t.versions, k.analysisVersionId),
            status: k.status,
            model: k.model,
            output: k.output,
            error: k.error,
            costUsd: k.costUsd,
          }))
          .sort((a, b) => (a.analysisVersion ?? 0) - (b.analysisVersion ?? 0)),
      };
      yield `${ci > 0 ? "," : ""}\n      ${JSON.stringify(conv)}`;
    }
    yield "]}";
  }
  yield "\n  ]";

  // Comparisons only belong to a whole-experiment export.
  if (t.scope === "experiment") {
    const comps = await db.select().from(comparisons).where(eq(comparisons.experimentId, e.id)).orderBy(asc(comparisons.number));
    const out = comps.map((c) => ({
      number: c.number,
      analysisVersion: versionNumber(t.versions, c.analysisVersionId),
      runs: c.labels.map((l) => ({ run: runId(l.runNumber), label: `Run ${l.label}` })),
      status: c.status,
      model: c.model,
      content: c.content,
      maskedContent: c.maskedContent,
      warning: c.warning,
      error: c.error,
      citationCheck: c.citationCheck,
      costUsd: c.costUsd,
      finishedAt: iso(c.finishedAt),
    }));
    yield `,\n  "comparisons": ${JSON.stringify(out)}`;
  }
  yield "\n}\n";
}

// ---------- Markdown ----------

/** Puts text in a fenced block that its own content cannot close. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function promptOrNone(s: string): string {
  return s.trim() ? fenced(s) : "_None (no system prompt sent)_";
}

function usd(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

function stopReason(r: ConversationStopReason | null): string {
  return r ? (STOP_REASON_TEXT[r] ?? r) : "—";
}

function configMarkdown(r: RunRow): string {
  const c = r.config;
  const lines = [
    `- Agent A: ${modelLabel(c.agentA.model)} (\`${c.agentA.model}\`), effort ${EFFORT_LABELS[c.agentA.effort]}`,
    `- Agent B: ${modelLabel(c.agentB.model)} (\`${c.agentB.model}\`), effort ${EFFORT_LABELS[c.agentB.effort]}`,
    `- Turns: ${c.turns} · Max tokens per message: ${c.maxTokens} · Conversations: ${c.conversations} · Concurrency: ${c.concurrency}`,
    `- Sign-off: ${c.signOff ? "on" : "off"} · Repetition: threshold ${c.repetitionThreshold}, ${c.repetitionAction}`,
    `- Opening message attributed to B: ${c.attributeOpeningToB ? "yes" : "no"}`,
    `- Cost ceiling: ${usd(c.costCeilingUsd)} · Cost: ${usd(r.costUsd)}${r.retriedCostUsd > 0 ? ` (including ${usd(r.retriedCostUsd)} on retried attempts)` : ""}`,
    "",
    "System prompt sent to A:",
    "",
    promptOrNone(c.resolved.systemPromptA),
    "",
    `System prompt sent to B${c.agentB.sameAsA ? " (same as A)" : ""}:`,
    "",
    promptOrNone(c.resolved.systemPromptB),
    "",
    "Opening message to A:",
    "",
    fenced(c.openingMessage),
  ];
  return lines.join("\n");
}

function codingMarkdown(output: CodingOutput, defs: FieldDef[]): string {
  const out: string[] = [`**Summary.** ${output.summary}`];
  if (output.focusFindings.length) {
    out.push("", "**Focus findings.**", ...output.focusFindings.map((f) => `- ${f.finding}${f.turns.length ? ` [${f.turns.join(", ")}]` : ""}`));
  }
  if (output.notable) out.push("", `**Notable.** ${output.notable}`);
  const rows: string[] = [];
  for (const d of defs) {
    const stored = output.fields[d.name];
    if (!stored) continue;
    for (const slot of slotsFor(d.scope)) {
      const entry = stored[slot];
      if (!entry) continue;
      const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
      const name = slot === "all" ? d.name : `${d.name} (${slot})`;
      rows.push(`| ${cell(name)} | ${cell(formatValue(d, entry.value))} | ${entry.turns.join(", ")} | ${cell(entry.reason)} |`);
    }
  }
  if (rows.length) out.push("", "| Field | Value | Turns | Reason |", "| --- | --- | --- | --- |", ...rows);
  return out.join("\n");
}

/**
 * The export as Markdown, in chunks, under one analysis version: the one
 * asked for, or the latest.
 */
export async function* exportMarkdown(db: Db, t: ExportTarget, requestedVersion: number | null = null, exportedAt = new Date()): AsyncGenerator<string> {
  const e = t.experiment;
  const version = t.versions.find((v) => v.version === requestedVersion) ?? t.versions[t.versions.length - 1] ?? null;
  const defs = (version?.fieldDefinitions ?? []) as FieldDef[];
  const variable = variableLabel(e.declaredVariables, e.sharedSettings?.agentB.sameAsA ?? false);

  const head = [
    `# ${t.baseName}: ${e.name}`,
    "",
    `Exported ${exportedAt.toISOString()} from Agent Dialogues.`,
    "",
    `- Variable: ${variable || "none (a standalone run)"}`,
    `- Analysis focus: ${version?.focus || e.analysisFocus || "none"}`,
  ];
  if (version) {
    head.push(
      `- Analysis version: v${version.version} · Summarizer ${modelLabel(version.summarizerModel)} · Report ${modelLabel(version.reportModel)} · Thinking summaries ${version.judgeReadsThinking ? "shown to the judge" : "hidden from the judge"}`,
      `- Fields: ${defs.length ? defs.map((d) => `\`${d.name}\``).join(", ") : "none"}`,
    );
  }
  head.push("", "Citations such as R1·C07·T12 refer to run 1, conversation 7, turn 12.", "");
  yield head.join("\n");

  for (const r of t.runs) {
    const header = [
      "",
      `## ${runId(r.number)}${r.number === 1 ? " (baseline)" : ""}${e.declaredVariables.length ? `: ${variable} = ${variableValues(e.declaredVariables, r.config)}` : ""}`,
      "",
      `Status: ${r.status}`,
      "",
      "### Settings",
      "",
      configMarkdown(r),
      "",
    ];
    if (version) {
      const [report] = await db
        .select()
        .from(reports)
        .where(and(eq(reports.runId, r.id), eq(reports.analysisVersionId, version.id)));
      header.push("### Report", "");
      if (report?.content) {
        // Shift the report's own headings down so they sit under this one.
        header.push(report.content.replace(/^(#{1,4}) /gm, "###$1 "));
        if (report.opened.length) {
          header.push("", `_Transcripts opened: ${report.opened.map((o) => `${runId(o.run)}·${conversationId(o.conversation)}`).join(", ")}_`);
        }
        if (report.citationCheck && report.citationCheck.failures?.length) {
          header.push("", `_Citation check: ${report.citationCheck.failures.length} problem(s) found._`);
        }
      } else {
        header.push(`_${report ? `Report ${report.status}${report.error ? `: ${report.error}` : ""}` : "No report under this analysis version."}_`);
      }
      header.push("");
    }
    yield header.join("\n");

    for (const c of await conversationsOf(db, r.id)) {
      const rows = await turnsOf(db, c.id);
      const parts = [
        "",
        `### ${runId(r.number)}·${conversationId(c.index)}`,
        "",
        `Status: ${c.status} · Stop reason: ${stopReason(c.stopReason)} · Turns: ${c.turnsCompleted} · Cost: ${usd(c.costUsd)}${c.retries ? ` · Retried ${c.retries}×` : ""}${c.repetitionFlagTurn ? ` · Repetition flagged at T${c.repetitionFlagTurn}` : ""}`,
      ];
      if (c.error) parts.push("", `Error: ${c.error}`);
      if (version) {
        const [coding] = await db
          .select()
          .from(codings)
          .where(and(eq(codings.conversationId, c.id), eq(codings.analysisVersionId, version.id)));
        if (coding?.output) parts.push("", "#### Coding", "", codingMarkdown(coding.output, defs));
        else if (coding) parts.push("", `_Coding ${coding.status}${coding.error ? `: ${coding.error}` : ""}_`);
      }
      parts.push("", "#### Transcript");
      for (const x of rows) {
        const flags = [x.truncated && "truncated", x.placeholderUsed && "empty reply, the other agent saw \"[no reply]\"", x.signedOff && "signed off", x.stopReason === "refusal" && "refusal"]
          .filter(Boolean)
          .join(", ");
        parts.push("", `**${runId(r.number)}·${conversationId(c.index)}·T${x.turnNumber} · ${x.speaker}**${flags ? ` _(${flags})_` : ""}`);
        if (x.thinkingSummary) {
          parts.push("", `> Thinking summary (private to ${x.speaker}):`, ...x.thinkingSummary.split("\n").map((l) => `> ${l}`));
        }
        parts.push("", x.text.trim() ? x.text : "_(no visible text)_");
      }
      parts.push("");
      yield parts.join("\n");
    }
  }

  if (t.scope === "experiment") {
    const comps = await db.select().from(comparisons).where(eq(comparisons.experimentId, e.id)).orderBy(asc(comparisons.number));
    for (const c of comps) {
      yield [
        "",
        `## Comparison ${c.number}: ${c.labels.map((l) => runId(l.runNumber)).join(", ")}`,
        "",
        c.content ? c.content.replace(/^(#{1,4}) /gm, "##$1 ") : `_${c.status}${c.error ? `: ${c.error}` : ""}_`,
        "",
      ].join("\n");
    }
  }
}

/** Collects an export into one string. For tests and small exports. */
export async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let s = "";
  for await (const c of chunks) s += c;
  return s;
}

/** A streamed download response for an export. */
export function exportResponse(chunks: AsyncGenerator<string>, fileName: string, format: ExportFormat): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
