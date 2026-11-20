import { Badge, type Tone } from "@/components/ui/badge";
import type { ConversationStatus, ConversationStopReason } from "@/lib/engine/types";
import type { AnalysisStatus, RunStatus } from "@/lib/db/schema";
import { STOP_REASON_TEXT } from "@/lib/analysis/labels";

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

export function StatusBadge({ status }: { status: RunStatus | ConversationStatus | "mixed" | AnalysisStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;
}

export const STOP_REASON_LABEL = STOP_REASON_TEXT;

export function stopReasonLabel(r: ConversationStopReason | null | undefined): string {
  return r ? (STOP_REASON_LABEL[r] ?? r) : "—";
}
