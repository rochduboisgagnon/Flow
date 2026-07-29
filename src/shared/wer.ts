// C8: the measuring instrument for transcription quality - word error rate, on
// French, at the WORD level. Pure by construction (no disk, no Electron, no
// engine): the arithmetic is the part that has to be RIGHT, and it must be
// arguable against hand-computed cases without a whisper server anywhere near
// it. scripts/bench-wer.ts is the only thing that drives an engine; this file
// only compares two strings.
//
// ---------------------------------------------------------------------------
// WHY NORMALIZATION IS THE WHOLE DESIGN, NOT A DETAIL
// ---------------------------------------------------------------------------
// A word error rate is only as honest as what it calls "the same word". In
// French, a bench that scores "vingt-cinq" against "25" as an error is not
// measuring the engine, it is measuring its own normalization - the speaker
// said one thing, both spellings write it, and whisper picks one on its own
// mood. The same goes for casing, accents and punctuation, none of which the
// microphone ever carried.
//
// So the pipeline is, in order:
//   1. cut into maximal [letter|digit] runs (punctuation, hyphens, apostrophes
//      and whitespace are separators and disappear),
//   2. expand any run of DIGITS into the French words that read it out loud
//      ("25" -> vingt cinq, "2026" -> deux mille vingt six),
//   3. in "folded" mode only: NFD, drop combining marks, lowercase.
//
// Step 3 is what makes the headline number comparable between runs; it is also
// what makes the headline number BLIND to accents and casing. That blindness is
// not acceptable in a French dictation tool, so the same engine is run a second
// time in "strict" mode (steps 1 and 2 only) and both numbers are reported. The
// gap between them IS the accent-and-casing error rate, named rather than
// hidden.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE DELIBERATELY DOES NOT MEASURE
// ---------------------------------------------------------------------------
// Punctuation. It is stripped by step 1 in BOTH modes, so a transcript with no
// commas at all scores exactly like one that punctuates perfectly. Punctuation
// matters a great deal for dictation, and a bench that folded it into the same
// number would let a punctuation regression hide behind a word-accuracy win.
// Measuring it is a separate metric with a separate reference; it is out of
// scope here and said out loud rather than quietly assumed.

/** How much of the writing survives into the comparison. */
export type WerMode = "folded" | "strict";

/** One aligned error, kept so a run can say WHICH words the engine misses
 * rather than only how many. */
export interface WerAlignment {
  /** Reference word -> what was written instead. */
  readonly substitutions: ReadonlyArray<{ ref: string; hyp: string }>;
  /** Words in the hypothesis that answer to nothing in the reference. */
  readonly insertions: readonly string[];
  /** Reference words the hypothesis never produced. */
  readonly deletions: readonly string[];
}

export interface WerResult {
  /** Reference length AFTER normalization - the denominator, and the reason a
   * number written in digits does not shrink it (see expandFrenchNumber). */
  readonly refWords: number;
  readonly hypWords: number;
  readonly hits: number;
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly errors: number;
  /**
   * errors / refWords, or NULL when the reference holds no word at all.
   *
   * Not 0, and not 1: a rate over zero words is not a number, and both of the
   * tempting answers are lies in one direction. An empty reference with a
   * non-empty hypothesis is a real, countable failure (the engine invented
   * words on silence - the exact thing shared/textGate.ts exists to stop), and
   * it is reported through `insertions`, which stays true whatever the
   * denominator does. Aggregation over a corpus handles it correctly by summing
   * errors and reference words separately (aggregateWer).
   */
  readonly wer: number | null;
  readonly alignment: WerAlignment;
}

// ---------------------------------------------------------------------------
// French numbers
// ---------------------------------------------------------------------------

const UNITS = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
  "dix sept", "dix huit", "dix neuf",
];

const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "", "quatre vingt", ""];

/** Groups of three digits, from the top. "mille" is invariable; the others take
 * a plural s ("deux millions"), which matters because the s survives folding
 * and would otherwise score as a substitution. */
const SCALES = ["", "mille", "million", "milliard"];

/** Above 999 999 999 999 the group loop runs out of scale names. A number that
 * big in a dictation is a serial, not a cardinal, and guessing how it is read
 * aloud would invent errors; expandFrenchNumber leaves it alone instead. */
const MAX_EXPANDABLE = 12; // digits

function underHundred(n: number): string {
  if (n < 20) return UNITS[n];
  const tens = Math.floor(n / 10);
  const rest = n % 10;
  // 70-79 and 90-99 are built on the PREVIOUS ten plus a teen: soixante dix,
  // quatre vingt onze. The French orthography of the whole 70/90 family.
  if (tens === 7 || tens === 9) {
    const base = TENS[tens - 1];
    const teen = n - (tens - 1) * 10; // 10..19
    // 71 is "soixante et onze"; 91 is "quatre vingt onze" - no "et" on the
    // quatre-vingt family, which is the one exception people actually write.
    if (teen === 11 && tens === 7) return `${base} et onze`;
    return `${base} ${UNITS[teen]}`;
  }
  const base = TENS[tens];
  if (rest === 0) return tens === 8 ? "quatre vingts" : base; // 80 alone takes the s
  if (rest === 1 && tens !== 8) return `${base} et un`; // 21, 31... 61; never 81
  return `${base} ${UNITS[rest]}`;
}

