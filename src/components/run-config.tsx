import type { ReactNode } from "react";
import { SIGN_OFF_LINE, type RunConfigSnapshot } from "@/lib/config";
import { EFFORT_LABELS, modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,12rem)_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Prompt({ text }: { text: string }) {
  if (!text.trim()) return <span className="text-muted-foreground italic">None (no system prompt sent)</span>;
  return <pre className="rounded-md bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap">{text}</pre>;
}

/** Read-only view of a run's config snapshot. */
export function RunConfigView({ config }: { config: RunConfigSnapshot }) {
  const c = config;
  return (
    <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
      <section>
        <h3 className="mb-1 text-sm font-semibold">Agent A</h3>
        <dl>
          <Row label="Model">
            {modelLabel(c.agentA.model)} <span className="font-mono text-xs text-muted-foreground">({c.agentA.model})</span>
          </Row>
          <Row label="Effort">{EFFORT_LABELS[c.agentA.effort]}</Row>
          <Row label="System prompt sent">
            <Prompt text={c.resolved.systemPromptA} />
          </Row>
        </dl>
      </section>
      <section>
        <h3 className="mb-1 text-sm font-semibold">Agent B</h3>
        <dl>
          <Row label="Model">
            {modelLabel(c.agentB.model)} <span className="font-mono text-xs text-muted-foreground">({c.agentB.model})</span>
          </Row>
          <Row label="Effort">{EFFORT_LABELS[c.agentB.effort]}</Row>
          <Row label="System prompt sent">
            {c.agentB.sameAsA && <p className="mb-1 text-xs text-muted-foreground">Same as A</p>}
            <Prompt text={c.resolved.systemPromptB} />
          </Row>
        </dl>
      </section>
      <section>
        <h3 className="mb-1 text-sm font-semibold">Conversation</h3>
        <dl>
          <Row label="Opening message to A">
            <pre className="rounded-md bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap">{c.openingMessage}</pre>
          </Row>
          <Row label="Attributed to B">{c.attributeOpeningToB ? "Yes" : "No"}</Row>
          <Row label="Turns">{c.turns}</Row>
          <Row label="Max tokens per message">{c.maxTokens.toLocaleString("en-US")}</Row>
          <Row label="Conversations">{c.conversations}</Row>
          <Row label="Concurrency">{c.concurrency}</Row>
          <Row label="Sign-off">
            {c.signOff ? (
              <>
                On. Added to both system prompts: <q className="text-muted-foreground">{SIGN_OFF_LINE}</q>
              </>
            ) : (
              "Off"
            )}
          </Row>
          <Row label="Repetition">
            Threshold {c.repetitionThreshold}, {c.repetitionAction === "stop" ? "stop the conversation" : "flag and continue"}
          </Row>
          <Row label="Cost ceiling">{formatUsd(c.costCeilingUsd)}</Row>
        </dl>
      </section>
      <section>
        <h3 className="mb-1 text-sm font-semibold">Analysis (as first set; see the Analysis panel for re-analysis)</h3>
        <dl>
          <Row label="Analysis focus">
            {c.analysisFocus ? c.analysisFocus : <span className="text-muted-foreground italic">None</span>}
          </Row>
          <Row label="Fields">
            {c.fields?.length ? <span className="font-mono text-xs">{c.fields.join(", ")}</span> : <span className="text-muted-foreground italic">None</span>}
          </Row>
          <Row label="Summarizer model">{modelLabel(c.summarizerModel)}</Row>
          <Row label="Report model">{modelLabel(c.reportModel)}</Row>
          <Row label="Judge reads thinking">{c.judgeReadsThinking ? "Yes" : "No"}</Row>
        </dl>
      </section>
    </div>
  );
}
