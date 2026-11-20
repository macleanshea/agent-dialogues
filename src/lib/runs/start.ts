import { start } from "workflow/api";
import type { Db } from "../db";
import { runWorkflow } from "@/workflows/run";
import { failRunToStart, recordWorkflowRun } from "./execution";

/**
 * Starts a queued run's workflow in the background. If it cannot be started,
 * the run is marked failed with the reason.
 */
export async function startRunWorkflow(db: Db, runId: string): Promise<void> {
  try {
    const run = await start(runWorkflow, [runId]);
    await recordWorkflowRun(db, runId, run.runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failRunToStart(db, runId, `The run could not be started: ${msg}`);
  }
}
