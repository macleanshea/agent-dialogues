import { z } from "zod";
import { PREDEFINED_FIELDS } from "./fields/library";
import { DEFAULT_EFFORT, DEFAULT_JUDGE_MODEL, EFFORTS, MOCK_MODEL_ID, getModel } from "./models";

export const OPENING_STUB = "[Begin the conversation.]";
export const SIGN_OFF_LINE =
  "If the conversation has reached a natural end, finish your message with [END] on its own line.";
export const NO_REPLY_PLACEHOLDER = "[no reply]";

export const LIMITS = {
  turns: { min: 1, max: 200, default: 30 },
  conversations: { min: 1, max: 200, default: 20 },
  concurrency: { min: 1, max: 16, default: 4 },
  maxTokens: { min: 1, max: 128_000, default: 8000 },
  costCeilingUsd: { default: 25 },
  repetitionThreshold: { default: 0.8 },
} as const;

const knownModel = z.string().refine((id) => getModel(id) !== undefined, "Unknown model");
const agentModel = knownModel.refine(
  (id) => getModel(id)?.agentReady === true,
  "This model cannot be used for agents.",
);

/** Treats an empty form input as missing, so it reports "Required" rather than 0. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const num = () => z.preprocess(blankToUndefined, z.coerce.number({ message: "Required" }));

const int = (min: number, max: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ message: "Required" })
      .int("Must be a whole number")
      .min(min, `At least ${min}`)
      .max(max, `At most ${max}`),
  );

export const runConfigSchema = z
  .object({
    name: z.string().trim().max(120).default(""),
    agentA: z.object({
      model: agentModel,
      effort: z.enum(EFFORTS),
      systemPrompt: z.string().max(50_000),
    }),
    agentB: z.object({
      model: agentModel,
      effort: z.enum(EFFORTS),
      systemPrompt: z.string().max(50_000),
      sameAsA: z.boolean(),
    }),
    openingMessage: z
      .string()
      .max(50_000)
      .refine((s) => s.trim().length > 0, "The opening message cannot be empty"),
    attributeOpeningToB: z.boolean(),
    turns: int(LIMITS.turns.min, LIMITS.turns.max),
    maxTokens: int(LIMITS.maxTokens.min, LIMITS.maxTokens.max),
    conversations: int(LIMITS.conversations.min, LIMITS.conversations.max),
    concurrency: int(LIMITS.concurrency.min, LIMITS.concurrency.max),
    signOff: z.boolean(),
    repetitionThreshold: num().pipe(z.number().min(0, "At least 0").max(1, "At most 1")),
    repetitionAction: z.enum(["flag", "stop"]),
    costCeilingUsd: num().pipe(z.number().positive("Must be more than 0").max(10_000, "At most 10,000")),
    analysisFocus: z.string().trim().max(2000),
    /** Names of the selected fields, built-in or custom. Checked against the library when the run is created. */
    fields: z.array(z.string().min(1).max(60)).max(100).default([]),
    summarizerModel: knownModel,
    reportModel: knownModel,
    judgeReadsThinking: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (c.attributeOpeningToB && c.openingMessage.trim() === OPENING_STUB) {
      ctx.addIssue({
        code: "custom",
        path: ["attributeOpeningToB"],
        message: "Only available when the opening message differs from the stub",
      });
    }
  });

export type RunConfig = z.infer<typeof runConfigSchema>;

/** The picker starts with only topics and themes_by_turn ticked. */
export const DEFAULT_FIELDS = ["topics", "themes_by_turn"].filter((n) => PREDEFINED_FIELDS.some((f) => f.name === n));

export function defaultRunConfig(): RunConfig {
  return {
    name: "",
    agentA: { model: MOCK_MODEL_ID, effort: DEFAULT_EFFORT, systemPrompt: "" },
    agentB: { model: MOCK_MODEL_ID, effort: DEFAULT_EFFORT, systemPrompt: "", sameAsA: false },
    openingMessage: OPENING_STUB,
    attributeOpeningToB: false,
    turns: LIMITS.turns.default,
    maxTokens: LIMITS.maxTokens.default,
    conversations: LIMITS.conversations.default,
    concurrency: LIMITS.concurrency.default,
    signOff: false,
    repetitionThreshold: LIMITS.repetitionThreshold.default,
    repetitionAction: "flag",
    costCeilingUsd: LIMITS.costCeilingUsd.default,
    analysisFocus: "",
    fields: DEFAULT_FIELDS,
    summarizerModel: DEFAULT_JUDGE_MODEL,
    reportModel: DEFAULT_JUDGE_MODEL,
    judgeReadsThinking: false,
  };
}

/**
 * The same settings with the Mock model replaced by the default Claude model,
 * for forms on a deployment where the Mock model is not offered (for example
 * a clone of a run that used it, or the form's own defaults).
 */
export function withoutMock(c: RunConfig): RunConfig {
  const swap = (m: string) => (m === MOCK_MODEL_ID ? DEFAULT_JUDGE_MODEL : m);
  return {
    ...c,
    agentA: { ...c.agentA, model: swap(c.agentA.model) },
    agentB: { ...c.agentB, model: swap(c.agentB.model) },
    summarizerModel: swap(c.summarizerModel),
    reportModel: swap(c.reportModel),
  };
}

export function usesMock(models: string[]): boolean {
  return models.includes(MOCK_MODEL_ID);
}

/**
 * The system prompts actually sent to each agent. A blank result means no
 * system parameter is sent at all.
 */
export function resolveSystemPrompts(c: RunConfig): { a: string; b: string } {
  const withSignOff = (p: string) => {
    if (!c.signOff) return p;
    return p.trim() === "" ? SIGN_OFF_LINE : `${p}\n\n${SIGN_OFF_LINE}`;
  };
  const a = c.agentA.systemPrompt;
  const b = c.agentB.sameAsA ? c.agentA.systemPrompt : c.agentB.systemPrompt;
  return { a: withSignOff(a), b: withSignOff(b) };
}

/** What is stored on a run: the full config plus the prompts it resolved to. */
export interface RunConfigSnapshot extends RunConfig {
  resolved: { systemPromptA: string; systemPromptB: string };
}

export function snapshotConfig(c: RunConfig): RunConfigSnapshot {
  const { a, b } = resolveSystemPrompts(c);
  return { ...c, resolved: { systemPromptA: a, systemPromptB: b } };
}

export function defaultExperimentName(c: RunConfig): string {
  if (c.name.trim()) return c.name.trim();
  const short = (id: string) => getModel(id)?.label.replace(/^Claude /, "") ?? id;
  return `${short(c.agentA.model)} × ${short(c.agentB.model)}, ${c.turns} turns`;
}
