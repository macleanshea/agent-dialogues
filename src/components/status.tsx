import { Badge, type Tone } from "@/components/ui/badge";
import type { ConversationStatus, ConversationStopReason } from "@/lib/engine/types";
import type { RunStatus } from "@/lib/db/schema";

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  queued: "neutral",
  pending: "neutral",
  running: "info",
  done: "success",
  failed: "danger",
  errored: "danger",
  stopped: "warning",
  mixed: "neutral",
};

export function StatusBadge({ status }: { status: RunStatus | ConversationStatus | "mixed" }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;
}

export const STOP_REASON_LABEL: Record<ConversationStopReason, string> = {
  turn_cap: "Turn cap reached",
  repetition: "Repetition",
  sign_off: "Sign-off",
  error: "Error",
  cost_ceiling: "Cost ceiling reached",
  stopped_by_user: "Stopped by user",
};

export function stopReasonLabel(r: ConversationStopReason | null | undefined): string {
  return r ? (STOP_REASON_LABEL[r] ?? r) : "—";
}
