"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { experiments, runs } from "@/lib/db/schema";
import { runHref } from "@/lib/ids";
import { requestStop, retryFailedConversations } from "@/lib/runs/execution";
import { startRunWorkflow } from "@/lib/runs/start";

/**
 * The Stop button. Conversations that have not started stop at once; running
 * ones stop before their next model call.
 */
export async function stopRunAction(experimentNumber: number, runNumber: number): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .where(and(eq(experiments.number, experimentNumber), eq(runs.number, runNumber)));
  if (!row) return;
  await requestStop(db, row.id);
  revalidatePath(runHref(experimentNumber, runNumber));
}

/**
 * "Retry failed conversations": restarts every errored conversation of a
 * finished run from turn 1, then runs and analyzes them in the background.
 */
export async function retryFailedAction(experimentNumber: number, runNumber: number): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .where(and(eq(experiments.number, experimentNumber), eq(runs.number, runNumber)));
  if (!row) return;
  const res = await retryFailedConversations(db, row.id);
  if (res.ok) await startRunWorkflow(db, row.id);
  revalidatePath(runHref(experimentNumber, runNumber));
}
