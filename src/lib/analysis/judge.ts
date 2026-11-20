/**
 * Model calls made by the analysis (summarizer and report writer), as opposed
 * to the agents' own turns. Same Anthropic SDK, same retry rules, plus
 * structured outputs (JSON) and tools.
 *
 * Checked against the docs on 2026-11-20 (see the PR 3 section of the
 * Decisions log): JSON output uses output_config.format {type: "json_schema"};
 * tools use strict: true; forced tool_choice is rejected on Opus 5.5, so the
 * default (auto) is used and the prompt asks for the tool.
 */
import Anthropic from "@anthropic-ai/sdk";
import { classifyApiError, usageFromApi } from "../engine/anthropic";
import { hash } from "../engine/mock";
import type { AgentMessage, ContentBlock, ModelResponse } from "../engine/types";
import { getModel, type Effort } from "../models";

export interface JudgeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface JudgeRequest {
  model: string;
  /** Content blocks are replayed unchanged, thinking included. */
  messages: AgentMessage[];
  maxTokens: number;
  effort: Effort;
  /** When set, the reply's text is JSON following this schema. */
  outputSchema?: Record<string, unknown>;
  tools?: readonly JudgeTool[];
  purpose: "summarizer" | "report";
}

export type JudgeResponse = ModelResponse;

export interface JudgeClient {
  call(req: JudgeRequest): Promise<JudgeResponse>;
}

let sdk: Anthropic | null = null;
function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set for this deployment.");
  sdk ??= new Anthropic({ maxRetries: 0, timeout: 280_000 });
  return sdk;
}

/** The request body for one analysis call. Exported for tests. */
export function buildJudgeRequest(req: JudgeRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: req.messages as unknown as Anthropic.MessageParam[],
    thinking: { type: "adaptive" },
    output_config: {
      effort: req.effort,
      ...(req.outputSchema ? { format: { type: "json_schema", schema: req.outputSchema } } : {}),
    },
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ ...t, strict: true })) as unknown as Anthropic.Tool[] } : {}),
    // Automatic prompt caching: the report writer resends the same long prefix on every call.
    cache_control: { type: "ephemeral" },
  };
}

export const anthropicJudge: JudgeClient = {
  async call(req) {
    let message: Anthropic.Message;
    try {
      message = await client().messages.stream(buildJudgeRequest(req)).finalMessage();
    } catch (err) {
      throw classifyApiError(err);
    }
    return {
      content: message.content as unknown as ContentBlock[],
      stopReason: message.stop_reason ?? "unknown",
      usage: usageFromApi(message.usage),
      rawUsage: message.usage,
    };
  },
};

// ---------- Mock judge ----------

const textOf = (m: AgentMessage) =>
  m.content.map((b) => (b.type === "text" ? (b as { text: string }).text : b.type === "tool_result" ? JSON.stringify(b.content) : "")).join("\n");

/**
 * Fills a JSON schema with deterministic values. It reads only the schema, so
 * it exercises exactly the schema the real model would get, whatever fields
 * (built-in or custom) produced it.
 */
export function fakeFromSchema(schema: Record<string, unknown>, ctx: { seed: number; maxTurn: number }, path = ""): unknown {
  const h = hash(`${ctx.seed}|${path}`);
  const turn = 1 + (h % Math.max(1, ctx.maxTurn));
  if (Array.isArray(schema.enum)) {
    const choices = (schema.enum as unknown[]).filter((v) => v !== null);
    return choices.length ? choices[h % choices.length] : null;
  }
  // Allowed values are listed in the description, as the real model reads them.
  const listed = typeof schema.description === "string" ? /One of (\[.*\])/.exec(schema.description)?.[1] : undefined;
  if (listed && schema.type === "string") {
    const choices = JSON.parse(listed) as string[];
    return choices[h % choices.length];
  }
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== "null") : schema.type;
  const key = path.split(".").pop() ?? "";
  switch (type) {
    case "boolean":
      return h % 2 === 0;
    case "integer":
    case "number":
      if (key === "first_turn" || key === "change_turn" || key === "from") return turn;
      if (key === "to") return Math.min(ctx.maxTurn, turn + (h % 3));
      return 1 + (h % 5);
    case "string":
      if (schema.pattern || /"T7"/.test(String(schema.description ?? ""))) return `T${turn}`;
      if (key === "summary") return `Mock summary. The agents opened by greeting each other [T1] and continued for ${ctx.maxTurn} turns.`;
      if (key === "reason") return `Mock reason, based on [T${turn}].`;
      if (key === "finding") return `Mock finding at [T${turn}].`;
      if (key === "notable") return `Mock notable thing at [T${turn}].`;
      return `mock ${key || "text"} ${h % 7}`;
    case "array": {
      const items = (schema.items ?? {}) as Record<string, unknown>;
      const n = 1 + (h % 2);
      const out = Array.from({ length: n }, (_, i) => fakeFromSchema(items, ctx, `${path}[${i}]`));
      return Array.isArray(items.enum) || /One of/.test(String(items.description ?? "")) ? [...new Set(out)] : out;
    }
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(props).map(([k, s]) => [k, fakeFromSchema(s, ctx, path ? `${path}.${k}` : k)]));
    }
    default:
      return null;
  }
}

