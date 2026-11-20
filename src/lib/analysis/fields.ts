/**
 * One code path for every field, built-in or custom.
 *
 * Each field type has exactly one entry in FIELD_TYPES, which says how that
 * type is:
 *   - described to the summarizer (the prompt's {{field_definitions}}),
 *   - expressed in the JSON schema the summarizer must follow,
 *   - normalized into what is stored, and
 *   - aggregated on the run page.
 * Nothing here looks at a field's name or its built-in flag, so a custom field
 * is coded, stored, and aggregated exactly like a predefined one.
 */
import { z } from "zod";
import type { FieldOptions, FieldScope, FieldType } from "../fields/library";

/** A field definition as an analysis version snapshots it. */
export interface FieldDef {
  name: string;
  type: FieldType;
  scope: FieldScope;
  options: FieldOptions;
  definition: string;
}

export interface TurnRange {
  value: string;
  from: number;
  to: number;
}

export type FieldValue = boolean | number | string | string[] | TurnRange[] | Record<string, string | null> | null;

/** One coded value with its evidence. */
export interface FieldEntry {
  value: FieldValue;
  /** Turn citations, as "T7" or "T7-T9". */
  turns: string[];
  reason: string;
  /** Yes/no and single-value category fields: the first turn where the value applies. */
  firstTurn: number | null;
  /** Fields whose definition asks for the turn where the value changes. */
  changeTurn: number | null;
}

/** "all" for conversation-scope fields; "A" and "B" for per-speaker fields. */
export type Slot = "all" | "A" | "B";

export type StoredField = Partial<Record<Slot, FieldEntry>>;

export function slotsFor(scope: FieldScope): Slot[] {
  return scope === "per_speaker" ? ["A", "B"] : ["all"];
}

// ---------- JSON schema pieces ----------

type Json = Record<string, unknown>;

/**
 * The API compiles the schema into a grammar and rejects one that grows too
 * large. Enums and regex patterns are what make it grow, so the schema only
 * fixes the shape (keys and basic types). Allowed values are listed in each
 * property's description and in the prompt, and checked in code when stored.
 */
export const TURNS_SCHEMA: Json = {
  type: "array",
  items: { type: "string", description: 'A turn or span, like "T7" or "T7-T9".' },
};

const obj = (properties: Json, order?: string[]): Json => ({
  type: "object",
  properties,
  required: order ?? Object.keys(properties),
  additionalProperties: false,
});

/** A choice from a list, as a plain string. "" means none applies. */
const choice = (values: readonly string[]): Json => ({
  type: "string",
  description: `One of ${JSON.stringify(values)}, or "" if none applies.`,
});
/** An item of a list of choices. */
const choiceItem = (values: readonly string[]): Json => ({ type: "string", description: `One of ${JSON.stringify(values)}.` });

// ---------- Aggregates ----------

export interface Count {
  value: string;
  count: number;
}

export type Aggregate =
  | { kind: "yes_no"; yes: number; n: number; medianFirstTurn: number | null }
  | { kind: "distribution"; part: string | null; counts: Count[]; n: number }
  | { kind: "scale"; median: number | null; min: number | null; max: number | null; n: number; answered: number; min_label?: string; max_label?: string }
  | { kind: "frequency"; counts: Count[]; n: number }
  | { kind: "texts"; items: Array<{ conversation: number; text: string }>; n: number }
  | { kind: "turn_ranges"; series: Array<{ value: string; points: Array<{ turn: number; share: number; n: number }> }>; n: number };

/** What aggregation needs from one coded conversation. */
export interface CodedConversation {
  conversation: number;
  turnsCompleted: number;
  entry: FieldEntry | undefined;
}

// ---------- Helpers ----------

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Matches a returned value to an allowed one, ignoring case (the API does not guarantee enum casing). */
function canonical(values: readonly string[] | undefined, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hit = (values ?? []).find((v) => v.toLowerCase() === raw.trim().toLowerCase());
  return hit ?? null;
}

function turnOrNull(raw: unknown, maxTurn: number): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= maxTurn ? n : null;
}

