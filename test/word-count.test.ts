import test from "node:test";
import assert from "node:assert/strict";
import { countWords } from "../src/shared/wordCount";

// U7b: the word count is the whole statistics feature (words per day, words per
// minute, the streak), it runs on French text full of elisions and hyphens, and
// nothing in the app can tell a wrong count from a right one - the user just
// sees a plausible-looking total. So the rule stated in wordCount.ts's module
// note is pinned here, edge case by edge case.

test("empty, whitespace-only and non-string inputs count zero", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
  assert.equal(countWords("\n\t  \r\n"), 0);
  // Fed from a transcription pipeline and (one day) from IPC: a non-string must
  // never take the dictation path down with it.
  assert.equal(countWords(null), 0);
  assert.equal(countWords(undefined), 0);
  assert.equal(countWords(42), 0);
  assert.equal(countWords({ text: "bonjour" }), 0);
});

test("plain words split on any run of whitespace, including newlines and tabs", () => {
  assert.equal(countWords("bonjour"), 1);
  assert.equal(countWords("bonjour le monde"), 3);
  assert.equal(countWords("  bonjour   le    monde  "), 3);
  assert.equal(countWords("bonjour\nle\tmonde"), 3);
});

test("French elisions count as ONE word (l'agent, aujourd'hui), straight or typographic apostrophe", () => {
  // The speech model emits U+2019 as often as the ASCII apostrophe; the two
  // must never give different counts for the same sentence.
  assert.equal(countWords("l'agent"), 1);
  assert.equal(countWords("l’agent"), 1);
  assert.equal(countWords("aujourd'hui"), 1);
  assert.equal(countWords("aujourd’hui"), 1);
  assert.equal(countWords("j'ai vu l'agent aujourd'hui"), 4);
});

test("hyphenated words count as ONE (peut-etre, c'est-a-dire, vas-y)", () => {
  assert.equal(countWords("peut-etre"), 1);
  assert.equal(countWords("peut-être"), 1);
  assert.equal(countWords("c'est-a-dire"), 1);
  assert.equal(countWords("vas-y tout de suite"), 4);
  // "qu'est-ce que" is TWO written words: the elision and the hyphen bind
  // "qu'est-ce" into one, "que" stands alone. Documented, not accidental.
  assert.equal(countWords("qu'est-ce que"), 2);
});

test("a hyphen or apostrophe standing ALONE is a separator, not a word", () => {
  assert.equal(countWords("Flow - local"), 2);
  assert.equal(countWords("-"), 0);
  assert.equal(countWords("'"), 0);
  assert.equal(countWords("—"), 0, "an em dash is punctuation, not a word");
  assert.equal(countWords("..."), 0);
  assert.equal(countWords("?!"), 0);
  assert.equal(countWords(". . ."), 0);
});

test("punctuation glued to a word does not create or destroy one", () => {
  assert.equal(countWords("Bonjour, comment ca va ?"), 4);
  assert.equal(countWords("Bonjour!"), 1);
  assert.equal(countWords("(bonjour)"), 1);
  assert.equal(countWords("« bonjour »"), 1);
  // No space after the ellipsis: two words, not one. A naive split on spaces
  // would say one.
  assert.equal(countWords("bonjour...merci"), 2);
  // A trailing apostrophe leaves the word it was attached to.
  assert.equal(countWords("l'"), 1);
});

test("accented French counts (the whole reason this is not [A-Za-z])", () => {
  assert.equal(countWords("élève"), 1);
  assert.equal(countWords("École élémentaire"), 2);
  assert.equal(countWords("naïve façon"), 2);
});

test("digits are words: dictated numbers must not vanish from the count", () => {
  assert.equal(countWords("Loi 25"), 2);
  assert.equal(countWords("25"), 1);
  assert.equal(countWords("25%"), 1, "the percent sign is a separator, the number is the word");
  assert.equal(countWords("le 27 juillet 2026"), 4);
  assert.equal(countWords("3,14"), 2, "a comma separates - counting it as one would be arbitrary either way");
});

test("French non-breaking spaces (U+00A0, U+202F) separate words like any other space", () => {
  // Whisper emits the narrow no-break space before French double punctuation.
  // A counter that treated it as a word character would glue "va" and "?" into
  // one token - and then count that token, because it holds a letter.
  // Written as escapes on purpose: an invisible character in a test is a test
  // nobody can review.
  assert.equal(countWords("comment\u00a0ca va\u202f?"), 3);
});

test("a long paragraph counts the same as the sum of its sentences", () => {
  const a = "Le rapport est pret pour la reunion de demain matin.";
  const b = "J'ai relu la section sur l'automatisation, c'est-a-dire les trois premiers paragraphes.";
  assert.equal(countWords(`${a} ${b}`), countWords(a) + countWords(b));
  assert.equal(countWords(a), 10);
  assert.equal(countWords(b), 11);
});

test("the module-level /g regex does not carry lastIndex between calls", () => {
  // A global regex reused across calls without a reset resumes where the
  // previous match stopped: the second identical call would return a SMALLER
  // count than the first, and the counter would drift downward all day.
  const s = "un deux trois quatre cinq";
  assert.equal(countWords(s), 5);
  assert.equal(countWords(s), 5);
  assert.equal(countWords(s), 5);
});
