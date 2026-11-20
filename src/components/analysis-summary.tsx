import type { analysisVersions } from "@/lib/db/schema";
import { modelLabel } from "@/lib/models";

type Version = typeof analysisVersions.$inferSelect;

/** The experiment's current analysis settings (its latest analysis version), read-only. */
export function AnalysisSummary({ version }: { version: Version | null }) {
  if (!version) return <p className="text-sm text-muted-foreground">No analysis version.</p>;
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]" data-testid="analysis-summary">
      <dt className="text-muted-foreground">Version</dt>
      <dd>v{version.version}</dd>
      <dt className="text-muted-foreground">Focus</dt>
      <dd>{version.focus || <span className="text-muted-foreground italic">None</span>}</dd>
      <dt className="text-muted-foreground">Fields</dt>
      <dd className="font-mono text-xs">{version.fieldDefinitions.length ? version.fieldDefinitions.map((d) => d.name).join(", ") : "none"}</dd>
      <dt className="text-muted-foreground">Judges</dt>
      <dd>
        Summarizer {modelLabel(version.summarizerModel)} · Report {modelLabel(version.reportModel)} · Thinking summaries{" "}
        {version.judgeReadsThinking ? "shown" : "hidden"}
      </dd>
    </dl>
  );
}
