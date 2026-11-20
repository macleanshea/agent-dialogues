import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { NO_REPLY_PLACEHOLDER, OPENING_STUB } from "@/lib/config";
import { buildRequest, classifyApiError, usageFromApi } from "@/lib/engine/anthropic";
import { runConversation, takeTurn, type ConversationSetup, type NewTurn } from "@/lib/engine/engine";
import { buildHistory, ownTurnForReplay, visibleText } from "@/lib/engine/history";
import { mockClient, mockReply, validateRequest } from "@/lib/engine/mock";
import { endsWithSignOff, trigramOverlap, words } from "@/lib/engine/stop-rules";
import {
  TransientModelError,
  type ContentBlock,
  type ModelClient,
  type ModelRequest,
  type TurnRecord,
} from "@/lib/engine/types";

const setup = (patch: Partial<ConversationSetup> = {}): ConversationSetup => ({
  agentA: { model: "mock", effort: "medium", systemPrompt: "" },
  agentB: { model: "mock", effort: "medium", systemPrompt: "" },
  openingMessage: OPENING_STUB,
  attributeOpeningToB: false,
  turns: 6,
  maxTokens: 8000,
  signOff: false,
  repetitionThreshold: 0.8,
  repetitionAction: "flag",
  ...patch,
});
const agent = (systemPrompt: string) => ({ model: "mock", effort: "medium" as const, systemPrompt });

async function run(s: ConversationSetup, client: ModelClient = mockClient) {
  const saved: NewTurn[] = [];
  const requests: ModelRequest[] = [];
  const result = await runConversation({
    setup: s,
    client: { call: async (req) => (requests.push(structuredClone(req)), client.call(req)) },
    saveTurn: async (t) => void saved.push(t),
  });
  return { result, saved, requests };
}

const thinking = (s: string): ContentBlock => ({ type: "thinking", thinking: s, signature: "sig" });
const text = (s: string): ContentBlock => ({ type: "text", text: s });

describe("word-trigram overlap", () => {
  it("normalizes case and punctuation", () => {
    expect(words("Hello, World! It's me.")).toEqual(["hello", "world", "it's", "me"]);
  });

  it("is 1 for the same message and 0 for unrelated ones", () => {
    const a = "the cat sat on the mat today";
    expect(trigramOverlap(a, a)).toBe(1);
    expect(trigramOverlap(a, "a completely different sentence here")).toBe(0);
  });

  it("is shared trigrams over all distinct trigrams (Jaccard)", () => {
    // a: [a b c], [b c d]; b: [b c d], [c d e]. Shared 1 of 3.
    expect(trigramOverlap("a b c d", "b c d e")).toBeCloseTo(1 / 3, 6);
  });

  it("handles messages under three words", () => {
    expect(trigramOverlap("Goodbye.", "goodbye")).toBe(1);
    expect(trigramOverlap("Goodbye.", "Farewell.")).toBe(0);
    expect(trigramOverlap("", "")).toBe(0);
  });
});

describe("sign-off detection", () => {
  it("needs [END] on its own line at the end", () => {
    expect(endsWithSignOff("Thanks for this.\n[END]")).toBe(true);
    expect(endsWithSignOff("Thanks.\n\n  [END]  \n\n")).toBe(true);
    expect(endsWithSignOff("[END]")).toBe(true);
    expect(endsWithSignOff("Thanks. [END]")).toBe(false);
    expect(endsWithSignOff("[END]\nOne more thing.")).toBe(false);
    expect(endsWithSignOff("We could write [END] later.")).toBe(false);
  });
});

