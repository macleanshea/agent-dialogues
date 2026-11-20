import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Info } from "@/components/ui/info";
import { getDb } from "@/lib/db";
import { PRESET_KINDS, PRESET_KIND_LABELS, listPresets } from "@/lib/presets/service";
import { deletePresetAction } from "./actions";
import { NewPresetForm } from "./new-preset-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Presets · Agent Dialogues" };

/** Saved prompt presets: the built-in ones and any saved from the run form or here. */
export default async function PresetsPage() {
  const presets = await listPresets(await getDb());
  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        Presets
        <Info>
          Saved text for a system prompt or the opening message. On the run form, &quot;Load preset…&quot; under each box fills it in, and
          &quot;Save as preset&quot; saves what is in the box. Built-in presets cannot be deleted.
        </Info>
      </h1>
      {PRESET_KINDS.map((kind) => (
        <Card key={kind}>
          <CardHeader title={PRESET_KIND_LABELS[kind]} />
          <CardBody className="flex flex-col divide-y divide-border p-0">
            {presets
              .filter((p) => p.kind === kind)
              .map((p) => (
                <div key={p.id} className="flex items-start gap-4 px-5 py-3" data-testid="preset-row">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {p.name}
                      {p.builtin && <Badge tone="neutral">built-in</Badge>}
                    </div>
                    {p.text.trim() ? (
                      <pre className="mt-1.5 rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{p.text}</pre>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground italic">Empty: no system prompt is sent.</p>
                    )}
                  </div>
                  {!p.builtin && (
                    <form action={deletePresetAction.bind(null, p.id)}>
                      <Button type="submit" variant="ghost" className="px-2.5 py-1 text-xs" aria-label={`Delete preset ${p.name}`}>
                        Delete
                      </Button>
                    </form>
                  )}
                </div>
              ))}
          </CardBody>
        </Card>
      ))}
      <NewPresetForm />
    </div>
  );
}
