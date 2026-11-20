import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { RunConfigSnapshot } from "../config";
import type { Db } from "../db";
import { conversations, experiments, runs, turns, type RunStatus } from "../db/schema";
import {
  endForStopReason,
  takeTurn,
  type ConversationEnd,
  type ConversationSetup,
  type NewTurn,
  type PendingRetry,
} from "../engine/engine";
import { isTransientModelError, type ConversationStopReason, type ModelClient, type TurnRecord } from "../engine/types";

/**
 * Executing a run, one model call at a time.
 *
 * Deployed runs go through Vercel Workflow (src/workflows/run.ts): a parent
 * workflow per run and a child workflow per conversation, whose steps each
 * call advanceConversation once. The functions here hold all the logic and
 * take the database and model client as arguments, so tests drive them
 * directly with PGlite and the Mock model (see executeRunInProcess).
 */

export function setupFromConfig(c: RunConfigSnapshot): ConversationSetup {
  return {
    agentA: { model: c.agentA.model, effort: c.agentA.effort, systemPrompt: c.resolved.systemPromptA },
    agentB: { model: c.agentB.model, effort: c.agentB.effort, systemPrompt: c.resolved.systemPromptB },
    openingMessage: c.openingMessage,
    attributeOpeningToB: c.attributeOpeningToB,
    turns: c.turns,
    maxTokens: c.maxTokens,
    signOff: c.signOff,
    repetitionThreshold: c.repetitionThreshold,
    repetitionAction: c.repetitionAction,
  };
}

const ACTIVE = ["pending", "running"] as const;

/**
 * Saves a turn once, and adds its usage to the conversation and its cost to
 * the run. A retried save of the same turn number does nothing (returns false).
 */
export async function saveTurn(db: Db, conversationId: string, t: NewTurn): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(turns)
      .values({
        conversationId,
        turnNumber: t.turnNumber,
        speaker: t.speaker,
        model: t.model,
        text: t.text,
        thinkingSummary: t.thinkingSummary,
        content: t.content,
        stopReason: t.stopReason,
        usage: t.rawUsage as object | null,
        inputTokens: t.usage.inputTokens,
        outputTokens: t.usage.outputTokens,
        thinkingTokens: t.usage.thinkingTokens,
        cacheReadTokens: t.usage.cacheReadTokens,
        cacheWriteTokens: t.usage.cacheWriteTokens,
        costUsd: t.costUsd,
        truncated: t.truncated,
        placeholderUsed: t.placeholderUsed,
        attempts: t.attempts,
        maxTokensUsed: t.maxTokensUsed,
        repetition: t.repetition,
        signedOff: t.signedOff,
        crossSimilarity: t.measures.crossSimilarity,
        emojiCount: t.measures.emojiCount,
        modelMentions: t.measures.modelMentions,
      })
      .onConflictDoNothing({ target: [turns.conversationId, turns.turnNumber] })
      .returning({ id: turns.id });
    if (inserted.length === 0) return false;

    // Only count usage for a turn that was actually inserted.
    const [conv] = await tx
      .update(conversations)
      .set({
        turnsCompleted: sql`${conversations.turnsCompleted} + 1`,
        inputTokens: sql`${conversations.inputTokens} + ${t.usage.inputTokens}`,
        outputTokens: sql`${conversations.outputTokens} + ${t.usage.outputTokens}`,
        thinkingTokens: sql`${conversations.thinkingTokens} + ${t.usage.thinkingTokens}`,
        cacheReadTokens: sql`${conversations.cacheReadTokens} + ${t.usage.cacheReadTokens}`,
        cacheWriteTokens: sql`${conversations.cacheWriteTokens} + ${t.usage.cacheWriteTokens}`,
        costUsd: sql`${conversations.costUsd} + ${t.costUsd}`,
        ...(t.repetitionTriggered
          ? { repetitionFlagTurn: sql`coalesce(${conversations.repetitionFlagTurn}, ${t.turnNumber})` }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(conversations.id, conversationId))
      .returning({ runId: conversations.runId });

    // The run's cost is what the ceiling is checked against, so keep it current.
    await tx
      .update(runs)
      .set({ costUsd: sql`${runs.costUsd} + ${t.costUsd}`, updatedAt: sql`now()` })
      .where(eq(runs.id, conv.runId));
    return true;
  });
}

