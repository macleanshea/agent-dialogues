"use client";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { runId } from "@/lib/ids";
import {
  MESSAGE_ASSUMPTIONS,
  VISIBLE_ASSUMPTION,
  baselineCaveats,
  estimateFromBaseline,
  estimateRange,
  type BaselineProfile,
  type CostRange,
  type EstimateInput,
} from "@/lib/estimate";
import { EFFORT_LABELS, EFFORTS, getModel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

function money(r: CostRange): string {
  return Math.abs(r.high - r.low) < 0.005 ? `≈ ${formatUsd(r.high)}` : `${formatUsd(r.low)} – ${formatUsd(r.high)}`;
}

/**
 * The pre-run cost estimate on the run form. Recomputed in the browser as
 * the settings change. A range until the experiment's baseline (R1) has run;
 * after that, R1's actual averages priced for this run's models.
 */
export function CostEstimate({ values, baseline }: { values: EstimateInput; baseline?: BaselineProfile | null }) {
  const est = baseline ? estimateFromBaseline(values, baseline) : estimateRange(values);
  const caveats = baseline ? baselineCaveats(values, baseline) : [];
  const allMock = [values.agentA.model, values.agentB.model].every((m) => getModel(m)?.kind === "mock");
  const judgesMock = [values.summarizerModel, values.reportModel].every((m) => getModel(m)?.kind === "mock");

  const info = baseline ? (
    <>
      From what {runId(baseline.runNumber)} actually used: its average tokens at each turn (over its conversations that reached that turn,
      weighted by how many did), priced for this run&apos;s models and scaled to this run&apos;s turns and number of conversations.
      Analysis uses {runId(baseline.runNumber)}&apos;s actual analysis spend per conversation plus one run report.
    </>
  ) : (
    <>
      A range, because nothing has run yet. Each conversation is simulated turn by turn with every message assumed to be between a low and
      a high length for its effort (
      {EFFORTS.map((e) => `${EFFORT_LABELS[e]} ${MESSAGE_ASSUMPTIONS[e].low.toLocaleString("en-US")}–${MESSAGE_ASSUMPTIONS[e].high.toLocaleString("en-US")}`).join(", ")}{" "}
      tokens including thinking, at most the max tokens per message), of which {VISIBLE_ASSUMPTION.low}–{VISIBLE_ASSUMPTION.high} are visible
      text. Each agent re-reads its growing history every turn, mostly from the prompt cache. Every conversation is assumed to run all its
      turns. Once the baseline (R1) has run, runs added to the experiment are estimated from its actual averages instead.
    </>
  );

  return (
    <Card data-testid="cost-estimate">
      <CardHeader title="Estimated cost" info={info} />
      <CardBody className="flex flex-col gap-2 text-sm">
        {!est ? (
          <p className="text-muted-foreground">Fill in turns, max tokens, conversations, and the cost ceiling to see an estimate.</p>
        ) : (
          <>
            <p>
              <span className="text-muted-foreground">Run: </span>
              <strong data-testid="estimate-run" className="tabular-nums">
                {allMock ? "$0.00 (Mock model)" : money(est.run)}
              </strong>{" "}
              <span className="text-muted-foreground">
                for {est.conversations.toLocaleString("en-US")} conversation{est.conversations === 1 ? "" : "s"} of up to {est.turns} turns
                {baseline ? `, from ${runId(baseline.runNumber)}'s actual averages` : ""}
              </span>
            </p>
            <p>
              <span className="text-muted-foreground">Analysis: </span>
              <span data-testid="estimate-analysis" className="tabular-nums">
                {judgesMock ? "$0.00 (Mock model)" : baseline && !baseline.analysis ? "not known yet" : money(est.analysis)}
              </span>{" "}
              <span className="text-muted-foreground">coding and the run report, not counted toward the ceiling</span>
            </p>
            {!allMock && est.run.low >= est.ceilingUsd ? (
              <p className="text-amber-700 dark:text-amber-300" data-testid="estimate-warning">
                This is above the {formatUsd(est.ceilingUsd)} cost ceiling, so the run will stop early when it reaches the ceiling.
              </p>
            ) : !allMock && est.run.high > est.ceilingUsd ? (
              <p className="text-amber-700 dark:text-amber-300" data-testid="estimate-warning">
                The high end is above the {formatUsd(est.ceilingUsd)} cost ceiling. If messages run long, the run stops when it reaches the ceiling.
              </p>
            ) : null}
            {caveats.length > 0 && <p className="text-xs text-muted-foreground">A rougher guide here: {caveats.join("; ")}.</p>}
          </>
        )}
      </CardBody>
    </Card>
  );
}
