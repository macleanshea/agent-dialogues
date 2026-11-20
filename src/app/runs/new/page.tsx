import { defaultRunConfig, withoutMock, type RunConfig } from "@/lib/config";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { findRun, formValuesFrom, getExperimentByNumber, latestVersion } from "@/lib/experiments/service";
import { mockModelEnabled } from "@/lib/mock-setting";
import { listPresets, toPresetOption } from "@/lib/presets/service";
import { toPickerField } from "@/lib/fields/picker";
import { experimentId, parseIndex, runId } from "@/lib/ids";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";

/**
 * The run form. With ?from=4&run=2 it is "Clone Run": pre-filled from R2 of
 * EXP-004 (R1 when no run is given) and that experiment's latest analysis
 * settings. Either way it starts a new standalone run, outside the source
 * experiment.
 */
export default async function NewRunPage({ searchParams }: PageProps<"/runs/new">) {
  const db = await getDb();
  const library = await listFieldLibrary(db);
  const fields = library.map(toPickerField);
  const query = await searchParams;
  const from = typeof query.from === "string" ? parseIndex(query.from) : null;
  const fromRun = (typeof query.run === "string" ? parseIndex(query.run) : null) ?? 1;
  const presets = (await listPresets(db)).map(toPresetOption);
  const allowMock = mockModelEnabled();

  let initial: RunConfig = defaultRunConfig();
  let source: string | null = null;
  const exp = from ? await getExperimentByNumber(db, from) : null;
  const picked = exp ? await findRun(db, exp.number, fromRun) : null;
  if (exp && picked) {
    const version = await latestVersion(db, exp.id);
    initial = {
      ...formValuesFrom(picked.config),
      name: picked.number === 1 ? `${exp.name} (copy)` : `${exp.name} ${runId(picked.number)} (copy)`,
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
    source = `${experimentId(exp.number)} / ${runId(picked.number)}`;
  }
  if (!allowMock) initial = withoutMock(initial);

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
      <RunForm initial={initial} fields={fields} presets={presets} allowMock={allowMock} cancelHref="/" />
    </div>
  );
}
