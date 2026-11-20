import { describe, expect, it } from "vitest";
import { citation, conversationId, experimentId, parseIndex, runId, turnHref, turnId } from "@/lib/ids";
import { EFFORTS, EFFORT_LABELS, MODELS, costUsd, getModel } from "@/lib/models";
import {
  OPENING_STUB,
  SIGN_OFF_LINE,
  defaultExperimentName,
  defaultRunConfig,
  resolveSystemPrompts,
  runConfigSchema,
} from "@/lib/config";

describe("display IDs", () => {
  it("formats the hierarchy", () => {
    expect(experimentId(4)).toBe("EXP-004");
    expect(runId(2)).toBe("R2");
    expect(conversationId(7)).toBe("C07");
    expect(conversationId(150)).toBe("C150");
    expect(turnId(12)).toBe("T12");
    expect(citation(2, 7, 12)).toBe("R2·C07·T12");
    expect(turnHref(4, 2, 7, 12)).toBe("/experiments/4/runs/2/conversations/7#T12");
  });
  it("parses URL indexes strictly", () => {
    expect(parseIndex("3")).toBe(3);
    expect(parseIndex("0")).toBeNull();
    expect(parseIndex("-1")).toBeNull();
    expect(parseIndex("1.5")).toBeNull();
    expect(parseIndex("abc")).toBeNull();
  });
});

describe("models and prices", () => {
  it("lists the spec's model IDs and the mock", () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      "mock",
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(getModel("mock")?.label).toBe("Mock (no cost)");
  });
  it("prices a call", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, thinkingTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    // 4 input + 20 output + 0.20 cache read + 5 cache write
    expect(costUsd("claude-opus-5-5", usage)).toBeCloseTo(29.2, 6);
    expect(costUsd("mock", usage)).toBe(0);
    // 8 input + 40 output + 0.20 cache read + 10 cache write
    expect(costUsd("claude-fable-5-2", usage)).toBeCloseTo(58.2, 6);
  });
  it("uses Haiku's long-context prices above 100k prompt tokens", () => {
    const short = { inputTokens: 100_000, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const long = { ...short, inputTokens: 100_001 };
    expect(costUsd("claude-haiku-5-5", short)).toBeCloseTo(0.01, 6);
    expect(costUsd("claude-haiku-5-5", long)).toBeCloseTo(0.0500005, 6);
  });
});

describe("run config", () => {
  it("shows effort levels capitalized, with xhigh as Extra", () => {
    expect(EFFORTS.map((e) => EFFORT_LABELS[e])).toEqual(["Low", "Medium", "High", "Extra", "Max"]);
  });

  it("has the spec's defaults", () => {
    const c = defaultRunConfig();
    expect(c.agentA.effort).toBe("medium");
    expect(c.openingMessage).toBe(OPENING_STUB);
    expect(c.attributeOpeningToB).toBe(false);
    expect(c.turns).toBe(30);
    expect(c.maxTokens).toBe(8000);
    expect(c.conversations).toBe(20);
    expect(c.concurrency).toBe(4);
    expect(c.signOff).toBe(false);
    expect(c.repetitionThreshold).toBe(0.8);
    expect(c.repetitionAction).toBe("flag");
    expect(c.costCeilingUsd).toBe(25);
    expect(c.summarizerModel).toBe("claude-opus-5-5");
    expect(c.reportModel).toBe("claude-opus-5-5");
    expect(c.judgeReadsThinking).toBe(false);
    expect(runConfigSchema.safeParse(c).success).toBe(true);
  });

  const errorsFor = (patch: Record<string, unknown>) => {
    const r = runConfigSchema.safeParse({ ...defaultRunConfig(), ...patch });
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };

  it("enforces limits", () => {
    expect(errorsFor({ turns: 201 })).toContain("turns");
    expect(errorsFor({ turns: 0 })).toContain("turns");
    expect(errorsFor({ conversations: 201 })).toContain("conversations");
    expect(errorsFor({ costCeilingUsd: 0 })).toContain("costCeilingUsd");
    expect(errorsFor({ costCeilingUsd: "" })).toContain("costCeilingUsd");
    expect(errorsFor({ openingMessage: "   " })).toContain("openingMessage");
    expect(errorsFor({ turns: 200, conversations: 200 })).toEqual([]);
  });

  it("only allows attributing the opening to B when it differs from the stub", () => {
    expect(errorsFor({ attributeOpeningToB: true })).toContain("attributeOpeningToB");
    expect(errorsFor({ attributeOpeningToB: true, openingMessage: "Hello there." })).toEqual([]);
  });

  it("allows every listed model for agents, and rejects unknown ones", () => {
    const c = defaultRunConfig();
    for (const model of ["mock", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) {
      expect(errorsFor({ agentA: { ...c.agentA, model }, agentB: { ...c.agentB, model } })).toEqual([]);
    }
    expect(errorsFor({ agentA: { ...c.agentA, model: "gpt" } })).toContain("agentA.model");
  });

  it("resolves system prompts with same-as-A and sign-off", () => {
    const c = defaultRunConfig();
    c.agentA.systemPrompt = "Be curious.";
    c.agentB.systemPrompt = "Be terse.";
    expect(resolveSystemPrompts(c)).toEqual({ a: "Be curious.", b: "Be terse." });
    c.agentB.sameAsA = true;
    expect(resolveSystemPrompts(c)).toEqual({ a: "Be curious.", b: "Be curious." });
    c.signOff = true;
    expect(resolveSystemPrompts(c).a).toBe(`Be curious.\n\n${SIGN_OFF_LINE}`);
    c.agentA.systemPrompt = "";
    expect(resolveSystemPrompts(c)).toEqual({ a: SIGN_OFF_LINE, b: SIGN_OFF_LINE });
  });

  it("names experiments", () => {
    const c = defaultRunConfig();
    expect(defaultExperimentName(c)).toBe("Mock (no cost) × Mock (no cost), 30 turns");
    expect(defaultExperimentName({ ...c, name: "  My run " })).toBe("My run");
  });
});
