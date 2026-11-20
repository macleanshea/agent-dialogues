import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunConfigSnapshot } from "../config";
import type {
  AgentMessage,
  ApiStopReason,
  ContentBlock,
  ConversationStatus,
  ConversationStopReason,
  Speaker,
} from "../engine/types";
import type { FieldGroup, FieldOptions, FieldScope, FieldType, PresetKey } from "../fields/library";
import type { CodingOutput } from "../analysis/fields";
import type { CitationCheckResult } from "../analysis/citations";
import type { PresetKind } from "../presets/kinds";

export type RunStatus = "draft" | "queued" | "running" | "done" | "failed" | "stopped";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Experiment > Run > Conversation > Turn. */
export const experiments = pgTable("experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Shown as EXP-004. */
  number: serial("number").notNull().unique(),
  /** Placeholder for future accounts. */
  ownerId: text("owner_id").notNull().default("owner"),
  name: text("name").notNull(),
  analysisFocus: text("analysis_focus").notNull().default(""),
  /** Which settings may vary between runs. Empty for a standalone run. */
  declaredVariables: jsonb("declared_variables").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** The baseline settings shared by every run. */
  sharedSettings: jsonb("shared_settings").$type<RunConfigSnapshot | null>(),
  locked: boolean("locked").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    /** Shown as R2. R1 is the baseline. */
    number: integer("number").notNull(),
    /** A full copy of the settings, not a reference. */
    config: jsonb("config").$type<RunConfigSnapshot>().notNull(),
    modelA: text("model_a").notNull(),
    modelB: text("model_b").notNull(),
    /** Settings that differ from the baseline (R1). Empty for R1. */
    configDiff: jsonb("config_diff").$type<Record<string, { baseline: unknown; value: unknown }>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<RunStatus>().notNull().default("draft"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    error: text("error"),
    /** Set by the Stop button. Conversations check it before every model call. */
    stopRequested: boolean("stop_requested").notNull().default(false),
    /** The Vercel Workflow run executing this run. */
    workflowRunId: text("workflow_run_id"),
    /**
     * Agent spend on conversation attempts that were discarded by "Retry
     * failed conversations" (PR 5). Still part of the run's cost.
     */
    retriedCostUsd: doublePrecision("retried_cost_usd").notNull().default(0),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("runs_experiment_number_uq").on(t.experimentId, t.number)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Shown as C07. */
    index: integer("index").notNull(),
    status: text("status").$type<ConversationStatus>().notNull().default("pending"),
    stopReason: text("stop_reason").$type<ConversationStopReason>(),
    error: text("error"),
    turnsCompleted: integer("turns_completed").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    thinkingTokens: integer("thinking_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    /** First turn where repetition met the stop condition (two consecutive checks at or above the threshold). */
    repetitionFlagTurn: integer("repetition_flag_turn"),
    /** How many times this conversation was retried from scratch after it errored (PR 5). */
    retries: integer("retries").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("conversations_run_index_uq").on(t.runId, t.index)],
);

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Shown as T12. A speaks on odd turns. */
    turnNumber: integer("turn_number").notNull(),
    speaker: text("speaker").$type<Speaker>().notNull(),
    model: text("model").notNull(),
    /** Visible text: the text blocks joined. */
    text: text("text").notNull(),
    thinkingSummary: text("thinking_summary"),
    /** The content blocks exactly as returned. */
    content: jsonb("content").$type<ContentBlock[]>().notNull(),
    stopReason: text("stop_reason").$type<ApiStopReason>().notNull(),
    /** The usage object exactly as returned. */
    usage: jsonb("usage"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    thinkingTokens: integer("thinking_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    truncated: boolean("truncated").notNull().default(false),
    placeholderUsed: boolean("placeholder_used").notNull().default(false),
    attempts: integer("attempts").notNull().default(1),
    maxTokensUsed: integer("max_tokens_used").notNull(),
    /** Word-trigram overlap with the same speaker's previous message (null on each speaker's first turn). */
    repetition: doublePrecision("repetition"),
    /** The message ended with [END] on its own line while sign-off was on. */
    signedOff: boolean("signed_off").notNull().default(false),
    /** Computed measures (PR 3). Null on turns saved before PR 3 until backfilled. */
    crossSimilarity: doublePrecision("cross_similarity"),
    emojiCount: integer("emoji_count"),
    modelMentions: jsonb("model_mentions").$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("turns_conversation_turn_uq").on(t.conversationId, t.turnNumber)],
);

/** Built-in and custom fields, treated identically. */
export const fieldDefinitions = pgTable("field_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  type: text("type").$type<FieldType>().notNull(),
  scope: text("scope").$type<FieldScope>().notNull(),
  options: jsonb("options").$type<FieldOptions>().notNull().default(sql`'{}'::jsonb`),
  definition: text("definition").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  /** Picker group. Custom fields may use any group. */
  group: text("group").$type<FieldGroup | string>().notNull(),
  presets: jsonb("presets").$type<PresetKey[]>().notNull().default(sql`'[]'::jsonb`),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface FieldDefinitionSnapshot {
  id: string;
  name: string;
  type: FieldType;
  scope: FieldScope;
  options: FieldOptions;
  definition: string;
  /** False for custom fields. Missing on snapshots made before custom fields could be deleted. */
  builtin?: boolean;
}

/**
 * Codings and reports (PR 3) are keyed to an analysis version, so the same
 * transcripts can be re-analyzed without re-running them.
 */
export const analysisVersions = pgTable(
  "analysis_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    focus: text("focus").notNull().default(""),
    /** Copies of the selected field definitions at the time of creation. */
    fieldDefinitions: jsonb("field_definitions").$type<FieldDefinitionSnapshot[]>().notNull().default(sql`'[]'::jsonb`),
    summarizerModel: text("summarizer_model").notNull(),
    reportModel: text("report_model").notNull(),
    judgeReadsThinking: boolean("judge_reads_thinking").notNull().default(false),
    promptVersions: jsonb("prompt_versions").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("analysis_versions_experiment_version_uq").on(t.experimentId, t.version),
    index("analysis_versions_experiment_idx").on(t.experimentId),
  ],
);

export type AnalysisStatus = "pending" | "running" | "done" | "errored";

const tokenColumns = () => ({
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  thinkingTokens: integer("thinking_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
});

/** One summarizer coding of one conversation, under one analysis version. */
export const codings = pgTable(
  "codings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisVersionId: uuid("analysis_version_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    status: text("status").$type<AnalysisStatus>().notNull().default("pending"),
    model: text("model").notNull(),
    /** The coding as stored: summary, focus findings, notable, and one value per field. */
    output: jsonb("output").$type<CodingOutput>(),
    /** The JSON exactly as the model returned it. */
    rawOutput: jsonb("raw_output"),
    error: text("error"),
    ...tokenColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("codings_version_conversation_uq").on(t.analysisVersionId, t.conversationId),
    index("codings_conversation_idx").on(t.conversationId),
  ],
);

/** A transcript the report writer opened. */
export interface OpenedTranscript {
  run: number;
  conversation: number;
}

/** The run report for one run under one analysis version. */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisVersionId: uuid("analysis_version_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    status: text("status").$type<AnalysisStatus>().notNull().default("pending"),
    model: text("model").notNull(),
    /** The report writer's conversation so far, replayed unchanged on each call. */
    messages: jsonb("messages").$type<AgentMessage[]>().notNull().default(sql`'[]'::jsonb`),
    /** How many transcripts it must open. */
    minTranscripts: integer("min_transcripts").notNull().default(0),
    opened: jsonb("opened").$type<OpenedTranscript[]>().notNull().default(sql`'[]'::jsonb`),
    nudges: integer("nudges").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    /** The report in Markdown, as written. The footer is rendered separately. */
    content: text("content"),
    warning: text("warning"),
    citationCheck: jsonb("citation_check").$type<CitationCheckResult>(),
    error: text("error"),
    ...tokenColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("reports_version_run_uq").on(t.analysisVersionId, t.runId)],
);

