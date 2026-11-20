/** Display IDs: EXP-004 / R2 / C07 / T12. Citations: R2·C07·T12. */

export function experimentId(n: number): string {
  return `EXP-${String(n).padStart(3, "0")}`;
}

export function runId(n: number): string {
  return `R${n}`;
}

export function conversationId(n: number): string {
  return `C${String(n).padStart(2, "0")}`;
}

export function turnId(n: number): string {
  return `T${n}`;
}

export function citation(run: number, conversation: number, turn: number): string {
  return `${runId(run)}·${conversationId(conversation)}·${turnId(turn)}`;
}

export function runHref(exp: number, run: number): string {
  return `/experiments/${exp}/runs/${run}`;
}

export function conversationHref(exp: number, run: number, conversation: number): string {
  return `${runHref(exp, run)}/conversations/${conversation}`;
}

export function turnHref(exp: number, run: number, conversation: number, turn: number): string {
  return `${conversationHref(exp, run, conversation)}#${turnId(turn)}`;
}

/** Parses a positive whole number from a URL segment, or returns null. */
export function parseIndex(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}
