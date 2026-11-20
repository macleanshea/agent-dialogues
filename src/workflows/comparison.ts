import { RetryableError, getStepMetadata } from "workflow";

/**
 * Vercel Workflow orchestration for one comparison report: one step per
 * model call (plus the transcripts it asked for), until it is done. All logic
 * lives in src/lib/analysis/comparison.ts.
 */
export async function comparisonWorkflow(comparisonId: string) {
  "use workflow";
  try {
    for (;;) {
      if (await comparisonStep(comparisonId)) break;
    }
  } catch (err) {
    await failComparisonStep(comparisonId, errorMessage(err));
  }
  return { comparisonId };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : err.message;
  }
  return String(err);
}

/** One writer call. Rate limits and server errors are retried, honoring retry-after, with backoff (10 s doubling to 2 minutes). */
async function comparisonStep(comparisonId: string): Promise<boolean> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { comparisonStep: step } = await import("@/lib/analysis/comparison");
  const { routingJudge } = await import("@/lib/analysis/judge");
  const { isTransientModelError } = await import("@/lib/engine/types");
  try {
    return await step(await getDb(), comparisonId, routingJudge);
  } catch (err) {
    if (isTransientModelError(err)) {
      const attempt = getStepMetadata().attempt;
      const backoff = Math.min(120_000, 10_000 * 2 ** Math.max(0, attempt - 1));
      throw new RetryableError(err.message, { retryAfter: Math.max(err.retryAfterMs ?? 0, backoff) });
    }
    throw err;
  }
}
comparisonStep.maxRetries = 6;

async function failComparisonStep(comparisonId: string, message: string): Promise<void> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { failComparison } = await import("@/lib/analysis/comparison");
  await failComparison(await getDb(), comparisonId, message);
}
