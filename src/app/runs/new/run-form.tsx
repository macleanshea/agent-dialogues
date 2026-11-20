"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { LIMITS, OPENING_STUB, SIGN_OFF_LINE, type RunConfig } from "@/lib/config";
import { CostEstimate } from "@/components/cost-estimate";
import { FieldPicker } from "@/components/field-picker";
import { PresetPicker } from "@/components/preset-picker";
import type { BaselineProfile } from "@/lib/estimate";
import type { PresetOption } from "@/lib/presets/kinds";
import { ModelOptions } from "@/components/model-options";
import type { PickerField } from "@/lib/fields/picker";
import { EFFORTS, EFFORT_LABELS } from "@/lib/models";
import { PER_RUN_SETTINGS, normalizeVariables, pathsFor } from "@/lib/experiments/variables";
import { createRunAction } from "./actions";
import type { RunFormState } from "./validate";

/** Number inputs hold text while the user types; the server validates them. */
type Values = { [K in keyof RunConfig]: RunConfig[K] extends number ? number | string : RunConfig[K] };

const INITIAL_STATE: RunFormState = { errors: {}, message: null };

/**
 * The run form.
 * - "new": a new standalone run; everything is editable.
 * - "add": "+ Add run" in an experiment; pre-filled from the baseline, with only
 *   the declared variable (plus the per-run cost ceiling and concurrency)
 *   unlocked. The server enforces the same rule.
 */