function underThousand(n: number): string {
  if (n < 100) return underHundred(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  // "cent" alone for 100-199; "deux cents" only when nothing follows.
  const head = hundreds === 1 ? "cent" : `${UNITS[hundreds]} cent${rest === 0 ? "s" : ""}`;
  return rest === 0 ? head : `${head} ${underThousand(rest)}`;
}

/**
 * The French words that read a non-negative integer out loud, in ordinary
 * written orthography (accents included, hyphens NOT included - they are
 * separators here, so writing them would change nothing and hide the intent).
 *
 * Exported because it is the half of the normalization most likely to be wrong,
 * and a rule nobody can test is a rule nobody should trust.
 */
export function frenchNumberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return String(n);
  if (n < 1000) return underThousand(n);
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const parts: string[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    const value = groups[g];
    if (value === 0) continue;
    const scale = SCALES[g];
    if (scale === "") {
      parts.push(underThousand(value));
    } else if (g === 1) {
      // "mille", never "un mille", and never "milles".
      parts.push(value === 1 ? "mille" : `${underThousand(value)} mille`);
    } else {
      parts.push(`${underThousand(value)} ${scale}${value > 1 ? "s" : ""}`);
    }
  }
  return parts.join(" ");
}

/**
 * A DIGIT token, read the way it would be said. Everything else comes back
 * unchanged, and the two refusals are deliberate:
 *
 *  - a LEADING ZERO is not a cardinal ("05", "007"): it is read digit by digit,
 *    which is what a speaker does with a code or an hour;
 *  - a run longer than MAX_EXPANDABLE digits is left as it is, because nobody
 *    reads a 20-digit string as a number and inventing a reading would create
 *    errors that no engine made.
 *
 * A MIXED token ("v3", "1re", "8h") never reaches here: tokenizeForWer keeps it
 * whole, and "v3" against "v trois" therefore scores as an error. That is a
 * named residue of this design, not an oversight - the alternative is a
 * grapheme-to-phoneme guesser, and a bench that guesses is a bench that argues
 * with itself.
 */
