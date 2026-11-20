import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
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
          description={
            finished
              ? "The writer saw each run only by its random letter, with model names masked as [model]. Unmasked now that the report is written."
              : "The writer sees each run only by a random letter, with model names masked. Which run is which is shown once the report is written."
          }
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
                      Hidden until the report is written
                    </Td>
                  )}
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card data-testid="comparison-report">
        <CardHeader title="Comparison report" description="Every R·C·T citation links to its turn. Quotes keep [model] where the writer saw a masked name." />
        <CardBody className="flex flex-col gap-4">
          {!finished && (
            <p className="text-sm text-muted-foreground">
              Writing the comparison…{" "}
              {c.opened.length > 0 && `Opened ${c.opened.length} transcript${c.opened.length > 1 ? "s" : ""} so far.`}
            </p>
          )}
          {c.error && (
            <p className="text-sm text-destructive" role="alert">
              {c.error}
            </p>
          )}
          {check && (
            <div
              data-testid="citation-check"
              className={
                check.failures.length
                  ? "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/40"
                  : "rounded-md bg-muted px-3 py-2 text-sm"
              }
            >
              {check.failures.length === 0 ? (
                <span>
                  Citation check passed: {check.citations} citation{check.citations === 1 ? "" : "s"} and {check.quotes} quote
                  {check.quotes === 1 ? "" : "s"} checked against the stored turns (masked as the writer saw them).
                </span>
              ) : (
                <>
                  <strong>
                    Citation check: {check.failures.length} problem{check.failures.length === 1 ? "" : "s"}
                  </strong>
                  <ul className="mt-1 list-disc pl-5">
                    {check.failures.map((f, i) => (
                      <li key={i}>
                        <span className="font-mono">{f.citation}</span>: {f.problem}
                        {f.quote && <> Quote: “{f.quote}”</>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {c.warning && <p className="text-sm text-amber-700 dark:text-amber-300">{c.warning}</p>}
          {c.status === "done" && c.content && <Markdown>{linkCitations(c.content, experiment.number)}</Markdown>}
          {c.status === "done" && (
            <footer className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="comparison-footer">
              Transcripts opened by the writer ({c.opened.length}):{" "}
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
              <summary className="cursor-pointer text-muted-foreground">The report as the writer wrote it (masked)</summary>
              <pre className="mt-2 font-mono text-xs whitespace-pre-wrap" data-testid="masked-report">
                {c.maskedContent}
              </pre>
            </details>
          )}
        </CardBody>
      </Card>

      <div>
        <ButtonLink variant="secondary" href="/prompts">
          See the comparison prompt
        </ButtonLink>
      </div>
    </div>
  );
}
