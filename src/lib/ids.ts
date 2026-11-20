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

/** The main list with this experiment expanded. */
export function experimentHref(exp: number): string {
  return `/?open=${exp}#${experimentId(exp)}`;
}

export function addRunHref(exp: number): string {
  return `/experiments/${exp}/runs/new`;
}

export function sharedSettingsHref(exp: number): string {
  return `/experiments/${exp}/settings`;
}

export function comparisonHref(exp: number, comparison: number): string {
  return `/experiments/${exp}/comparisons/${comparison}`;
}

/** Parses the main list's ?open=1,4 into experiment numbers. */
export function parseOpenParam(raw: string | string[] | undefined): number[] {
  const s = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return [...new Set(s.split(",").map((x) => parseIndex(x.trim())).filter((n): n is number => n !== null))];
}

/** The ?open= value with one experiment toggled. */
export function toggleOpen(open: number[], exp: number): string {
  const next = open.includes(exp) ? open.filter((n) => n !== exp) : [...open, exp];
  return next.length ? `/?open=${next.sort((a, b) => a - b).join(",")}` : "/";
}
