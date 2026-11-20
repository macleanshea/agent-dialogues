"use server";

import { revalidatePath } from "next/cache";
import { createCustomField } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { toPickerField, type PickerField } from "@/lib/fields/picker";

export type CreateFieldActionResult = { ok: true; field: PickerField } | { ok: false; errors: Record<string, string> };

/** "+ New field": saves a custom field to the library. */
export async function createFieldAction(input: unknown): Promise<CreateFieldActionResult> {
  const r = await createCustomField(await getDb(), input);
  if (!r.ok) return r;
  revalidatePath("/runs/new");
  return { ok: true, field: toPickerField(r.field) };
}
