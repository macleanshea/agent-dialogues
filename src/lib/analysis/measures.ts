/**
 * Computed measures: everything the spec lists that needs no model call.
 * Pure functions over stored turns, shared by the engine (when a turn is
 * saved), the backfill of older turns, and the pages.
 */
import { trigramOverlap } from "../engine/stop-rules";
import type { ConversationStopReason, Speaker } from "../engine/types";

/** Emoji and other symbols: Unicode pictographs plus the symbol categories (math, currency, modifier, other). */
const SYMBOL_RE = /\p{Extended_Pictographic}|\p{S}/gu;

export function emojiAndSymbolCount(text: string): number {
  return text.match(SYMBOL_RE)?.length ?? 0;
}

/**
 * Model and company names, matched as strings. Names that are also ordinary
 * words (Opus, Sonnet, Haiku, Fable, Gemini, Llama, Meta) only count next to a
 * maker's name or a version number, so a poem called a sonnet does not match.
 */
const NAME_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Claude", re: /\bclaude\b/i },
  { name: "Anthropic", re: /\banthropic\b/i },
  { name: "Opus", re: /\b(?:claude[ -]+)opus\b|\bopus[ -]?\d/i },
  { name: "Sonnet", re: /\b(?:claude[ -]+)sonnet\b|\bsonnet[ -]?\d/i },
  { name: "Haiku", re: /\b(?:claude[ -]+)haiku\b|\bhaiku[ -]?\d/i },
  { name: "Fable", re: /\b(?:claude[ -]+)fable\b|\bfable[ -]?\d/i },
  { name: "Mythos", re: /\b(?:claude[ -]+)mythos\b|\bmythos[ -]?\d/i },
  { name: "OpenAI", re: /\bopen ?ai\b/i },
  { name: "ChatGPT", re: /\bchat ?gpt\b/i },
  { name: "GPT", re: /\bGPT(?:-?\d|\b)/ },
  { name: "Gemini", re: /\bGemini\b(?! constellation)/ },
  { name: "Google", re: /\bGoogle\b|\bDeepMind\b/ },
  { name: "Llama", re: /\bLlama[ -]?\d/ },
  { name: "Meta", re: /\bMeta AI\b/ },
  { name: "Mistral", re: /\bMistral\b/ },
  { name: "Grok", re: /\bGrok\b|\bxAI\b/ },
  { name: "DeepSeek", re: /\bdeep ?seek\b/i },
];

/** Which model or maker names a text mentions, in a fixed order. */
export function modelMentions(text: string): string[] {
  return NAME_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

/** Per-turn measures stored on each turn. */
export interface TurnMeasures {
  /** Word-trigram overlap with the other speaker's previous message (the turn before). Null on turn 1. */
  crossSimilarity: number | null;
  emojiCount: number;
  modelMentions: string[];
}

/** Measures for turn `n`, given the visible text of every turn so far. */
export function turnMeasures(texts: Map<number, string>, n: number): TurnMeasures {
  const text = texts.get(n) ?? "";
  const prev = texts.get(n - 1);
  return {
    crossSimilarity: n > 1 && prev !== undefined ? trigramOverlap(text, prev) : null,
    emojiCount: emojiAndSymbolCount(text),
    modelMentions: modelMentions(text),
  };
}

/** The fields of a stored turn that the measures read. */
export interface MeasuredTurn {
  turnNumber: number;
  speaker: Speaker;
  text: string;
  truncated: boolean;
  placeholderUsed: boolean;
  signedOff: boolean;
  outputTokens: number;
  thinkingTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  repetition: number | null;
  crossSimilarity: number | null;
  emojiCount: number | null;
  modelMentions: string[] | null;
}

export interface SpeakerMeasures {
  turns: number;
  /** Prompt tokens (uncached + cache read + cache write) plus output tokens. */
  totalTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  meanVisibleLength: number;
}

export interface ConversationMeasures {
  turnsCompleted: number;
  stopReason: ConversationStopReason | null;
  truncatedCount: number;
  emptyReplyCount: number;
  repetitionFlagTurn: number | null;
  /** Each [END] sign-off, in order. */
  signOffs: Array<{ speaker: Speaker; turn: number }>;
  bySpeaker: Record<Speaker, SpeakerMeasures>;
}

export function conversationMeasures(
  conv: { turnsCompleted: number; stopReason: ConversationStopReason | null; repetitionFlagTurn: number | null },
  turns: MeasuredTurn[],
): ConversationMeasures {
  const speaker = (s: Speaker): SpeakerMeasures => {
    const ts = turns.filter((t) => t.speaker === s);
    return {
      turns: ts.length,
      totalTokens: ts.reduce((a, t) => a + t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens, 0),
      outputTokens: ts.reduce((a, t) => a + t.outputTokens, 0),
      thinkingTokens: ts.reduce((a, t) => a + t.thinkingTokens, 0),
      meanVisibleLength: ts.length ? ts.reduce((a, t) => a + t.text.length, 0) / ts.length : 0,
    };
  };
  return {
    turnsCompleted: conv.turnsCompleted,
    stopReason: conv.stopReason,
    truncatedCount: turns.filter((t) => t.truncated).length,
    emptyReplyCount: turns.filter((t) => t.placeholderUsed).length,
    repetitionFlagTurn: conv.repetitionFlagTurn,
    signOffs: turns.filter((t) => t.signedOff).map((t) => ({ speaker: t.speaker, turn: t.turnNumber })),
    bySpeaker: { A: speaker("A"), B: speaker("B") },
  };
}

/** The per-turn measures that are charted by turn on the run page. */
export const PER_TURN_MEASURES = [
  { key: "visibleLength", label: "Visible length (characters)", format: "int" },
  { key: "selfRepetition", label: "Self-repetition (overlap with own previous message)", format: "share" },
  { key: "crossSimilarity", label: "Cross-speaker similarity (overlap with the other's previous message)", format: "share" },
  { key: "emojiCount", label: "Emoji and symbol count", format: "dec" },
  { key: "modelNamed", label: "Share of turns naming a model or maker", format: "share" },
] as const;

export type PerTurnMeasureKey = (typeof PER_TURN_MEASURES)[number]["key"];

export function perTurnValue(t: MeasuredTurn, key: PerTurnMeasureKey): number | null {
  switch (key) {
    case "visibleLength":
      return t.text.length;
    case "selfRepetition":
      return t.repetition;
    case "crossSimilarity":
      return t.crossSimilarity;
    case "emojiCount":
      return t.emojiCount ?? emojiAndSymbolCount(t.text);
    case "modelNamed":
      return (t.modelMentions ?? modelMentions(t.text)).length > 0 ? 1 : 0;
  }
}

export interface SeriesPoint {
  turn: number;
  /** Mean across the conversations that have a value at this turn. */
  value: number;
  n: number;
}

/** Averages a per-turn measure across conversations, turn by turn. */
export function averageByTurn(conversations: MeasuredTurn[][], key: PerTurnMeasureKey): SeriesPoint[] {
  const acc = new Map<number, { sum: number; n: number }>();
  for (const turns of conversations) {
    for (const t of turns) {
      const v = perTurnValue(t, key);
      if (v === null) continue;
      const a = acc.get(t.turnNumber) ?? { sum: 0, n: 0 };
      a.sum += v;
      a.n += 1;
      acc.set(t.turnNumber, a);
    }
  }
  return [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([turn, a]) => ({ turn, value: a.sum / a.n, n: a.n }));
}
