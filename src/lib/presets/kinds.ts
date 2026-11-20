/** Preset kinds and their labels. No database imports, so pages in the browser can use it. */
export type PresetKind = "system_prompt" | "opening_message";

export const PRESET_KINDS: PresetKind[] = ["system_prompt", "opening_message"];
export const PRESET_KIND_LABELS: Record<PresetKind, string> = {
  system_prompt: "System prompt",
  opening_message: "Opening message",
};

/** A preset as the run form uses it: plain data, safe to pass to the browser. */
export interface PresetOption {
  id: string;
  kind: PresetKind;
  name: string;
  text: string;
  builtin: boolean;
}
