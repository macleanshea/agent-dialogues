"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { ActionState } from "@/app/experiments/[exp]/actions";
import { ExportLinks } from "@/components/export-links";
import { StatusBadge } from "@/components/status";
import { Button, ButtonLink } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { addRunHref, cloneHref, comparisonHref, runHref, runId } from "@/lib/ids";
import { formatUsd } from "@/lib/utils";

export interface PanelRunView {
  number: number;
  variableValue: string;
  status: string;
  costUsd: number;
  reportStatus: string | null;
  coded: number;
  codingWaiting: number;
}

const FINISHED = ["done", "stopped", "failed"];

/** The expanded panel of one experiment on the main list. */
export function ExperimentPanel({
  exp,
  variable,
  focus,
  locked,
  runs,
  comparisons,
  compare,
  startDraft,
  deleteDraft,
  runAll,
}: {
  exp: number;
  variable: string;
  focus: string;
  locked: boolean;
  runs: PanelRunView[];
  comparisons: Array<{ number: number; status: string; runNumbers: number[] }>;
  compare: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  startDraft: Array<{ number: number; action: () => Promise<void> }>;
  deleteDraft: Array<{ number: number; action: () => Promise<void> }>;
  runAll: () => Promise<void>;
}) {
  const [state, formAction, pending] = useActionState(compare, { message: null });
  const drafts = runs.filter((r) => r.status === "draft");

  return (
    <form action={formAction} className="flex flex-col gap-3 bg-muted/40 px-4 py-4" data-testid="experiment-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm" data-testid="panel-header">
          <span className="text-muted-foreground">Variable:</span> <strong>{variable || "none declared"}</strong>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-muted-foreground">Focus:</span> {focus || <span className="text-muted-foreground italic">none</span>}
          {locked && <span className="ml-2 text-xs text-muted-foreground">(locked)</span>}
        </p>
        <div className="ml-auto flex flex-wrap gap-2">
          <ExportLinks exp={exp} />
          <ButtonLink variant="secondary" href={addRunHref(exp)}>
            + Add run
          </ButtonLink>
          <Button type="submit" variant="secondary" formAction={runAll} disabled={drafts.length === 0} formNoValidate>
            Run all{drafts.length ? ` (${drafts.length})` : ""}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border bg-background">
        <Table>
          <thead>
            <tr>
              <Th className="w-8">
                <span className="sr-only">Compare</span>
              </Th>
              <Th>Run</Th>
              <Th>{variable || "Variable"}</Th>
              <Th>Status</Th>
              <Th className="text-right">Cost</Th>
              <Th>Report</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const start = startDraft.find((d) => d.number === r.number)?.action;
              const del = deleteDraft.find((d) => d.number === r.number)?.action;
              return (
                <Tr key={r.number} data-testid="panel-run-row">
                  <Td>
                    <input
                      type="checkbox"
                      name="run"
                      value={r.number}
                      aria-label={`Compare ${runId(r.number)}`}
                      disabled={!FINISHED.includes(r.status)}
                      className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                    />
                  </Td>
                  <Td className="font-mono text-xs">
                    <Link href={runHref(exp, r.number)} className="hover:underline">
                      {runId(r.number)}
                    </Link>
                    {r.number === 1 && <span className="ml-1.5 font-sans text-xs text-muted-foreground">baseline</span>}
                  </Td>
                  <Td className="max-w-80 truncate" title={r.variableValue}>
                    {r.variableValue}
                  </Td>
                  <Td>
                    <StatusBadge status={r.status as "done"} />
                  </Td>
                  <Td className="text-right tabular-nums">{formatUsd(r.costUsd)}</Td>
                  <Td className="whitespace-nowrap">
                    {r.reportStatus ? (
                      <Link href={`${runHref(exp, r.number)}#run-report`} className="underline">
                        {r.reportStatus === "done" ? "Report" : r.reportStatus === "errored" ? "Report failed" : "Writing…"}
                      </Link>
                    ) : r.codingWaiting ? (
                      "Coding…"
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <ButtonLink variant="ghost" href={cloneHref(exp, r.number)} className="mr-1 px-2.5 py-1 text-xs" aria-label={`Clone Run ${runId(r.number)}`}>
                      Clone Run
                    </ButtonLink>
                    {start && (
                      <Button type="submit" formAction={start} formNoValidate className="px-2.5 py-1 text-xs">
                        Run
                      </Button>
                    )}
                    {del && (
                      <Button type="submit" variant="ghost" formAction={del} formNoValidate className="ml-1 px-2.5 py-1 text-xs">
                        Delete draft
                      </Button>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Starting…" : "Compare"}
        </Button>
        {state.message && !pending && (
          <p className="w-full text-sm text-destructive" role="alert">
            {state.message}
          </p>
        )}
      </div>

      {comparisons.length > 0 && (
        <div className="text-sm" data-testid="panel-comparisons">
          <span className="text-muted-foreground">Comparisons: </span>
          {comparisons.map((c, i) => (
            <span key={c.number}>
              {i > 0 && " · "}
              <Link href={comparisonHref(exp, c.number)} className="underline">
                Comparison {c.number}
              </Link>{" "}
              <span className="text-muted-foreground">
                ({c.runNumbers.map(runId).join(", ")}, {c.status})
              </span>
            </span>
          ))}
        </div>
      )}
    </form>
  );
}
