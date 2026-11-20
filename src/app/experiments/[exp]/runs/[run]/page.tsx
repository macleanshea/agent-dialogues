import Link from "next/link";
import { notFound } from "next/navigation";
import { FieldAggregates } from "@/components/analysis/aggregates";
import { TurnLineChart } from "@/components/analysis/charts";
import { RunReport } from "@/components/analysis/report";
import { VersionPicker, versionParam } from "@/components/analysis/version-picker";
import { AutoRefresh } from "@/components/auto-refresh";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CostMeter } from "@/components/cost-meter";
import { StopButton } from "@/components/stop-button";
import { RunConfigView } from "@/components/run-config";
import { StatusBadge, stopReasonLabel } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { formatValue, slotsFor, type FieldDef } from "@/lib/analysis/fields";
import { PER_TURN_MEASURES } from "@/lib/analysis/measures";
import { getRunAnalysis } from "@/lib/analysis/queries";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { conversationHref, conversationId, experimentId, parseIndex, runHref, runId } from "@/lib/ids";
import { modelLabel } from "@/lib/models";
import { getRunPage } from "@/lib/runs/service";
import { formatDateTime, formatNumber, formatUsd } from "@/lib/utils";
import { stopRunAction } from "./actions";

export const dynamic = "force-dynamic";

