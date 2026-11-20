import { RetryableError, getStepMetadata } from "workflow";
import type { AnalysisPlan } from "@/lib/analysis/service";

/**
 * Vercel Workflow orchestration for analyzing one run under one analysis
 * version (the latest, when versionId is null).
 *
 * - Codes each conversation with the summarizer: one step (one model call)
 *   per conversation, in `concurrency` lanes, as the run itself did.
 * - Then writes the run report: one step per model call, until it is done.
 *
 * Started when a run finishes, and by re-analysis for every run in the
 * experiment. All logic lives in src/lib/analysis/service.ts.
 */
export async function analysisWorkflow(runId: string, versionId: string | null) {
  "use workflow";
  const plan = await prepareStep(runId, versionId);
  const n = Math.max(1, Math.min(plan.concurrency, plan.codingIds.length));
  const lanes: string[][] = Array.from({ length: n }, () => []);
  plan.codingIds.forEach((id, i) => lanes[i % n].push(id));
  await Promise.all(
    lanes.map(async (lane) => {
      for (const codingId of lane) {
        try {
          await codeStep(codingId);
        } catch (err) {
          await failCodingStep(codingId, errorMessage(err));
        }
      }
    }),
  );
  if (plan.reportId) {
    try {
      for (;;) {
        if (await reportStep(plan.reportId)) break;
      }
    } catch (err) {
      await failReportStep(plan.reportId, errorMessage(err));
    }
  }
  return { codings: plan.codingIds.length, report: plan.reportId !== null };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : err.message;
  }
  return String(err);
}

/** Rate limits and server errors are retried, honoring retry-after, with backoff (10 s doubling to 2 minutes). */
function retryable(err: unknown, isTransient: (e: unknown) => e is { message: string; retryAfterMs: number | null }): never {
  if (isTransient(err)) {
    const attempt = getStepMetadata().attempt;
    const backoff = Math.min(120_000, 10_000 * 2 ** Math.max(0, attempt - 1));
    throw new RetryableError(err.message, { retryAfter: Math.max(err.retryAfterMs ?? 0, backoff) });
  }
  throw err;
}

// ---------- Steps ----------

async function prepareStep(runId: string, versionId: string | null): Promise<AnalysisPlan> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { prepareAnalysis } = await import("@/lib/analysis/service");
  return prepareAnalysis(await getDb(), runId, versionId);
}

/** One summarizer call. */
async function codeStep(codingId: string): Promise<string> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { codeConversation } = await import("@/lib/analysis/service");
  const { routingJudge } = await import("@/lib/analysis/judge");
  const { isTransientModelError } = await import("@/lib/engine/types");
  try {
    return await codeConversation(await getDb(), codingId, routingJudge);
  } catch (err) {
    retryable(err, isTransientModelError);
  }
}
codeStep.maxRetries = 6;

/** One report-writer call, plus the transcripts it asked to open. Returns true when the report is finished. */
async function reportStep(reportId: string): Promise<boolean> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { reportStep: step } = await import("@/lib/analysis/service");
  const { routingJudge } = await import("@/lib/analysis/judge");
  const { isTransientModelError } = await import("@/lib/engine/types");
  try {
    return await step(await getDb(), reportId, routingJudge);
  } catch (err) {
    retryable(err, isTransientModelError);
  }
}
reportStep.maxRetries = 6;

async function failCodingStep(codingId: string, message: string): Promise<void> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { failCoding } = await import("@/lib/analysis/service");
  await failCoding(await getDb(), codingId, message);
}

async function failReportStep(reportId: string, message: string): Promise<void> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { failReport } = await import("@/lib/analysis/service");
  await failReport(await getDb(), reportId, message);
}
