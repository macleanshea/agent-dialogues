"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { deletePreset, savePreset, toPresetOption, type PresetOption } from "@/lib/presets/service";

export type SavePresetState = { ok: true; preset: PresetOption } | { ok: false; errors: Record<string, string> };

/** Saves a prompt preset from the run form or the Presets page. */
export async function savePresetAction(input: { kind: string; name: string; text: string }): Promise<SavePresetState> {
  const res = await savePreset(await getDb(), input);
  revalidatePath("/presets");
  return res.ok ? { ok: true, preset: toPresetOption(res.preset) } : res;
}

/** Deletes a saved preset. Built-in presets are refused. */
export async function deletePresetAction(id: string): Promise<void> {
  await deletePreset(await getDb(), id);
  revalidatePath("/presets");
}
