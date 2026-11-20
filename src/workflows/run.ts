import { RetryableError, getStepMetadata } from "workflow";
import { start } from "workflow/api";
import type { AdvanceResult, RunPlan } from "@/lib/runs/execution";
import type { PendingRetry } from "@/lib/engine/engine";

/**
 * Vercel Workflow orchestration for one run.
 *
 * - runWorkflow (one per run) starts a child workflow per conversation, in
 *   `concurrency` lanes, so at most that many conversations run at once.
 * - conversationWorkflow (one per conversation) calls the advance step in a
 *   loop. Each step makes at most one model call and stores its turn.
 *
 * Workflow functions run in a sandbox and only orchestrate. Everything that
 * touches the database or the network happens inside "use step" functions,
 * which load those modules with dynamic imports so nothing Node-only reaches
 * the workflow bundle. All logic lives in src/lib/runs/execution.ts.
 */

export async function runWorkflow(runId: string) {
  "use workflow";
  const plan = await beginRunStep(runId);
  const lanes = lanesOf(plan.conversationIds, plan.concurrency);
  await Promise.all(
    lanes.map(async (lane) => {
      for (const conversationId of lane) {
        const child = await start(conversationWorkflow, [conversationId]);
        try {
          await child.returnValue;
        } catch (err) {
          // The child failed outright (not an API error it handled itself).
          await failConversationStep(conversationId, errorMessage(err));
        }
      }
    }),
  );
  return finalizeRunStep(runId);
}

export async function conversationWorkflow(conversationId: string) {
  "use workflow";
  let retry: PendingRetry | null = null;
  for (;;) {
    let result: AdvanceResult;
    try {
      result = await advanceStep(conversationId, retry);
    } catch (err) {
      // The step ran out of retries (for example, the API kept returning 529).
      await failConversationStep(conversationId, errorMessage(err));
      return { status: "errored" as const };
    }
    if (result.kind === "finished") return { status: result.end.status };
    retry = result.retry;
  }
}

/** Same split as splitIntoLanes in execution.ts; repeated here to keep the workflow bundle free of imports. */
function lanesOf<T>(items: T[], concurrency: number): T[][] {
  if (items.length === 0) return [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  const lanes: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => lanes[i % n].push(item));
  return lanes;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : err.message;
  }
  return String(err);
}

// ---------- Steps ----------

async function beginRunStep(runId: string): Promise<RunPlan> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { beginRun } = await import("@/lib/runs/execution");
  return beginRun(await getDb(), runId);
}

/**
 * One model call. Rate limits and server errors are retried by Workflow,
 * waiting for the API's retry-after when it gives one, and backing off
 * (10s, 20s, 40s, ... up to 2 minutes) when it does not.
 */
async function advanceStep(conversationId: string, retry: PendingRetry | null): Promise<AdvanceResult> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { advanceConversation } = await import("@/lib/runs/execution");
  const { routingClient } = await import("@/lib/engine/anthropic");
  const { isTransientModelError } = await import("@/lib/engine/types");
  try {
    return await advanceConversation(await getDb(), conversationId, routingClient, retry);
  } catch (err) {
    if (isTransientModelError(err)) {
      const attempt = getStepMetadata().attempt;
      const backoff = Math.min(120_000, 10_000 * 2 ** Math.max(0, attempt - 1));
      throw new RetryableError(err.message, { retryAfter: Math.max(err.retryAfterMs ?? 0, backoff) });
    }
    throw err;
  }
}
advanceStep.maxRetries = 6;

async function failConversationStep(conversationId: string, message: string): Promise<void> {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { failConversation } = await import("@/lib/runs/execution");
  await failConversation(await getDb(), conversationId, message);
}

async function finalizeRunStep(runId: string) {
  "use step";
  const { getDb } = await import("@/lib/db");
  const { finalizeRun } = await import("@/lib/runs/execution");
  return finalizeRun(await getDb(), runId);
}
