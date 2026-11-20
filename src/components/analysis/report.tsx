import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { linkCitations } from "@/lib/analysis/citations";
import type { CitationCheckResult } from "@/lib/analysis/citations";
import type { reports } from "@/lib/db/schema";
import { conversationHref, conversationId, runId } from "@/lib/ids";
import { modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

type Report = typeof reports.$inferSelect;

/** Words in a Markdown report, ignoring heading and list marks. */
export function wordCount(markdown: string): number {
  return markdown.replace(/[#*_>`-]+/g, " ").split(/\s+/).filter(Boolean).length;
}

/** The citation check result, shown above a report. */
export function CitationCheck({ check }: { check: CitationCheckResult }) {
  return (
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
          Citation check passed: {check.citations} citation{check.citations === 1 ? "" : "s"}, {check.quotes} quote{check.quotes === 1 ? "" : "s"}.
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
  );
}

/** A run's report, its citation check, and the footer listing the transcripts it opened. */
export function RunReport({ report, exp }: { report: Report | null; exp: number }) {
  if (!report) {
    return (
      <div className="px-5 py-4 text-sm text-muted-foreground" data-testid="run-report">
        Not written yet.
      </div>
    );
  }
  const check = report.citationCheck;
  return (
    <div className="flex flex-col gap-4 px-5 py-4" data-testid="run-report">
      {report.status === "pending" || report.status === "running" ? (
        <p className="text-sm text-muted-foreground">
          Writing… {report.opened.length > 0 && `${report.opened.length} transcript${report.opened.length > 1 ? "s" : ""} opened.`}
        </p>
      ) : null}
      {report.error && (
        <p className="text-sm text-destructive" role="alert">
          {report.error}
        </p>
      )}
      {check && <CitationCheck check={check} />}
      {report.warning && <p className="text-sm text-amber-700 dark:text-amber-300">{report.warning}</p>}
      {report.content && <Markdown>{linkCitations(report.content, exp)}</Markdown>}
      {(report.status === "done" || report.opened.length > 0) && (
        <footer className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="report-footer">
          Transcripts opened ({report.opened.length}):{" "}
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
          {report.content ? `${wordCount(report.content)} words · ` : ""}
          {modelLabel(report.model)} · {report.calls} call{report.calls === 1 ? "" : "s"} · {formatUsd(report.costUsd)}
        </footer>
      )}
    </div>
  );
}
