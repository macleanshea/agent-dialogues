import { runConfigSchema, type RunConfig } from "@/lib/config";
import { getModel } from "@/lib/models";

export interface RunFormState {
  /** Error messages keyed by setting path, e.g. "agentA.model". */
  errors: Record<string, string>;
  message: string | null;
}

/** Validates a submitted run form. */
export function parseRunConfig(raw: unknown): { ok: true; config: RunConfig } | { ok: false; state: RunFormState } {
  const parsed = runConfigSchema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= issue.message;
  return { ok: false, state: { errors, message: "Some settings need fixing. See the messages next to each field." } };
}

/** The message to show when a real model is chosen but the deployment has no API key. */
export function missingApiKey(c: RunConfig): string | null {
  const usesApi = [c.agentA.model, c.agentB.model, c.summarizerModel, c.reportModel].some((m) => getModel(m)?.kind === "anthropic");
  if (usesApi && !process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY is not set for this deployment, so only the Mock model can be used (for the agents, the summarizer, and the report). Add the key in Vercel and redeploy.";
  }
  return null;
}

