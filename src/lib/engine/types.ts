import type { Effort, TokenUsage } from "../models";

/**
 * Content blocks as the Messages API returns them. We keep the shapes we read
 * and pass everything else through untouched, because an agent's own history
 * must replay its raw blocks unchanged.
 */
export type TextBlock = { type: "text"; text: string; [k: string]: unknown };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature: string; [k: string]: unknown };
export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string; [k: string]: unknown };
export type OtherBlock = { type: string; [k: string]: unknown };
export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | OtherBlock;

export interface AgentMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Every stop_reason the Messages API documents, plus a catch-all. */
export type ApiStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded"
  | (string & {});

export type Speaker = "A" | "B";

export interface ModelRequest {
  model: string;
  /** Omitted entirely when the system prompt is blank. */
  system?: string;
  messages: AgentMessage[];
  maxTokens: number;
  effort: Effort;
  /** For the mock and for logging; never sent to the API. */
  meta: { speaker: Speaker; turnNumber: number; conversationIndex?: number; attempt?: number };
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: ApiStopReason;
  usage: TokenUsage;
  /** The raw usage object as returned, kept for the record. */
  rawUsage?: unknown;
}

export interface ModelClient {
  call(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * A model call failed in a way that is worth retrying later: a rate limit
 * (429), an overloaded or failing server (5xx, 529), or a dropped connection.
 * The engine never swallows it; the caller (a Workflow step) retries it,
 * waiting at least `retryAfterMs` when the API said how long to wait.
 * Any other error from a model call ends the conversation as errored.
 */
export class TransientModelError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "TransientModelError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isTransientModelError(err: unknown): err is TransientModelError {
  return err instanceof TransientModelError || (err instanceof Error && err.name === "TransientModelError");
}

/** A stored turn, as the engine needs it to rebuild histories. */
export interface TurnRecord {
  turnNumber: number;
  speaker: Speaker;
  content: ContentBlock[];
}

/** Stop reasons recorded on a conversation. */
export type ConversationStopReason =
  | "turn_cap"
  | "repetition"
  | "sign_off"
  | "error"
  | "cost_ceiling"
  | "stopped_by_user";

export type ConversationStatus = "pending" | "running" | "done" | "errored" | "stopped";
