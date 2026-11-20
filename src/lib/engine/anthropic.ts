import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "../models";
import { getModel } from "../models";
import { mockClient } from "./mock";
import { TransientModelError, type ContentBlock, type ModelClient, type ModelRequest, type ModelResponse } from "./types";

/**
 * Real calls to the Claude Messages API, checked against the docs on
 * 2026-11-20 (see the PR 2 section of the Decisions log in docs/SPEC.md).
 *
 * Every agent call:
 * - asks for readable thinking summaries: thinking {type: "adaptive", display: "summarized"};
 * - sets output_config.effort;
 * - turns on automatic prompt caching with a top-level cache_control;
 * - sends no temperature, top_p, or top_k (they return a 400 on these models);
 * - streams, then waits for the final message, so a large max_tokens never
 *   hits the SDK's non-streaming time check. Nothing is streamed to the UI.
 *
 * The SDK's own retries are off. Retryable failures (429, 5xx, 529, dropped
 * connections) are thrown as TransientModelError, so the Workflow step retries
 * them without holding a function open, honoring the retry-after header.
 */

let sdk: Anthropic | null = null;
function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set for this deployment.");
  }
  sdk ??= new Anthropic({ maxRetries: 0, timeout: 280_000 });
  return sdk;
}

/** Maps the API's usage object to our token counts. */
export function usageFromApi(u: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** The request body sent for one agent turn. Exported for tests. */
export function buildRequest(req: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.system ? { system: req.system } : {}),
    // Stored blocks are replayed exactly as the API returned them.
    messages: req.messages as unknown as Anthropic.MessageParam[],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: req.effort },
    cache_control: { type: "ephemeral" },
  };
}

/** Seconds from a retry-after header, as milliseconds. */
function retryAfterMs(headers: Headers | undefined): number | null {
  const raw = headers?.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Converts an SDK error into a TransientModelError when it is worth retrying. */
export function classifyApiError(err: unknown): unknown {
  if (err instanceof Anthropic.RateLimitError) {
    const wait = retryAfterMs(err.headers);
    // A 429 without retry-after is the monthly spend cap: retrying cannot help.
    if (wait === null) return new Error(`Rate limit with no retry-after (spend limit reached?): ${err.message}`);
    return new TransientModelError(`Rate limited (429): ${err.message}`, wait);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new TransientModelError(`Connection failed: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && (err.status >= 500 || err.status === 408 || err.status === 409)) {
    return new TransientModelError(`API error ${err.status}: ${err.message}`, retryAfterMs(err.headers as Headers | undefined));
  }
  return err;
}

export const anthropicClient: ModelClient = {
  async call(req: ModelRequest): Promise<ModelResponse> {
    let message: Anthropic.Message;
    try {
      message = await client().messages.stream(buildRequest(req)).finalMessage();
    } catch (err) {
      throw classifyApiError(err);
    }
    return {
      content: message.content as unknown as ContentBlock[],
      // A missing stop reason is treated like an unknown one: the conversation ends as errored.
      stopReason: message.stop_reason ?? "unknown",
      usage: usageFromApi(message.usage),
      rawUsage: message.usage,
    };
  },
};

/** Sends each call to the Mock or the real API, by model. A run may mix them. */
export const routingClient: ModelClient = {
  call(req) {
    return getModel(req.model)?.kind === "mock" ? mockClient.call(req) : anthropicClient.call(req);
  },
};
