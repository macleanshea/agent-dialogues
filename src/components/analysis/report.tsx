import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { linkCitations } from "@/lib/analysis/citations";
import type { reports } from "@/lib/db/schema";
import { conversationHref, conversationId, runId } from "@/lib/ids";
import { modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

type Report = typeof reports.$inferSelect;

/** The run report, its citation check, and the footer listing the transcripts it opened. */
export function RunReport({ report, exp }: { report: Report | null; exp: number }) {
  if (!report) {
    return (
      <Card data-testid="run-report">
        <CardHeader title="Run report" />
        <CardBody>
          <p className="text-sm text-muted-foreground">No report yet. It is written after the conversations are coded.</p>
        </CardBody>
      </Card>
    );
  }
  const check = report.citationCheck;
  return (
    <Card data-testid="run-report">
      <CardHeader
        title="Run report"
        description={`Written by ${modelLabel(report.model)}. Every R·C·T citation links to its turn.`}
        actions={<StatusBadge status={report.status} />}
      />
      <CardBody className="flex flex-col gap-4">
        {report.status === "pending" || report.status === "running" ? (
          <p className="text-sm text-muted-foreground">
            Writing the report… {report.opened.length > 0 && `Opened ${report.opened.length} transcript${report.opened.length > 1 ? "s" : ""} so far.`}
          </p>
        ) : null}
        {report.error && (
          <p className="text-sm text-destructive" role="alert">
            {report.error}
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
                {check.quotes === 1 ? "" : "s"} checked against the stored turns.
              </span>
            ) : (
              <>
                <strong>
                  Citation check: {check.failures.length} problem{check.failures.length === 1 ? "" : "s"}
                </strong>{" "}
                ({check.citations} citations, {check.quotes} quotes checked)
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
        {report.warning && <p className="text-sm text-amber-700 dark:text-amber-300">{report.warning}</p>}
        {report.content && <Markdown>{linkCitations(report.content, exp)}</Markdown>}
        {(report.status === "done" || report.opened.length > 0) && (
          <footer className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="report-footer">
            Transcripts opened by the report writer ({report.opened.length}):{" "}
            {report.opened.length === 0
              ? "none."
              : report.opened.map((o, i) => (
                  <span key={`${o.run}-${o.conversation}`}>
                    {i > 0 && ", "}
                    <Link className="font-mono underline" href={conversationHref(exp, o.run, o.conversation)}>
                      {runId(o.run)}·{conversationId(o.conversation)}
                    </Link>
                  </span>
                ))}
            {" · "}
            {report.calls} model call{report.calls === 1 ? "" : "s"} · {formatUsd(report.costUsd)}
          </footer>
        )}
      </CardBody>
    </Card>
  );
}
