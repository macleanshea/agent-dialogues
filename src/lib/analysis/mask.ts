/**
 * Masking model names for the comparison writer. It must not be able to tell
 * which model produced which run, so every text it receives passes through
 * maskModelNames.
 *
 * What is masked is found with the same name patterns as the computed
 * "model or maker named" measure (NAME_PATTERNS in measures.ts), widened to
 * take in a version number after the name ("Opus 5.5", "GPT-4"), plus the
 * exact model IDs and labels from models.ts.
 */
import { MODELS } from "../models";
import { NAME_PATTERNS, modelMentions } from "./measures";

export const MODEL_MASK = "[model]";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A version number or suffix right after a name: " 5.5", "-4o", "-5-5". */
const VERSION = String.raw`(?:[ -]?v?\d+(?:[.\-]\d+)*)?[a-z0-9]*`;

/** Family names that can follow a masked "Claude". */
const FAMILY = String.raw`(?:opus|sonnet|haiku|fable|mythos)`;

const PATTERNS: RegExp[] = (() => {
  const exact = MODELS.filter((m) => m.kind === "anthropic").flatMap((m) => [m.id, m.label]);
  // Multi-word names first ("Claude Opus 5.5" before "Claude"), so nothing is left half-masked.
  const ordered = [...NAME_PATTERNS].sort((a, b) => Number(a.name === "Claude") - Number(b.name === "Claude"));
  return [
    ...exact.sort((a, b) => b.length - a.length).map((s) => new RegExp(`\\b${escape(s)}\\b`, "gi")),
    ...ordered.map((p) => new RegExp(`(?:${p.re.source})${VERSION}`, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`)),
  ];
})();

const MASK_RE = escape(MODEL_MASK);
/** "[model] Opus 5", "[model]-sonnet": a family word left after a masked maker name. */
const TRAILING_FAMILY = new RegExp(`${MASK_RE}(?:[ -]+${FAMILY}\\b${VERSION})+`, "gi");
/** "[model] [model]" and "[model]-[model]" collapse to one. */
const ADJACENT = new RegExp(`${MASK_RE}(?:[\\s-]*${MASK_RE})+`, "g");

/** Replaces every model or maker name in a text with [model]. */
export function maskModelNames(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, MODEL_MASK);
  return out.replace(TRAILING_FAMILY, MODEL_MASK).replace(ADJACENT, MODEL_MASK);
}

/** Masks every string inside a JSON value. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskModelNames(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  }
  return value;
}

/** True if the computed measure would still find a name. Used by tests and as a last check. */
export function stillNamesAModel(text: string): boolean {
  return modelMentions(text).length > 0;
}
