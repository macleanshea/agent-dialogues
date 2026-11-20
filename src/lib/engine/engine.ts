import { addUsage, costUsd, type Effort, type TokenUsage } from "../models";
import { buildHistory, speakerForTurn, textForOtherAgent, thinkingSummary, visibleText } from "./history";
import { endsWithSignOff, trigramOverlap } from "./stop-rules";
import {
  isTransientModelError,
  type ApiStopReason,
  type ContentBlock,
  type ConversationStatus,
  type ConversationStopReason,
  type ModelClient,
  type ModelResponse,
  type Speaker,
  type TurnRecord,
} from "./types";

export interface AgentSetup {
  model: string;
  effort: Effort;
  /** Already resolved (same-as-A and sign-off applied). Blank means none. */
  systemPrompt: string;
}

export interface ConversationSetup {
  agentA: AgentSetup;
  agentB: AgentSetup;
  openingMessage: string;
  attributeOpeningToB: boolean;
  turns: number;
  maxTokens: number;
  /** When on, a message ending with [END] on its own line ends the conversation. */
  signOff: boolean;
  repetitionThreshold: number;
  /** "flag" records the turn and continues; "stop" ends the conversation. */
  repetitionAction: "flag" | "stop";
}

/** Everything stored for one turn. */
export interface NewTurn {
  turnNumber: number;
  speaker: Speaker;
  model: string;
  text: string;
  thinkingSummary: string | null;
  content: ContentBlock[];
  stopReason: ApiStopReason;
  /** Summed over both attempts when the turn was retried. */
  usage: TokenUsage;
  rawUsage: unknown;
  costUsd: number;
  /** The reply was cut off by max_tokens. */
  truncated: boolean;
  /** The reply had no visible text, so the other agent got the placeholder. */
  placeholderUsed: boolean;
  /** 1 normally, 2 if it was retried with double max tokens. */
  attempts: number;
  /** The max_tokens value of the attempt that was kept. */
  maxTokensUsed: number;
  /** Word-trigram overlap with the same speaker's previous message; null for each speaker's first turn. */
  repetition: number | null;
  /** True on the turn where repetition first met the stop condition (two consecutive checks at or above the threshold). */
  repetitionTriggered: boolean;
  /** The message ended with [END] on its own line (only checked when sign-off is on). */
  signedOff: boolean;
}

/** How a conversation ended. */
export interface ConversationEnd {
  status: ConversationStatus;
  stopReason: ConversationStopReason;
  error: string | null;
}

export interface ConversationResult extends ConversationEnd {
  turnsCompleted: number;
}

/**
 * Carried from a turn that was cut off with no visible text to the retry of
 * that same turn at double max tokens. The first attempt's tokens and cost
 * are added to the turn that is finally kept.
 */
export interface PendingRetry {
  turnNumber: number;
  firstAttemptUsage: TokenUsage;
  firstAttemptCostUsd: number;
}

/** The result of one step: at most one model call. */
export type TurnStep =
  /** A turn to save. `end` is set when the conversation ends with this turn. */
  | { kind: "turn"; turn: NewTurn; end: ConversationEnd | null }
  /** The reply was cut off with no visible text: call again at double max tokens. */
  | { kind: "retry"; retry: PendingRetry }
  /** The conversation ends without a new turn. */
  | { kind: "end"; end: ConversationEnd };

export interface TakeTurnInput {
  setup: ConversationSetup;
  client: ModelClient;
  /** The conversation's number in its run. Passed to the model as metadata only. */
  conversationIndex?: number;
  /** All stored turns, 1..k in order. */
  turns: TurnRecord[];
  /** Set when this call retries a truncated, empty turn. */
  retry?: PendingRetry | null;
}