/** How a compared run was shown to the comparison writer. */
export interface ComparisonLabel {
  runId: string;
  runNumber: number;
  /** "X" for Run X. Assigned at random. */
  label: string;
  /** Transcripts the writer must open from this run: 2, or all of its coded conversations if fewer. */
  required: number;
}

/**
 * A comparison report (PR 4): two or more runs of one experiment, compared
 * under one analysis version. The writer sees the runs only by their random
 * labels, with model names masked; the page unmasks them once it is done.
 */
export const comparisons = pgTable(
  "comparisons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    /** Shown as "Comparison 2", numbered within the experiment. */
    number: integer("number").notNull(),
    analysisVersionId: uuid("analysis_version_id")
      .notNull()
      .references(() => analysisVersions.id, { onDelete: "cascade" }),
    /** The compared runs in run order, with the label the writer saw for each. */
    labels: jsonb("labels").$type<ComparisonLabel[]>().notNull(),
    status: text("status").$type<AnalysisStatus>().notNull().default("pending"),
    model: text("model").notNull(),
    /** The writer's conversation so far (masked), replayed unchanged on each call. */
    messages: jsonb("messages").$type<AgentMessage[]>().notNull().default(sql`'[]'::jsonb`),
    /** How many transcripts it must open from each run (fewer if a run has fewer coded conversations). */
    minPerRun: integer("min_per_run").notNull().default(0),
    /** Transcripts it opened, by real run number. */
    opened: jsonb("opened").$type<OpenedTranscript[]>().notNull().default(sql`'[]'::jsonb`),
    nudges: integer("nudges").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    /** The report exactly as written, with Run X labels and masked names. */
    maskedContent: text("masked_content"),
    /** The same report with the run labels replaced by run IDs. */
    content: text("content"),
    warning: text("warning"),
    citationCheck: jsonb("citation_check").$type<CitationCheckResult>(),
    error: text("error"),
    ...tokenColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("comparisons_experiment_number_uq").on(t.experimentId, t.number)],
);


/**
 * Saved prompt presets (PR 5): text that can be loaded into a system prompt
 * or the opening message on the run form. Built-in presets are seeded and
 * cannot be deleted; saved ones can.
 */
export const promptPresets = pgTable(
  "prompt_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Fixed for built-in presets, so seeding can update them in place. Null for saved ones. */
    seedKey: text("seed_key").unique(),
    kind: text("kind").$type<PresetKind>().notNull(),
    name: text("name").notNull(),
    text: text("text").notNull(),
    builtin: boolean("builtin").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prompt_presets_kind_name_uq").on(t.kind, t.name)],
);
