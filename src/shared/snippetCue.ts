// Matching a spoken snippet cue. Pure, no I/O, no model.
//
// 2026-07-30: extracted from shared/functions.ts when voice functions were
// removed from Flow. Only the tokenizer and the cue rule came across, because
// only they were ever about snippets - the rest of that file existed to decide
// whether an utterance was a COMMAND, which is a question Flow no longer asks.

export interface Token {
  /** normalized: lowercase, no diacritics, [a-z0-9] only */
  n: string;
  /** index in the ORIGINAL string where this token starts */
  start: number;
  /** index in the ORIGINAL string just past this token */
  end: number;
}

function normChar(ch: string): string {
  const n = ch
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return /^[a-z0-9]+$/.test(n) ? n : "";
}

/** Split into normalized tokens, keeping each one's position in the original
 * string. Iterated by code point (for..of) so an astral character counts as one
 * separator instead of two halves of a surrogate pair. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let start = 0;
  let at = 0;
  for (const ch of text) {
    const n = normChar(ch);
    if (n) {
      if (cur === "") start = at;
      cur += n;
    } else if (cur !== "") {
      out.push({ n: cur, start, end: at });
      cur = "";
    }
    at += ch.length;
  }
  if (cur !== "") out.push({ n: cur, start, end: at });
  return out;
}

/**
 * What a snippet cue must satisfy to fire, and it is deliberately the strictest
 * rule Flow applies to a transcript: the WHOLE utterance must be the cue -
 * nothing before it, nothing after.
 *
 * A snippet is not "command + payload", it IS the utterance, so there is no
 * ambiguity left to resolve. Saying "insere ma signature" fires; saying "insere
 * ma signature en bas du courriel" does not, because that is a sentence ABOUT
 * the signature and it lands as text.
 *
 * That strictness is why this rule survived the removal of voice functions
 * intact. The hard problem there was telling a command apart from ordinary
 * speech, and it cost two blocking review findings and a failed human test. A
 * whole-utterance match has no such problem: an exact match is not a judgement
 * call.
 *
 * Cost: the comparison is on the normalized token join, so trailing
 * punctuation, capitalization and accents from the transcript never matter.
 */
export function matchSnippetCue<T extends { cue: string; enabled: boolean }>(
  text: string,
  snippets: readonly T[],
): T | null {
  const spoken = tokenize(text)
    .map((t) => t.n)
    .join(" ");
  if (!spoken) return null;
  for (const s of snippets) {
    if (!s.enabled) continue;
    const cue = tokenize(s.cue)
      .map((t) => t.n)
      .join(" ");
    if (cue && cue === spoken) return s;
  }
  return null;
}
