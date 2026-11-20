"use client";

import { useState, useTransition } from "react";
import { createFieldAction, deleteFieldAction } from "@/app/fields/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { FIELD_GROUPS, type FieldType } from "@/lib/fields/library";
import type { PickerField } from "@/lib/fields/picker";

const TYPE_LABELS: Record<FieldType, string> = {
  yes_no: "Yes/no",
  category: "Category",
  multi_select: "Multi-select",
  scale: "Scale 1 to 5",
  tags: "Tags",
  short_text: "Short text",
  turn_ranges: "Turn ranges",
};

const NEEDS_VALUES: FieldType[] = ["category", "multi_select", "turn_ranges"];


function describeOptions(f: PickerField): string {
  const o = f.options;
  if (o.values?.length) return o.values.join(" · ");
  if (f.type === "tags") return `up to ${o.maxItems ?? 5} tags`;
  if (f.type === "scale") return `1${o.minLabel ? ` ${o.minLabel}` : ""} to 5${o.maxLabel ? ` ${o.maxLabel}` : ""}`;
  return "";
}

const EMPTY_DRAFT = {
  name: "",
  type: "yes_no" as FieldType,
  scope: "conversation" as "conversation" | "per_speaker",
  group: "Content" as (typeof FIELD_GROUPS)[number],
  definition: "",
  values: "",
  maxItems: "5",
  minLabel: "",
  maxLabel: "",
};

