"use client";

import { useState, useTransition } from "react";
import type { ActionState } from "@/app/experiments/[exp]/actions";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/form";
import { BOTH_MODELS, VARIABLES, hasUnrelatedVariables, normalizeVariables, variableLabel } from "@/lib/experiments/variables";

/**
 * The run page's "Turn this run into an experiment" toggle: which setting or
 * settings may vary between runs. Saving an empty choice makes it a
 * standalone run again. Only shown while the experiment is unlocked.
 */
export function ExperimentToggle({
  declared,
  sameAsA,
  save,
}: {
  declared: string[];
  sameAsA: boolean;
  save: (keys: string[]) => Promise<ActionState>;
}) {
  const [on, setOn] = useState(declared.length > 0);
  const [keys, setKeys] = useState<string[]>(declared);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const tick = (k: string, checked: boolean) => {
    setMessage(null);
    setKeys((prev) => normalizeVariables(checked ? [...prev, k] : prev.filter((x) => x !== k)));
  };
  const bothModels = BOTH_MODELS.every((k) => keys.includes(k));
  const chosen = on ? keys : [];
  const unchanged = JSON.stringify(normalizeVariables(chosen)) === JSON.stringify(normalizeVariables(declared));

  const options: Array<{ key: string; label: string; checked: boolean; onChange: (c: boolean) => void }> = [];
  for (const v of VARIABLES) {
    options.push({ key: v.key, label: v.label, checked: keys.includes(v.key), onChange: (c) => tick(v.key, c) });
    if (v.key === "agentB.model") {
      options.push({
        key: "both-models",
        label: "Both models",
        checked: bothModels,
        onChange: (c) => {
          setMessage(null);
          setKeys((prev) => normalizeVariables(c ? [...prev, ...BOTH_MODELS] : prev.filter((x) => !BOTH_MODELS.includes(x as never))));
        },
      });
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="experiment-toggle">
      <Toggle
        id="make-experiment"
        label="Turn this run into an experiment"
        hint="Choose which setting may vary between runs. Every other setting stays the same as this run (the baseline, R1)."
        checked={on}
        onChange={(e) => {
          setMessage(null);
          setOn(e.target.checked);
        }}
      />
      {on && (
        <fieldset className="flex flex-col gap-3 pl-6">
          <legend className="mb-2 text-sm font-medium">Which setting may vary?</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {options.map((o) => (
              <Toggle key={o.key} id={`var-${o.key}`} label={o.label} checked={o.checked} onChange={(e) => o.onChange(e.target.checked)} />
            ))}
          </div>
          {keys.length > 0 && (
            <p className="text-sm">
              Variable: <strong data-testid="variable-preview">{variableLabel(keys, sameAsA)}</strong>
            </p>
          )}
          {hasUnrelatedVariables(keys) && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert" data-testid="unrelated-warning">
              These settings are unrelated. If more than one of them changes between runs, a difference between the runs cannot be put down to
              any one of them.
            </p>
          )}
        </fieldset>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={pending || unchanged || (on && keys.length === 0)}
          onClick={() =>
            startTransition(async () => {
              const res = await save(chosen);
              setMessage(res.message ?? "Saved.");
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        {on && keys.length === 0 && <span className="text-xs text-muted-foreground">Tick at least one setting.</span>}
        {message && (
          <span className={message === "Saved." ? "text-sm text-muted-foreground" : "text-sm text-destructive"} role="status">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