export async function loadTurnRecords(db: Db, conversationId: string): Promise<TurnRecord[]> {
  return db
    .select({ turnNumber: turns.turnNumber, speaker: turns.speaker, content: turns.content })
    .from(turns)
    .where(eq(turns.conversationId, conversationId))
    .orderBy(asc(turns.turnNumber));
}

/** Checked before every model call: the Stop button, then the cost ceiling. */
export async function checkBeforeCall(db: Db, runId: string): Promise<ConversationStopReason | null> {
  const [run] = await db
    .select({ stopRequested: runs.stopRequested, costUsd: runs.costUsd, config: runs.config })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!run) return "stopped_by_user";
  if (run.stopRequested) return "stopped_by_user";
  if (run.costUsd >= run.config.costCeilingUsd) return "cost_ceiling";
  return null;
}

/** Records how a conversation ended. Does nothing if it already ended. */
export async function finishConversation(db: Db, conversationId: string, end: ConversationEnd): Promise<void> {
  await db
    .update(conversations)
    .set({
      status: end.status,
      stopReason: end.stopReason,
      error: end.error,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(conversations.id, conversationId), inArray(conversations.status, [...ACTIVE])));
}

export type AdvanceResult =
  | { kind: "continue"; retry: PendingRetry | null }
  | { kind: "finished"; end: ConversationEnd };

/**
 * Advances one conversation by at most one model call, and stores the result.
 * Safe to repeat: it always works from what is stored, so a retried step
 * picks up where the stored turns end and never duplicates a turn.
 *
 * Throws a TransientModelError for rate limits and server errors, so the
 * caller can retry later.
 */
export async function advanceConversation(
  db: Db,
  conversationId: string,
  client: ModelClient,
  retry: PendingRetry | null = null,
): Promise<AdvanceResult> {
  const [row] = await db
    .select({ conv: conversations, config: runs.config, runId: runs.id })
    .from(conversations)
    .innerJoin(runs, eq(runs.id, conversations.runId))
    .where(eq(conversations.id, conversationId));
  if (!row) throw new Error(`Conversation not found: ${conversationId}`);
  const { conv, config, runId } = row;

  if (!ACTIVE.includes(conv.status as (typeof ACTIVE)[number])) {
    return {
      kind: "finished",
      end: { status: conv.status, stopReason: conv.stopReason ?? "error", error: conv.error },
    };
  }
  if (conv.status === "pending") {
    await db
      .update(conversations)
      .set({ status: "running", startedAt: sql`coalesce(${conversations.startedAt}, now())`, updatedAt: sql`now()` })
      .where(and(eq(conversations.id, conversationId), eq(conversations.status, "pending")));
  }

  const early = await checkBeforeCall(db, runId);
  if (early) {
    const end = endForStopReason(early);
    await finishConversation(db, conversationId, end);
    return { kind: "finished", end };
  }

  const stored = await loadTurnRecords(db, conversationId);
  const step = await takeTurn({
    setup: setupFromConfig(config),
    client,
    conversationIndex: conv.index,
    turns: stored,
    retry,
  });

  if (step.kind === "retry") return { kind: "continue", retry: step.retry };
  if (step.kind === "end") {
    await finishConversation(db, conversationId, step.end);
    return { kind: "finished", end: step.end };
  }
  await saveTurn(db, conversationId, step.turn);
  if (step.end) {
    await finishConversation(db, conversationId, step.end);
    return { kind: "finished", end: step.end };
  }
  return { kind: "continue", retry: null };
}

/** Marks a conversation errored after its model calls kept failing. */
export async function failConversation(db: Db, conversationId: string, message: string): Promise<void> {
  await finishConversation(db, conversationId, {
    status: "errored",
    stopReason: "error",
    error: `API error after retries: ${message}`,
  });
}

export interface RunPlan {
  conversationIds: string[];
  concurrency: number;
}

