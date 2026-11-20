import { MODELS } from "@/lib/models";

/** The model list for a select. Agent lists disable models that cannot be used for agents. */
export function ModelOptions({ agent }: { agent: boolean }) {
  return (
    <>
      {MODELS.map((m) => {
        const unavailable = agent && !m.agentReady;
        return (
          <option key={m.id} value={m.id} disabled={unavailable}>
            {m.label}
            {unavailable ? " (available in a later update)" : ""}
          </option>
        );
      })}
    </>
  );
}
