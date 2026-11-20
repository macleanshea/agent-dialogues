"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { start } from "workflow/api";
import { z } from "zod";
import { createAnalysisVersion, failCoding, failReport, prepareAnalysis } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { experiments, runs } from "@/lib/db/schema";
import { runHref } from "@/lib/ids";
import { getModel } from "@/lib/models";
import { analysisWorkflow } from "@/workflows/analysis";

export interface ReanalyzeState {
  errors: Record<string, string>;
  message: string | null;
}

const knownModel = z.string().refine((id) => getModel(id) !== undefined, "Unknown model");

const settingsSchema = z.object({
  focus: z.string().trim().max(2000, "At most 2,000 characters"),
  fields: z.array(z.string().min(1)).max(100),
  summarizerModel: knownModel,
  reportModel: knownModel,
  judgeReadsThinking: z.boolean(),
});

/**
 * Re-analysis: creates a new analysis version for the experiment and re-codes
 * the existing transcripts of every finished run. Runs still going are
 * analyzed under the new version when they finish. Nothing is re-run.
 */
export async function reanalyzeAction(experimentNumber: number, _prev: ReanalyzeState, formData: FormData): Promise<ReanalyzeState> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("settings") ?? ""));
  } catch {
    return { errors: {}, message: "The form could not be read. Reload the page and try again." };
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    return { errors, message: "Some settings need fixing." };
  }
  const s = parsed.data;
  if ([s.summarizerModel, s.reportModel].some((m) => getModel(m)?.kind === "anthropic") && !process.env.ANTHROPIC_API_KEY) {
    return { errors: {}, message: "ANTHROPIC_API_KEY is not set for this deployment, so only the Mock model can be used as judge." };
  }

  const db = await getDb();
  const [exp] = await db.select().from(experiments).where(eq(experiments.number, experimentNumber));
  if (!exp) return { errors: {}, message: "This experiment no longer exists." };

  let version;
  try {
    version = await createAnalysisVersion(db, exp.id, s);
  } catch (err) {
    return { errors: { fields: err instanceof Error ? err.message : String(err) }, message: "Some settings need fixing." };
  }
  const all = await db.select().from(runs).where(eq(runs.experimentId, exp.id)).orderBy(runs.number);
  for (const r of all.filter((x) => x.status === "done" || x.status === "stopped" || x.status === "failed")) {
    // Create the coding rows now, so the run page shows the work as waiting straight away.
    const plan = await prepareAnalysis(db, r.id, version.id);
    try {
      await start(analysisWorkflow, [r.id, version.id]);
    } catch (err) {
      const msg = `Analysis could not be started: ${err instanceof Error ? err.message : String(err)}`;
      for (const id of plan.codingIds) await failCoding(db, id, msg, { raw: true });
      if (plan.reportId) await failReport(db, plan.reportId, msg, { raw: true });
    }
  }
  redirect(`${runHref(exp.number, all[0]?.number ?? 1)}?v=${version.version}`);
}