/** Moves a queued run to running and lists the conversations still to do. */
export async function beginRun(db: Db, runId: string): Promise<RunPlan> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`Run not found: ${runId}`);
  await db
    .update(runs)
    .set({ status: "running", startedAt: sql`coalesce(${runs.startedAt}, now())`, updatedAt: sql`now()` })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])));
  const todo = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.runId, runId), inArray(conversations.status, [...ACTIVE])))
    .orderBy(asc(conversations.index));
  return { conversationIds: todo.map((c) => c.id), concurrency: run.config.concurrency };
}

/**
 * Splits conversations into `concurrency` lanes. Each lane runs its
 * conversations one after another, and the lanes run side by side, so at most
 * `concurrency` conversations are in flight. Conversation 1 goes to lane 1,
 * conversation 2 to lane 2, and so on, wrapping around.
 */
export function splitIntoLanes<T>(items: T[], concurrency: number): T[][] {
  const n = Math.max(1, Math.min(concurrency, items.length));
  const lanes: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => lanes[i % n].push(item));
  return items.length === 0 ? [] : lanes;
}

/**
 * Sets the run's final status once every conversation has ended.
 * A stopped run stays stopped. Otherwise one failed conversation does not
 * fail the run; all of them failing does.
 */
export async function finalizeRun(db: Db, runId: string): Promise<RunStatus> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`Run not found: ${runId}`);
  const all = await db
    .select({ status: conversations.status, cost: conversations.costUsd })
    .from(conversations)
    .where(eq(conversations.runId, runId));
  const cost = all.reduce((s, c) => s + c.cost, 0);
  const status: RunStatus = run.stopRequested
    ? "stopped"
    : all.length > 0 && all.every((c) => c.status === "errored")
      ? "failed"
      : "done";
  await db
    .update(runs)
    .set({ status, costUsd: cost, finishedAt: sql`coalesce(${runs.finishedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(runs.id, runId));
  await db.update(experiments).set({ updatedAt: sql`now()` }).where(eq(experiments.id, run.experimentId));
  return status;
}

/**
 * The Stop button. Conversations that have not started are stopped at once.
 * Running conversations stop before their next model call, so a call already
 * in flight finishes and its turn is kept.
 */
export async function requestStop(db: Db, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ stopRequested: true, status: "stopped", updatedAt: sql`now()` })
      .where(and(eq(runs.id, runId), inArray(runs.status, ["draft", "queued", "running"])));
    await tx
      .update(conversations)
      .set({ status: "stopped", stopReason: "stopped_by_user", finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(conversations.runId, runId), eq(conversations.status, "pending")));
  });
}

/** Records which Workflow run executes a run. */
export async function recordWorkflowRun(db: Db, runId: string, workflowRunId: string): Promise<void> {
  await db.update(runs).set({ workflowRunId, updatedAt: sql`now()` }).where(eq(runs.id, runId));
}

/** Marks a run failed when its workflow could not be started at all. */
export async function failRunToStart(db: Db, runId: string, message: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "failed", error: message, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(runs.id, runId));
}

/**
 * Executes a whole run in this process, with the same steps and lanes the
 * workflow uses. For tests and local tooling only.
 */
export async function executeRunInProcess(
  db: Db,
  runId: string,
  client: ModelClient,
  opts: { transientRetries?: number } = {},
): Promise<RunStatus> {
  const plan = await beginRun(db, runId);
  const maxTransient = opts.transientRetries ?? 2;
  await Promise.all(
    splitIntoLanes(plan.conversationIds, plan.concurrency).map(async (lane) => {
      for (const id of lane) {
        let retry: PendingRetry | null = null;
        let failures = 0;
        for (;;) {
          let r: AdvanceResult;
          try {
            r = await advanceConversation(db, id, client, retry);
          } catch (err) {
            if (isTransientModelError(err) && failures < maxTransient) {
              failures++;
              continue;
            }
            await failConversation(db, id, err instanceof Error ? err.message : String(err));
            break;
          }
          failures = 0;
          if (r.kind === "finished") break;
          retry = r.retry;
        }
      }
    }),
  );
  return finalizeRun(db, runId);
}
