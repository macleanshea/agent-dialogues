/**
 * The pre-run cost estimate (PR 5). Pure functions with no database or
 * network access, so the run form can recompute the estimate in the browser
 * as settings change.
 *
 * Two kinds of estimate:
 * - A range, before the experiment's baseline (R1) has run. It simulates one
 *   conversation turn by turn with assumed message lengths (a low and a high
 *   assumption per effort level), using the same history and caching rules
 *   the engine uses, and prices every call with the model's prices.
 * - A single figure from R1's actual averages, once R1 has finished. It
 *   takes R1's average tokens at each turn number, prices them for this run's
 *   models, and scales to this run's turns and number of conversations.
 */
import { resolveSystemPrompts, type RunConfig } from "./config";
import { costUsd, type Effort, type TokenUsage } from "./models";

/** About 4 characters per token, the usual rule of thumb for English. */
export function roughTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Prompts shorter than this are not cached on the current models. */
const MIN_CACHEABLE = 512;
/** Framing the API adds per message (role markers and so on). A guess; small either way. */
const PER_MESSAGE_OVERHEAD = 5;

/**
 * Assumed tokens per message (thinking plus visible text), low and high, by
 * effort. Visible text is assumed to be a share of that. These are planning
 * assumptions, not measurements: the baseline's actual averages replace them
 * once it has run.
 */
export const MESSAGE_ASSUMPTIONS: Record<Effort, { low: number; high: number }> = {
  low: { low: 150, high: 1_000 },
  medium: { low: 300, high: 2_000 },
  high: { low: 500, high: 4_000 },
  xhigh: { low: 800, high: 6_000 },
  max: { low: 1_000, high: 10_000 },
};
/** Visible text per message, low and high. The rest of a message is thinking. */
export const VISIBLE_ASSUMPTION = { low: 100, high: 600 };

/** The run form's values, with numbers possibly still typed as text. */
export type EstimateInput = Pick<
  RunConfig,
  "agentA" | "agentB" | "openingMessage" | "attributeOpeningToB" | "signOff" | "summarizerModel" | "reportModel"
> & {
  turns: number | string;
  maxTokens: number | string;
  conversations: number | string;
  costCeilingUsd: number | string;
};

export interface CostRange {
  low: number;
  high: number;
}

export interface Estimate {
  kind: "range" | "baseline";
  /** Agent calls for the whole run. In "baseline" mode low equals high. */
  run: CostRange;
  /** Coding and the run report (separate from the run's cost and its ceiling). */
  analysis: CostRange;
  ceilingUsd: number;
  conversations: number;
  turns: number;
}

