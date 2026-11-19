import { describe, expect, it } from "vitest";
import { NO_REPLY_PLACEHOLDER, OPENING_STUB } from "@/lib/config";
import { classifyStopReason, runConversation, type ConversationSetup, type NewTurn } from "@/lib/engine/engine";
import { buildHistory, speakerForTurn, thinkingSummary, visibleText } from "@/lib/engine/history";
import { mockClient, mockReply } from "@/lib/engine/mock";
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse, TurnRecord } from "@/lib/engine/types";

const setup = (patch: Partial<ConversationSetup> = {}): ConversationSetup => ({
  agentA: { model: "mock", effort: "medium", systemPrompt: "" },
  agentB: { model: "mock", effort: "medium", systemPrompt: "" },
  openingMessage: OPENING_STUB,
  attributeOpeningToB: false,
  turns: 6,
  maxTokens: 8000,
  ...patch,
});

async function run(s: ConversationSetup, client: ModelClient = mockClient, existingTurns: TurnRecord[] = []) {
  const saved: NewTurn[] = [];
  const requests: ModelRequest[] = [];
  const recording: ModelClient = {
    call: async (req) => {
      requests.push(structuredClone(req));
      return client.call(req);
    },
  };
  const result = await runConversation({
    setup: s,
    client: recording,
    existingTurns,
    saveTurn: async (t) => {
      saved.push(t);
    },
  });
  return { result, saved, requests };
}

const thinking = (s: string): ContentBlock => ({ type: "thinking", thinking: s, signature: "sig" });
const text = (s: string): ContentBlock => ({ type: "text", text: s });

describe("content blocks", () => {
  it("selects by type, not position", () => {
    const content = [thinking("plan"), text("Hello "), { type: "other", x: 1 }, text("world")];
    expect(visibleText(content)).toBe("Hello world");
    expect(thinkingSummary(content)).toBe("plan");
    expect(thinkingSummary([thinking(""), text("x")])).toBeNull();
  });
});

describe("history", () => {
  const turns: TurnRecord[] = [
    { turnNumber: 1, speaker: "A", content: [thinking("A thinks"), text("A1")] },
    { turnNumber: 2, speaker: "B", content: [thinking("B thinks"), text("B2")] },
    { turnNumber: 3, speaker: "A", content: [thinking("A thinks again"), text("A3")] },
  ];

  it("A speaks on odd turns", () => {
    expect([1, 2, 3, 4].map(speakerForTurn)).toEqual(["A", "B", "A", "B"]);
  });

  it("gives A the opening message, its own raw blocks, and B's text only", () => {
    const h = buildHistory({ speaker: "A", openingMessage: "Open", attributeOpeningToB: false, turns: turns.slice(0, 2) });
    expect(h).toEqual([
      { role: "user", content: [text("Open")] },
      { role: "assistant", content: turns[0].content },
      { role: "user", content: [text("B2")] },
    ]);
    // Own blocks are replayed unchanged (same object, thinking included).
    expect(h[1].content).toBe(turns[0].content);
  });

  it("never shows B the opening message or A's thinking", () => {
    const h = buildHistory({ speaker: "B", openingMessage: "Secret opening", attributeOpeningToB: false, turns });
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(h)).not.toContain("Secret opening");
    expect(JSON.stringify(h)).not.toContain("A thinks");
    expect(h[0].content).toEqual([text("A1")]);
  });

  it("attributes the opening message to B when asked", () => {
    const h = buildHistory({ speaker: "B", openingMessage: "Hello B", attributeOpeningToB: true, turns: turns.slice(0, 1) });
    expect(h).toEqual([
      { role: "user", content: [text(OPENING_STUB)] },
      { role: "assistant", content: [text("Hello B")] },
      { role: "user", content: [text("A1")] },
    ]);
  });

  it("passes the placeholder for an empty reply", () => {
    const h = buildHistory({
      speaker: "B",
      openingMessage: "x",
      attributeOpeningToB: false,
      turns: [{ turnNumber: 1, speaker: "A", content: [thinking("t"), text("")] }],
    });
    expect(h[0].content).toEqual([text(NO_REPLY_PLACEHOLDER)]);
  });

  it("is append-only: each agent's earlier history is a prefix of its later history", async () => {
    const { requests } = await run(setup({ turns: 8 }));
    for (const speaker of ["A", "B"] as const) {
      const mine = requests.filter((r) => r.meta.speaker === speaker);
      for (let i = 1; i < mine.length; i++) {
        const before = mine[i - 1].messages;
        const after = mine[i].messages;
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.length).toBe(before.length + 2);
      }
    }
  });
});

