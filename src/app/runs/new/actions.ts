"use server";

import { redirect } from "next/navigation";
import { start } from "workflow/api";
import { runConfigSchema } from "@/lib/config";
import { getDb } from "@/lib/db";
import { runHref } from "@/lib/ids";
import { getModel } from "@/lib/models";
import { failRunToStart, recordWorkflowRun } from "@/lib/runs/execution";
import { createStandaloneRun } from "@/lib/runs/service";
import { runWorkflow } from "@/workflows/run";

export interface RunFormState {
  /** Error messages keyed by setting path, e.g. "agentA.model". */
  errors: Record<string, string>;
  message: string | null;
}

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

  const parsed = runConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      errors[key] ??= issue.message;
    }
    return { errors, message: "Some settings need fixing. See the messages next to each field." };
  }

  const c = parsed.data;
  const usesApi = [c.agentA.model, c.agentB.model, c.summarizerModel, c.reportModel].some((m) => getModel(m)?.kind === "anthropic");
  if (usesApi && !process.env.ANTHROPIC_API_KEY) {
    return {
      errors: {},
      message:
        "ANTHROPIC_API_KEY is not set for this deployment, so only the Mock model can be used (for the agents, the summarizer, and the report). Add the key in Vercel and redeploy.",
    };
  }

  const db = await getDb();
  let created;
  try {
    created = await createStandaloneRun(db, c);
  } catch (err) {
    return { errors: { fields: err instanceof Error ? err.message : String(err) }, message: "Some settings need fixing." };
  }
  try {
    const run = await start(runWorkflow, [created.runId]);
    await recordWorkflowRun(db, created.runId, run.runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failRunToStart(db, created.runId, `The run could not be started: ${msg}`);
  }
  redirect(runHref(created.experimentNumber, created.runNumber));
}
