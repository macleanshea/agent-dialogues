"use server";

import { redirect } from "next/navigation";
import { runConfigSchema } from "@/lib/config";
import { getDb } from "@/lib/db";
import { runHref } from "@/lib/ids";
import { createStandaloneRun, executeRun } from "@/lib/runs/service";

export interface RunFormState {
  /** Error messages keyed by setting path, e.g. "agentA.model". */
  errors: Record<string, string>;
  message: string | null;
}

/**
 * Creates the run and, in this version, executes it in mock mode before
 * responding. No login check: Vercel Authentication protects every deployment.
 */
export async function createRunAction(_prev: RunFormState, formData: FormData): Promise<RunFormState> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("config") ?? ""));
  } catch {
    return { errors: {}, message: "The form could not be read. Reload the page and try again." };
  }

  const parsed = runConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      errors[key] ??= issue.message;
    }
    return { errors, message: "Some settings need fixing. See the messages next to each field." };
  }

  const db = await getDb();
  const created = await createStandaloneRun(db, parsed.data);
  await executeRun(db, created.runId);
  redirect(runHref(created.experimentNumber, created.runNumber));
}
