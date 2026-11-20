import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status";
import { CitationCheck, wordCount } from "@/components/analysis/report";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { linkCitations } from "@/lib/analysis/citations";
import { getComparisonPage } from "@/lib/analysis/comparison";
import { getDb } from "@/lib/db";
import { normalizeVariables, variableLabel, variableValues } from "@/lib/experiments/variables";
import { conversationHref, conversationId, experimentHref, experimentId, parseIndex, runHref, runId } from "@/lib/ids";
import { modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ComparisonPage({ params }: PageProps<"/experiments/[exp]/comparisons/[cmp]">) {
  const { exp, cmp } = await params;
  const expN = parseIndex(exp);
  const cmpN = parseIndex(cmp);
  if (!expN || !cmpN) notFound();
  const page = await getComparisonPage(await getDb(), expN, cmpN);
  if (!page) notFound();
  const { comparison: c, experiment, version, runs } = page;
  const finished = c.status === "done" || c.status === "errored";
  const variables = normalizeVariables(experiment.declaredVariables);
  const sameAsA = (experiment.sharedSettings ?? runs[0]?.config)?.agentB.sameAsA ?? false;
  const check = c.citationCheck;
  const byLabel = [...c.labels].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { label: "Experiments", href: "/" },
            { label: experimentId(experiment.number), href: experimentHref(experiment.number) },
            { label: `Comparison ${c.number}` },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Comparison {c.number}: {c.labels.map((l) => runId(l.runNumber)).join(" vs ")}
          </h1>
          <StatusBadge status={c.status} />
          <AutoRefresh active={!finished} />
        </div>
        <p className="text-sm text-muted-foreground">
          {experiment.name} · Variable: {variables.length ? variableLabel(variables, sameAsA) : "none"} · Analysis v{version.version} · Written by{" "}
          {modelLabel(c.model)} · {c.calls} model call{c.calls === 1 ? "" : "s"} · {formatUsd(c.costUsd)}
        </p>
      </div>

      <Card data-testid="comparison-runs">
        <CardHeader
          title="Runs"
          info="The writer sees each run only by a random letter, with model and maker names masked as [model]. Which run is which is shown once the report is written."
        />
        <Table>
          <thead>
            <tr>
              <Th>Writer saw</Th>
              <Th>Run</Th>
              <Th>{variables.length ? variableLabel(variables, sameAsA) : "Variable"}</Th>
              <Th>Models (A / B)</Th>
            </tr>
          </thead>
          <tbody>
            {byLabel.map((l) => {
              const run = runs.find((r) => r.id === l.runId);
              return (
                <Tr key={l.label} data-testid="comparison-run-row">
                  <Td className="font-medium">Run {l.label}</Td>
                  {finished && run ? (
                    <>
                      <Td className="font-mono text-xs">
                        <Link href={runHref(experiment.number, l.runNumber)} className="underline">
                          {runId(l.runNumber)}
                        </Link>
                      </Td>
                      <Td>{variableValues(variables, run.config)}</Td>
                      <Td>
                        {modelLabel(run.config.agentA.model)} / {modelLabel(run.config.agentB.model)}
                      </Td>
                    </>
                  ) : (
                    <Td colSpan={3} className="text-muted-foreground italic">
                      Hidden until done
                    </Td>
                  )}
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card data-testid="comparison-report">
        <CardHeader title="Report" info="Citations link to their turns. Quotes keep [model] where the writer saw a masked name, and are checked against the masked text." />
        <CardBody className="flex flex-col gap-4">
          {!finished && (
            <p className="text-sm text-muted-foreground">
              Writing… {c.opened.length > 0 && `${c.opened.length} transcript${c.opened.length > 1 ? "s" : ""} opened.`}
            </p>
          )}
          {c.error && (
            <p className="text-sm text-destructive" role="alert">
              {c.error}
            </p>
          )}
          {check && <CitationCheck check={check} />}
          {c.warning && <p className="text-sm text-amber-700 dark:text-amber-300">{c.warning}</p>}
          {c.status === "done" && c.content && <Markdown>{linkCitations(c.content, experiment.number)}</Markdown>}
          {c.status === "done" && (
            <footer className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="comparison-footer">
              {c.content ? `${wordCount(c.content)} words · ` : ""}Transcripts opened ({c.opened.length}):{" "}
              {c.opened.length === 0
                ? "none."
                : c.opened.map((o, i) => (
                    <span key={`${o.run}-${o.conversation}`}>
                      {i > 0 && ", "}
                      <Link className="font-mono underline" href={conversationHref(experiment.number, o.run, o.conversation)}>
                        {runId(o.run)}·{conversationId(o.conversation)}
                      </Link>
                    </span>
                  ))}
            </footer>
          )}
          {c.status === "done" && c.maskedContent && (
            <details className="rounded-md border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Masked original</summary>
              <pre className="mt-2 font-mono text-xs whitespace-pre-wrap" data-testid="masked-report">
                {c.maskedContent}
              </pre>
            </details>
          )}
        </CardBody>
      </Card>

    </div>
  );
}
