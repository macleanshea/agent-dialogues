import { defaultRunConfig, type RunConfig } from "@/lib/config";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { formValuesFrom, getBaseline, getExperimentByNumber, latestVersion } from "@/lib/experiments/service";
import { toPickerField } from "@/lib/fields/picker";
import { experimentId, parseIndex } from "@/lib/ids";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";

/**
 * The run form. With ?from=4 it is a clone of EXP-004: pre-filled from that
 * experiment's baseline settings and its latest analysis settings, and it
 * starts a new standalone experiment.
 */
export default async function NewRunPage({ searchParams }: PageProps<"/runs/new">) {
  const db = await getDb();
  const library = await listFieldLibrary(db);
  const fields = library.map(toPickerField);
  const fromRaw = (await searchParams).from;
  const from = typeof fromRaw === "string" ? parseIndex(fromRaw) : null;

  let initial: RunConfig = defaultRunConfig();
  let source: string | null = null;
  const exp = from ? await getExperimentByNumber(db, from) : null;
  const baseline = exp ? await getBaseline(db, exp.id) : null;
  if (exp && baseline) {
    const version = await latestVersion(db, exp.id);
    initial = {
      ...formValuesFrom(baseline.config),
      name: `${exp.name} (copy)`,
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
    source = experimentId(exp.number);
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
      <RunForm initial={initial} fields={fields} />
    </div>
  );
}
