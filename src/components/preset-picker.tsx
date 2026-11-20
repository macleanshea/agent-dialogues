"use client";

import { useState, useTransition } from "react";
import { savePresetAction } from "@/app/presets/actions";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import type { PresetKind, PresetOption } from "@/lib/presets/kinds";

/**
 * Under a system prompt or the opening message on the run form: a list to
 * load a saved preset into the box, and "Save as preset" to save what is in
 * the box now.
 */
export function PresetPicker({
  id,
  label,
  kind,
  presets,
  text,
  disabled,
  onLoad,
  onSaved,
}: {
  /** Used for element ids, e.g. "a-system". */
  id: string;
  /** What the box is, e.g. "System prompt A". */
  label: string;
  kind: PresetKind;
  presets: PresetOption[];
  text: string;
  disabled?: boolean;
  onLoad: (text: string) => void;
  onSaved: (preset: PresetOption) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const options = presets.filter((p) => p.kind === kind);

  const save = () =>
    startTransition(async () => {
      const res = await savePresetAction({ kind, name, text });
      if (res.ok) {
        onSaved(res.preset);
        setSaving(false);
        setName("");
        setError(null);
      } else {
        setError(Object.values(res.errors)[0] ?? "Could not save the preset.");
      }
    });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-60 max-w-full">
        <Select
          id={`${id}-preset`}
          aria-label={`${label} preset`}
          className="py-1 text-xs"
          disabled={disabled}
          value=""
          onChange={(e) => {
            const p = options.find((o) => o.id === e.target.value);
            if (p) onLoad(p.text);
          }}
        >
          <option value="">Load preset…</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        </div>
        {!saving && (
          <Button
            type="button"
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => setSaving(true)}
            aria-label={`Save ${label} as preset`}
          >
            Save as preset
          </Button>
        )}
      </div>
      {saving && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Name for the ${label} preset`}
            className="w-56 py-1 text-xs"
            placeholder="Preset name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Enter saves the preset instead of submitting the run form.
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
          />
          <Button type="button" className="px-2.5 py-1 text-xs" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => {
              setSaving(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          {error && (
            <p className="w-full text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