export function RunForm({
  initial,
  fields,
  mode = "new",
  variables = [],
  action = createRunAction,
  analysisSummary,
  presets = [],
  baseline = null,
  cloneFrom = null,
}: {
  initial: RunConfig;
  fields: PickerField[];
  mode?: "new" | "add";
  variables?: string[];
  action?: (prev: RunFormState, formData: FormData) => Promise<RunFormState>;
  /** Shown instead of the analysis settings in "add" mode. */
  analysisSummary?: ReactNode;
  /** Saved prompt presets, for the lists under the prompts. */
  presets?: PresetOption[];
  /** The experiment's finished baseline, so the cost estimate can use its actual averages. */
  baseline?: BaselineProfile | null;
  /** When cloning a whole experiment: its number, and how its other runs are offered for copying. */
  cloneFrom?: { exp: number; otherRuns: number; variable: string } | null;
}) {
  const [presetList, setPresetList] = useState<PresetOption[]>(presets);
  const addPreset = (p: PresetOption) => setPresetList((prev) => [...prev, p]);
  const [copyRuns, setCopyRuns] = useState(Boolean(cloneFrom && cloneFrom.otherRuns > 0));
  const [v, setV] = useState<Values>(initial);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const err = (path: string) => state.errors[path];
  const unlocked = new Set<string>([...normalizeVariables(variables).flatMap(pathsFor), ...PER_RUN_SETTINGS]);
  /** True when this setting cannot be changed in this mode. */
  const locked = (path: string) => mode === "add" && !unlocked.has(path);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const setA = (patch: Partial<Values["agentA"]>) => setV((p) => ({ ...p, agentA: { ...p.agentA, ...patch } }));
  const setB = (patch: Partial<Values["agentB"]>) => setV((p) => ({ ...p, agentB: { ...p.agentB, ...patch } }));

  const openingIsStub = v.openingMessage.trim() === OPENING_STUB;
  // The attribution toggle only applies when the opening message is not the stub.
  const payload: Values = { ...v, attributeOpeningToB: openingIsStub ? false : v.attributeOpeningToB };

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="config" value={JSON.stringify(payload)} />
      {cloneFrom && <input type="hidden" name="cloneFrom" value={cloneFrom.exp} />}
      {cloneFrom && copyRuns && <input type="hidden" name="copyRuns" value="1" />}

      <Card>
        <CardHeader title="Name" info={mode === "new" ? "Optional. Leave blank to name it after the models and turn count." : undefined} />
        <CardBody>
          <Input
            id="name"
                disabled={locked("name")}
            aria-label="Name"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Open-ended, blank prompts"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Agents" info="A speaks first and on every odd turn. B speaks on even turns." />
        <CardBody className="grid gap-6 md:grid-cols-2">
          {/* Agent A */}
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-semibold">Agent A</legend>
            <Field label="Model" htmlFor="a-model" error={err("agentA.model")}>
              <Select id="a-model"
                disabled={locked("agentA.model")} value={v.agentA.model} onChange={(e) => setA({ model: e.target.value })}>
                <ModelOptions agent />
              </Select>
            </Field>
            <Field label="Effort" htmlFor="a-effort" hint="How deeply the model thinks before replying.">
              <Select
                id="a-effort"
                disabled={locked("agentA.effort")}
                value={v.agentA.effort}
                onChange={(e) => setA({ effort: e.target.value as RunConfig["agentA"]["effort"] })}
              >
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {EFFORT_LABELS[e]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="System prompt"
              htmlFor="a-system"
              hint="Optional. If blank, no system prompt is sent."
              error={err("agentA.systemPrompt")}
            >
              <Textarea
                id="a-system"
                disabled={locked("agentA.systemPrompt")}
                rows={5}
                value={v.agentA.systemPrompt}
                onChange={(e) => setA({ systemPrompt: e.target.value })}
              />
              <PresetPicker
                id="a-system"
                label="System prompt A"
                kind="system_prompt"
                presets={presetList}
                text={v.agentA.systemPrompt}
                disabled={locked("agentA.systemPrompt")}
                onLoad={(text) => setA({ systemPrompt: text })}
                onSaved={addPreset}
              />
            </Field>
          </fieldset>

          {/* Agent B */}
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-semibold">Agent B</legend>
            <Field label="Model" htmlFor="b-model" error={err("agentB.model")}>
              <Select id="b-model"
                disabled={locked("agentB.model")} value={v.agentB.model} onChange={(e) => setB({ model: e.target.value })}>
                <ModelOptions agent />
              </Select>
            </Field>
            <Field label="Effort" htmlFor="b-effort" hint="How deeply the model thinks before replying.">
              <Select
                id="b-effort"
                disabled={locked("agentB.effort")}
                value={v.agentB.effort}
                onChange={(e) => setB({ effort: e.target.value as RunConfig["agentB"]["effort"] })}
              >
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {EFFORT_LABELS[e]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="System prompt"
              htmlFor="b-system"
              hint={v.agentB.sameAsA ? "Using A's system prompt." : "Optional. If blank, no system prompt is sent."}
              error={err("agentB.systemPrompt")}
            >
              <Textarea
                id="b-system"
                rows={5}
                value={v.agentB.sameAsA ? v.agentA.systemPrompt : v.agentB.systemPrompt}
                disabled={v.agentB.sameAsA || locked("agentB.systemPrompt")}
                onChange={(e) => setB({ systemPrompt: e.target.value })}
              />
              <PresetPicker
                id="b-system"
                label="System prompt B"
                kind="system_prompt"
                presets={presetList}
                text={v.agentB.sameAsA ? v.agentA.systemPrompt : v.agentB.systemPrompt}
                disabled={v.agentB.sameAsA || locked("agentB.systemPrompt")}
                onLoad={(text) => setB({ systemPrompt: text })}
                onSaved={addPreset}
              />
            </Field>
            <Toggle
              id="b-same"
              label="Same as A"
              disabled={locked("agentB.sameAsA")}
              checked={v.agentB.sameAsA}
              onChange={(e) => setB({ sameAsA: e.target.checked })}
            />
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Conversation" />
        <CardBody className="flex flex-col gap-5">
          <Field
            label="Opening message to A"
            htmlFor="opening"
            hint="Sent to A before turn 1. It is not a turn, and B never sees it unless it is attributed to B."
            error={err("openingMessage")}
          >
            <Textarea
              id="opening"
                disabled={locked("openingMessage")}
              rows={3}
              value={v.openingMessage}
              onChange={(e) => set("openingMessage", e.target.value)}
            />
            <PresetPicker
              id="opening"
              label="Opening message"
              kind="opening_message"
              presets={presetList}
              text={v.openingMessage}
              disabled={locked("openingMessage")}
              onLoad={(text) => set("openingMessage", text)}
              onSaved={addPreset}
            />
          </Field>
          <Toggle
            id="attribute"
            label="Attribute opening message to B"
            hint={
              openingIsStub
                ? `Available once the opening message differs from "${OPENING_STUB}".`
                : "B's history starts as if B had written the opening message."
            }
            disabled={openingIsStub || locked("attributeOpeningToB")}
            checked={!openingIsStub && v.attributeOpeningToB}
            onChange={(e) => set("attributeOpeningToB", e.target.checked)}
            error={err("attributeOpeningToB")}
          />

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Turns"
              htmlFor="turns"
              hint={`One turn is one message. Max ${LIMITS.turns.max}.`}
              error={err("turns")}
            >
              <Input
                id="turns"
                disabled={locked("turns")}
                type="number"
                min={LIMITS.turns.min}
                max={LIMITS.turns.max}
                value={v.turns}
                onChange={(e) => set("turns", e.target.value)}
              />
            </Field>
            <Field
              label="Max tokens per message"
              htmlFor="max-tokens"
              hint="Covers thinking plus visible text."
              error={err("maxTokens")}
            >
              <Input
                id="max-tokens"
                disabled={locked("maxTokens")}
                type="number"
                min={LIMITS.maxTokens.min}
                value={v.maxTokens}
                onChange={(e) => set("maxTokens", e.target.value)}
              />
            </Field>
            <Field
              label="Number of conversations"
              htmlFor="conversations"
              hint={`Max ${LIMITS.conversations.max}.`}
              error={err("conversations")}
            >
              <Input
                id="conversations"
                disabled={locked("conversations")}
                type="number"
                min={LIMITS.conversations.min}
                max={LIMITS.conversations.max}
                value={v.conversations}
                onChange={(e) => set("conversations", e.target.value)}
              />
            </Field>
            <Field
              label="Concurrency"
              htmlFor="concurrency"
              hint="Conversations running at once."
              error={err("concurrency")}
            >
              <Input
                id="concurrency"
                disabled={locked("concurrency")}
                type="number"
                min={LIMITS.concurrency.min}
                max={LIMITS.concurrency.max}
                value={v.concurrency}
                onChange={(e) => set("concurrency", e.target.value)}
              />
            </Field>
          </div>

          <Toggle
            id="sign-off"
                disabled={locked("signOff")}
            label="Sign-off"
            hint={
              v.signOff ? (
                <>
                  This line is added to both system prompts: <q>{SIGN_OFF_LINE}</q>
                </>
              ) : (
                "Let either agent end the conversation by writing [END] on its own line."
              )
            }
            checked={v.signOff}
            onChange={(e) => set("signOff", e.target.checked)}
          />

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Repetition threshold"
              htmlFor="rep-threshold"
              hint="0 to 1. Overlap with the speaker's previous message."
              error={err("repetitionThreshold")}
            >
              <Input
                id="rep-threshold"
                disabled={locked("repetitionThreshold")}
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={v.repetitionThreshold}
                onChange={(e) => set("repetitionThreshold", e.target.value)}
              />
            </Field>
            <Field label="When repetition is found" htmlFor="rep-action">
              <Select
                id="rep-action"
                disabled={locked("repetitionAction")}
                value={v.repetitionAction}
                onChange={(e) => set("repetitionAction", e.target.value as RunConfig["repetitionAction"])}
              >
                <option value="flag">Flag it and continue</option>
                <option value="stop">Stop the conversation</option>
              </Select>
            </Field>
            <Field
              label="Cost ceiling per run (USD)"
              htmlFor="cost-ceiling"
              hint="The run stops when it is reached."
              error={err("costCeilingUsd")}
            >
              <Input
                id="cost-ceiling"
                disabled={locked("costCeilingUsd")}
                type="number"
                step="0.01"
                min={0}
                required
                value={v.costCeilingUsd}
                onChange={(e) => set("costCeilingUsd", e.target.value)}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      {mode === "new" ? (
      <Card>
        <CardHeader
          title="Analysis"
          info="After the run, a judge model codes every conversation against the fields you tick, then a report writer summarizes the run."
        />
        <CardBody className="flex flex-col gap-5">
          <Field
            label="Analysis focus"
            htmlFor="focus"
            hint="One to three sentences, in your own words, on what to look for. The judge reads it and lists findings on it for each conversation, and the run report gives it its own section. It is free text: it is not counted or charted. To count something across conversations, tick or add a field below."
            error={err("analysisFocus")}
          >
            <Textarea
              id="focus"
              rows={2}
              className="font-sans text-sm"
              value={v.analysisFocus}
              onChange={(e) => set("analysisFocus", e.target.value)}
            />
          </Field>
          <FieldPicker fields={fields} selected={v.fields} onChange={(names) => set("fields", names)} error={err("fields")} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Summarizer model" htmlFor="summarizer" hint="Codes each conversation." error={err("summarizerModel")}>
              <Select id="summarizer" value={v.summarizerModel} onChange={(e) => set("summarizerModel", e.target.value)}>
                <ModelOptions agent={false} />
              </Select>
            </Field>
            <Field label="Report model" htmlFor="report" hint="Writes the run report." error={err("reportModel")}>
              <Select id="report" value={v.reportModel} onChange={(e) => set("reportModel", e.target.value)}>
                <ModelOptions agent={false} />
              </Select>
            </Field>
          </div>
          <Toggle
            id="judge-thinking"
            label="Judge can read thinking summaries"
            hint="Off: the judge sees only what the agents said to each other."
            checked={v.judgeReadsThinking}
            onChange={(e) => set("judgeReadsThinking", e.target.checked)}
          />
        </CardBody>
      </Card>
      ) : (
        <Card>
          <CardHeader title="Analysis" info="Analysis settings belong to the experiment and apply to every run in it. Change them with Re-analyze." />
          <CardBody>{analysisSummary}</CardBody>
        </Card>
      )}

      {cloneFrom && cloneFrom.otherRuns > 0 && (
        <Card data-testid="clone-runs">
          <CardHeader title="Experiment" />
          <CardBody>
            <Toggle
              id="copy-runs"
              label={`Also copy the variable (${cloneFrom.variable}) and the other ${cloneFrom.otherRuns} run${cloneFrom.otherRuns === 1 ? "" : "s"} as drafts`}
              hint="The settings above become the new baseline (R1), which starts now. Each other run is saved as a draft with its own value of the variable and everything else from the new baseline, so you can change shared settings and run the whole experiment again."
              checked={copyRuns}
              onChange={(e) => setCopyRuns(e.target.checked)}
            />
          </CardBody>
        </Card>
      )}

      <CostEstimate values={payload} baseline={baseline} />

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {mode === "add" ? (pending ? "Saving…" : "Save draft") : pending ? "Starting…" : "Start run"}
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