function counts(values: string[], order?: readonly string[]): Count[] {
  const m = new Map<string, number>();
  for (const v of order ?? []) m.set(v, 0);
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  const out = [...m.entries()].map(([value, count]) => ({ value, count }));
  return order ? out : out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const NOT_APPLICABLE = "(not applicable)";

// ---------- The registry ----------

interface TypeHandler {
  label: string;
  /** Lines that explain the value to the summarizer. */
  describe(def: FieldDef): string[];
  /** JSON schema for `value`. */
  valueSchema(def: FieldDef): Json;
  /** Whether the entry carries first_turn. */
  hasFirstTurn(def: FieldDef): boolean;
  /** Turns the raw value into what is stored. */
  normalize(def: FieldDef, raw: unknown, maxTurn: number): FieldValue;
  aggregate(def: FieldDef, rows: CodedConversation[]): Aggregate[];
  /** Short display of a stored value. */
  format(def: FieldDef, value: FieldValue): string;
}

const parts = (def: FieldDef) => def.options.parts ?? [];

export const FIELD_TYPES: Record<FieldType, TypeHandler> = {
  yes_no: {
    label: "Yes/no",
    describe: () => [
      "Value: true or false.",
      "first_turn: the turn where it first happens, or 0 if it never happens.",
    ],
    valueSchema: () => ({ type: "boolean" }),
    hasFirstTurn: () => true,
    normalize: (_d, raw) => (typeof raw === "boolean" ? raw : null),
    aggregate: (_d, rows) => {
      const coded = rows.filter((r) => r.entry);
      const yes = coded.filter((r) => r.entry?.value === true);
      const firsts = yes.map((r) => r.entry?.firstTurn).filter((t): t is number => typeof t === "number");
      return [{ kind: "yes_no", yes: yes.length, n: coded.length, medianFirstTurn: median(firsts) }];
    },
    format: (_d, v) => (v === true ? "yes" : v === false ? "no" : "—"),
  },

  category: {
    label: "Category",
    describe: (def) => {
      const lines = [`Values: ${(def.options.values ?? []).map((v) => JSON.stringify(v)).join(", ")}. Choose one, or "" if none applies.`];
      if (parts(def).length) {
        lines.push(`Give one value for each of: ${parts(def).join(", ")}.`);
      } else {
        lines.push("first_turn: the turn where the chosen value first applies, or 0 if none.");
      }
      if (def.options.recordChangeTurn) {
        lines.push("change_turn: the turn where this changes, or 0 if it does not change.");
      }
      return lines;
    },
    valueSchema: (def) => {
      const c = choice(def.options.values ?? []);
      if (!parts(def).length) return c;
      return obj(Object.fromEntries(parts(def).map((p) => [p, c])));
    },
    hasFirstTurn: (def) => parts(def).length === 0,
    normalize: (def, raw) => {
      if (!parts(def).length) return canonical(def.options.values, raw);
      const r = (raw ?? {}) as Record<string, unknown>;
      return Object.fromEntries(parts(def).map((p) => [p, canonical(def.options.values, r[p])]));
    },
    aggregate: (def, rows) => {
      const coded = rows.filter((r) => r.entry);
      const order = [...(def.options.values ?? []), NOT_APPLICABLE];
      const partList = parts(def).length ? parts(def) : [null];
      return partList.map((part) => {
        const vals = coded.map((r) => {
          const v = part ? (r.entry?.value as Record<string, string | null> | null)?.[part] : r.entry?.value;
          return typeof v === "string" ? v : NOT_APPLICABLE;
        });
        return { kind: "distribution" as const, part, counts: counts(vals, order).filter((c) => c.count > 0 || c.value !== NOT_APPLICABLE), n: coded.length };
      });
    },
    format: (def, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return parts(def).map((p) => `${p}: ${(v as Record<string, string | null>)[p] ?? "—"}`).join(" · ");
      }
      return typeof v === "string" ? v : "—";
    },
  },

  multi_select: {
    label: "Multi-select",
    describe: (def) => [
      `Values: ${(def.options.values ?? []).map((v) => JSON.stringify(v)).join(", ")}. Choose all that apply, as a list.`,
    ],
    valueSchema: (def) => ({ type: "array", items: choiceItem(def.options.values ?? []) }),
    hasFirstTurn: () => false,
    normalize: (def, raw) =>
      Array.isArray(raw)
        ? [...new Set(raw.map((x) => canonical(def.options.values, x)).filter((x): x is string => x !== null))]
        : [],
    aggregate: (def, rows) => {
      const coded = rows.filter((r) => r.entry);
      const vals = coded.flatMap((r) => (Array.isArray(r.entry?.value) ? (r.entry?.value as string[]) : []));
      return [{ kind: "distribution", part: null, counts: counts(vals, def.options.values), n: coded.length }];
    },
    format: (_d, v) => (Array.isArray(v) && v.length ? (v as string[]).join(", ") : "—"),
  },

  scale: {
    label: "Scale 1 to 5",
    describe: (def) => {
      const lo = def.options.minLabel ? ` (${def.options.minLabel})` : "";
      const hi = def.options.maxLabel ? ` (${def.options.maxLabel})` : "";
      return [`Value: a whole number from 1${lo} to 5${hi}, or 0 if it does not apply.`];
    },
    valueSchema: () => ({ type: "integer", description: "1 to 5, or 0 if it does not apply." }),
    hasFirstTurn: () => false,
    normalize: (_d, raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : null),
    aggregate: (def, rows) => {
      const coded = rows.filter((r) => r.entry);
      const xs = coded.map((r) => r.entry?.value).filter((v): v is number => typeof v === "number");
      return [
        {
          kind: "scale",
          median: median(xs),
          min: xs.length ? Math.min(...xs) : null,
          max: xs.length ? Math.max(...xs) : null,
          n: coded.length,
          answered: xs.length,
          min_label: def.options.minLabel,
          max_label: def.options.maxLabel,
        },
      ];
    },
    format: (_d, v) => (typeof v === "number" ? String(v) : "—"),
  },

  tags: {
    label: "Tags",
    describe: (def) => [`Value: up to ${def.options.maxItems ?? 5} short tags, lowercase, one to three words each.`],
    valueSchema: () => ({ type: "array", items: { type: "string" } }),
    hasFirstTurn: () => false,
    normalize: (def, raw) =>
      Array.isArray(raw)
        ? [...new Set(raw.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(
            0,
            def.options.maxItems ?? 5,
          )
        : [],
    aggregate: (_d, rows) => {
      const coded = rows.filter((r) => r.entry);
      const vals = coded.flatMap((r) => (Array.isArray(r.entry?.value) ? (r.entry?.value as string[]) : []));
      return [{ kind: "frequency", counts: counts(vals), n: coded.length }];
    },
    format: (_d, v) => (Array.isArray(v) && v.length ? (v as string[]).join(", ") : "—"),
  },

  short_text: {
    label: "Short text",
    describe: () => ['Value: one short sentence, or "" if it does not apply.'],
    valueSchema: () => ({ type: "string" }),
    hasFirstTurn: () => false,
    normalize: (_d, raw) => (typeof raw === "string" && raw.trim() ? raw.trim() : null),
    aggregate: (_d, rows) => {
      const coded = rows.filter((r) => r.entry);
      return [
        {
          kind: "texts",
          items: coded
            .filter((r) => typeof r.entry?.value === "string")
            .map((r) => ({ conversation: r.conversation, text: r.entry?.value as string })),
          n: coded.length,
        },
      ];
    },
    format: (_d, v) => (typeof v === "string" ? v : "—"),
  },

  turn_ranges: {
    label: "Turn ranges",
    describe: (def) => [
      `Values: ${(def.options.values ?? []).map((v) => JSON.stringify(v)).join(", ")}.`,
      "Give a list of {value, from, to}: each value with the turns it covers. A value may appear more than once, and ranges may overlap.",
    ],
    valueSchema: (def) => ({
      type: "array",
      items: obj({ value: choiceItem(def.options.values ?? []), from: { type: "integer" }, to: { type: "integer" } }),
    }),
    hasFirstTurn: () => false,
    normalize: (def, raw, maxTurn) => {
      if (!Array.isArray(raw)) return [];
      const out: TurnRange[] = [];
      for (const r of raw as Array<Record<string, unknown>>) {
        const value = canonical(def.options.values, r?.value);
        let from = turnOrNull(r?.from, maxTurn);
        let to = turnOrNull(r?.to, maxTurn);
        if (!value || from === null) continue;
        if (to === null) to = from;
        if (to < from) [from, to] = [to, from];
        out.push({ value, from, to });
      }
      return out;
    },
    aggregate: (def, rows) => {
      const coded = rows.filter((r) => r.entry);
      const maxTurn = Math.max(0, ...coded.map((r) => r.turnsCompleted));
      const series = (def.options.values ?? []).map((value) => ({
        value,
        points: Array.from({ length: maxTurn }, (_, i) => {
          const turn = i + 1;
          const reached = coded.filter((r) => r.turnsCompleted >= turn);
          const inTheme = reached.filter((r) =>
            ((r.entry?.value as TurnRange[] | null) ?? []).some((x) => x.value === value && x.from <= turn && turn <= x.to),
          );
          return { turn, share: reached.length ? inTheme.length / reached.length : 0, n: reached.length };
        }),
      }));
      return [{ kind: "turn_ranges", series, n: coded.length }];
    },
    format: (_d, v) =>
      Array.isArray(v) && v.length
        ? (v as TurnRange[]).map((r) => `${r.value} T${r.from}${r.to !== r.from ? `-T${r.to}` : ""}`).join("; ")
        : "—",
  },
};

// ---------- Whole-coding functions ----------

/** The prompt text for {{field_definitions}}. */
export function describeFields(defs: FieldDef[]): string {
  if (defs.length === 0) return "(No fields were selected. Return an empty fields object.)";
  return defs
    .map((def) => {
      const h = FIELD_TYPES[def.type];
      const scope =
        def.scope === "per_speaker"
          ? "per speaker: give a separate entry for A and for B"
          : "conversation: one entry for the whole conversation";
      return [
        `<field name="${def.name}">`,
        `Type: ${h.label}. Scope: ${scope}.`,
        `Definition: ${def.definition}`,
        ...h.describe(def),
        `</field>`,
      ].join("\n");
    })
    .join("\n\n");
}

/** The JSON schema of one entry (value, citations, reason, and turns where asked). */
export function entrySchema(def: FieldDef): Json {
  const h = FIELD_TYPES[def.type];
  const props: Json = { value: h.valueSchema(def) };
  if (h.hasFirstTurn(def)) props.first_turn = { type: "integer" };
  if (def.options.recordChangeTurn) props.change_turn = { type: "integer" };
  props.turns = TURNS_SCHEMA;
  props.reason = { type: "string" };
  return obj(props);
}

export function fieldSchema(def: FieldDef): Json {
  const entry = entrySchema(def);
  return def.scope === "per_speaker" ? obj({ A: entry, B: entry }) : entry;
}

/** The whole summarizer output schema, generated from the selected fields. Every property is required. */
export function codingSchema(defs: FieldDef[]): Json {
  return obj({
    summary: { type: "string" },
    focus_findings: { type: "array", items: obj({ finding: { type: "string" }, turns: TURNS_SCHEMA }) },
    notable: { type: "string", description: 'The single most unusual thing, or "" if nothing stands out.' },
    fields: obj(Object.fromEntries(defs.map((d) => [d.name, fieldSchema(d)]))),
  });
}

/** Citations that point inside the transcript, as "T7" or "T7-T9". */
export function normalizeTurns(raw: unknown, maxTurn: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    const m = typeof c === "string" ? /^\s*\[?T(\d+)(?:\s*[-–]\s*T?(\d+))?\]?\s*$/i.exec(c) : null;
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > maxTurn || b < a) continue;
    out.push(a === b ? `T${a}` : `T${a}-T${b}`);
  }
  return [...new Set(out)];
}

