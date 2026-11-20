import type { ConversationStopReason } from "../engine/types";

/** Plain-language stop reasons, shared by the pages and the prompts. */
export const STOP_REASON_TEXT: Record<ConversationStopReason, string> = {
  turn_cap: "Turn cap reached",
  repetition: "Repetition",
  sign_off: "Sign-off",
  error: "Error",
  cost_ceiling: "Cost ceiling reached",
  stopped_by_user: "Stopped by user",
};
