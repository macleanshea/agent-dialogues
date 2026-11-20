import { cn, formatNumber, formatUsd } from "@/lib/utils";

export interface TokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/**
 * What the run has spent against its ceiling, and where the tokens went.
 * Cached tokens show prompt caching at work; thinking tokens are the part of
 * output spent on (hidden) reasoning, billed as output.
 */
export function CostMeter({ costUsd, ceilingUsd, totals }: { costUsd: number; ceilingUsd: number; totals: TokenTotals }) {
  const share = ceilingUsd > 0 ? Math.min(1, costUsd / ceilingUsd) : 0;
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const cachedShare = prompt > 0 ? totals.cacheReadTokens / prompt : 0;
  const thinkingShare = totals.outputTokens > 0 ? totals.thinkingTokens / totals.outputTokens : 0;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <div className="flex flex-col gap-4 px-5 py-4" data-testid="cost-meter">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-sm">
            <span>
              <span className="text-lg font-semibold tabular-nums" data-testid="cost-spent">
                {formatUsd(costUsd)}
              </span>{" "}
              <span className="text-muted-foreground">of {formatUsd(ceilingUsd)} ceiling</span>
            </span>
            <span className="text-muted-foreground tabular-nums">{pct(share)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={ceilingUsd} aria-valuenow={costUsd} aria-label="Cost against ceiling">
            <div className={cn("h-full rounded-full", share >= 1 ? "bg-red-500" : share >= 0.8 ? "bg-amber-500" : "bg-blue-500")} style={{ width: `${share * 100}%` }} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Input (uncached)" value={formatNumber(totals.inputTokens)} testId="tokens-input" />
          <Stat
            label="Cached input read"
            value={formatNumber(totals.cacheReadTokens)}
            hint={`${pct(cachedShare)} of all input`}
            testId="tokens-cache-read"
          />
          <Stat label="Written to cache" value={formatNumber(totals.cacheWriteTokens)} testId="tokens-cache-write" />
          <Stat label="Output" value={formatNumber(totals.outputTokens)} hint="Includes thinking" testId="tokens-output" />
          <Stat
            label="Thinking"
            value={formatNumber(totals.thinkingTokens)}
            hint={`${pct(thinkingShare)} of output`}
            testId="tokens-thinking"
          />
        </dl>
    </div>
  );
}
