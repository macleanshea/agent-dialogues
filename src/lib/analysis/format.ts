/**
 * Turns stored data into the text blocks the prompts in prompts.ts insert:
 * transcripts, codings, aggregates, and computed measures.
 */
import { NO_REPLY_PLACEHOLDER } from "../config";
import { conversationId, runId } from "../ids";
import { STOP_REASON_TEXT } from "./labels";
import type { CodingOutput, FieldAggregate } from "./fields";
import type { ConversationMeasures } from "./measures";
import type { ConversationStopReason, Speaker } from "../engine/types";

export interface TranscriptTurn {
  turnNumber: number;
  speaker: Speaker;
  text: string;
  thinkingSummary: string | null;
}

/**
 * One line block per turn, as "[T7] A: text". Thinking summaries are included
 * only when the judge may read them, and are marked private.
 */
export function formatTranscript(turns: TranscriptTurn[], opts: { includeThinking: boolean }): string {
  if (turns.length === 0) return "(No turns.)";
  return turns
    .map((t) => {
      const lines: string[] = [];
      if (opts.includeThinking && t.thinkingSummary) {
        lines.push(`[T${t.turnNumber}] ${t.speaker} thinking summary (private to ${t.speaker}): ${t.thinkingSummary}`);
      }
      const body = t.text.trim()
        ? t.text
        : `(no visible text; the other agent was shown "${NO_REPLY_PLACEHOLDER}")`;
      lines.push(`[T${t.turnNumber}] ${t.speaker}: ${body}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function promptOrNone(p: string): string {
  return p.trim() ? p : "(none)";
}

/** One coding, compact, for the report writer. */
export function formatCodingForReport(run: number, conversation: number, turnsCompleted: number, stop: ConversationStopReason | null, c: CodingOutput): string {
  const id = `${runId(run)}·${conversationId(conversation)}`;
  return `<coding id="${id}" turns="${turnsCompleted}" stop="${stop ? STOP_REASON_TEXT[stop] : "none"}">\n${JSON.stringify(c)}\n</coding>`;
}

export function formatMeasuresLine(run: number, conversation: number, m: ConversationMeasures): string {
  const signOffs = m.signOffs.length ? m.signOffs.map((s) => `${s.speaker} at T${s.turn}`).join(", ") : "none";
  const sp = (s: Speaker) =>
    `${s}: ${m.bySpeaker[s].turns} turns, mean visible length ${Math.round(m.bySpeaker[s].meanVisibleLength)} chars, ${m.bySpeaker[s].totalTokens} tokens, ${m.bySpeaker[s].thinkingTokens} thinking tokens`;
  return `${runId(run)}·${conversationId(conversation)}: ${m.turnsCompleted} turns; stop: ${
    m.stopReason ? STOP_REASON_TEXT[m.stopReason] : "none"
  }; truncated ${m.truncatedCount}; empty replies ${m.emptyReplyCount}; repetition first flagged ${
    m.repetitionFlagTurn ? `at T${m.repetitionFlagTurn}` : "never"
  }; sign-offs ${signOffs}. ${sp("A")}. ${sp("B")}.`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The run-page aggregates as plain text. */
export function formatAggregates(aggs: FieldAggregate[]): string {
  if (aggs.length === 0) return "(No fields were selected.)";
  const lines: string[] = [];
  for (const { def, slots } of aggs) {
    for (const { slot, aggregates } of slots) {
      const label = slot === "all" ? def.name : `${def.name} (${slot})`;
      for (const a of aggregates) {
        switch (a.kind) {
          case "yes_no":
            lines.push(`${label}: yes in ${a.yes} of ${a.n}; median first turn ${a.medianFirstTurn ?? "n/a"}.`);
            break;
          case "distribution":
            lines.push(
              `${label}${a.part ? ` [${a.part}]` : ""}: ${a.counts.map((c) => `${c.value} ${c.count} of ${a.n}`).join("; ")}.`,
            );
            break;
          case "scale":
            lines.push(
              `${label}: median ${a.median ?? "n/a"}, range ${a.min ?? "n/a"} to ${a.max ?? "n/a"} (${a.answered} of ${a.n} gave a value).`,
            );
            break;
          case "frequency":
            lines.push(`${label}: ${a.counts.slice(0, 25).map((c) => `${c.value} ${c.count} of ${a.n}`).join("; ") || "none"}.`);
            break;
          case "texts":
            lines.push(`${label}: free text, ${a.items.length} of ${a.n} gave one (see codings).`);
            break;
          case "turn_ranges":
            lines.push(
              `${label}: ${a.series
                .map((s) => {
                  const peak = s.points.reduce((m, p) => (p.share > m.share ? p : m), { turn: 0, share: 0, n: 0 });
                  return peak.share > 0 ? `${s.value} peaks at ${pct(peak.share)} of conversations at T${peak.turn}` : `${s.value} never`;
                })
                .join("; ")}.`,
            );
            break;
        }
      }
    }
  }
  return lines.join("\n");
}