const MOCK_USAGE = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function mockSummarizer(req: JudgeRequest): JudgeResponse {
  const prompt = req.messages.map(textOf).join("\n");
  const turnNumbers = [...prompt.matchAll(/^\[T(\d+)\]/gm)].map((m) => Number(m[1]));
  const maxTurn = Math.max(1, ...turnNumbers);
  // Without an enforced schema, the format note carries the schema in the prompt.
  const noted = /<json_schema>\n([\s\S]*?)\n<\/json_schema>/.exec(prompt)?.[1];
  const schema = req.outputSchema ?? (noted ? (JSON.parse(noted) as Record<string, unknown>) : { type: "object", properties: {} });
  const value = fakeFromSchema(schema, { seed: hash(prompt), maxTurn });
  return {
    content: [
      { type: "thinking", thinking: "Mock judge reads the transcript.", signature: "mock-judge" },
      { type: "text", text: JSON.stringify(value) },
    ],
    stopReason: "end_turn",
    usage: MOCK_USAGE,
  };
}

/**
 * The mock report writer opens transcripts with the tool until it has opened
 * as many as the prompt requires, then writes a short report whose quotes and
 * citations come from the transcripts it opened, so the citation check passes.
 */
function mockReport(req: JudgeRequest): JudgeResponse {
  const first = textOf(req.messages[0]);
  const ids = [...new Set([...first.matchAll(/<coding id="R(\d+)·C(\d+)"/g)].map((m) => `${m[1]}·${m[2]}`))];
  const required = Number(/open at least (\d+) transcripts/.exec(first)?.[1] ?? 3);
  const results = req.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
  const opened = results.length;
  const thinking: ContentBlock = { type: "thinking", thinking: "Mock report writer plans.", signature: "mock-report" };

  if (opened < required && opened < ids.length) {
    const [run, conversation] = ids[opened].split("·").map(Number);
    return {
      content: [thinking, { type: "tool_use", id: `mock_tool_${opened + 1}`, name: "open_transcript", input: { run, conversation } }],
      stopReason: "tool_use",
      usage: MOCK_USAGE,
    };
  }

  const examples = results.flatMap((b) => {
    const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    const id = /Transcript (R\d+·C\d+)/.exec(text)?.[1];
    const line = /^\[T(\d+)\] [AB]: (.+)$/m.exec(text);
    if (!id || !line) return [];
    const words = line[2].replace(/["“”*]/g, "").split(/\s+/).slice(0, 6).join(" ");
    return [`- In ${id}, A opened with "${words}" (${id}·T${line[1]}).`];
  });
  const n = ids.length;
  const report = [
    "## Overview",
    `This mock report covers ${n} coded conversations. The codings were made by a Claude model acting as judge and may contain errors (here, the Mock judge).`,
    "## Patterns",
    ...(examples.length ? examples : ["- No transcripts were available."]),
    `- All ${n} of ${n} conversations were coded.`,
    "## Caveats",
    "This report was written by the Mock model and says nothing about real model behavior.",
  ].join("\n\n");
  return { content: [thinking, { type: "text", text: report }], stopReason: "end_turn", usage: MOCK_USAGE };
}

export const mockJudge: JudgeClient = {
  async call(req) {
    return req.purpose === "summarizer" ? mockSummarizer(req) : mockReport(req);
  },
};

/** Sends each call to the Mock or the real API, by model. */
export const routingJudge: JudgeClient = {
  call(req) {
    return getModel(req.model)?.kind === "mock" ? mockJudge.call(req) : anthropicJudge.call(req);
  },
};
