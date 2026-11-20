import { eq, sql } from "drizzle-orm";
import { runs } from "@/lib/db/schema";
import { defaultRunConfig, type RunConfig } from "@/lib/config";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { findRun, formValuesFrom, getBaseline, getExperimentByNumber, latestVersion } from "@/lib/experiments/service";
import { variableLabel } from "@/lib/experiments/variables";
import { listPresets, toPresetOption } from "@/lib/presets/service";
import { toPickerField } from "@/lib/fields/picker";
import { experimentId, parseIndex, runId } from "@/lib/ids";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";

/**
 * The run form. With ?from=4 it is a clone of EXP-004: pre-filled from that
 * experiment's baseline settings and its latest analysis settings, and it
 * starts a new experiment (optionally with the source's variable and other
 * runs copied as drafts). With ?from=4&run=2 it is a clone of one run: the
 * form is pre-filled from R2's settings instead, and nothing else is copied.
 */
export default async function NewRunPage({ searchParams }: PageProps<"/runs/new">) {
  const db = await getDb();
  const library = await listFieldLibrary(db);
  const fields = library.map(toPickerField);
  const fromRaw = (await searchParams).from;
  const from = typeof fromRaw === "string" ? parseIndex(fromRaw) : null;
  const runRaw = (await searchParams).run;
  const fromRun = typeof runRaw === "string" ? parseIndex(runRaw) : null;
  const presets = (await listPresets(db)).map(toPresetOption);

  let initial: RunConfig = defaultRunConfig();
  let source: string | null = null;
  const exp = from ? await getExperimentByNumber(db, from) : null;
  const picked = exp && fromRun && fromRun !== 1 ? await findRun(db, exp.number, fromRun) : null;
  const baseline = exp ? (picked ?? (await getBaseline(db, exp.id))) : null;
  let cloneFrom: { exp: number; otherRuns: number; variable: string } | null = null;
  if (exp && baseline) {
    const version = await latestVersion(db, exp.id);
    initial = {
      ...formValuesFrom(baseline.config),
      name: picked ? `${exp.name} ${runId(picked.number)} (copy)` : `${exp.name} (copy)`,
      ...(version
        ? {
            analysisFocus: version.focus,
            // Fields deleted from the library since are left out.
            fields: version.fieldDefinitions.map((f) => f.name).filter((n) => library.some((l) => l.name === n)),
            summarizerModel: version.summarizerModel,
            reportModel: version.reportModel,
            judgeReadsThinking: version.judgeReadsThinking,
          }
        : {}),
    };
    source = picked ? `${experimentId(exp.number)} / ${runId(picked.number)}` : experimentId(exp.number);
    if (!fromRun && exp.declaredVariables.length > 0) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(runs).where(eq(runs.experimentId, exp.id));
      cloneFrom = { exp: exp.number, otherRuns: Number(n) - 1, variable: variableLabel(exp.declaredVariables, baseline.config.agentB.sameAsA) };
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        {source && (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="clone-source">
            Cloned from {source}
          </p>
        )}
      </div>
      <RunForm initial={initial} fields={fields} presets={presets} cloneFrom={cloneFrom} />
    </div>
  );
}
