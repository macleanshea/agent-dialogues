import { NO_REPLY_PLACEHOLDER, OPENING_STUB } from "../config";
import type { AgentMessage, ContentBlock, Speaker, TextBlock, ThinkingBlock, TurnRecord } from "./types";

export function speakerForTurn(turnNumber: number): Speaker {
  return turnNumber % 2 === 1 ? "A" : "B";
}

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text" && typeof (b as TextBlock).text === "string";
}

export function isThinkingBlock(b: ContentBlock): b is ThinkingBlock {
  return b.type === "thinking";
}

/** Visible text: all text blocks, selected by type, joined in order. */
export function visibleText(content: ContentBlock[]): string {
  return content.filter(isTextBlock).map((b) => b.text).join("");
}

/** The readable thinking summary, if the response included one. */
export function thinkingSummary(content: ContentBlock[]): string | null {
  const parts = content
    .filter(isThinkingBlock)
    .map((b) => b.thinking)
    .filter((t) => t.trim().length > 0);
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * What the other agent receives: only the text, as fresh text blocks
 * (no thinking, no citations or other metadata). An empty reply becomes the
 * placeholder.
 */
export function textForOtherAgent(content: ContentBlock[]): { blocks: TextBlock[]; placeholderUsed: boolean } {
  const text = visibleText(content);
  if (text.trim().length === 0) {
    return { blocks: [{ type: "text", text: NO_REPLY_PLACEHOLDER }], placeholderUsed: true };
  }
  return { blocks: [{ type: "text", text }], placeholderUsed: false };
}

export interface HistoryInput {
  speaker: Speaker;
  openingMessage: string;
  attributeOpeningToB: boolean;
  /** All earlier turns of the conversation, in order. */
  turns: TurnRecord[];
}

/**
 * Builds the message list one agent sees before it speaks.
 *
 * - Its own turns are assistant messages that replay the raw content blocks.
 * - The other agent's turns are user messages with text only.
 * - A starts with the opening message as a user turn.
 * - B never sees the opening message, unless it is attributed to B, in which
 *   case B's history starts with the stub (user) and then the opening message
 *   as B's own assistant turn.
 *
 * Histories are rebuilt from stored turns, which never change, so each
 * agent's history only ever grows at the end (append-only).
 */
export function buildHistory(input: HistoryInput): AgentMessage[] {
  const messages: AgentMessage[] = [];
  if (input.speaker === "A") {
    messages.push({ role: "user", content: [{ type: "text", text: input.openingMessage }] });
  } else if (input.attributeOpeningToB) {
    messages.push({ role: "user", content: [{ type: "text", text: OPENING_STUB }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: input.openingMessage }] });
  }

  for (const turn of input.turns) {
    if (turn.speaker === input.speaker) {
      messages.push({ role: "assistant", content: turn.content });
    } else {
      messages.push({ role: "user", content: textForOtherAgent(turn.content).blocks });
    }
  }
  return messages;
}
