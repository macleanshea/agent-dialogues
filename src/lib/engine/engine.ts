import { costUsd, type Effort, type TokenUsage } from "../models";
import { buildHistory, speakerForTurn, textForOtherAgent, thinkingSummary, visibleText } from "./history";
import type {
  ApiStopReason,
  ContentBlock,
  ConversationStatus,
  ConversationStopReason,
  ModelClient,
  ModelResponse,
  Speaker,
  TurnRecord,
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
}

export interface ConversationResult {
  status: ConversationStatus;
  stopReason: ConversationStopReason;
  error: string | null;
  turnsCompleted: number;
}

export interface RunConversationOptions {
  setup: ConversationSetup;
  client: ModelClient;
  /** The conversation's number in its run. Passed to the model as metadata only. */
  conversationIndex?: number;
  /** Turns already stored (when resuming). Must be 1..k in order. */
  existingTurns?: TurnRecord[];
  /** Persist a turn. Must be idempotent on (conversation, turn number). */
  saveTurn: (turn: NewTurn) => Promise<void>;
  /** Checked before every model call. Return a reason to stop early. */
  checkBeforeCall?: () => Promise<ConversationStopReason | null>;
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

export async function runConversation(opts: RunConversationOptions): Promise<ConversationResult> {
  const { setup, client } = opts;
  const turns: TurnRecord[] = [...(opts.existingTurns ?? [])];

  for (let t = turns.length + 1; t <= setup.turns; t++) {
    const speaker = speakerForTurn(t);
    const agent = speaker === "A" ? setup.agentA : setup.agentB;

    const early = opts.checkBeforeCall ? await opts.checkBeforeCall() : null;
    if (early) {
      return {
        status: early === "stopped_by_user" ? "stopped" : "done",
        stopReason: early,
        error: null,
        turnsCompleted: turns.length,
      };
    }

    const messages = buildHistory({
      speaker,
      openingMessage: setup.openingMessage,
      attributeOpeningToB: setup.attributeOpeningToB,
      turns,
    });

    const call = (maxTokens: number) =>
      client.call({
        model: agent.model,
        system: agent.systemPrompt.trim() ? agent.systemPrompt : undefined,
        messages,
        maxTokens,
        effort: agent.effort,
        meta: { speaker, turnNumber: t, conversationIndex: opts.conversationIndex },
      });

    let response: ModelResponse;
    let maxTokensUsed = setup.maxTokens;
    let attempts = 1;
    let extraCost = 0;
    try {
      response = await call(maxTokensUsed);
      let kind = classifyStopReason(response.stopReason);
      if (kind === "truncated" && visibleText(response.content).trim() === "") {
        // Cut off with nothing visible: retry once with double max tokens.
        // The first attempt still cost money, so carry its cost forward.
        extraCost = costUsd(agent.model, response.usage);
        maxTokensUsed = setup.maxTokens * 2;
        attempts = 2;
        response = await call(maxTokensUsed);
        kind = classifyStopReason(response.stopReason);
      }
    } catch (err) {
      return { status: "errored", stopReason: "error", error: callFailed(t, err), turnsCompleted: turns.length };
    }

    const text = visibleText(response.content);
    const kind = classifyStopReason(response.stopReason);
    const truncated = kind === "truncated";
    const turn: NewTurn = {
      turnNumber: t,
      speaker,
      model: agent.model,
      text,
      thinkingSummary: thinkingSummary(response.content),
      content: response.content,
      stopReason: response.stopReason,
      usage: response.usage,
      rawUsage: response.rawUsage ?? null,
      costUsd: costUsd(agent.model, response.usage) + extraCost,
      truncated,
      placeholderUsed: textForOtherAgent(response.content).placeholderUsed,
      attempts,
      maxTokensUsed,
    };
    await opts.saveTurn(turn);
    turns.push({ turnNumber: t, speaker, content: response.content });

    if (truncated && text.trim() === "") {
      return {
        status: "errored",
        stopReason: "error",
        error: `Turn ${t} was cut off by max tokens with no visible text, even after retrying with ${maxTokensUsed} max tokens.`,
        turnsCompleted: turns.length,
      };
    }
    if (kind === "end") {
      return {
        status: "errored",
        stopReason: "error",
        error: `Turn ${t} ended with stop reason "${response.stopReason}", which ends the conversation.`,
        turnsCompleted: turns.length,
      };
    }
  }

  return { status: "done", stopReason: "turn_cap", error: null, turnsCompleted: turns.length };
}
