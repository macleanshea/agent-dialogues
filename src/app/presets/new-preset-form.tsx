"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { PRESET_KIND_LABELS, type PresetKind } from "@/lib/presets/kinds";
import { savePresetAction } from "./actions";

export function NewPresetForm() {
  const [kind, setKind] = useState<PresetKind>("system_prompt");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Card>
      <CardHeader title="New preset" />
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await savePresetAction({ kind, name, text });
              if (res.ok) {
                setName("");
                setText("");
                setErrors({});
                router.refresh();
              } else {
                setErrors(res.errors);
              }
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="For" htmlFor="preset-kind">
              <Select id="preset-kind" value={kind} onChange={(e) => setKind(e.target.value as PresetKind)}>
                {(Object.keys(PRESET_KIND_LABELS) as PresetKind[]).map((k) => (
                  <option key={k} value={k}>
                    {PRESET_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" htmlFor="preset-name" error={errors.name}>
              <Input id="preset-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Text" htmlFor="preset-text" error={errors.text}>
            <Textarea id="preset-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save preset"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