function callFailed(turn: number, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Model call for turn ${turn} failed: ${msg}`;
}

/**
 * How each API stop reason is handled.
 * - continue: keep the turn and carry on.
 * - truncated: cut off by max_tokens (retry once if there is no visible text).
 * - end: keep the turn, then end the conversation as errored.
 */
export function classifyStopReason(reason: ApiStopReason): "continue" | "truncated" | "end" {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "continue";
    case "refusal":
      // Recorded on the turn and shown in the transcript; the conversation goes on.
      return "continue";
    case "max_tokens":
      return "truncated";
    case "model_context_window_exceeded":
      return "end";
    case "tool_use":
    case "pause_turn":
      // No tools are offered, so these should never happen.
      return "end";
    default:
      return "end";
  }
}

/** Overlap of turn `n` with the same speaker's previous turn (n - 2), or null if there is none. */
function selfOverlap(texts: Map<number, string>, n: number): number | null {
  if (n <= 2) return null;
  const cur = texts.get(n);
  const prev = texts.get(n - 2);
  if (cur === undefined || prev === undefined) return null;
  return trigramOverlap(cur, prev);
}

/**
 * Takes the next turn of a conversation: exactly one model call (or none, if
 * the conversation is already over). It reads nothing and writes nothing; the
 * caller stores the turn, so the same code runs inside a Workflow step and in
 * tests.
 *
 * A transient model error (rate limit, overload, dropped connection) is
 * thrown, so the caller can retry the step. Any other model error ends the
 * conversation.
 */
export async function takeTurn(input: TakeTurnInput): Promise<TurnStep> {
  const { setup, client, turns } = input;
  const t = turns.length + 1;
  if (t > setup.turns) {
    return { kind: "end", end: { status: "done", stopReason: "turn_cap", error: null } };
  }
  const retry = input.retry && input.retry.turnNumber === t ? input.retry : null;

  const speaker = speakerForTurn(t);
  const agent = speaker === "A" ? setup.agentA : setup.agentB;
  const messages = buildHistory({
    speaker,
    openingMessage: setup.openingMessage,
    attributeOpeningToB: setup.attributeOpeningToB,
    turns,
  });
  const maxTokensUsed = retry ? setup.maxTokens * 2 : setup.maxTokens;

  let response: ModelResponse;
  try {
    response = await client.call({
      model: agent.model,
      system: agent.systemPrompt.trim() ? agent.systemPrompt : undefined,
      messages,
      maxTokens: maxTokensUsed,
      effort: agent.effort,
      meta: { speaker, turnNumber: t, conversationIndex: input.conversationIndex },
    });
  } catch (err) {
    if (isTransientModelError(err)) throw err;
    return { kind: "end", end: { status: "errored", stopReason: "error", error: callFailed(t, err) } };
  }

  const text = visibleText(response.content);
  const kind = classifyStopReason(response.stopReason);
  const truncated = kind === "truncated";
  const cost = costUsd(agent.model, response.usage);

  if (truncated && text.trim() === "" && !retry) {
    // Cut off with nothing visible: retry once with double max tokens.
    return {
      kind: "retry",
      retry: { turnNumber: t, firstAttemptUsage: response.usage, firstAttemptCostUsd: cost },
    };
  }

  // Stop rules read visible text only.
  const texts = new Map<number, string>(turns.map((r) => [r.turnNumber, visibleText(r.content)]));
  texts.set(t, text);
  const repetition = selfOverlap(texts, t);
  const previous = selfOverlap(texts, t - 1);
  const repetitionHit =
    repetition !== null &&
    previous !== null &&
    repetition >= setup.repetitionThreshold &&
    previous >= setup.repetitionThreshold;
  const signedOff = setup.signOff && endsWithSignOff(text);

  const turn: NewTurn = {
    turnNumber: t,
    speaker,
    model: agent.model,
    text,
    thinkingSummary: thinkingSummary(response.content),
    content: response.content,
    stopReason: response.stopReason,
    usage: retry ? addUsage(retry.firstAttemptUsage, response.usage) : response.usage,
    rawUsage: response.rawUsage ?? null,
    costUsd: cost + (retry?.firstAttemptCostUsd ?? 0),
    truncated,
    placeholderUsed: textForOtherAgent(response.content).placeholderUsed,
    attempts: retry ? 2 : 1,
    maxTokensUsed,
    repetition,
    repetitionTriggered: repetitionHit,
    signedOff,
  };

  let end: ConversationEnd | null = null;
  if (truncated && text.trim() === "") {
    end = {
      status: "errored",
      stopReason: "error",
      error: `Turn ${t} was cut off by max tokens with no visible text, even after retrying with ${maxTokensUsed} max tokens.`,
    };
  } else if (kind === "end") {
    end = {
      status: "errored",
      stopReason: "error",
      error: `Turn ${t} ended with stop reason "${response.stopReason}", which ends the conversation.`,
    };
  } else if (signedOff) {
    end = { status: "done", stopReason: "sign_off", error: null };
  } else if (repetitionHit && setup.repetitionAction === "stop") {
    end = { status: "done", stopReason: "repetition", error: null };
  } else if (t >= setup.turns) {
    end = { status: "done", stopReason: "turn_cap", error: null };
  }
  return { kind: "turn", turn, end };
}

export interface RunConversationOptions {
  setup: ConversationSetup;
  client: ModelClient;
  conversationIndex?: number;
  /** Turns already stored (when resuming). Must be 1..k in order. */
  existingTurns?: TurnRecord[];
  /** Persist a turn. Must be idempotent on (conversation, turn number). */
  saveTurn: (turn: NewTurn) => Promise<void>;
  /** Checked before every model call. Return a reason to stop early. */
  checkBeforeCall?: () => Promise<ConversationStopReason | null>;
  /** How many times to retry a transient model error before giving up. Default 2. */
  transientRetries?: number;
}

export function endForStopReason(reason: ConversationStopReason): ConversationEnd {
  return { status: reason === "stopped_by_user" ? "stopped" : "done", stopReason: reason, error: null };
}

/**
 * Runs a whole conversation in one process by calling takeTurn in a loop.
 * Used by tests and local tooling; deployed runs go through Workflow, which
 * calls takeTurn once per step instead.
 */
export async function runConversation(opts: RunConversationOptions): Promise<ConversationResult> {
  const turns: TurnRecord[] = [...(opts.existingTurns ?? [])];
  const maxTransient = opts.transientRetries ?? 2;
  let retry: PendingRetry | null = null;
  let transientFailures = 0;

  for (;;) {
    const early = opts.checkBeforeCall ? await opts.checkBeforeCall() : null;
    if (early) return { ...endForStopReason(early), turnsCompleted: turns.length };

    let step: TurnStep;
    try {
      step = await takeTurn({ setup: opts.setup, client: opts.client, conversationIndex: opts.conversationIndex, turns, retry });
    } catch (err) {
      if (isTransientModelError(err) && transientFailures < maxTransient) {
        transientFailures++;
        continue;
      }
      return { status: "errored", stopReason: "error", error: callFailed(turns.length + 1, err), turnsCompleted: turns.length };
    }
    transientFailures = 0;

    if (step.kind === "retry") {
      retry = step.retry;
      continue;
    }
    if (step.kind === "end") return { ...step.end, turnsCompleted: turns.length };

    await opts.saveTurn(step.turn);
    turns.push({ turnNumber: step.turn.turnNumber, speaker: step.turn.speaker, content: step.turn.content });
    retry = null;
    if (step.end) return { ...step.end, turnsCompleted: turns.length };
  }
}

