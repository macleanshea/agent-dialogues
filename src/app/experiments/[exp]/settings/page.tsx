import { notFound } from "next/navigation";
import { RunForm } from "@/app/runs/new/run-form";
import { AnalysisSummary } from "@/components/analysis-summary";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Button } from "@/components/ui/button";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { formValuesFrom, getBaseline, getExperimentByNumber, latestVersion } from "@/lib/experiments/service";
import { variableLabel } from "@/lib/experiments/variables";
import { toPickerField } from "@/lib/fields/picker";
import { experimentHref, experimentId, parseIndex } from "@/lib/ids";

export const dynamic = "force-dynamic";

/** The experiment's shared settings (the baseline's), as a read-only form. */
export default async function SharedSettingsPage({ params }: PageProps<"/experiments/[exp]/settings">) {
  const { exp } = await params;
  const expN = parseIndex(exp);
  if (!expN) notFound();
  const db = await getDb();
  const experiment = await getExperimentByNumber(db, expN);
  if (!experiment) notFound();
  const baseline = await getBaseline(db, experiment.id);
  const shared = experiment.sharedSettings ?? baseline?.config;
  if (!shared) notFound();
  const version = await latestVersion(db, experiment.id);
  const fields = (await listFieldLibrary(db)).map(toPickerField);
  const variable = variableLabel(experiment.declaredVariables, shared.agentB.sameAsA);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { label: "Experiments", href: "/" },
            { label: experimentId(experiment.number), href: experimentHref(experiment.number) },
            { label: "Shared settings" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Shared settings: {experiment.name}</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" disabled title="Cloning arrives in a later update (PR 5).">
              Clone
            </Button>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground" data-testid="shared-settings-intro">
          The baseline (R1) settings every run shares, read-only.{" "}
          {variable ? (
            <>
              Declared variable: <strong className="text-foreground">{variable}</strong>.{" "}
            </>
          ) : (
            "No variable is declared. "
          )}
          {experiment.locked
            ? "The experiment is locked because it has more than one run: to change these settings or the variable, clone it. Cloning arrives in a later update."
            : "These settings lock once a second run is added."}
        </p>
      </div>
      <RunForm initial={formValuesFrom(shared)} fields={fields} mode="view" analysisSummary={<AnalysisSummary version={version} />} />
    </div>
  );
}
