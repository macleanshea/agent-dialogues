import Link from "next/link";
import { Fragment } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ExperimentPanel } from "@/components/experiments/panel";
import { StatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { experimentIdsByNumber, getExperimentPanel } from "@/lib/experiments/service";
import { variableValues } from "@/lib/experiments/variables";
import { experimentId, parseOpenParam, runHref, toggleOpen } from "@/lib/ids";
import { listExperiments } from "@/lib/runs/service";
import { formatDateTime, formatUsd } from "@/lib/utils";
import { compareAction, deleteDraftAction, runAllAction, startDraftAction } from "./experiments/[exp]/actions";

export const dynamic = "force-dynamic";

const COLUMNS = 8;

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const db = await getDb();
  const rows = await listExperiments(db);
  // Which experiments are expanded lives in the URL: /?open=1,4
  const open = parseOpenParam((await searchParams).open);
  const ids = await experimentIdsByNumber(db, open);
  const panels = new Map(
    await Promise.all(
      rows
        .filter((r) => r.expandable && open.includes(r.number) && ids.has(r.number))
        .map(async (r) => [r.number, await getExperimentPanel(db, ids.get(r.number)!)] as const),
    ),
  );

  // Keep refreshing while anything in an expanded experiment is still going.
  const live = [...panels.values()].some(
    (p) =>
      p !== null &&
      (p.runs.some(
        (x) => x.status === "queued" || x.status === "running" || x.codingWaiting > 0 || x.reportStatus === "pending" || x.reportStatus === "running",
      ) ||
        p.comparisons.some((c) => c.status === "pending" || c.status === "running")),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>
        <AutoRefresh active={live} />
      </div>

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">No experiments yet.</p>
          <ButtonLink href="/runs/new">Start your first run</ButtonLink>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th className="w-8">
                  <span className="sr-only">Expand</span>
                </Th>
                <Th>ID</Th>
                <Th>Name</Th>
                <Th>Variable</Th>
                <Th className="text-right">Runs</Th>
                <Th>Status</Th>
                <Th className="text-right">Total cost</Th>
                <Th>Last updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = r.expandable && open.includes(r.number);
                // A standalone run has no expander: the row opens its run page.
                const href = r.expandable ? toggleOpen(open, r.number) : r.firstRunNumber ? runHref(r.number, r.firstRunNumber) : undefined;
                const label = r.expandable ? `${isOpen ? "Collapse" : "Expand"} ${experimentId(r.number)}` : undefined;
                const panel = panels.get(r.number);
                return (
                  <Fragment key={r.number}>
                    <Tr data-testid="experiment-row" id={experimentId(r.number)} aria-expanded={r.expandable ? isOpen : undefined}>
                      <Td className="text-muted-foreground">
                        {r.expandable && (
                          <Link href={href!} aria-label={label} className="inline-block w-4 text-center hover:text-foreground" scroll={false}>
                            {isOpen ? "▾" : "▸"}
                          </Link>
                        )}
                      </Td>
                      <Td className="font-mono text-xs whitespace-nowrap">
                        {href ? (
                          <Link href={href} scroll={false}>
                            {experimentId(r.number)}
                          </Link>
                        ) : (
                          experimentId(r.number)
                        )}
                      </Td>
                      <Td className="font-medium">
                        {href ? (
                          <Link href={href} className="hover:underline" scroll={false}>
                            {r.name}
                          </Link>
                        ) : (
                          r.name
                        )}
                      </Td>
                      <Td className="text-muted-foreground">{r.variable || "—"}</Td>
                      <Td className="text-right tabular-nums">{r.runCount}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td className="text-right tabular-nums">{formatUsd(r.totalCostUsd)}</Td>
                      <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.updatedAt)}</Td>
                    </Tr>
                    {isOpen && panel && (
                      <tr>
                        <td colSpan={COLUMNS} className="border-b border-border p-0">
                          <ExperimentPanel
                            exp={r.number}
                            variable={r.variable}
                            focus={panel.experiment.analysisFocus}
                            locked={panel.experiment.locked}
                            runs={panel.runs.map((x) => ({
                              number: x.number,
                              variableValue: variableValues(panel.experiment.declaredVariables, x.config),
                              status: x.status,
                              costUsd: x.costUsd,
                              reportStatus: x.reportStatus,
                              coded: x.coded,
                              codingWaiting: x.codingWaiting,
                            }))}
                            comparisons={panel.comparisons}
                            compare={compareAction.bind(null, r.number)}
                            startDraft={panel.runs
                              .filter((x) => x.status === "draft")
                              .map((x) => ({ number: x.number, action: startDraftAction.bind(null, r.number, x.number) }))}
                            deleteDraft={panel.runs
                              .filter((x) => x.status === "draft")
                              .map((x) => ({ number: x.number, action: deleteDraftAction.bind(null, r.number, x.number) }))}
                            runAll={runAllAction.bind(null, r.number)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
