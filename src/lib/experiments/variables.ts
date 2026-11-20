/**
 * Declared variables: the settings that may differ between the runs of an
 * experiment. Plain data and pure functions, used by the browser (the toggle
 * and the add-run form) and the server (which enforces them).
 */
import type { RunConfig } from "../config";
import { EFFORT_LABELS, modelLabel } from "../models";

export const VARIABLES = [
  { key: "agentA.model", label: "Model A" },
  { key: "agentB.model", label: "Model B" },
  { key: "agentA.effort", label: "Effort A" },
  { key: "agentB.effort", label: "Effort B" },
  { key: "agentA.systemPrompt", label: "System prompt A" },
  { key: "agentB.systemPrompt", label: "System prompt B" },
  { key: "openingMessage", label: "Opening message" },
  { key: "attributeOpeningToB", label: "Attribute opening message to B" },
  { key: "turns", label: "Turns" },
  { key: "maxTokens", label: "Max tokens per message" },
  { key: "signOff", label: "Sign-off" },
  { key: "repetition", label: "Repetition rule" },
] as const;

export type VariableKey = (typeof VARIABLES)[number]["key"];

export const VARIABLE_KEYS: readonly VariableKey[] = VARIABLES.map((v) => v.key);

export const BOTH_MODELS: VariableKey[] = ["agentA.model", "agentB.model"];

/**
 * Settings that are not experimental variables but may still be set per run,
 * because they change how a run is executed, not what the agents see.
 */
export const PER_RUN_SETTINGS = ["costCeilingUsd", "concurrency"] as const;

/**
 * Sets of settings that belong together. Ticking settings that all fall in
 * one group is fine; ticking settings from different groups shows a warning.
 */
export const RELATED_GROUPS: VariableKey[][] = [
  ["agentA.model", "agentB.model"],
  ["agentA.effort", "agentB.effort"],
  ["agentA.systemPrompt", "agentB.systemPrompt"],
  ["agentA.model", "agentA.effort"],
  ["agentB.model", "agentB.effort"],
  ["openingMessage", "attributeOpeningToB"],
];

export function isVariableKey(k: string): k is VariableKey {
  return (VARIABLE_KEYS as readonly string[]).includes(k);
}

/** Keeps known keys, in the standard order, without duplicates. */
export function normalizeVariables(keys: readonly string[]): VariableKey[] {
  return VARIABLE_KEYS.filter((k) => keys.includes(k));
}

/** True when two or more ticked settings do not belong to one related group. */
export function hasUnrelatedVariables(keys: readonly string[]): boolean {
  const ks = normalizeVariables(keys);
  if (ks.length < 2) return false;
  return !RELATED_GROUPS.some((g) => ks.every((k) => g.includes(k)));
}

/**
 * How the declared variable is shown. "Both models" when both models vary.
 * System prompt A with "same as A" on is shown as "Both prompts", because B
 * then gets A's prompt too.
 */
export function variableLabel(keys: readonly string[], sameAsA: boolean): string {
  const ks = normalizeVariables(keys);
  if (ks.length === 0) return "";
  const parts: string[] = [];
  const bothModels = BOTH_MODELS.every((k) => ks.includes(k));
  for (const k of ks) {
    if (bothModels && k === "agentA.model") parts.push("Both models");
    else if (bothModels && k === "agentB.model") continue;
    else if (k === "agentA.systemPrompt" && sameAsA) parts.push("Both prompts");
    else parts.push(VARIABLES.find((v) => v.key === k)!.label);
  }
  return parts.join(", ");
}

/** Which RunConfig paths a variable unlocks. */
export function pathsFor(key: VariableKey): string[] {
  switch (key) {
    case "agentB.systemPrompt":
      return ["agentB.systemPrompt", "agentB.sameAsA"];
    case "repetition":
      return ["repetitionThreshold", "repetitionAction"];
    default:
      return [key];
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    o[k] = { ...((o[k] as Record<string, unknown>) ?? {}) };
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = value;
}

/**
 * The settings for a new run in an experiment: the baseline, with only the
 * declared variables (and the per-run execution settings) taken from what
 * was submitted. Everything else is locked to the baseline, whatever the
 * browser sent.
 */
export function mergeWithBaseline(baseline: RunConfig, submitted: RunConfig, variables: readonly string[]): RunConfig {
  const out = structuredClone(baseline) as unknown as Record<string, unknown>;
  const paths = [...normalizeVariables(variables).flatMap(pathsFor), ...PER_RUN_SETTINGS];
  for (const p of paths) setPath(out, p, structuredClone(getPath(submitted, p)));
  // A blank opening message is never allowed; the attribution toggle only applies to a non-stub message (checked by the schema).
  return out as unknown as RunConfig;
}

const COMPARED_PATHS = [
  "agentA.model",
  "agentA.effort",
  "agentA.systemPrompt",
  "agentB.model",
  "agentB.effort",
  "agentB.systemPrompt",
  "agentB.sameAsA",
  "openingMessage",
  "attributeOpeningToB",
  "turns",
  "maxTokens",
  "conversations",
  "concurrency",
  "signOff",
  "repetitionThreshold",
  "repetitionAction",
  "costCeilingUsd",
  "resolved.systemPromptA",
  "resolved.systemPromptB",
];

/** Settings that differ from the baseline, by path. */
export function diffFromBaseline(baseline: object, config: object): Record<string, { baseline: unknown; value: unknown }> {
  const out: Record<string, { baseline: unknown; value: unknown }> = {};
  for (const p of COMPARED_PATHS) {
    const a = getPath(baseline, p);
    const b = getPath(config, p);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[p] = { baseline: a, value: b };
  }
  return out;
}

function shorten(s: string, n = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (!one) return "(blank)";
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

type ConfigLike = Pick<
  RunConfig,
  | "agentA"
  | "agentB"
  | "openingMessage"
  | "attributeOpeningToB"
  | "turns"
  | "maxTokens"
  | "signOff"
  | "repetitionThreshold"
  | "repetitionAction"
>;

/** One variable's value in a run, for tables. */
export function variableValue(key: VariableKey, c: ConfigLike, opts: { short?: boolean } = {}): string {
  const s = (t: string) => (opts.short === false ? t || "(blank)" : shorten(t));
  switch (key) {
    case "agentA.model":
      return modelLabel(c.agentA.model);
    case "agentB.model":
      return modelLabel(c.agentB.model);
    case "agentA.effort":
      return EFFORT_LABELS[c.agentA.effort];
    case "agentB.effort":
      return EFFORT_LABELS[c.agentB.effort];
    case "agentA.systemPrompt":
      return s(c.agentA.systemPrompt);
    case "agentB.systemPrompt":
      return c.agentB.sameAsA ? "Same as A" : s(c.agentB.systemPrompt);
    case "openingMessage":
      return s(c.openingMessage);
    case "attributeOpeningToB":
      return c.attributeOpeningToB ? "On" : "Off";
    case "turns":
      return String(c.turns);
    case "maxTokens":
      return c.maxTokens.toLocaleString("en-US");
    case "signOff":
      return c.signOff ? "On" : "Off";
    case "repetition":
      return `${c.repetitionThreshold}, ${c.repetitionAction}`;
  }
}

/** All declared variables' values in a run, joined. */
export function variableValues(keys: readonly string[], c: ConfigLike): string {
  const ks = normalizeVariables(keys);
  if (ks.length === 0) return "—";
  if (ks.length === 1) return variableValue(ks[0], c);
  return ks.map((k) => `${VARIABLES.find((v) => v.key === k)!.label}: ${variableValue(k, c)}`).join(" · ");
}
