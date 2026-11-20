import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { listFieldLibrary, listVersions } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { experiments, runs } from "@/lib/db/schema";
import { toPickerField } from "@/lib/fields/picker";
import { DEFAULT_JUDGE_MODEL } from "@/lib/models";
import { experimentId, parseIndex, runHref, runId } from "@/lib/ids";
import { ReanalyzeForm } from "./reanalyze-form";

export const dynamic = "force-dynamic";

export default async function ReanalyzePage({ params }: PageProps<"/experiments/[exp]/reanalyze">) {
  const { exp } = await params;
  const expN = parseIndex(exp);
  if (!expN) notFound();
  const db = await getDb();
  const [experiment] = await db.select().from(experiments).where(eq(experiments.number, expN));
  if (!experiment) notFound();
  const versions = await listVersions(db, experiment.id);
  const latest = versions[versions.length - 1];
  const fields = (await listFieldLibrary(db)).map(toPickerField);
  const allRuns = await db.select({ number: runs.number, status: runs.status }).from(runs).where(eq(runs.experimentId, experiment.id)).orderBy(runs.number);
  const first = allRuns[0]?.number ?? 1;
  const active = allRuns.filter((r) => r.status === "queued" || r.status === "running");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { label: "Experiments", href: "/" },
            { label: experimentId(experiment.number) },
            { label: runId(first), href: runHref(experiment.number, first) },
            { label: "Re-analyze" },
          ]}
        />
        <h1 className="text-2xl font-semibold tracking-tight">Re-analyze {experiment.name}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Creates analysis version {(latest?.version ?? 0) + 1} and codes the existing transcripts of every run in this experiment again, then
          writes a new run report for each. No conversation is re-run. Earlier versions are kept and stay selectable on the run page. This is
          the one change allowed after an experiment is locked, and it applies to all runs at once.
        </p>
        {active.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {active.length} run{active.length > 1 ? "s are" : " is"} still going and will be analyzed under the new version when finished.
          </p>
        )}
      </div>
      <ReanalyzeForm
        experimentNumber={experiment.number}
        fields={fields}
        initial={{
          focus: latest?.focus ?? experiment.analysisFocus,
          fields: (latest?.fieldDefinitions ?? []).map((f) => f.name).filter((n) => fields.some((f) => f.name === n)),
          summarizerModel: latest?.summarizerModel ?? DEFAULT_JUDGE_MODEL,
          reportModel: latest?.reportModel ?? DEFAULT_JUDGE_MODEL,
          judgeReadsThinking: latest?.judgeReadsThinking ?? false,
        }}
      />
    </div>
  );
}
