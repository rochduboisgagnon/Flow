// U7b: "how many words was that?" - the ONE definition, pure and unit-tested.
//
// WHY THIS IS A MODULE AND NOT A `text.split(" ").length` AT THE CALL SITE.
// This number is the whole statistics feature: words per day, words per minute,
// the streak. It is computed on the dictation path, from French text with
// elisions ("l'agent"), hyphenated words ("peut-etre", "c'est-a-dire"),
// typographic apostrophes the speech model emits ("aujourd'hui" with U+2019),
// and punctuation glued to words. Every one of those is a place where a naive
// split silently returns the wrong number - silently, because nothing in the
// app can tell a wrong word count from a right one, and the user only ever
// sees a total that looks plausible. So the rule is written down here, with
// its edge cases in test/word-count.test.ts, rather than guessed inline.
//
// THE RULE, STATED SO IT CAN BE ARGUED WITH.
// A word is a run of letters or digits, which may carry INTERNAL apostrophes
// (straight ' or typographic U+2019) and hyphens joining further such runs.
// Everything else is a separator. Consequences, all deliberate:
//
//   "l'agent"        -> 1   (as Word and LibreOffice count it; the elision is
//                            part of the written word, not a second one)
//   "aujourd'hui"    -> 1
//   "qu'est-ce que"  -> 2   ("qu'est-ce" is one written word, "que" another)
//   "peut-etre"      -> 1
//   "Loi 25"         -> 2   (a digit run is a word: dictated numbers count)
//   "25%"            -> 1   (the % is a separator, the 25 is the word)
//   "bonjour...merci"-> 2   (punctuation separates even without a space)
//   "-" / "..." / "" -> 0   (a token with no letter and no digit is not a word)
//
// The alternative rule - count SPOKEN words, so "l'agent" would be 2 - is
// rejected on purpose: it cannot be derived from text without a pronunciation
// dictionary, it would make the number depend on the language, and no other
// word counter the user has ever seen works that way.
//
// Unicode-aware (\p{L}/\p{N} under the u flag) rather than [A-Za-z]: accented
// French is the DEFAULT language of this app (settings.ts), and an ASCII class
// would count "eleve" as one word and "élève" as zero.

/** One word: a letter/digit run, plus any apostrophe- or hyphen-joined runs
 * after it. The two character classes are disjoint (a separator can never be
 * a word character), so the nested quantifier has exactly one way to match any
 * given input - no backtracking blow-up is possible on hostile text. */
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * How many words `text` holds. Never throws: a non-string (this is fed from a
 * transcription pipeline, and one day from IPC) counts as zero rather than
 * taking the dictation path down with it.
 *
 * Counts with a lastIndex loop instead of `text.match(WORD_RE)`: match() with
 * a /g regex allocates every matched substring into an array, and this runs on
 * the main process right after an utterance, on the same thread that owes
 * Windows a keystroke verdict. We want the count, not the words - and the
 * words are exactly what this app has promised never to keep (plan §5.4).
 */
export function countWords(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  // A module-level /g regex carries lastIndex between calls: reset it here so
  // two counts in a row can never continue where the previous one stopped.
  WORD_RE.lastIndex = 0;
  let count = 0;
  while (WORD_RE.exec(text) !== null) count++;
  return count;
}
