"use client";

import { useState, useTransition } from "react";
import type { ActionState } from "@/app/experiments/[exp]/actions";
import { Button } from "@/components/ui/button";
import { DialogButton } from "@/components/ui/dialog";
import { Toggle } from "@/components/ui/form";
import { BOTH_MODELS, VARIABLES, hasUnrelatedVariables, normalizeVariables, variableLabel } from "@/lib/experiments/variables";

/**
 * "Create Experiment" (run page header) or "Create Exp." (main list rows):
 * a dialog asking which setting may vary between runs. Saving turns the
 * standalone run into an experiment and opens the main list with it
 * expanded. Only shown for standalone runs: once an experiment exists the
 * button is gone.
 */
export function ExperimentButton({
  sameAsA,
  save,
  short = false,
}: {
  sameAsA: boolean;
  save: (keys: string[]) => Promise<ActionState>;
  /** "Create Exp." on the main list, where space is tight. */
  short?: boolean;
}) {
  return (
    <DialogButton label={short ? "Create Exp." : "Create Experiment"} title="Create Experiment" testId="experiment-dialog">
      <ExperimentToggle sameAsA={sameAsA} save={save} />
    </DialogButton>
  );
}

/** Which setting or settings may vary between runs. */
export function ExperimentToggle({ sameAsA, save }: { sameAsA: boolean; save: (keys: string[]) => Promise<ActionState> }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const tick = (k: string, checked: boolean) => {
    setMessage(null);
    setKeys((prev) => normalizeVariables(checked ? [...prev, k] : prev.filter((x) => x !== k)));
  };
  const bothModels = BOTH_MODELS.every((k) => keys.includes(k));

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
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm text-muted-foreground">
          Which setting varies between runs? Every other setting stays the same as this run, which becomes the baseline (R1).
        </legend>
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
            Unrelated settings: a difference between runs can&apos;t be attributed to any one of them.
          </p>
        )}
      </fieldset>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={pending || keys.length === 0}
          onClick={() =>
            startTransition(async () => {
              // On success the action opens the main list with the experiment expanded.
              const res = await save(keys);
              if (res?.message) setMessage(res.message);
            })
          }
        >
          {pending ? "Creating…" : "Create experiment"}
        </Button>
        {keys.length === 0 && <span className="text-xs text-muted-foreground">Tick at least one setting.</span>}
        {message && (
          <span className="text-sm text-destructive" role="status">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
