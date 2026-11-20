import { notFound } from "next/navigation";
import { RunForm } from "@/app/runs/new/run-form";
import { AnalysisSummary } from "@/components/analysis-summary";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { formValuesFrom, getBaseline, getExperimentByNumber, latestVersion } from "@/lib/experiments/service";
import { variableLabel } from "@/lib/experiments/variables";
import { toPickerField } from "@/lib/fields/picker";
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
        <h1 className="text-2xl font-semibold tracking-tight">Add a run to {experiment.name}</h1>
      </div>
      {experiment.declaredVariables.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-start gap-3 text-sm">
            <p>This experiment has no declared variable yet. Choose which setting may vary on the baseline run&apos;s page first.</p>
            <ButtonLink href={runHref(experiment.number, 1)}>Open R1</ButtonLink>
          </CardBody>
        </Card>
      ) : (
        <>
          <p className="max-w-3xl text-sm text-muted-foreground" data-testid="add-run-intro">
            Pre-filled from the baseline (R1). Only the declared variable, <strong className="text-foreground">{variable}</strong>, can be
            changed, plus the cost ceiling and concurrency, which only affect how this run is executed. The run is saved as a draft; start it
            from the experiment list.
          </p>
          <RunForm
            initial={formValuesFrom(baseline.config)}
            fields={fields}
            mode="add"
            variables={experiment.declaredVariables}
            action={addRunAction.bind(null, experiment.number)}
            analysisSummary={<AnalysisSummary version={version} />}
          />
        </>
      )}
    </div>
  );
}
