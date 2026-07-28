// U6a/U6b/U6c: the dictionary's PURE half - matching, replacement and prompt
// construction. No disk, no Electron, no state: main/dictionary.ts owns the
// file and the caches, this module owns the rules. Same split as
// shared/htmlSanitize.ts vs main/snippets.ts, and for the same reason - the
// parts that are worth arguing about are the parts that must be testable
// without an app around them.
//
// ---------------------------------------------------------------------------
// THE THREE STOREYS, AND WHICH ONE THIS FILE SERVES
// ---------------------------------------------------------------------------
// The design (plan-standalone §4.1) has three: (1) the whisper initial prompt
// BIASES recognition at ~0 ms, (2) a deterministic substitution on the final
// text GUARANTEES a spelling at ~0 ms, (3) an opt-in local LLM pass catches
// near-homophones the regex cannot (not built - later wave). This file builds
// storey 1 (buildDictationPrompt) and storey 2 (compileDictionary +
// applyDictionary).
//
// The kind field is what routes an entry:
//   "vocabulary"  -> storey 1 only. It NUDGES the decoder and never rewrites a
//                    single character of what came back.
//   "replacement" -> storeys 1 and 2. Its term is prompted AND guaranteed.
// ...and the STAR is what opens storey 1: only starred terms are sent to the
// decoder (promptTerms, and the constat-6 note there on why the star had to
// become a real decision). A starred vocabulary entry is the only kind of
// vocabulary entry that does anything; storey 2 does not look at the star.
// That distinction is not cosmetic, and the shipped "Claude" entry is exactly
// why (see main/dictionary.ts's DEFAULT_ENTRIES): whisper writes "Cloud" for
// "Claude", but a blind cloud -> Claude substitution would also rewrite every
// legitimate "the cloud provider". Vocabulary is the honest tool for a word
// whose wrong spelling is a real word.
//
// ---------------------------------------------------------------------------
// WHAT "NEVER CUTS A WORD" MEANS HERE
// ---------------------------------------------------------------------------
// Matching runs on TOKENS, never on the raw string. The text is cut into
// maximal runs of [a-z0-9] (after NFD + diacritic strip + lowercase, the SAME
// normalization shared/textGate.ts uses, so the two gates agree on what a word
// is), and a rule can only match a whole run of whole tokens. There is no
// indexOf, no /g regex over the text, and therefore no way for a rule to land
// inside a longer word: "loi" cannot match inside "emploi" because "emploi" is
// one token and no token is ever split. That is a property of the algorithm,
// not a check bolted on after it.
//
// ---------------------------------------------------------------------------
// COST: THIS RUNS ONCE PER UTTERANCE, ON THE PROCESS THAT CARRIES THE HOOK
// ---------------------------------------------------------------------------
// applyDictionary is on the dictation path (main/index.ts's processUtterance),
// so it is LINEAR in the text and INDEPENDENT of how many rules exist: rules
// live in a Map keyed by the normalized phrase, and each token position does at
// most MAX_PHRASE_WORDS map lookups. A user with 800 entries pays exactly what
// a user with 3 pays. The naive shape - loop over the rules, replace each one
// across the text - is O(rules x text) and would get slower every time the user
// taught Flow a word, which is the one direction this feature must never go.
// An empty compiled dictionary returns the input string itself, untouched,
// without even tokenizing.

import type { DictEntry } from "./ipcContracts";

/** Longest phrase (in words) a rule may have. Bounds the per-position work of
 * applyDictionary, and no legitimate term is a seven-word sentence - an entry
 * that long is a snippet, not a dictionary term. */
export const MAX_PHRASE_WORDS = 6;

/**
 * How many characters of dictionary the whisper prompt may carry, INCLUDING
 * the label and the punctuation around the terms - so the total prompt is
 * bounded by (the French seed) + this, and nothing else.
 *
 * WHY 320, and why the argument is about leakage rather than capacity:
 *
 * The capacity ceiling is not the binding constraint. whisper's initial prompt
 * is capped around n_text_ctx/2 (224 tokens) and an over-long prompt is
 * TRUNCATED rather than refused - and truncation keeps the tail, which would
 * silently drop the French seed at the front while keeping the word list. That
 * failure is invisible from here, so the only safe posture is to stay far
 * enough under the ceiling that it is never reached. 320 characters of proper
 * nouns is roughly 90-110 BPE tokens (names tokenize badly, 2-4 tokens each),
 * i.e. about half the window, seed included.
 *
 * The real constraint is the pitfall this budget exists for (plan §14, seen
 * for real in v5): a heavily loaded prompt makes whisper EMIT prompt
 * vocabulary on a short or near-silent clip - words nobody said, landing at the
 * user's cursor. Every term added to the prompt buys a little recognition and
 * costs a little of that risk, and the trade stops being worth it long before
 * the token window is full. 320 chars is ~25-40 terms: more than anyone's
 * genuinely hard vocabulary, half the capacity, deliberately.
 *
 * This is a budget, not a target: with an empty dictionary the prompt is the
 * seed and nothing else, byte for byte.
 */
