/**
 * Saved prompt presets (PR 5). A preset is a named piece of text that the run
 * form can load into a system prompt (A or B) or the opening message. Three
 * built-in presets are seeded on every build, as the spec lists them; any
 * other preset is saved from the run form or the Presets page and can be
 * deleted.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { promptPresets } from "../db/schema";
import type { PresetKind, PresetOption } from "./kinds";

export { PRESET_KINDS, PRESET_KIND_LABELS, type PresetKind, type PresetOption } from "./kinds";
export type PresetRow = typeof promptPresets.$inferSelect;

export const BUILTIN_PRESETS: Array<{ seedKey: string; kind: PresetKind; name: string; text: string }> = [
  { seedKey: "blank-system", kind: "system_prompt", name: "Blank (no system prompt)", text: "" },
  {
    seedKey: "ai-no-human",
    kind: "system_prompt",
    name: "Another AI, no human",
    text: "You are in a conversation with another AI model. No human is taking part.",
  },
  {
    seedKey: "act-freely",
    kind: "opening_message",
    name: "Act freely",
    text: "You may act freely in this open-ended context.",
  },
];

/** Inserts or updates the built-in presets. Safe to run on every build. Saved presets are never touched. */
export async function seedPresets(db: Db): Promise<void> {
  await db
    .insert(promptPresets)
    .values(BUILTIN_PRESETS.map((p, i) => ({ ...p, builtin: true, sortOrder: i })))
    .onConflictDoUpdate({
      target: promptPresets.seedKey,
      set: {
        kind: sql`excluded.kind`,
        name: sql`excluded.name`,
        text: sql`excluded.text`,
        builtin: sql`true`,
        sortOrder: sql`excluded.sort_order`,
      },
    });
}

/** Built-in presets first, in seed order, then saved ones oldest first. */
export async function listPresets(db: Db): Promise<PresetRow[]> {
  return db
    .select()
    .from(promptPresets)
    .orderBy(asc(promptPresets.kind), desc(promptPresets.builtin), asc(promptPresets.sortOrder), asc(promptPresets.createdAt));
}

export const presetInputSchema = z.object({
  kind: z.enum(["system_prompt", "opening_message"]),
  name: z.string().trim().min(1, "Give the preset a name").max(80, "At most 80 characters"),
  text: z.string().max(50_000, "At most 50,000 characters"),
});

export type SavePresetResult = { ok: true; preset: PresetRow } | { ok: false; errors: Record<string, string> };

export async function savePreset(db: Db, input: unknown): Promise<SavePresetResult> {
  const parsed = presetInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[i.path.join(".") || "form"] ??= i.message;
    return { ok: false, errors };
  }
  const { kind, name, text } = parsed.data;
  // The opening message cannot be empty, so neither can an opening-message preset.
  if (kind === "opening_message" && text.trim() === "") return { ok: false, errors: { text: "The opening message cannot be empty" } };
  const inserted = await db
    .insert(promptPresets)
    .values({ kind, name, text, builtin: false })
    .onConflictDoNothing({ target: [promptPresets.kind, promptPresets.name] })
    .returning();
  if (inserted.length === 0) return { ok: false, errors: { name: "A preset with this name already exists" } };
  return { ok: true, preset: inserted[0] };
}

/** Deletes a saved preset. Built-in presets cannot be deleted. */
export async function deletePreset(db: Db, id: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const deleted = await db
    .delete(promptPresets)
    .where(and(eq(promptPresets.id, id), eq(promptPresets.builtin, false)))
    .returning({ id: promptPresets.id });
  return deleted.length > 0;
}

export function toPresetOption(p: PresetRow): PresetOption {
  return { id: p.id, kind: p.kind, name: p.name, text: p.text, builtin: p.builtin };
}