describe("empty replies in an agent's own history", () => {
  it("leaves normal turns untouched (same object)", () => {
    const content = [thinking("t"), text("Hello")];
    expect(ownTurnForReplay(content)).toBe(content);
  });

  it("drops empty text blocks and adds the placeholder after the thinking", () => {
    const content = [thinking("t"), text("")];
    expect(ownTurnForReplay(content)).toEqual([thinking("t"), text(NO_REPLY_PLACEHOLDER)]);
    // The stored turn itself is not changed.
    expect(content).toEqual([thinking("t"), text("")]);
  });

  it("handles whitespace-only text and a reply with no text block at all", () => {
    expect(ownTurnForReplay([thinking("t"), text("  \n ")])).toEqual([thinking("t"), text(NO_REPLY_PLACEHOLDER)]);
    expect(ownTurnForReplay([thinking("t")])).toEqual([thinking("t"), text(NO_REPLY_PLACEHOLDER)]);
  });

  it("drops a stray empty text block from a turn that has text", () => {
    expect(ownTurnForReplay([thinking("t"), text(""), text("Hi")])).toEqual([thinking("t"), text("Hi")]);
  });

  it("never sends an empty text block, so the mock (like the API) accepts every request", async () => {
    const turns: TurnRecord[] = [
      { turnNumber: 1, speaker: "A", content: [thinking("t"), text("")] },
      { turnNumber: 2, speaker: "B", content: [thinking("t"), text("Are you there?")] },
    ];
    const history = buildHistory({ speaker: "A", openingMessage: "Hi", attributeOpeningToB: false, turns });
    expect(() =>
      validateRequest({ model: "mock", messages: history, maxTokens: 10, effort: "low", meta: { speaker: "A", turnNumber: 3 } }),
    ).not.toThrow();
    // Sending the raw empty block would be rejected.
    expect(() =>
      validateRequest({
        model: "mock",
        messages: [{ role: "user", content: [text("Hi")] }, { role: "assistant", content: [thinking("t"), text("")] }],
        maxTokens: 10,
        effort: "low",
        meta: { speaker: "A", turnNumber: 3 },
      }),
    ).toThrow(/non-whitespace/);
  });

  it("runs a conversation where one agent never replies, keeping histories append-only", async () => {
    const { result, saved, requests } = await run(setup({ turns: 6, agentA: agent("[mock:empty]") }));
    expect(result).toMatchObject({ status: "done", stopReason: "turn_cap", turnsCompleted: 6 });
    expect(saved.filter((t) => t.speaker === "A").every((t) => t.text === "" && t.placeholderUsed)).toBe(true);
    // A's own empty turn comes back to A with the placeholder, after its thinking.
    const aTurn5 = requests.find((r) => r.meta.turnNumber === 5)!;
    expect(aTurn5.messages[1].content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(visibleText(aTurn5.messages[1].content)).toBe(NO_REPLY_PLACEHOLDER);
    // Each agent's earlier request is a prefix of its next one.
    for (const speaker of ["A", "B"] as const) {
      const mine = requests.filter((r) => r.meta.speaker === speaker);
      for (let i = 1; i < mine.length; i++) {
        expect(mine[i].messages.slice(0, mine[i - 1].messages.length)).toEqual(mine[i - 1].messages);
      }
    }
  });
});

describe("stop rules", () => {
  it("ends on sign-off when the toggle is on", async () => {
    const { result, saved } = await run(setup({ signOff: true, agentB: agent("[mock:end]") }));
    expect(result).toMatchObject({ status: "done", stopReason: "sign_off", turnsCompleted: 2 });
    expect(saved[1].signedOff).toBe(true);
    expect(saved[0].signedOff).toBe(false);
  });

  it("ignores [END] when the toggle is off", async () => {
    const { result, saved } = await run(setup({ signOff: false, agentB: agent("[mock:end]") }));
    expect(result.stopReason).toBe("turn_cap");
    expect(saved.every((t) => !t.signedOff)).toBe(true);
  });

  it("flags repetition on the second consecutive check and carries on", async () => {
    const both = { agentA: agent("[mock:repeat]"), agentB: agent("[mock:repeat]") };
    const { result, saved } = await run(setup({ ...both, turns: 6, repetitionAction: "flag" }));
    expect(result).toMatchObject({ status: "done", stopReason: "turn_cap", turnsCompleted: 6 });
    expect(saved.map((t) => t.repetition)).toEqual([null, null, 1, 1, 1, 1]);
    // T3 is the first check at the threshold, T4 the second in a row.
    expect(saved.map((t) => t.repetitionTriggered)).toEqual([false, false, false, true, true, true]);
  });

  it("stops on repetition when the action is stop", async () => {
    const both = { agentA: agent("[mock:repeat]"), agentB: agent("[mock:repeat]") };
    const { result } = await run(setup({ ...both, turns: 10, repetitionAction: "stop" }));
    expect(result).toMatchObject({ status: "done", stopReason: "repetition", turnsCompleted: 4 });
  });

  it("does not trigger when only one check in a row is at the threshold", async () => {
    const { saved } = await run(setup({ agentA: agent("[mock:repeat]"), turns: 6, repetitionAction: "stop" }));
    expect(saved).toHaveLength(6);
    expect(saved.some((t) => t.repetitionTriggered)).toBe(false);
  });
});

describe("one model call per step", () => {
  it("returns a retry for a truncated empty reply, then sums both attempts", async () => {
    const s = setup({ turns: 2, maxTokens: 30 });
    let calls = 0;
    const counting: ModelClient = { call: async (req) => (calls++, mockClient.call(req)) };
    const first = await takeTurn({ setup: s, client: counting, turns: [] });
    expect(first.kind).toBe("retry");
    expect(calls).toBe(1);
    if (first.kind !== "retry") return;
    const second = await takeTurn({ setup: s, client: counting, turns: [], retry: first.retry });
    expect(calls).toBe(2);
    expect(second.kind).toBe("turn");
    if (second.kind !== "turn") return;
    expect(second.turn).toMatchObject({ attempts: 2, maxTokensUsed: 60, truncated: true });
    expect(second.turn.usage.outputTokens).toBe(first.retry.firstAttemptUsage.outputTokens + 40 + Math.ceil(second.turn.text.length / 4));
  });

  it("reports the turn cap without calling the model", async () => {
    const step = await takeTurn({
      setup: setup({ turns: 1 }),
      client: { call: async () => { throw new Error("should not be called"); } },
      turns: [{ turnNumber: 1, speaker: "A", content: [text("hi")] }],
    });
    expect(step).toEqual({ kind: "end", end: { status: "done", stopReason: "turn_cap", error: null } });
  });

  it("throws transient errors so the step can be retried", async () => {
    const flaky: ModelClient = { call: async () => { throw new TransientModelError("429", 5000); } };
    await expect(takeTurn({ setup: setup(), client: flaky, turns: [] })).rejects.toBeInstanceOf(TransientModelError);
  });

  it("retries transient errors in-process, then gives up with an error", async () => {
    let n = 0;
    const flakyOnce: ModelClient = {
      call: async (req) => {
        if (++n === 1) throw new TransientModelError("overloaded");
        return mockClient.call(req);
      },
    };
    expect((await run(setup({ turns: 2 }), flakyOnce)).result.status).toBe("done");
    const alwaysDown: ModelClient = { call: async () => { throw new TransientModelError("overloaded"); } };
    const down = await run(setup({ turns: 2 }), alwaysDown);
    expect(down.result).toMatchObject({ status: "errored", stopReason: "error", turnsCompleted: 0 });
  });
});

describe("mock prompt caching", () => {
  it("reads back what the agent's previous request wrote, once prompts pass 512 tokens", () => {
    const long = "x".repeat(4000); // about 1,000 tokens
    const req = (messages: ModelRequest["messages"]): ModelRequest => ({
      model: "mock", system: long, messages, maxTokens: 8000, effort: "medium", meta: { speaker: "A", turnNumber: 1 },
    });
    const first = mockReply(req([{ role: "user", content: [text("Hi")] }]));
    expect(first.usage.cacheReadTokens).toBe(0);
    expect(first.usage.cacheWriteTokens).toBeGreaterThan(1000);
    const second = mockReply(
      req([
        { role: "user", content: [text("Hi")] },
        { role: "assistant", content: first.content },
        { role: "user", content: [text("And then?")] },
      ]),
    );
    expect(second.usage.cacheReadTokens).toBe(first.usage.cacheWriteTokens);
    expect(second.usage.inputTokens).toBe(0);
    // Short prompts are not cached at all.
    const short = mockReply({ ...req([{ role: "user", content: [text("Hi")] }]), system: undefined });
    expect(short.usage.cacheWriteTokens + short.usage.cacheReadTokens).toBe(0);
  });
});

describe("Anthropic request and errors", () => {
  const base: ModelRequest = {
    model: "claude-haiku-5-5",
    messages: [{ role: "user", content: [text("Hi")] }],
    maxTokens: 8000,
    effort: "low",
    meta: { speaker: "A", turnNumber: 1 },
  };

  it("asks for thinking summaries, sets effort and caching, and sends no sampling parameters", () => {
    const body = buildRequest(base) as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 8000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
    });
    expect(body).not.toHaveProperty("system");
    for (const k of ["temperature", "top_p", "top_k", "fallbacks"]) expect(body).not.toHaveProperty(k);
    expect(buildRequest({ ...base, system: "Be brief." }).system).toBe("Be brief.");
  });

  it("maps usage, including cached and thinking tokens", () => {
    const usage = usageFromApi({
      input_tokens: 12,
      output_tokens: 300,
      output_tokens_details: { thinking_tokens: 250 },
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 80,
    } as unknown as Anthropic.Usage);
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 300, thinkingTokens: 250, cacheReadTokens: 900, cacheWriteTokens: 80 });
  });

  it("retries rate limits after retry-after, and server and connection errors", () => {
    const limited = classifyApiError(new Anthropic.RateLimitError(429, {}, "slow down", new Headers({ "retry-after": "7" })));
    expect(limited).toBeInstanceOf(TransientModelError);
    expect((limited as TransientModelError).retryAfterMs).toBe(7000);

    const overloaded = classifyApiError(new Anthropic.InternalServerError(529, {}, "overloaded", new Headers()));
    expect(overloaded).toBeInstanceOf(TransientModelError);
    expect(classifyApiError(new Anthropic.APIConnectionError({ message: "reset" }))).toBeInstanceOf(TransientModelError);
  });

  it("does not retry bad requests or a spend-cap 429 (no retry-after)", () => {
    const bad = classifyApiError(new Anthropic.BadRequestError(400, {}, "invalid", new Headers()));
    expect(bad).not.toBeInstanceOf(TransientModelError);
    const capped = classifyApiError(new Anthropic.RateLimitError(429, {}, "spend cap", new Headers()));
    expect(capped).not.toBeInstanceOf(TransientModelError);
    expect((capped as Error).message).toContain("spend limit");
  });
});
