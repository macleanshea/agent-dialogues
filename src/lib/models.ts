/**
 * The single source of truth for model IDs and prices.
 *
 * Confirmed on 2026-11-19 against:
 *   - https://platform.claude.com/docs/en/about-claude/models/overview
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 * All prices are USD per million tokens. Thinking tokens are billed as output.
 */

export const PRICES_CHECKED_ON = "2026-11-19";

export const MOCK_MODEL_ID = "mock";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: Effort = "medium";

/** How each effort level is shown. The API values above are what is sent and stored. */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

export interface PriceTable {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** "mock" never calls the network and costs nothing. */
  kind: "mock" | "anthropic";
  price: PriceTable;
  /**
   * Some models charge more when a single request's prompt (input + cache
   * reads + cache writes) is longer than a threshold.
   */
  longContext?: { thresholdTokens: number; price: PriceTable };
  /** Agents can only use models whose engine support has shipped. */
  agentReady: boolean;
}

const FREE: PriceTable = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

export const MODELS: ModelInfo[] = [
  { id: MOCK_MODEL_ID, label: "Mock (no cost)", kind: "mock", price: FREE, agentReady: true },
  {
    id: "claude-fable-5-2",
    label: "Claude Fable 5.2",
    kind: "anthropic",
    price: { input: 8, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2, output: 40 },
    agentReady: false,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    kind: "anthropic",
    price: { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
    // PR 1 runs mock only. Real calls arrive in PR 2.
    agentReady: false,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    kind: "anthropic",
    price: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
    agentReady: false,
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    kind: "anthropic",
    price: { input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 },
    longContext: {
      thresholdTokens: 100_000,
      price: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    },
    agentReady: false,
  },
];

export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelLabel(id: string): string {
  return getModel(id)?.label ?? id;
}

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  /** Includes thinking tokens. */
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Cost of one API call in USD. Cache writes are priced at the 5-minute rate. */
export function costUsd(modelId: string, usage: TokenUsage): number {
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const price =
    model.longContext && promptTokens > model.longContext.thresholdTokens
      ? model.longContext.price
      : model.price;
  const dollars =
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.cacheWrite5m +
    usage.cacheReadTokens * price.cacheRead +
    usage.outputTokens * price.output;
  return dollars / 1_000_000;
}