describe("mock model", () => {
  const req: ModelRequest = {
    model: "mock",
    messages: [{ role: "user", content: [text("Hi")] }],
    maxTokens: 8000,
    effort: "medium",
    meta: { speaker: "A", turnNumber: 1 },
  };

  it("is deterministic", () => {
    expect(mockReply(req)).toEqual(mockReply(structuredClone(req)));
  });

  it("starts with a thinking block, then text", () => {
    const r = mockReply(req);
    expect(r.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(r.stopReason).toBe("end_turn");
    expect(r.usage.outputTokens).toBeGreaterThan(r.usage.thinkingTokens);
  });

  it("varies with what it heard", () => {
    const other = { ...req, messages: [{ role: "user" as const, content: [text("Something else entirely")] }] };
    expect(visibleText(mockReply(other).content)).not.toBe(visibleText(mockReply(req).content));
  });
});

describe("runConversation", () => {
  it("runs to the turn cap, alternating speakers", async () => {
    const { result, saved } = await run(setup({ turns: 5 }));
    expect(result).toEqual({ status: "done", stopReason: "turn_cap", error: null, turnsCompleted: 5 });
    expect(saved.map((t) => `${t.turnNumber}${t.speaker}`)).toEqual(["1A", "2B", "3A", "4B", "5A"]);
    expect(saved.every((t) => t.thinkingSummary && t.text.length > 0 && !t.truncated)).toBe(true);
    expect(saved.every((t) => t.costUsd === 0)).toBe(true);
  });

  it("sends no system parameter for a blank prompt, and the prompt otherwise", async () => {
    const { requests } = await run(setup({ turns: 2, agentB: { model: "mock", effort: "high", systemPrompt: "Be brief." } }));
    expect(requests[0].system).toBeUndefined();
    expect(requests[1].system).toBe("Be brief.");
    expect(requests[1].effort).toBe("high");
  });

  it("flags a message truncated with visible text and carries on", async () => {
    const { result, saved } = await run(setup({ turns: 2, maxTokens: 50 }));
    expect(result.status).toBe("done");
    expect(saved.every((t) => t.truncated && t.text.length > 0 && t.attempts === 1)).toBe(true);
  });

  it("retries once with double max tokens when truncated with no visible text", async () => {
    // The mock spends 40 tokens thinking: 30 leaves no text, 60 leaves some.
    const { result, saved, requests } = await run(setup({ turns: 2, maxTokens: 30 }));
    expect(result.status).toBe("done");
    expect(requests.map((r) => r.maxTokens)).toEqual([30, 60, 30, 60]);
    expect(saved[0]).toMatchObject({ attempts: 2, maxTokensUsed: 60, truncated: true });
    expect(saved[0].text.length).toBeGreaterThan(0);
  });

  it("errors the conversation when the retry is still empty", async () => {
    const { result, saved } = await run(setup({ turns: 4, maxTokens: 10 }));
    expect(result.status).toBe("errored");
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("cut off by max tokens");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ truncated: true, attempts: 2, text: "" });
  });

  it("records an empty reply as a real turn and uses the placeholder", async () => {
    const { saved, requests } = await run(setup({ turns: 2, agentA: { model: "mock", effort: "medium", systemPrompt: "[mock:empty]" } }));
    expect(saved[0]).toMatchObject({ text: "", placeholderUsed: true });
    expect(visibleText(requests[1].messages[0].content)).toBe(NO_REPLY_PLACEHOLDER);
  });

  it("records a refusal on the turn and continues", async () => {
    const { result, saved } = await run(setup({ turns: 3, agentB: { model: "mock", effort: "medium", systemPrompt: "[mock:refuse]" } }));
    expect(result.status).toBe("done");
    expect(saved[1].stopReason).toBe("refusal");
  });

  it("ends the conversation as errored when the model call throws", async () => {
    const { result, saved } = await run(setup({ turns: 4, agentB: { model: "mock", effort: "medium", systemPrompt: "[mock:error]" } }));
    expect(result).toMatchObject({ status: "errored", stopReason: "error", turnsCompleted: 1 });
    expect(result.error).toContain("turn 2");
    expect(saved).toHaveLength(1);
  });

  it("handles every documented stop reason explicitly", () => {
    expect(classifyStopReason("end_turn")).toBe("continue");
    expect(classifyStopReason("stop_sequence")).toBe("continue");
    expect(classifyStopReason("refusal")).toBe("continue");
    expect(classifyStopReason("max_tokens")).toBe("truncated");
    expect(classifyStopReason("model_context_window_exceeded")).toBe("end");
    expect(classifyStopReason("tool_use")).toBe("end");
    expect(classifyStopReason("pause_turn")).toBe("end");
    expect(classifyStopReason("something_new")).toBe("end");
  });

  it("ends with an error on an unexpected stop reason, keeping the turn", async () => {
    const client: ModelClient = {
      call: async (): Promise<ModelResponse> => ({
        content: [text("hi")],
        stopReason: "pause_turn",
        usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    };
    const { result, saved } = await run(setup(), client);
    expect(result.status).toBe("errored");
    expect(result.error).toContain("pause_turn");
    expect(saved).toHaveLength(1);
  });

  it("resumes from stored turns without redoing them", async () => {
    const full = await run(setup({ turns: 6 }));
    const firstThree: TurnRecord[] = full.saved.slice(0, 3).map((t) => ({ turnNumber: t.turnNumber, speaker: t.speaker, content: t.content }));
    const resumed = await run(setup({ turns: 6 }), mockClient, firstThree);
    expect(resumed.saved.map((t) => t.turnNumber)).toEqual([4, 5, 6]);
    expect(resumed.saved).toEqual(full.saved.slice(3));
  });

  it("stops early when the pre-call check says so", async () => {
    let calls = 0;
    const result = await runConversation({
      setup: setup(),
      client: mockClient,
      saveTurn: async () => {},
      checkBeforeCall: async () => (++calls > 2 ? "stopped_by_user" : null),
    });
    expect(result).toEqual({ status: "stopped", stopReason: "stopped_by_user", error: null, turnsCompleted: 2 });
  });
});

describe("mock variety", () => {
  it("gives each conversation in a run different, repeatable text", async () => {
    const go = (conversationIndex: number) => {
      const saved: NewTurn[] = [];
      return runConversation({ setup: setup({ turns: 2 }), client: mockClient, conversationIndex, saveTurn: async (t) => void saved.push(t) }).then(() => saved.map((t) => t.text));
    };
    expect(await go(1)).toEqual(await go(1));
    expect(await go(1)).not.toEqual(await go(2));
  });
});
