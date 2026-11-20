import type { FieldOptions, FieldScope, FieldType, PresetKey } from "./library";

/** What the field picker needs to know about a field. Plain data, safe to send to the browser. */
export interface PickerField {
  name: string;
  type: FieldType;
  scope: FieldScope;
  group: string;
  definition: string;
  options: FieldOptions;
  builtin: boolean;
  presets: PresetKey[];
}

export function toPickerField(r: {
  name: string;
  type: FieldType;
  scope: FieldScope;
  group: string;
  definition: string;
  options: FieldOptions;
  builtin: boolean;
  presets: PresetKey[];
}): PickerField {
  return {
    name: r.name,
    type: r.type,
    scope: r.scope,
    group: r.group,
    definition: r.definition,
    options: r.options,
    builtin: r.builtin,
    presets: r.presets,
  };
}
