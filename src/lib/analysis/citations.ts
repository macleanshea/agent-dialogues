/**
 * The citation check, run in code after every report: each cited turn must
 * exist, and each quote must appear in the turn it cites.
 */
import { turnHref } from "../ids";

/** R2·C07·T12, or a span R2·C07·T12-T15. */
const CITATION_RE = /R(\d+)·C(\d+)·T(\d+)(?:\s*[-–]\s*T?(\d+))?/g;

/** A double-quoted passage followed directly by a citation: "words" (R1·C07·T12). */
const QUOTE_RE = /["“]([^"“”\n]{2,600})["”]\s*[,.;:]?\s*\(?\s*(R\d+·C\d+·T\d+(?:\s*[-–]\s*T?\d+)?)/g;

export interface Citation {
  text: string;
  run: number;
  conversation: number;
  from: number;
  to: number;
}

export function parseCitation(text: string): Citation | null {
  CITATION_RE.lastIndex = 0;
  const m = new RegExp(CITATION_RE.source).exec(text);
  if (!m) return null;
  const from = Number(m[3]);
  const to = m[4] ? Number(m[4]) : from;
  return { text: m[0], run: Number(m[1]), conversation: Number(m[2]), from: Math.min(from, to), to: Math.max(from, to) };
}

export function findCitations(markdown: string): Citation[] {
  return [...markdown.matchAll(CITATION_RE)].map((m) => parseCitation(m[0])!);
}

export function findQuotes(markdown: string): Array<{ quote: string; citation: Citation }> {
  return [...markdown.matchAll(QUOTE_RE)].map((m) => ({ quote: m[1], citation: parseCitation(m[2])! }));
}

/**
 * Normalizes text for quote matching: case, whitespace, curly quotes and
 * apostrophes, dashes, and Markdown emphasis marks are ignored, and a
 * trailing ellipsis or leading/trailing punctuation in the quote is dropped.
 */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function trimQuote(q: string): string {
  return normalizeForQuote(q)
    .replace(/^(\.\.\.|…)\s*/, "")
    .replace(/\s*(\.\.\.|…)$/, "")
    .replace(/^[\s.,;:!?'"-]+|[\s.,;:!?'"-]+$/g, "");
}

export interface CitationFailure {
  citation: string;
  quote?: string;
  problem: string;
}

export interface CitationCheckResult {
  citations: number;
  quotes: number;
  failures: CitationFailure[];
  checkedAt: string;
}

/** Looks up the visible text of a turn in the report's experiment, or undefined if it does not exist. */
export type TurnLookup = (run: number, conversation: number, turn: number) => string | undefined;

export function checkCitations(markdown: string, lookup: TurnLookup): CitationCheckResult {
  const failures: CitationFailure[] = [];
  const citations = findCitations(markdown);
  const seen = new Set<string>();
  for (const c of citations) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    for (let t = c.from; t <= c.to; t++) {
      if (lookup(c.run, c.conversation, t) === undefined) {
        failures.push({ citation: c.text, problem: `Turn T${t} does not exist in R${c.run}·C${String(c.conversation).padStart(2, "0")}.` });
        break;
      }
    }
  }
  const quotes = findQuotes(markdown);
  for (const { quote, citation } of quotes) {
    const needle = trimQuote(quote);
    if (!needle) continue;
    let found = false;
    let exists = false;
    for (let t = citation.from; t <= citation.to; t++) {
      const text = lookup(citation.run, citation.conversation, t);
      if (text === undefined) continue;
      exists = true;
      if (normalizeForQuote(text).includes(needle)) found = true;
    }
    if (exists && !found) {
      failures.push({ citation: citation.text, quote, problem: "The quote does not appear in the cited turn." });
    }
  }
  return { citations: citations.length, quotes: quotes.length, failures, checkedAt: new Date().toISOString() };
}

/** Turns every R·C·T citation into a Markdown link to that turn. */
export function linkCitations(markdown: string, experimentNumber: number): string {
  return markdown.replace(CITATION_RE, (m, run: string, conv: string, turn: string) => {
    return `[${m}](${turnHref(experimentNumber, Number(run), Number(conv), Number(turn))})`;
  });
}

/** Turns [T7] and [T7-T9] in a coding into links to the turn on the conversation page. */
export function linkTurnRefs(text: string): string {
  return text.replace(/\[T(\d+)(?:\s*[-–]\s*T?(\d+))?\]/g, (m, a: string) => `[${m.slice(1, -1)}](#T${a})`);
}