function toInt(v: number | string): number | null {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The numbers the estimate needs, or null while a required field is blank or invalid. */
function numbers(c: EstimateInput) {
  const turns = toInt(c.turns);
  const maxTokens = toInt(c.maxTokens);
  const conversations = toInt(c.conversations);
  const ceiling = toInt(c.costCeilingUsd);
  if (!turns || !maxTokens || !conversations || !ceiling) return null;
  return { turns: Math.floor(turns), maxTokens: Math.floor(maxTokens), conversations: Math.floor(conversations), ceiling };
}

interface SimulatedConversation {
  agentCost: number;
  /** Visible text tokens across the transcript, for the analysis estimate. */
  visibleTokens: number;
}

/**
 * One conversation, turn by turn, with every message `output` tokens long,
 * of which `visible` are visible text. Each agent's history replays its own
 * messages whole (thinking included, which is counted as input) and only the
 * visible text of the other agent's. Automatic caching reads back what the
 * same agent's previous call wrote, and writes the rest.
 */
function simulate(c: EstimateInput, n: { turns: number; maxTokens: number }, size: "low" | "high"): SimulatedConversation {
  const prompts = resolveSystemPrompts(c as RunConfig);
  const agents = {
    A: { model: c.agentA.model, effort: c.agentA.effort, system: roughTokens(prompts.a) },
    B: { model: c.agentB.model, effort: c.agentB.effort, system: roughTokens(prompts.b) },
  };
  const opening = roughTokens(c.openingMessage) + PER_MESSAGE_OVERHEAD;
  // History lengths in tokens, as each agent sees it.
  const history = {
    A: agents.A.system + opening,
    B: agents.B.system + (c.attributeOpeningToB ? roughTokens("[Begin the conversation.]") + opening + PER_MESSAGE_OVERHEAD : 0),
  };
  const lastWritten = { A: 0, B: 0 };
  let agentCost = 0;
  let visibleTokens = 0;
  for (let t = 1; t <= n.turns; t++) {
    const s = t % 2 === 1 ? "A" : "B";
    const other = s === "A" ? "B" : "A";
    const agent = agents[s];
    const output = Math.min(n.maxTokens, MESSAGE_ASSUMPTIONS[agent.effort][size]);
    const visible = Math.min(output, VISIBLE_ASSUMPTION[size]);
    const prompt = history[s];
    const cached = prompt >= MIN_CACHEABLE ? lastWritten[s] : 0;
    const usage: TokenUsage = {
      inputTokens: prompt >= MIN_CACHEABLE ? 0 : prompt,
      cacheReadTokens: cached,
      cacheWriteTokens: prompt >= MIN_CACHEABLE ? prompt - cached : 0,
      outputTokens: output,
      thinkingTokens: output - visible,
    };
    agentCost += costUsd(agent.model, usage);
    lastWritten[s] = prompt >= MIN_CACHEABLE ? prompt : 0;
    history[s] += output + PER_MESSAGE_OVERHEAD;
    history[other] += visible + PER_MESSAGE_OVERHEAD;
    visibleTokens += visible;
  }
  return { agentCost, visibleTokens };
}

/** Tokens the summarizer prompt adds around a transcript (instructions and field definitions). */
const SUMMARIZER_PROMPT_TOKENS = 3_000;
const SUMMARIZER_OUTPUT = { low: 1_500, high: 6_000 };
/** The report writer re-reads its growing context on each call. */
const REPORT_CALLS = { low: 4, high: 8 };
const REPORT_OUTPUT = { low: 2_000, high: 10_000 };
const REPORT_PROMPT_TOKENS = 4_000;
/** Each coding as the report writer reads it. */
const CODING_TOKENS = 600;

function analysisCost(c: EstimateInput, conversations: number, visible: CostRange): CostRange {
  const one = (size: "low" | "high") => {
    const transcript = size === "low" ? visible.low : visible.high;
    const coding = costUsd(c.summarizerModel, {
      inputTokens: SUMMARIZER_PROMPT_TOKENS + transcript,
      outputTokens: SUMMARIZER_OUTPUT[size],
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // The report writer's context: its prompt, every coding, then the transcripts it opens (at least 3).
    const context = REPORT_PROMPT_TOKENS + conversations * CODING_TOKENS + Math.min(3, conversations) * transcript;
    const calls = REPORT_CALLS[size];
    const report = costUsd(c.reportModel, {
      // Rough: each call reads the context once, mostly from the cache after the first.
      inputTokens: context,
      cacheReadTokens: context * (calls - 1),
      cacheWriteTokens: 0,
      outputTokens: REPORT_OUTPUT[size],
      thinkingTokens: 0,
    });
    return coding * conversations + report;
  };
  return { low: one("low"), high: one("high") };
}

/** The range estimate, used before the baseline has run. Null while the form has blank or invalid numbers. */
export function estimateRange(c: EstimateInput): Estimate | null {
  const n = numbers(c);
  if (!n) return null;
  const low = simulate(c, n, "low");
  const high = simulate(c, n, "high");
  return {
    kind: "range",
    run: { low: low.agentCost * n.conversations, high: high.agentCost * n.conversations },
    analysis: analysisCost(c, n.conversations, { low: low.visibleTokens, high: high.visibleTokens }),
    ceilingUsd: n.ceiling,
    conversations: n.conversations,
    turns: n.turns,
  };
}

// ---------- From the baseline's actual averages ----------

/** R1's average usage at one turn number, over the conversations that reached it. */
export interface ProfileTurn {
  turn: number;
  /** Share of R1's conversations that reached this turn (0 to 1). */
  reached: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

/** What R1 actually used. Built on the server from the stored turns (see baselineProfile in runs/service.ts). */
export interface BaselineProfile {
  runNumber: number;
  conversations: number;
  modelA: string;
  modelB: string;
  effortA: Effort;
  effortB: Effort;
  turns: ProfileTurn[];
  /** R1's actual analysis spend: mean per coded conversation, and its run report. */
  analysis: { perConversation: number; report: number } | null;
}

/**
 * R1's averages at one turn number, extended past R1's last turn when this
 * run has more turns: the speaker's prompt keeps growing by its average
 * growth per turn in R1, its messages stay as long as in its last R1 turn,
 * and the share of conversations still going stays as at R1's last turn.
 */
function profileAt(p: BaselineProfile, t: number): ProfileTurn | null {
  const found = p.turns.find((x) => x.turn === t);
  if (found) return found;
  const same = p.turns.filter((x) => x.turn % 2 === t % 2 && x.turn < t);
  if (same.length === 0) return null;
  const last = same[same.length - 1];
  const first = same[0];
  const prompt = (x: ProfileTurn) => x.inputTokens + x.cacheReadTokens + x.cacheWriteTokens;
  const growthPerTurn = last.turn > first.turn ? Math.max(0, (prompt(last) - prompt(first)) / (last.turn - first.turn)) : 0;
  const total = prompt(last) + growthPerTurn * (t - last.turn);
  // Since this agent's previous call, two messages are new (written to the cache); the rest is read back.
  const fresh = Math.min(total, growthPerTurn * 2);
  return { ...last, turn: t, inputTokens: 0, cacheWriteTokens: fresh, cacheReadTokens: total - fresh };
}

/** The estimate from R1's actual averages, priced for this run's models. Null while the form has blank or invalid numbers. */
export function estimateFromBaseline(c: EstimateInput, p: BaselineProfile): Estimate | null {
  const n = numbers(c);
  if (!n || p.turns.length === 0) return null;
  let perConversation = 0;
  for (let t = 1; t <= n.turns; t++) {
    const x = profileAt(p, t);
    if (!x) continue;
    const model = t % 2 === 1 ? c.agentA.model : c.agentB.model;
    // A lower max tokens caps the messages.
    const output = Math.min(x.outputTokens, n.maxTokens);
    const usage: TokenUsage = {
      inputTokens: x.inputTokens,
      cacheReadTokens: x.cacheReadTokens,
      cacheWriteTokens: x.cacheWriteTokens,
      outputTokens: output,
      thinkingTokens: Math.min(x.thinkingTokens, output),
    };
    perConversation += x.reached * costUsd(model, usage);
  }
  const run = perConversation * n.conversations;
  const analysis = p.analysis ? p.analysis.perConversation * n.conversations + p.analysis.report : null;
  return {
    kind: "baseline",
    run: { low: run, high: run },
    analysis: analysis === null ? { low: 0, high: 0 } : { low: analysis, high: analysis },
    ceilingUsd: n.ceiling,
    conversations: n.conversations,
    turns: n.turns,
  };
}

/** Settings that make R1's averages a weaker guide for this run, named for a note under the estimate. */
export function baselineCaveats(c: EstimateInput, p: BaselineProfile): string[] {
  const notes: string[] = [];
  if (c.agentA.effort !== p.effortA || c.agentB.effort !== p.effortB) notes.push("effort differs from R1, so message lengths may differ");
  if (c.agentA.model !== p.modelA || c.agentB.model !== p.modelB) notes.push("R1's tokens are repriced for this run's models, which may write longer or shorter messages");
  const maxTurn = p.turns.reduce((m, x) => Math.max(m, x.turn), 0);
  const n = numbers(c);
  if (n && n.turns > maxTurn) notes.push(`turns past T${maxTurn} are extrapolated from R1's last turns`);
  return notes;
}
