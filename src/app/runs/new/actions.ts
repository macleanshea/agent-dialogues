"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { experimentHref, runHref } from "@/lib/ids";
import { missingApiKey, parseRunConfig, type RunFormState } from "./validate";
import { createStandaloneRun } from "@/lib/runs/service";
import { copyRunsFromExperiment, getExperimentByNumber } from "@/lib/experiments/service";
import { parseIndex } from "@/lib/ids";
import { startRunWorkflow } from "@/lib/runs/start";

export type { RunFormState };

/**
 * Creates the run, starts its workflow in the background, and opens the run
 * page, which refreshes itself while the run is going. No login check: Vercel
 * Authentication protects every deployment.
 */
export async function createRunAction(_prev: RunFormState, formData: FormData): Promise<RunFormState> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("config") ?? ""));
  } catch {
    return { errors: {}, message: "The form could not be read. Reload the page and try again." };
  }

  const parsed = parseRunConfig(raw);
  if (!parsed.ok) return parsed.state;
  const c = parsed.config;
  const keyProblem = missingApiKey(c);
  if (keyProblem) return { errors: {}, message: keyProblem };

  const db = await getDb();
  let created;
  try {
    created = await createStandaloneRun(db, c);
  } catch (err) {
    return { errors: { fields: err instanceof Error ? err.message : String(err) }, message: "Some settings need fixing." };
  }
  // Clone with "also copy the other runs": the source's variable and its other runs, as drafts.
  const cloneFrom = parseIndex(String(formData.get("cloneFrom") ?? ""));
  let copied = 0;
  if (cloneFrom && formData.get("copyRuns") === "1") {
    const source = await getExperimentByNumber(db, cloneFrom);
    if (source) {
      const res = await copyRunsFromExperiment(db, created.experimentId, source.id);
      if (res.ok) copied = res.copied;
    }
  }
  await startRunWorkflow(db, created.runId);
  redirect(copied > 0 ? experimentHref(created.experimentNumber) : runHref(created.experimentNumber, created.runNumber));
}
