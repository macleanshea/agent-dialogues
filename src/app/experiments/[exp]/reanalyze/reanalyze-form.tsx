"use client";

import { useActionState, useState } from "react";
import { FieldPicker } from "@/components/field-picker";
import { ModelOptions } from "@/components/model-options";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Select, Textarea, Toggle } from "@/components/ui/form";
import type { PickerField } from "@/lib/fields/picker";
import { reanalyzeAction, type ReanalyzeState } from "./actions";

export interface ReanalyzeSettings {
  focus: string;
  fields: string[];
  summarizerModel: string;
  reportModel: string;
  judgeReadsThinking: boolean;
}

const INITIAL: ReanalyzeState = { errors: {}, message: null };

export function ReanalyzeForm({ experimentNumber, initial, fields }: { experimentNumber: number; initial: ReanalyzeSettings; fields: PickerField[] }) {
  const [v, setV] = useState(initial);
  const [state, formAction, pending] = useActionState(reanalyzeAction.bind(null, experimentNumber), INITIAL);
  const set = <K extends keyof ReanalyzeSettings>(k: K, val: ReanalyzeSettings[K]) => setV((p) => ({ ...p, [k]: val }));

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="settings" value={JSON.stringify(v)} />
      <Card>
        <CardHeader title="Analysis" info="Pre-filled from the latest analysis version." />
        <CardBody className="flex flex-col gap-5">
          <Field label="Analysis focus" htmlFor="focus" hint="Free text the judge and report writer read. It produces findings, not counts. To count something, tick or add a field." error={state.errors.focus}>
            <Textarea id="focus" rows={2} className="font-sans text-sm" value={v.focus} onChange={(e) => set("focus", e.target.value)} />
          </Field>
          <FieldPicker fields={fields} selected={v.fields} onChange={(names) => set("fields", names)} error={state.errors.fields} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Summarizer model" htmlFor="summarizer" error={state.errors.summarizerModel}>
              <Select id="summarizer" value={v.summarizerModel} onChange={(e) => set("summarizerModel", e.target.value)}>
                <ModelOptions agent={false} />
              </Select>
            </Field>
            <Field label="Report model" htmlFor="report" error={state.errors.reportModel}>
              <Select id="report" value={v.reportModel} onChange={(e) => set("reportModel", e.target.value)}>
                <ModelOptions agent={false} />
              </Select>
            </Field>
          </div>
          <Toggle
            id="judge-thinking"
            label="Judge can read thinking summaries"
            checked={v.judgeReadsThinking}
            onChange={(e) => set("judgeReadsThinking", e.target.checked)}
          />
        </CardBody>
      </Card>
      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Starting…" : "Re-analyze all runs"}
        </Button>
        {state.message && !pending && (
          <p className="text-sm text-destructive" role="alert">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
