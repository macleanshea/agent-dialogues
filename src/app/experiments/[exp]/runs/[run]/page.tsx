import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { RunConfigView } from "@/components/run-config";
import { StatusBadge, stopReasonLabel } from "@/components/status";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { conversationHref, conversationId, experimentId, parseIndex, runId } from "@/lib/ids";
import { getRunPage } from "@/lib/runs/service";
import { formatDateTime, formatNumber, formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: PageProps<"/experiments/[exp]/runs/[run]">) {
  const { exp, run } = await params;
  const expN = parseIndex(exp);
  const runN = parseIndex(run);
  if (!expN || !runN) notFound();
  const page = await getRunPage(await getDb(), expN, runN);
  if (!page) notFound();
  const { experiment, run: r, conversations } = page;

  const done = conversations.filter((c) => c.status === "done").length;
  const errored = conversations.filter((c) => c.status === "errored").length;
  const turns = conversations.reduce((s, c) => s + c.turnsCompleted, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[{ label: "Experiments", href: "/" }, { label: experimentId(experiment.number) }, { label: runId(r.number) }]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{experiment.name}</h1>
          <StatusBadge status={r.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {experimentId(experiment.number)} / {runId(r.number)} · Started {formatDateTime(r.startedAt)} · Cost{" "}
          {formatUsd(r.costUsd)}
        </p>
        {r.error && <p className="text-sm text-destructive">{r.error}</p>}
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

      <Card>
        <CardHeader title="Conversations" description="Click a conversation to read its transcript." />
        <Table>
          <thead>
            <tr>
              <Th>ID</Th>
              <Th>Status</Th>
              <Th>Stop reason</Th>
              <Th className="text-right">Turns</Th>
              <Th className="text-right">Input tokens</Th>
              <Th className="text-right">Output tokens</Th>
              <Th className="text-right">Thinking tokens</Th>
              <Th className="text-right">Cost</Th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => (
              <Tr key={c.id} data-testid="conversation-row">
                <Td className="font-mono text-xs">
                  <Link href={conversationHref(experiment.number, r.number, c.index)} className="hover:underline">
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
                <Td className="text-right tabular-nums">{formatNumber(c.inputTokens)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(c.outputTokens)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(c.thinkingTokens)}</Td>
                <Td className="text-right tabular-nums">{formatUsd(c.costUsd)}</Td>
              </Tr>
            ))}
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
