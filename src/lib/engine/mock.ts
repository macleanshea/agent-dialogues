import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from "./types";
import { visibleText } from "./history";

/**
 * A fake model with deterministic canned replies. Same request in, same
 * response out. It never touches the network and costs nothing.
 *
 * It behaves like the real API in the ways the engine cares about:
 * - Each response starts with a thinking block (with a readable summary),
 *   then a text block.
 * - Thinking uses up max_tokens first. If max_tokens is too small, the text is
 *   cut short (stop reason "max_tokens"), or missing entirely.
 *
 * Test hooks, written anywhere in a system prompt:
 * - [mock:empty]   reply with no visible text (stop reason "end_turn").
 * - [mock:refuse]  reply with stop reason "refusal".
 * - [mock:error]   throw an error, as a failed API call would.
 */

const OPENERS = [
  "That's an interesting place to start.",
  "I keep coming back to what you just said.",
  "Let me try a different angle.",
  "I'm not sure I agree, but I want to understand.",
  "Here's a thought I haven't voiced yet.",
  "Picking up the thread you left:",
  "Something about this feels worth slowing down for.",
  "I'd like to build on that.",
];

const MIDDLES = [
  "Conversations like this one tend to circle back on themselves, and I wonder whether that is a feature or a limitation.",
  "If we treat this as an experiment, the interesting question is what neither of us would say on our own.",
  "I can describe what I notice, but I'm cautious about claiming more than that.",
  "A small example might help: two people describing the same room will still disagree about where the door is.",
  "We could keep going in this direction, or step back and ask what we actually want from the exchange.",
  "There is a pattern here worth naming: each reply narrows the space a little more.",
  "I find the uncertainty itself more interesting than any answer we might reach.",
  "Maybe the most honest move is to admit what I don't know.",
];

const CLOSERS = [
  "What do you make of that?",
  "Where would you take it next?",
  "Does that match how it looks from your side?",
  "I'm curious which part you'd push back on.",
  "Shall we follow that further?",
];

/** FNV-1a, 32-bit. Small and stable across platforms. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Rough token estimate: about 4 characters per token. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

const THINKING_TOKENS = 40;

function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === "user") return visibleText(m.content);
  }
  return "";
}

function quote(s: string, max = 70): string {
  const one = s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function mockReply(req: ModelRequest): ModelResponse {
  const system = req.system ?? "";
  const { speaker, turnNumber } = req.meta;
  if (system.includes("[mock:error]")) {
    throw new Error("Mock model error (requested with [mock:error])");
  }

  const heard = lastUserText(req);
  // Same inputs give the same reply; each conversation in a run differs.
  const seed = hash(`${req.meta.conversationIndex ?? 0}|${speaker}|${turnNumber}|${heard}`);
  const pick = <T>(xs: T[], salt: number) => xs[(seed + salt * 7919) % xs.length];

  const summary = `Speaker ${speaker} is preparing turn ${turnNumber}. It considers the last message${
    heard ? ` ("${quote(heard, 40)}")` : ""
  } and decides how to respond.`;

  let text: string;
  if (system.includes("[mock:empty]")) {
    text = "";
  } else {
    text =
      `**${speaker}, turn ${turnNumber}.** ${pick(OPENERS, 1)} ` +
      (heard ? `You said: “${quote(heard)}” ` : "") +
      `${pick(MIDDLES, 2)} ${pick(CLOSERS, 3)}`;
  }

  const inputTokens = estimateTokens(system) + req.messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content)), 0);

  // Thinking spends the max_tokens budget first.
  const thinkingTokens = Math.min(THINKING_TOKENS, req.maxTokens);
  const textBudget = req.maxTokens - thinkingTokens;
  const wantedTextTokens = estimateTokens(text);
  let stopReason: ModelResponse["stopReason"] = system.includes("[mock:refuse]") ? "refusal" : "end_turn";
  if (wantedTextTokens > textBudget) {
    text = text.slice(0, textBudget * 4);
    stopReason = "max_tokens";
  }

  const content: ContentBlock[] = [
    { type: "thinking", thinking: summary, signature: `mock-signature-${seed.toString(16)}` },
  ];
  if (text.length > 0 || system.includes("[mock:empty]")) {
    content.push({ type: "text", text });
  }

  const outputTokens = thinkingTokens + estimateTokens(text);
  return {
    content,
    stopReason,
    usage: { inputTokens, outputTokens, thinkingTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    rawUsage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      output_tokens_details: { thinking_tokens: thinkingTokens },
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

export const mockClient: ModelClient = {
  async call(req) {
    return mockReply(req);
  },
};