function truncate(s: string, n = 60) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default async function RunPage({ params, searchParams }: PageProps<"/experiments/[exp]/runs/[run]">) {
  const { exp, run } = await params;
  const expN = parseIndex(exp);
  const runN = parseIndex(run);
  if (!expN || !runN) notFound();
  const db = await getDb();
  const page = await getRunPage(db, expN, runN);
  if (!page) notFound();
  const { experiment, run: r, conversations } = page;
  const analysis = await getRunAnalysis(db, r, versionParam(await searchParams));
  const custom = new Set((await listFieldLibrary(db)).filter((f) => !f.builtin).map((f) => f.name));
  const defs = (analysis.version?.fieldDefinitions ?? []) as FieldDef[];
  const codingByIndex = new Map(analysis.codings.map((c) => [c.conversationIndex, c.coding]));
  const base = runHref(experiment.number, r.number);
  const v = analysis.version?.version;
  const withV = (href: string) => (v && analysis.versions.length > 1 ? `${href}?v=${v}` : href);

  const done = conversations.filter((c) => c.status === "done").length;
  const errored = conversations.filter((c) => c.status === "errored").length;
  const turns = conversations.reduce((s, c) => s + c.turnsCompleted, 0);
  const sum = (k: "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" | "thinkingTokens") =>
    conversations.reduce((s, c) => s + c[k], 0);
  const totals = {
    inputTokens: sum("inputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    outputTokens: sum("outputTokens"),
    thinkingTokens: sum("thinkingTokens"),
  };
  const runActive = r.status === "queued" || r.status === "running";
  // Keep refreshing until every conversation has ended (including after Stop) and the analysis is finished.
  const live = runActive || conversations.some((c) => c.status === "running") || Boolean(analysis.status?.active);
  const stop = stopRunAction.bind(null, experiment.number, r.number);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[{ label: "Experiments", href: "/" }, { label: experimentId(experiment.number) }, { label: runId(r.number) }]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{experiment.name}</h1>
          <StatusBadge status={r.status} />
          <AutoRefresh active={live} />
          {runActive && (
            <div className="ml-auto">
              <StopButton onStop={stop} />
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {experimentId(experiment.number)} / {runId(r.number)} · Started {formatDateTime(r.startedAt)} · Cost{" "}
          {formatUsd(r.costUsd)}
          {analysis.status ? ` · Analysis ${formatUsd(analysis.status.costUsd)}` : ""}
        </p>
        {r.error && <p className="text-sm text-destructive">{r.error}</p>}
        {r.stopRequested && live && runActive && (
          <p className="text-sm text-muted-foreground">
            Stopping. Conversations that are mid-call finish that call, keep the turn, and then stop.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ["Conversations", formatNumber(conversations.length)],
          ["Done", formatNumber(done)],
          ["Errored", formatNumber(errored)],
          ["Turns recorded", formatNumber(turns)],
        ].map(([label, value]) => (
          <Card key={label} className="px-4 py-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold tabular-nums">{value}</div>
          </Card>
        ))}
      </div>

      <CostMeter costUsd={r.costUsd} ceilingUsd={r.config.costCeilingUsd} totals={totals} />

      <Card data-testid="analysis-panel">
        <CardHeader
          title="Analysis"
          description="A judge model codes each conversation against the selected fields, then a report writer reads the codings and opens transcripts."
          actions={
            <div className="flex flex-wrap gap-2">
              <ButtonLink variant="secondary" href="/prompts">
                Prompts
              </ButtonLink>
              <ButtonLink variant="secondary" href={`/experiments/${experiment.number}/reanalyze`}>
                Re-analyze
              </ButtonLink>
            </div>
          }
        />
        <CardBody className="flex flex-col gap-3 text-sm">
          {analysis.version ? (
            <>
              <VersionPicker base={base} versions={analysis.versions.map((x) => x.version)} current={analysis.version.version} />
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Focus</dt>
                <dd>{analysis.version.focus || <span className="text-muted-foreground italic">None</span>}</dd>
                <dt className="text-muted-foreground">Fields</dt>
                <dd className="font-mono text-xs">{defs.length ? defs.map((d) => d.name).join(", ") : "none"}</dd>
                <dt className="text-muted-foreground">Judges</dt>
                <dd>
                  Summarizer {modelLabel(analysis.version.summarizerModel)} · Report {modelLabel(analysis.version.reportModel)} · Thinking
                  summaries {analysis.version.judgeReadsThinking ? "shown" : "hidden"} · Prompts{" "}
                  {Object.entries(analysis.version.promptVersions)
                    .map(([k, val]) => `${k} ${val}`)
                    .join(", ")}
                </dd>
                <dt className="text-muted-foreground">Coding</dt>
                <dd data-testid="coding-status">
                  {analysis.status && analysis.status.total > 0 ? (
                    <>
                      {analysis.status.done} of {analysis.status.total} conversations coded
                      {analysis.status.errored ? `, ${analysis.status.errored} failed` : ""}
                      {analysis.status.waiting ? `, ${analysis.status.waiting} waiting` : ""} · {formatUsd(analysis.status.costUsd)}
                    </>
                  ) : runActive ? (
                    "Starts when the run finishes."
                  ) : (
                    "Not analyzed under this version."
                  )}
                </dd>
              </dl>
            </>
          ) : (
            <p className="text-muted-foreground">No analysis version.</p>
          )}
        </CardBody>
      </Card>

      <RunReport report={analysis.report} exp={experiment.number} />

      <Card>
        <CardHeader
          title="Coded fields"
          description={
            analysis.status?.done
              ? `Aggregated across ${analysis.status.done} coded conversation${analysis.status.done === 1 ? "" : "s"}.`
              : "Appears once conversations are coded."
          }
        />
        <CardBody>
          {analysis.status?.done ? (
            <FieldAggregates aggregates={analysis.aggregates} exp={experiment.number} run={r.number} custom={custom} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing coded yet.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Computed measures" description="Counted from the stored turns, with no model call. Lines are averaged across conversations at each turn." />
        <CardBody className="flex flex-col gap-6">
          <Table data-testid="speaker-measures">
            <thead>
              <tr>
                <Th>Speaker</Th>
                <Th className="text-right">Turns</Th>
                <Th className="text-right">Tokens</Th>
                <Th className="text-right">Thinking tokens</Th>
                <Th className="text-right">Mean visible length</Th>
              </tr>
            </thead>
            <tbody>
              {analysis.speakers.map((s) => (
                <Tr key={s.speaker}>
                  <Td>{s.speaker}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(s.turns)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(Math.round(s.tokens))}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(Math.round(s.thinkingTokens))}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(Math.round(s.meanLength))} chars</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="grid gap-6 md:grid-cols-2">
            {PER_TURN_MEASURES.map((m) => (
              <TurnLineChart
                key={m.key}
                testId={`chart-${m.key}`}
                title={m.label}
                format={m.format}
                points={analysis.series[m.key].map((p) => ({ x: p.turn, y: p.value, note: `${p.n} conversation${p.n === 1 ? "" : "s"}` }))}
              />
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Conversations" description="Click a conversation to read its transcript and coding." />
        <Table>
          <thead>
            <tr>
              <Th>ID</Th>
              <Th>Status</Th>
              <Th>Stop reason</Th>
              <Th className="text-right">Turns</Th>
              <Th>Repetition</Th>
              <Th className="text-right">Truncated</Th>
              <Th className="text-right">Empty</Th>
              <Th>Sign-off</Th>
              <Th className="text-right">Input tokens</Th>
              <Th className="text-right">Cached read</Th>
              <Th className="text-right">Output tokens</Th>
              <Th className="text-right">Thinking tokens</Th>
              <Th className="text-right">Cost</Th>
              <Th>Coding</Th>
              {defs.map((d) => (
                <Th key={d.name} className="font-mono normal-case">
                  {d.name}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => {
              const coding = codingByIndex.get(c.index);
              const counts = analysis.counts.get(c.id);
              return (
                <Tr key={c.id} data-testid="conversation-row">
                  <Td className="font-mono text-xs">
                    <Link href={withV(conversationHref(experiment.number, r.number, c.index))} className="hover:underline">
                      {conversationId(c.index)}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={c.status} />
                  </Td>
                  <Td>
                    {stopReasonLabel(c.stopReason)}
                    {c.error && <div className="mt-0.5 max-w-sm text-xs text-destructive">{c.error}</div>}
                  </Td>
                  <Td className="text-right tabular-nums">{c.turnsCompleted}</Td>
                  <Td className="whitespace-nowrap">
                    {c.repetitionFlagTurn ? <span className="text-amber-700 dark:text-amber-300">Flagged at T{c.repetitionFlagTurn}</span> : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">{counts?.truncated ?? 0}</Td>
                  <Td className="text-right tabular-nums">{counts?.empty ?? 0}</Td>
                  <Td className="whitespace-nowrap">
                    {counts?.signOffs.length ? counts.signOffs.map((s) => `${s.speaker} at T${s.turn}`).join(", ") : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">{formatNumber(c.inputTokens)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(c.cacheReadTokens)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(c.outputTokens)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(c.thinkingTokens)}</Td>
                  <Td className="text-right tabular-nums">{formatUsd(c.costUsd)}</Td>
                  <Td>
                    {coding ? (
                      <span title={coding.error ?? undefined}>
                        <StatusBadge status={coding.status} />
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  {defs.map((d) => {
                    const stored = coding?.output?.fields[d.name];
                    const text = stored
                      ? slotsFor(d.scope)
                          .map((s) => {
                            const val = formatValue(d, stored[s]?.value ?? null);
                            return s === "all" ? val : `${s}: ${val}`;
                          })
                          .join(" · ")
                      : "—";
                    return (
                      <Td key={d.name} className="max-w-56 text-xs" title={text}>
                        {truncate(text)}
                      </Td>
                    );
                  })}
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Config" description="A full copy of the settings this run used." />
        <CardBody>
          <RunConfigView config={r.config} />
        </CardBody>
      </Card>
    </div>
  );
}
