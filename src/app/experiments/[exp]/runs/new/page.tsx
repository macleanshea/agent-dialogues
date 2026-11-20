import { notFound } from "next/navigation";
import { RunForm } from "@/app/runs/new/run-form";
import { AnalysisSummary } from "@/components/analysis-summary";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { ButtonLink } from "@/components/ui/button";
import { Info } from "@/components/ui/info";
import { Card, CardBody } from "@/components/ui/card";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { formValuesFrom, getBaseline, getExperimentByNumber, latestVersion } from "@/lib/experiments/service";
import { variableLabel } from "@/lib/experiments/variables";
import { toPickerField } from "@/lib/fields/picker";
import { listPresets, toPresetOption } from "@/lib/presets/service";
import { baselineProfile } from "@/lib/runs/service";
import { experimentHref, experimentId, parseIndex, runHref } from "@/lib/ids";
import { addRunAction } from "../../actions";

export const dynamic = "force-dynamic";

/** "+ Add run": the run form pre-filled from the baseline, with only the declared variable unlocked. */
export default async function AddRunPage({ params }: PageProps<"/experiments/[exp]/runs/new">) {
  const { exp } = await params;
  const expN = parseIndex(exp);
  if (!expN) notFound();
  const db = await getDb();
  const experiment = await getExperimentByNumber(db, expN);
  if (!experiment) notFound();
  const baseline = await getBaseline(db, experiment.id);
  if (!baseline) notFound();
  const version = await latestVersion(db, experiment.id);
  const fields = (await listFieldLibrary(db)).map(toPickerField);
  const presets = (await listPresets(db)).map(toPresetOption);
  const profile = await baselineProfile(db, experiment.id);
  const variable = variableLabel(experiment.declaredVariables, baseline.config.agentB.sameAsA);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[
            { label: "Experiments", href: "/" },
            { label: experimentId(experiment.number), href: experimentHref(experiment.number) },
            { label: "Add run" },
          ]}
        />
        <h1 className="text-2xl font-semibold tracking-tight">Add run: {experiment.name}</h1>
      </div>
      {experiment.declaredVariables.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-start gap-3 text-sm">
            <p>No declared variable yet. Set one with the Experiment button.</p>
            <ButtonLink href={runHref(experiment.number, 1)}>Open R1</ButtonLink>
          </CardBody>
        </Card>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm" data-testid="add-run-intro">
            <span>
              <span className="text-muted-foreground">Varies:</span> <strong>{variable}</strong>
            </span>
            <Info>
              Pre-filled from the baseline (R1). Only the declared variable can change, plus the cost ceiling and concurrency, which only
              affect how this run is executed. The run is saved as a draft.
            </Info>
          </p>
          <RunForm
            initial={formValuesFrom(baseline.config)}
            fields={fields}
            mode="add"
            variables={experiment.declaredVariables}
            action={addRunAction.bind(null, experiment.number)}
            analysisSummary={<AnalysisSummary version={version} />}
            presets={presets}
            baseline={profile}
          />
        </>
      )}
    </div>
  );
}
