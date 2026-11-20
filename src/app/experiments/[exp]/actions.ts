"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { start } from "workflow/api";
import { createComparison, failComparison } from "@/lib/analysis/comparison";
import { getDb } from "@/lib/db";
import {
  addDraftRun,
  declareVariables,
  deleteDraftRun,
  draftRunIds,
  findRun,
  getExperimentByNumber,
  queueDraftRun,
} from "@/lib/experiments/service";
import { comparisonHref, experimentHref, runHref } from "@/lib/ids";
import { startRunWorkflow } from "@/lib/runs/start";
import { missingApiKey, parseRunConfig, type RunFormState } from "@/app/runs/new/validate";
import { comparisonWorkflow } from "@/workflows/comparison";

export interface ActionState {
  message: string | null;
}

/** The run-page toggle: saves which settings may vary. An empty list makes it a standalone run again. */
export async function declareVariablesAction(experimentNumber: number, keys: string[]): Promise<ActionState> {
  const db = await getDb();
  const exp = await getExperimentByNumber(db, experimentNumber);
  if (!exp) return { message: "This experiment no longer exists." };
  const res = await declareVariables(db, exp.id, keys);
  revalidatePath("/", "layout");
  return { message: res.ok ? null : res.message };
}

/** "+ Add run": saves the run as a draft and goes back to the experiment in the list. */
export async function addRunAction(experimentNumber: number, _prev: RunFormState, formData: FormData): Promise<RunFormState> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("config") ?? ""));
  } catch {
    return { errors: {}, message: "The form could not be read. Reload the page and try again." };
  }
  const parsed = parseRunConfig(raw);
  if (!parsed.ok) return parsed.state;
  const keyProblem = missingApiKey(parsed.config);
  if (keyProblem) return { errors: {}, message: keyProblem };

  const db = await getDb();
  const exp = await getExperimentByNumber(db, experimentNumber);
  if (!exp) return { errors: {}, message: "This experiment no longer exists." };
  const res = await addDraftRun(db, exp.id, parsed.config);
  if (!res.ok) return { errors: res.errors ?? {}, message: res.message };
  redirect(experimentHref(experimentNumber));
}

/** A draft row's Run button. */
export async function startDraftAction(experimentNumber: number, runNumber: number): Promise<void> {
  const db = await getDb();
  const run = await findRun(db, experimentNumber, runNumber);
  if (run && (await queueDraftRun(db, run.id))) await startRunWorkflow(db, run.id);
  revalidatePath("/", "layout");
}

/** "Run all": starts every draft in the experiment. */
export async function runAllAction(experimentNumber: number): Promise<void> {
  const db = await getDb();
  const exp = await getExperimentByNumber(db, experimentNumber);
  if (!exp) return;
  for (const id of await draftRunIds(db, exp.id)) {
    if (await queueDraftRun(db, id)) await startRunWorkflow(db, id);
  }
  revalidatePath("/", "layout");
}

export async function deleteDraftAction(experimentNumber: number, runNumber: number): Promise<void> {
  const db = await getDb();
  const run = await findRun(db, experimentNumber, runNumber);
  if (run) await deleteDraftRun(db, run.id);
  revalidatePath("/", "layout");
}

/** Compare the ticked runs: creates the comparison, starts its writer, and opens its page. */
export async function compareAction(experimentNumber: number, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const runNumbers = formData.getAll("run").map((v) => Number(v)).filter((n) => Number.isInteger(n));
  const db = await getDb();
  const exp = await getExperimentByNumber(db, experimentNumber);
  if (!exp) return { message: "This experiment no longer exists." };
  const created = await createComparison(db, exp.id, runNumbers);
  if (!created.ok) return { message: created.message };
  try {
    await start(comparisonWorkflow, [created.id]);
  } catch (err) {
    await failComparison(db, created.id, `The comparison could not be started: ${err instanceof Error ? err.message : String(err)}`, { raw: true });
  }
  redirect(comparisonHref(experimentNumber, created.number));
}

/** Where a draft's page sends you after it is deleted. */
export async function deleteDraftFromRunPageAction(experimentNumber: number, runNumber: number): Promise<void> {
  await deleteDraftAction(experimentNumber, runNumber);
  redirect(experimentHref(experimentNumber));
}

export async function startDraftFromRunPageAction(experimentNumber: number, runNumber: number): Promise<void> {
  await startDraftAction(experimentNumber, runNumber);
  redirect(runHref(experimentNumber, runNumber));
}