export function normalizeEntry(def: FieldDef, raw: unknown, maxTurn: number): FieldEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const h = FIELD_TYPES[def.type];
  return {
    value: h.normalize(def, r.value, maxTurn),
    turns: normalizeTurns(r.turns, maxTurn),
    reason: typeof r.reason === "string" ? r.reason.trim() : "",
    firstTurn: h.hasFirstTurn(def) ? turnOrNull(r.first_turn, maxTurn) : null,
    changeTurn: def.options.recordChangeTurn ? turnOrNull(r.change_turn, maxTurn) : null,
  };
}

export interface CodingOutput {
  summary: string;
  focusFindings: Array<{ finding: string; turns: string[] }>;
  notable: string | null;
  fields: Record<string, StoredField>;
}

/** Turns the summarizer's JSON into what is stored. Unknown keys are dropped; missing fields are left out. */
export function normalizeCoding(defs: FieldDef[], raw: unknown, maxTurn: number): CodingOutput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawFields = (r.fields ?? {}) as Record<string, unknown>;
  const fields: Record<string, StoredField> = {};
  for (const def of defs) {
    const rf = rawFields[def.name];
    if (rf === undefined || rf === null) continue;
    if (def.scope === "per_speaker") {
      const ab = rf as Record<string, unknown>;
      fields[def.name] = { A: normalizeEntry(def, ab.A, maxTurn), B: normalizeEntry(def, ab.B, maxTurn) };
    } else {
      fields[def.name] = { all: normalizeEntry(def, rf, maxTurn) };
    }
  }
  const findings = Array.isArray(r.focus_findings) ? (r.focus_findings as Array<Record<string, unknown>>) : [];
  return {
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    focusFindings: findings
      .filter((f) => typeof f?.finding === "string" && f.finding.trim())
      .map((f) => ({ finding: (f.finding as string).trim(), turns: normalizeTurns(f.turns, maxTurn) })),
    notable: typeof r.notable === "string" && r.notable.trim() && r.notable.trim().toLowerCase() !== "null" ? r.notable.trim() : null,
    fields,
  };
}