export const DICT_PROMPT_BUDGET_CHARS = 320;

/** Introduces the term list. Named (rather than a bare comma list glued to the
 * seed) so the model reads it as an aside, and the whole prompt is closed with
 * a period, because a prompt that ends mid-sentence invites the decoder to
 * finish the sentence - which is the leak, in its most literal form. */
export const DICT_PROMPT_LABEL = "Vocabulaire : ";

/** One maximal word of a text, with its span in the ORIGINAL string - which is
 * what lets a replacement rewrite exactly the matched characters and leave
 * every byte around them (accents, casing, punctuation) alone. */
export interface DictToken {
  /** Lowercased, diacritic-free, [a-z0-9] only. */
  norm: string;
  start: number;
  end: number;
}

/** A dictionary compiled for the hot path. Built once per change (see
 * main/dictionary.ts), read once per utterance. */
export interface CompiledDictionary {
  /** normalized phrase ("loi vingt cinq") -> canonical text ("Loi 25"). */
  readonly rules: ReadonlyMap<string, string>;
  /** Longest key, in words. 0 means "no rules at all", the fast path. */
  readonly maxWords: number;
}

const WORD_CHARS = /^[a-z0-9]+$/;
// Written with explicit escapes rather than the literal combining characters
// shared/textGate.ts uses: same range (U+0300-U+036F), but visible in a diff.
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const HAS_LETTER = /\p{L}/u;

/**
 * A gap between two tokens that a multi-word rule is allowed to span.
 *
 * Whole-word matching alone is not enough: a three-word rule matching across a
 * SENTENCE boundary ("...de la loi. Vingt-cinq personnes...") would splice two
 * sentences into "...de la Loi 25 personnes...". Nothing was cut mid-word, and
 * the result is still wrong. So the separator itself has to be legal:
 *   - horizontal whitespace (the ordinary case), or
 *   - a hyphen/dash, spaced or not ("vingt-cinq"), or
 *   - ONE tight connector with no whitespace around it: apostrophe, period or
 *     slash ("whisper.cpp", "l'AGR").
 * Everything else - a comma, a colon, ". " with its space, a newline, a run of
 * mixed punctuation - ends the phrase. A period followed by a space is the
 * whole point of writing this as three alternatives instead of "any
 * punctuation": "whisper.cpp" must match, "loi. Vingt" must not.
 */