/** The "+ New field" form. Not a <form> element, because it sits inside the run form. */
function NewFieldForm({ onCreated, onCancel }: { onCreated: (f: PickerField) => void; onCancel: () => void }) {
  const [d, setD] = useState(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((p) => ({ ...p, [k]: v }));

  const save = () =>
    startTransition(async () => {
      const r = await createFieldAction({ ...d, values: d.values.split("\n") });
      if (r.ok) {
        setD(EMPTY_DRAFT);
        setErrors({});
        onCreated(r.field);
      } else {
        setErrors(r.errors);
      }
    });

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-muted/40 p-4" data-testid="new-field-form">
      <div className="text-sm font-semibold">New field</div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="nf-name" hint="Lowercase, digits, and underscores, e.g. mentions_weather." error={errors.name}>
          <Input id="nf-name" value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="mentions_weather" />
        </Field>
        <Field label="Type" htmlFor="nf-type" error={errors.type}>
          <Select id="nf-type" value={d.type} onChange={(e) => set("type", e.target.value as FieldType)}>
            {Object.entries(TYPE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Scope" htmlFor="nf-scope" hint="Per speaker codes A and B separately." error={errors.scope}>
          <Select id="nf-scope" value={d.scope} onChange={(e) => set("scope", e.target.value as typeof d.scope)}>
            <option value="conversation">Conversation</option>
            <option value="per_speaker">Per speaker</option>
          </Select>
        </Field>
        <Field label="Group" htmlFor="nf-group" hint="Where it is listed in the picker." error={errors.group}>
          <Select id="nf-group" value={d.group} onChange={(e) => set("group", e.target.value as typeof d.group)}>
            {FIELD_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Definition" htmlFor="nf-definition" hint="One sentence, written for the judge." error={errors.definition}>
        <Textarea id="nf-definition" rows={2} className="min-h-0 font-sans text-sm" value={d.definition} onChange={(e) => set("definition", e.target.value)} />
      </Field>
      {NEEDS_VALUES.includes(d.type) && (
        <Field
          label={d.type === "turn_ranges" ? "Themes" : "Options"}
          htmlFor="nf-values"
          hint="One per line. At least two."
          error={errors.values}
        >
          <Textarea id="nf-values" rows={4} className="min-h-0 font-sans text-sm" value={d.values} onChange={(e) => set("values", e.target.value)} />
        </Field>
      )}
      {d.type === "tags" && (
        <Field label="Most tags" htmlFor="nf-max" error={errors.maxItems}>
          <Input id="nf-max" type="number" min={1} max={10} value={d.maxItems} onChange={(e) => set("maxItems", e.target.value)} />
        </Field>
      )}
      {d.type === "scale" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What 1 means" htmlFor="nf-min" error={errors.minLabel}>
            <Input id="nf-min" value={d.minLabel} onChange={(e) => set("minLabel", e.target.value)} placeholder="e.g. constant pushback" />
          </Field>
          <Field label="What 5 means" htmlFor="nf-maxl" error={errors.maxLabel}>
            <Input id="nf-maxl" value={d.maxLabel} onChange={(e) => set("maxLabel", e.target.value)} placeholder="e.g. constant deference" />
          </Field>
        </div>
      )}
      {errors.form && <p className="text-xs text-destructive">{errors.form}</p>}
      <div className="flex gap-2">
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save field"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Every field in the library, in groups, with tick boxes. Custom fields sit in
 * their group like any other, marked only by a small "custom" label.
 */
export function FieldPicker({
  fields: initialFields,
  selected,
  onChange,
  error,
}: {
  fields: PickerField[];
  selected: string[];
  onChange: (names: string[]) => void;
  error?: string;
}) {
  const [fields, setFields] = useState(initialFields);
  const [adding, setAdding] = useState(false);
  const [deleting, startDelete] = useTransition();
  const chosen = new Set(selected);
  const groups = [...FIELD_GROUPS, ...new Set(fields.map((f) => f.group).filter((g) => !(FIELD_GROUPS as string[]).includes(g)))];

  const toggle = (name: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(name);
    else next.delete(name);
    // Keep library order.
    onChange(fields.map((f) => f.name).filter((n) => next.has(n)));
  };
  const remove = (f: PickerField) => {
    if (!window.confirm(`Delete the custom field "${f.name}" from the library? Analyses that already used it keep their copy and their codings.`)) return;
    startDelete(async () => {
      const r = await deleteFieldAction(f.name);
      if (!r.ok) return;
      setFields((prev) => prev.filter((x) => x.name !== f.name));
      onChange(selected.filter((n) => n !== f.name));
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="field-picker">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Fields</span>
        <span className="text-xs text-muted-foreground" data-testid="field-count">
          {selected.length} selected
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={() => onChange(fields.map((f) => f.name))}>
            Select all
          </Button>
          <Button type="button" variant="ghost" onClick={() => onChange([])}>
            Deselect all
          </Button>
          <Button type="button" variant="secondary" onClick={() => setAdding(true)} disabled={adding}>
            + New field
          </Button>
        </div>
      </div>
      <div className="-mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          Each ticked field is a question the judge answers the same way for every conversation, so the answers can be counted and charted
          across the run. Every conversation also gets a summary, findings on the analysis focus, and the most notable thing, whatever is ticked.
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {adding && (
        <NewFieldForm
          onCancel={() => setAdding(false)}
          onCreated={(f) => {
            setFields((prev) => [...prev, f]);
            onChange([...selected, f.name]);
            setAdding(false);
          }}
        />
      )}
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {groups.map((g) => {
          const inGroup = fields.filter((f) => f.group === g);
          if (inGroup.length === 0) return null;
          return (
            <fieldset key={g} className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</legend>
              {inGroup.map((f) => (
                <label key={f.name} className="flex cursor-pointer items-start gap-2.5" data-testid="field-option">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
                    checked={chosen.has(f.name)}
                    onChange={(e) => toggle(f.name, e.target.checked)}
                    aria-label={f.name}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm">{f.name}</span>
                      {!f.builtin && <Badge>custom</Badge>}
                      {!f.builtin && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline hover:text-destructive disabled:opacity-50"
                          onClick={(e) => {
                            e.preventDefault();
                            remove(f);
                          }}
                          disabled={deleting}
                          aria-label={`Delete ${f.name}`}
                        >
                          delete
                        </button>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {TYPE_LABELS[f.type]} · {f.scope === "per_speaker" ? "per speaker" : "conversation"}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{f.definition}</span>
                    {describeOptions(f) && <span className="text-xs text-muted-foreground/80 italic">{describeOptions(f)}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