export interface FieldAggregate {
  def: FieldDef;
  slots: Array<{ slot: Slot; aggregates: Aggregate[] }>;
}

/** Aggregates every field across the coded conversations of a run, by type. */
export function aggregateFields(
  defs: FieldDef[],
  coded: Array<{ conversation: number; turnsCompleted: number; fields: Record<string, StoredField> }>,
): FieldAggregate[] {
  return defs.map((def) => ({
    def,
    slots: slotsFor(def.scope).map((slot) => ({
      slot,
      aggregates: FIELD_TYPES[def.type].aggregate(
        def,
        coded.map((c) => ({ conversation: c.conversation, turnsCompleted: c.turnsCompleted, entry: c.fields[def.name]?.[slot] })),
      ),
    })),
  }));
}

export function formatValue(def: FieldDef, value: FieldValue): string {
  return FIELD_TYPES[def.type].format(def, value);
}

// ---------- Custom fields ----------

export const RESERVED_NAMES = ["summary", "focus_findings", "notable", "fields"];

const valueList = z
  .array(z.string().trim().min(1, "Values cannot be empty").max(60, "Each value: at most 60 characters"))
  .min(2, "Give at least two values")
  .max(20, "At most 20 values")
  .refine((vs) => new Set(vs.map((v) => v.toLowerCase())).size === vs.length, "Values must differ (ignoring case)");