export function expandFrenchNumber(token: string): string[] {
  if (!/^[0-9]+$/.test(token)) return [token];
  if (token.length > MAX_EXPANDABLE) return [token];
  if (token.length > 1 && token[0] === "0") {
    return token.split("").map((d) => UNITS[Number(d)]);
  }
  return frenchNumberWords(Number(token)).split(" ");
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

// Maximal runs of letters OR digits. \p{L} keeps accented letters whole in
// strict mode (where they are the point); \p{N} keeps digit runs whole so
// expandFrenchNumber sees "2026" and not four separate digits.
const WORD_RUN = /[\p{L}\p{N}]+/gu;
const DIGITS_ONLY = /^[0-9]+$/;
// Explicit escapes rather than the literal combining characters, same range and
// same reason as shared/dictionary.ts: it stays visible in a diff.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Lowercase + strip diacritics. The SAME rule shared/textGate.ts and
 * shared/dictionary.ts use, so "the same word" means one thing across the app
 * and the bench. */
function fold(word: string): string {
  return word.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

/**
 * The word sequence a text is compared as. See the module note for the three
 * steps and for what each one deliberately throws away.
 *
 * A digit run expands into SEVERAL tokens, so "il reste 25 énoncés" and "il
 * reste vingt-cinq énoncés" both come out four words long: the denominator of a
 * WER does not move because the engine chose one spelling over the other.
 */
export function tokenizeForWer(text: string, mode: WerMode = "folded"): string[] {
  const out: string[] = [];
  for (const run of text.match(WORD_RUN) ?? []) {
    // Only pure-ASCII digit runs are numbers to read out; \p{N} also matches
    // digits from other scripts, and those are left whole rather than guessed.
    const pieces = DIGITS_ONLY.test(run) ? expandFrenchNumber(run) : [run];
    for (const p of pieces) out.push(mode === "folded" ? fold(p) : p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The alignment itself
// ---------------------------------------------------------------------------

const MATCH = 0;
const SUB = 1;
const DEL = 2;
const INS = 3;

/**
 * Levenshtein at the WORD level, with a backtrace, and every edit costing 1.
 *
 * Equal costs is the standard definition of WER and the only one that makes
 * runs comparable to anyone else's numbers; weighting a substitution at 2 (as
 * some tools do) would quietly make this bench's figures incomparable with
 * every published French WER.
 *
 * TIE-BREAKING, stated because it changes the alignment REPORT and not the
 * counts: on an equal-cost tie we prefer the diagonal (match/substitution),
 * then the deletion, then the insertion. So "a b c" against "a c" reports "b"
 * deleted rather than "b"->"c" substituted plus "c" deleted, which is both the
 * smaller edit and the one a human reads the same way.
 *
 * Cost is O(ref x hyp) in time and space. Utterances here are sentences, not
 * documents; a caller that ever feeds it a transcript of a one-hour meeting
 * should chunk it first.
 */
export function alignWords(ref: readonly string[], hyp: readonly string[]): WerResult {
  const n = ref.length;
  const m = hyp.length;
  const width = m + 1;
  const cost = new Int32Array((n + 1) * width);
  const from = new Uint8Array((n + 1) * width);

  for (let j = 1; j <= m; j++) {
    cost[j] = j;
    from[j] = INS;
  }
  for (let i = 1; i <= n; i++) {
    cost[i * width] = i;
    from[i * width] = DEL;
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      const diag = cost[(i - 1) * width + (j - 1)] + (same ? 0 : 1);
      const del = cost[(i - 1) * width + j] + 1;
      const ins = cost[i * width + (j - 1)] + 1;
      let best = diag;
      let op = same ? MATCH : SUB;
      if (del < best) {
        best = del;
        op = DEL;
      }
      if (ins < best) {
        best = ins;
        op = INS;
      }
      cost[i * width + j] = best;
      from[i * width + j] = op;
    }
  }

  const substitutions: Array<{ ref: string; hyp: string }> = [];
  const insertions: string[] = [];
  const deletions: string[] = [];
  let hits = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const op = from[i * width + j];
    if (op === MATCH) {
      hits++;
      i--;
      j--;
    } else if (op === SUB) {
      substitutions.push({ ref: ref[i - 1], hyp: hyp[j - 1] });
      i--;
      j--;
    } else if (op === DEL) {
      deletions.push(ref[i - 1]);
      i--;
    } else {
      insertions.push(hyp[j - 1]);
      j--;
    }
  }
  // The backtrace walks from the end; reverse so a reader sees the errors in
  // the order they were said.
  substitutions.reverse();
  insertions.reverse();
  deletions.reverse();

  const errors = substitutions.length + insertions.length + deletions.length;
  return {
    refWords: n,
    hypWords: m,
    hits,
    substitutions: substitutions.length,
    insertions: insertions.length,
    deletions: deletions.length,
    errors,
    wer: n === 0 ? null : errors / n,
    alignment: { substitutions, insertions, deletions },
  };
}

/** Normalize both sides, then align. The one call a bench needs. */
export function wordErrorRate(reference: string, hypothesis: string, mode: WerMode = "folded"): WerResult {
  return alignWords(tokenizeForWer(reference, mode), tokenizeForWer(hypothesis, mode));
}

export interface WerTotals {
  readonly utterances: number;
  readonly refWords: number;
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly errors: number;
  /** Total errors over total reference words - NOT the mean of the individual
   * rates. The mean gives a three-word utterance the same weight as a
   * forty-word one, so one bad short sentence can swing a corpus average by ten
   * points while changing almost nothing about how the tool actually behaves.
   * Corpus WER is a ratio of sums, always. */
  readonly wer: number | null;
}

export function aggregateWer(results: readonly WerResult[]): WerTotals {
  let refWords = 0;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  for (const r of results) {
    refWords += r.refWords;
    substitutions += r.substitutions;
    insertions += r.insertions;
    deletions += r.deletions;
  }
  const errors = substitutions + insertions + deletions;
  return {
    utterances: results.length,
    refWords,
    substitutions,
    insertions,
    deletions,
    errors,
    wer: refWords === 0 ? null : errors / refWords,
  };
}

// ---------------------------------------------------------------------------
// Terms: the metric WER cannot see
// ---------------------------------------------------------------------------

/**
 * Which of `terms` the hypothesis writes EXACTLY - same letters, same accents,
 * same capitals, same punctuation inside the term ("whisper.cpp", "AGR Labs").
 *
 * WHY THIS EXISTS BESIDE THE WER, AND WHY IT IS NOT A REFINEMENT OF IT: the
 * dictionary (shared/dictionary.ts) exists to make a handful of names come out
 * spelled right. Its whole effect is on casing and punctuation inside two or
 * three words of a sentence - precisely what the folded WER throws away in step
 * 3, and often only one word out of twenty even in the strict mode. Judging the
 * dictionary by WER alone would report "no measurable effect" for a feature
 * that did exactly what it was built to do. So the corpus names the terms that
 * must survive verbatim, and they are counted separately.
 *
 * Substring, not token, matching: a term can carry characters tokenization
 * would eat ("whisper.cpp"), and the question here is only whether the exact
 * string was written.
 */
export function termHits(hypothesis: string, terms: readonly string[]): { hit: string[]; miss: string[] } {
  const hit: string[] = [];
  const miss: string[] = [];
  for (const t of terms) {
    if (t !== "" && hypothesis.includes(t)) hit.push(t);
    else miss.push(t);
  }
  return { hit, miss };
}
