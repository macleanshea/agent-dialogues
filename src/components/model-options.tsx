import { MODELS } from "@/lib/models";

/**
 * The model list for a select. Agent lists disable models that cannot be used
 * for agents. The Mock model is listed only where it is enabled (tests).
 */
export function ModelOptions({ agent, allowMock = false }: { agent: boolean; allowMock?: boolean }) {
  return (
    <>
      {MODELS.filter((m) => allowMock || m.kind !== "mock").map((m) => {
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
