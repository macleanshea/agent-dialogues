import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Markdown } from "@/components/markdown";
import { StatusBadge, stopReasonLabel } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { NO_REPLY_PLACEHOLDER, OPENING_STUB } from "@/lib/config";
import { getDb } from "@/lib/db";
import {
  citation,
  conversationHref,
  conversationId,
  experimentId,
  parseIndex,
  runHref,
  runId,
  turnId,
} from "@/lib/ids";
import { modelLabel } from "@/lib/models";
import { getConversationPage } from "@/lib/runs/service";
import { cn, formatNumber, formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: PageProps<"/experiments/[exp]/runs/[run]/conversations/[conv]">) {
  const { exp, run, conv } = await params;
  const expN = parseIndex(exp);
  const runN = parseIndex(run);
  const convN = parseIndex(conv);
  if (!expN || !runN || !convN) notFound();
  const page = await getConversationPage(await getDb(), expN, runN, convN);
  if (!page) notFound();
  const { experiment, run: r, conversation: c, turns } = page;
  const cfg = r.config;

  const truncated = turns.filter((t) => t.truncated).length;
  const empty = turns.filter((t) => t.placeholderUsed).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { label: "Experiments", href: "/" },
            { label: experimentId(experiment.number) },
            { label: runId(r.number), href: runHref(experiment.number, r.number) },
            { label: conversationId(c.index) },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Conversation {conversationId(c.index)}</h1>
          <StatusBadge status={c.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {experiment.name} · A: {modelLabel(cfg.agentA.model)} · B: {modelLabel(cfg.agentB.model)}
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="text-muted-foreground">Stop reason:</span> {stopReasonLabel(c.stopReason)}
          </span>
          <span>
            <span className="text-muted-foreground">Turns:</span> {c.turnsCompleted} of {cfg.turns}
          </span>
          <span>
            <span className="text-muted-foreground">Truncated:</span> {truncated}
          </span>
          <span>
            <span className="text-muted-foreground">Empty replies:</span> {empty}
          </span>
          <span>
            <span className="text-muted-foreground">Tokens in / out / thinking:</span> {formatNumber(c.inputTokens)} /{" "}
            {formatNumber(c.outputTokens)} / {formatNumber(c.thinkingTokens)}
          </span>
          <span>
            <span className="text-muted-foreground">Cost:</span> {formatUsd(c.costUsd)}
          </span>
        </div>
        {c.error && (
          <p className="text-sm text-destructive" role="alert">
            {c.error}
          </p>
        )}
        <div className="flex gap-4 text-sm">
          {c.index > 1 && (
            <Link className="underline" href={conversationHref(experiment.number, r.number, c.index - 1)}>
              ← {conversationId(c.index - 1)}
            </Link>
          )}
          {c.index < page.conversationCount && (
            <Link className="underline" href={conversationHref(experiment.number, r.number, c.index + 1)}>
              {conversationId(c.index + 1)} →
            </Link>
          )}
        </div>
      </div>

      <Card className="border-dashed">
        <CardBody>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Opening message to A (not a turn
            {cfg.attributeOpeningToB
              ? `; B's history starts with "${OPENING_STUB}" and this message as B's own reply`
              : "; B never sees it"}
            )
          </div>
          <pre className="font-mono text-xs whitespace-pre-wrap">{cfg.openingMessage}</pre>
        </CardBody>
      </Card>

      <ol className="flex flex-col gap-3" aria-label="Transcript">
        {turns.map((t) => (
          <li key={t.id} id={turnId(t.turnNumber)} className="scroll-mt-6" data-testid="turn">
            <Card className={cn(t.speaker === "B" && "md:ml-12", t.speaker === "A" && "md:mr-12")}>
              <CardBody className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <a href={`#${turnId(t.turnNumber)}`} className="font-mono font-semibold hover:underline">
                    {turnId(t.turnNumber)}
                  </a>
                  <Badge tone={t.speaker === "A" ? "info" : "neutral"}>{t.speaker}</Badge>
                  <span className="text-muted-foreground">{modelLabel(t.model)}</span>
                  {t.truncated && <Badge tone="warning">truncated</Badge>}
                  {t.attempts > 1 && <Badge tone="warning">retried at {formatNumber(t.maxTokensUsed)} max tokens</Badge>}
                  {t.placeholderUsed && <Badge tone="warning">empty reply, other agent saw “{NO_REPLY_PLACEHOLDER}”</Badge>}
                  {t.stopReason !== "end_turn" && <Badge tone="neutral">stop: {t.stopReason}</Badge>}
                  <span className="ml-auto font-mono text-muted-foreground">
                    {citation(r.number, c.index, t.turnNumber)}
                  </span>
                </div>

                {t.thinkingSummary && (
                  <details className="rounded-md bg-muted px-3 py-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground select-none">
                      Thinking summary (private to {t.speaker})
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap">{t.thinkingSummary}</p>
                  </details>
                )}

                {t.text.trim() ? (
                  <Markdown>{t.text}</Markdown>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No visible text.</p>
                )}

                <div className="text-xs text-muted-foreground tabular-nums">
                  {formatNumber(t.text.length)} chars · in {formatNumber(t.inputTokens)} · out{" "}
                  {formatNumber(t.outputTokens)} (thinking {formatNumber(t.thinkingTokens)}) · cached{" "}
                  {formatNumber(t.cacheReadTokens)} · {formatUsd(t.costUsd)}
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>
      {turns.length === 0 && <p className="text-sm text-muted-foreground">No turns recorded.</p>}
    </div>
  );
}