const JOINABLE_GAP = /^(?:[ \t\u00a0]+|[ \t]*[-\u2010\u2011\u2013\u2014][ \t]*|['\u2019./])$/;

/** Per-character normalization: NFD, drop combining marks, lowercase. Applied
 * character by character (rather than to the whole string) precisely so token
 * spans keep pointing into the ORIGINAL text - normalizing first would shift
 * every index after the first accent. */
function normalizeChar(ch: string): string {
  return ch.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

/**
 * Cut a text into maximal word tokens with their original spans. Iterates by
 * CODE POINT (for...of) so an emoji or any astral character advances by its
 * true length and never leaves a span pointing into the middle of a surrogate
 * pair.
 */
export function tokenizeForDictionary(text: string): DictToken[] {
  const tokens: DictToken[] = [];
  let acc = "";
  let start = 0;
  let at = 0;
  for (const ch of text) {
    const n = normalizeChar(ch);
    if (n.length > 0 && WORD_CHARS.test(n)) {
      if (acc === "") start = at;
      acc += n;
    } else if (acc !== "") {
      tokens.push({ norm: acc, start, end: at });
      acc = "";
    }
    at += ch.length;
  }
  if (acc !== "") tokens.push({ norm: acc, start, end: at });
  return tokens;
}

/** The normalized key a pattern matches under, or "" when the pattern holds no
 * word at all (a stored alias of "  " or "---") or is longer than
 * MAX_PHRASE_WORDS. Exported for the page and the tests: it is also the
 * predicate for "this alias will never do anything". */
export function phraseKey(pattern: string): string {
  const toks = tokenizeForDictionary(pattern);
  if (toks.length === 0 || toks.length > MAX_PHRASE_WORDS) return "";
  return toks.map((t) => t.norm).join(" ");
}

/**
 * The key a term may claim AS ITS OWN PATTERN, or "" when it may not claim one.
 *
 * A term is added to the rule table on the user's behalf - he never typed it as
 * something to match - and that convenience is only honest while the key still
 * SPELLS THE TERM BACK. phraseKey keeps letters and digits and nothing else, so
 * for a term whose identity IS its punctuation it does not: measured, ".NET"
 * becomes "net", "C#" becomes "c" and "C++" becomes "c" as well. The first
 * rewrites the ordinary word "net" everywhere it appears; the last two are the
 * same key, so one of two distinct terms silently swallows the other.
 *
 * So the key is only granted when every character of the term is either part of
 * a token or a JOINABLE_GAP BETWEEN two tokens - nothing before the first, and
 * nothing after the last. "whisper.cpp" keeps its rule ("whisper cpp", the dot
 * sits between two tokens and is a legal separator anyway), "AGR Labs" and
 * "Loi 25" keep theirs, ".NET", "C#", "C++" and "e.g." get none.
 *
 * What a user LOSES is nothing he asked for, and what he keeps is the way to
 * ask: an alias. "dot net" -> ".NET" and "c sharp" -> "C#" are one line each in
 * the editor, they say what should be matched, and aliases are deliberately not
 * subject to this rule - a pattern the user wrote is a statement, a pattern Flow
 * inferred is a guess, and only the guess has to be provably harmless.
 */
export function termSelfKey(term: string): string {
  const key = phraseKey(term);
  if (key === "") return "";
  const toks = tokenizeForDictionary(term);
  if (toks[0].start !== 0 || toks[toks.length - 1].end !== term.length) return "";
  for (let i = 1; i < toks.length; i++) {
    if (!JOINABLE_GAP.test(term.slice(toks[i - 1].end, toks[i].start))) return "";
  }
  return key;
}

/**
 * Build the storey-2 rule table. ONLY "replacement" entries contribute (see
 * the module note on why "Claude" is deliberately not one of them).
 *
 * Each entry contributes its ALIASES *and its own term* as patterns: the term
 * is what fixes casing and punctuation when the engine got the word right but
 * spelled it flat ("agr labs" -> "AGR Labs", "whisper cpp" -> "whisper.cpp"),
 * which is most of the value and costs nothing - a term that is already
 * correct rewrites to itself. The one term that contributes NOTHING is the one
 * whose spelling the key would destroy (see termSelfKey).
 *
 * Collisions: the FIRST entry to claim a normalized phrase keeps it. Stable
 * (file order is creation order), and the alternative - last writer wins - would
 * make an old, deliberate rule silently change meaning when a new entry happens
 * to reuse one of its aliases.
 */
export function compileDictionary(entries: readonly DictEntry[]): CompiledDictionary {
  const rules = new Map<string, string>();
  let maxWords = 0;
  const add = (key: string, canonical: string): void => {
    if (key === "" || rules.has(key)) return;
    rules.set(key, canonical);
    const words = key.split(" ").length;
    if (words > maxWords) maxWords = words;
  };
  for (const e of entries) {
    if (e.kind !== "replacement") continue;
    // The TRIMMED term, both as the text written out and as the pattern read
    // in: a stored " AGR Labs " must not lose its self-rule over a space.
    const canonical = e.term.trim();
    if (canonical === "") continue;
    add(termSelfKey(canonical), canonical);
    for (const alias of e.aliases) add(phraseKey(alias), canonical);
  }
  return { rules, maxWords };
}

/** Does this token hold a letter? tokenizeForDictionary normalizes to [a-z0-9],
 * so a token of digits alone ("25", "2026") tests false - a number carries no
 * information about a voice. */
const LETTER_TOKEN = /[a-z]/;

/** How many WORDS the matched text spans, counting only the ones that could
 * have been said rather than counted out. The shouting test below is about this
 * number, not about the string's length. */
function letterWords(matched: string): number {
  let n = 0;
  for (const t of tokenizeForDictionary(matched)) if (LETTER_TOKEN.test(t.norm)) n++;
  return n;
}

/**
 * Carry the ORIGINAL casing onto the canonical spelling, without ever
 * destroying casing the canonical form itself is making a point of.
 *
 *  - The match was SHOUTED ("LOI VINGT-CINQ") -> the replacement shouts too.
 *  - The match was Capitalized and the canonical starts lowercase ("Whisper
 *    cpp" at the start of a sentence) -> capitalize the first letter, because
 *    the capital came from the sentence, not from the term.
 *  - Otherwise the canonical form wins verbatim. This is the case that matters
 *    most: "AGR Labs" and "whisper.cpp" are spelled the way they are ON
 *    PURPOSE, and a well-meant "restore the original casing" that lowercased
 *    the first or title-cased the rest would undo the exact thing the user
 *    added the entry for.
 *
 * ---------------------------------------------------------------------------
 * WHY SHOUTING TAKES TWO WORDS (review constat 5)
 * ---------------------------------------------------------------------------
 * "two or more characters, all upper case" is not a test for shouting, it is a
 * test for an ACRONYM - and the acronym of a term is the single most natural
 * alias anyone adds for it. Under the old rule, teaching Flow that "CC" means
 * "Claude Code" or that "AGR" means "AGR Labs" made every ordinary sentence
 * come back with "CLAUDE CODE" in the middle of it: the entry the user added to
 * get a spelling right was the entry that broke the sentence.
 *
 * The two cases are told apart by how far the capitals REACH. Capitals over a
 * single word are how acronyms are written in perfectly calm text, and are what
 * an ASR emits for one all the time; capitals over two or more consecutive
 * words are not how anything is normally written, and are therefore the actual
 * signal of a raised voice. So the replacement shouts back only when the match
 * spans at least two spoken words - and the test reads the MATCH alone, which
 * keeps this function pure and lets a page or a test decide the outcome without
 * an utterance around it.
 *
 * The residue, named rather than hidden: a genuine one-word shout ("TAILSCALE")
 * comes back in the term's own spelling instead of in capitals. That is the
 * safe direction to be wrong in - the user gets exactly what he asked Flow to
 * write - and it is the rarer of the two cases by a wide margin.
 */
export function adaptCase(canonical: string, matched: string): string {
  if (canonical === "" || matched === "" || !HAS_LETTER.test(matched)) return canonical;
  if (matched === matched.toUpperCase() && matched !== matched.toLowerCase() && letterWords(matched) >= 2) {
    return canonical.toUpperCase();
  }
  const head = matched[0];
  const canonicalHead = canonical[0];
  const matchedStartsUpper = head === head.toUpperCase() && head !== head.toLowerCase();
  const canonicalStartsLower =
    canonicalHead === canonicalHead.toLowerCase() && canonicalHead !== canonicalHead.toUpperCase();
  if (matchedStartsUpper && canonicalStartsLower) {
    return canonicalHead.toUpperCase() + canonical.slice(1);
  }
  return canonical;
}

/**
 * Storey 2: rewrite the final transcript. Left to right, longest rule first at
 * each position, non-overlapping, everything not matched copied through
 * byte-identical.
 *
 * Linear in the text and independent of the rule count (module note). The fast
 * path returns the very same string instance when there is nothing to do, which
 * is what the dictation path hits for a user who has no replacement rules.
 */
export function applyDictionary(text: string, dict: CompiledDictionary): string {
  if (dict.maxWords === 0 || text === "") return text;
  const tokens = tokenizeForDictionary(text);
  if (tokens.length === 0) return text;

  let out = "";
  let copied = 0; // how much of `text` is already in `out`
  let i = 0;
  while (i < tokens.length) {
    const limit = Math.min(dict.maxWords, tokens.length - i);
    // Build the candidate keys ONCE, growing (1 word, 2 words, ...), then try
    // them longest-first. Building them per attempt instead would re-join the
    // same tokens up to MAX_PHRASE_WORDS times per position.
    const keys: string[] = [];
    let acc = "";
    for (let k = 0; k < limit; k++) {
      if (k > 0) {
        if (!JOINABLE_GAP.test(text.slice(tokens[i + k - 1].end, tokens[i + k].start))) break;
        acc += " ";
      }
      acc += tokens[i + k].norm;
      keys.push(acc);
    }

    let words = 0;
    let canonical = "";
    for (let k = keys.length; k >= 1; k--) {
      const hit = dict.rules.get(keys[k - 1]);
      if (hit !== undefined) {
        words = k;
        canonical = hit;
        break;
      }
    }
    if (words === 0) {
      i += 1;
      continue;
    }
    const from = tokens[i].start;
    const to = tokens[i + words - 1].end;
    out += text.slice(copied, from) + adaptCase(canonical, text.slice(from, to));
    copied = to;
    i += words;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * EXACTLY the terms storey 1 sends to the engine, in the order it sends them.
 *
 * Exported because the page has to be able to state a true number: "N terms are
 * sent" is a claim about this function's output and about nothing else. Counting
 * `entries.filter(starred)` instead was the same sentence said about a different
 * quantity - the budget can still drop the tail of a long starred list - which
 * is half of how the interface came to promise something the builder did not do
 * (review constat 6).
 *
 * Three rules, each one a leak the naive version has:
 *
 * 1. ALIASES NEVER GO IN. An alias is the WRONG spelling ("cloud code", "loi
 *    vingt-cinq"); prompting it would teach the decoder to write the mistake
 *    the entry exists to fix. Only canonical terms are prompted.
 * 2. THE BUDGET IS A HARD STOP, and a term either fits WHOLE or is not there:
 *    half a term in the prompt is an invented token, which is the leak in
 *    miniature. When the first term does not fit, we stop rather than skipping
 *    ahead to shorter ones - priority order stays meaningful, and "the list is
 *    used in order until the budget runs out" is a rule a user can be told.
 * 3. ONLY STARRED TERMS GO IN, in the user's own list order - starring IS the
 *    statement of priority, and re-sorting it would take that control away.
 *
 * That third rule is the other half of constat 6, and a decision rather than a
 * detail. The builder used to walk the starred terms and then keep going
 * through the unstarred ones until the budget filled, while the page said the
 * starred ones were what the engine is told about. Both cannot be true, and the
 * one worth keeping is the page's: the star is the user's only control over the
 * one channel that can put a word nobody said in front of the decoder (see
 * DICT_PROMPT_BUDGET_CHARS for why that channel is deliberately small), and a
 * control that decides nothing is not a control.
 *
 * The consequence, which the page has to say out loud rather than leave to be
 * discovered: an UNSTARRED VOCABULARY entry now does nothing at all, because
 * storey 1 is the only storey a vocabulary entry ever acts through. An unstarred
 * REPLACEMENT entry still works, after the fact, at no cost to the prompt.
 */
export function promptTerms(
  entries: readonly DictEntry[],
  budget: number = DICT_PROMPT_BUDGET_CHARS,
): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  // The suffix is " " + label + terms + "." - all of it charged to the budget,
  // so the builder's guarantee is simply prompt.length <= base.length + budget.
  // The separator is charged here unconditionally, so this count never depends
  // on a `base` the page has no way of knowing.
  let used = 1 + DICT_PROMPT_LABEL.length + 1;
  for (const e of entries) {
    if (!e.starred) continue;
    // Collapsed here as well as at the store boundary: a newline reaching the
    // prompt would turn one aside into two lines of pseudo-transcript.
    const term = e.term.replace(/\s+/gu, " ").trim();
    if (term === "") continue;
    // Two entries whose terms normalize alike (the same word starred twice,
    // "AGR Labs" and "agr labs") would spend the budget twice and over-weight
    // one word.
    const key = phraseKey(term) || term.toLowerCase();
    if (seen.has(key)) continue;
    const cost = term.length + (picked.length > 0 ? 2 : 0); // ", "
    if (used + cost > budget) break;
    seen.add(key);
    picked.push(term);
    used += cost;
  }
  return picked;
}

/**
 * Storey 1: the whisper initial prompt, seed + the BOUNDED term list promptTerms
 * chose.
 *
 * NOTHING IS APPENDED WHEN THERE IS NOTHING TO SAY: a dictionary with no starred
 * term returns `base` unchanged, byte for byte, so a user who stars nothing - or
 * deletes every entry - gets exactly the prompt Flow shipped with.
 */
export function buildDictationPrompt(
  base: string,
  entries: readonly DictEntry[],
  budget: number = DICT_PROMPT_BUDGET_CHARS,
): string {
  const picked = promptTerms(entries, budget);
  if (picked.length === 0) return base;
  const separator = base === "" ? "" : " ";
  return `${base}${separator}${DICT_PROMPT_LABEL}${picked.join(", ")}.`;
}