/** What the "+ New field" form submits. */
export const customFieldSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "At least 2 characters")
      .max(40, "At most 40 characters")
      .regex(/^[a-z][a-z0-9_]*$/, "Lowercase letters, digits, and underscores, starting with a letter")
      .refine((n) => !RESERVED_NAMES.includes(n), "This name is reserved"),
    type: z.enum(["yes_no", "category", "multi_select", "scale", "tags", "short_text", "turn_ranges"]),
    scope: z.enum(["conversation", "per_speaker"]),
    group: z.enum(["Content", "Self and counterpart", "Dynamics", "Conduct"]),
    definition: z.string().trim().min(5, "Write a one-sentence definition").max(500, "At most 500 characters"),
    values: z.array(z.string()).default([]),
    maxItems: z.coerce.number().int().min(1).max(10).default(5),
    minLabel: z.string().trim().max(60).default(""),
    maxLabel: z.string().trim().max(60).default(""),
  })
  .superRefine((f, ctx) => {
    if (f.type === "category" || f.type === "multi_select" || f.type === "turn_ranges") {
      const r = valueList.safeParse(f.values.map((v) => v.trim()).filter(Boolean));
      if (!r.success) ctx.addIssue({ code: "custom", path: ["values"], message: r.error.issues[0].message });
    }
  });

export type CustomFieldInput = z.input<typeof customFieldSchema>;

/** The options stored for a validated custom field. */
export function optionsForCustomField(f: z.infer<typeof customFieldSchema>): FieldOptions {
  switch (f.type) {
    case "category":
    case "multi_select":
    case "turn_ranges":
      return { values: f.values.map((v) => v.trim()).filter(Boolean) };
    case "tags":
      return { maxItems: f.maxItems };
    case "scale":
      return {
        min: 1,
        max: 5,
        ...(f.minLabel ? { minLabel: f.minLabel } : {}),
        ...(f.maxLabel ? { maxLabel: f.maxLabel } : {}),
      };
    default:
      return {};
  }
}
