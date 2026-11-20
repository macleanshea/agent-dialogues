/**
 * Stop rules that read the visible text of turns: sign-off and repetition.
 * Pure functions, shared by the engine and (later) the computed measures.
 */

/** Lowercased words, with punctuation stripped. Letters and digits in any script count. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** The set of word trigrams in a text. */
export function trigrams(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/**
 * Word-trigram overlap between two messages, from 0 to 1: shared trigrams
 * divided by all distinct trigrams in either message (Jaccard similarity).
 *
 * Messages too short to have a trigram (under three words) count as 1 when
 * their words are identical and 0 otherwise, so a loop of "Goodbye." still
 * registers. Two empty messages count as 0: silence is handled by the
 * empty-reply rule, not as repetition.
 */
export function trigramOverlap(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) {
    const wa = words(a).join(" ");
    const wb = words(b).join(" ");
    return wa.length > 0 && wa === wb ? 1 : 0;
  }
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** True if the message ends with [END] on its own line (trailing whitespace ignored). */
export function endsWithSignOff(text: string): boolean {
  return /(^|\n)[ \t]*\[END\][ \t]*$/.test(text.trimEnd());
}
