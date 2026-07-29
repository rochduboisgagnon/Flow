import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateWer,
  alignWords,
  expandFrenchNumber,
  frenchNumberWords,
  termHits,
  tokenizeForWer,
  wordErrorRate,
} from "../src/shared/wer";

// C8: the WER engine, checked against cases computed BY HAND. This file is the
// reason the arithmetic can be trusted at all - a bench whose own measuring
// stick is unverified would let every later wave claim an improvement that only
// exists in the normalization. Every expected number below is written out in
// the comment that precedes it, so a reader can disagree with the arithmetic
// rather than with the code.

// ---------------------------------------------------------------------------
// French numbers: the half of the normalization most likely to be quietly wrong
// ---------------------------------------------------------------------------

test("frenchNumberWords: the orthography, including the parts that trip people up", () => {
  assert.equal(frenchNumberWords(0), "zéro");
  assert.equal(frenchNumberWords(1), "un");
  assert.equal(frenchNumberWords(16), "seize");
  assert.equal(frenchNumberWords(17), "dix sept");
  assert.equal(frenchNumberWords(20), "vingt");
  assert.equal(frenchNumberWords(21), "vingt et un");
  assert.equal(frenchNumberWords(25), "vingt cinq");
  assert.equal(frenchNumberWords(60), "soixante");
  assert.equal(frenchNumberWords(61), "soixante et un");
  // The 70/90 family: built on the previous ten plus a teen.
  assert.equal(frenchNumberWords(70), "soixante dix");
  assert.equal(frenchNumberWords(71), "soixante et onze");
  assert.equal(frenchNumberWords(78), "soixante dix huit");
  assert.equal(frenchNumberWords(90), "quatre vingt dix");
  assert.equal(frenchNumberWords(91), "quatre vingt onze"); // no "et", unlike 71
  assert.equal(frenchNumberWords(99), "quatre vingt dix neuf");
  // The plural s that only appears when nothing follows.
  assert.equal(frenchNumberWords(80), "quatre vingts");
  assert.equal(frenchNumberWords(81), "quatre vingt un");
  assert.equal(frenchNumberWords(100), "cent");
  assert.equal(frenchNumberWords(101), "cent un");
  assert.equal(frenchNumberWords(180), "cent quatre vingts");
  assert.equal(frenchNumberWords(200), "deux cents");
  assert.equal(frenchNumberWords(201), "deux cent un");
  assert.equal(frenchNumberWords(574), "cinq cent soixante quatorze");
  assert.equal(frenchNumberWords(835), "huit cent trente cinq");
  // "mille" is invariable and never takes "un".
  assert.equal(frenchNumberWords(1000), "mille");
  assert.equal(frenchNumberWords(2000), "deux mille");
  assert.equal(frenchNumberWords(2026), "deux mille vingt six");
  assert.equal(frenchNumberWords(8178), "huit mille cent soixante dix huit");
  // ...while million and milliard do take one.
  assert.equal(frenchNumberWords(1_000_000), "un million");
  assert.equal(frenchNumberWords(2_000_000), "deux millions");
  assert.equal(frenchNumberWords(1_000_000_000), "un milliard");
});

test("expandFrenchNumber: cardinals expand, codes and serials do not", () => {
  assert.deepEqual(expandFrenchNumber("25"), ["vingt", "cinq"]);
  assert.deepEqual(expandFrenchNumber("0"), ["zéro"]);
  // A LEADING ZERO is a code or an hour, not a cardinal: read digit by digit.
  assert.deepEqual(expandFrenchNumber("05"), ["zéro", "cinq"]);
  assert.deepEqual(expandFrenchNumber("007"), ["zéro", "zéro", "sept"]);
  // Over twelve digits nobody reads it as a number; left exactly as it stands.
  assert.deepEqual(expandFrenchNumber("1234567890123"), ["1234567890123"]);
  // A MIXED token is never a number here (named residue of the design).
  assert.deepEqual(expandFrenchNumber("v3"), ["v3"]);
});

// ---------------------------------------------------------------------------
// Tokenizing: what the comparison is allowed to see
// ---------------------------------------------------------------------------

test("tokenize folded: punctuation, hyphens and apostrophes are separators; accents and case fold", () => {
  assert.deepEqual(tokenizeForWer("Bonjour, ça va ?"), ["bonjour", "ca", "va"]);
  assert.deepEqual(tokenizeForWer("vingt-cinq"), ["vingt", "cinq"]);
  assert.deepEqual(tokenizeForWer("l'élève"), ["l", "eleve"]);
  assert.deepEqual(tokenizeForWer("whisper.cpp"), ["whisper", "cpp"]);
  assert.deepEqual(tokenizeForWer("   "), []);
});

test("tokenize strict: same cuts, same number expansion, but the writing survives", () => {
  assert.deepEqual(tokenizeForWer("L'Élève", "strict"), ["L", "Élève"]);
  // A digit run is expanded in BOTH modes, and to ACCENTED words, so "0" still
  // matches a spoken "zéro" under the strict comparison too.
  assert.deepEqual(tokenizeForWer("0 faute", "strict"), ["zéro", "faute"]);
});

test("tokenize: a number in digits costs as many reference words as it is said in", () => {
  // The point of the whole normalization: "25" is one glyph and two words, and
  // the denominator of a WER must follow the words, not the glyphs.
  assert.deepEqual(tokenizeForWer("il reste 25 énoncés"), ["il", "reste", "vingt", "cinq", "enonces"]);
  assert.deepEqual(tokenizeForWer("il reste vingt-cinq énoncés"), ["il", "reste", "vingt", "cinq", "enonces"]);
});

// ---------------------------------------------------------------------------
// The alignment, on cases small enough to compute in the head
// ---------------------------------------------------------------------------

test("identical texts: no errors at all", () => {
  const r = wordErrorRate("le chat dort", "le chat dort");
  assert.equal(r.refWords, 3);
  assert.equal(r.hits, 3);
  assert.equal(r.errors, 0);
  assert.equal(r.wer, 0);
});

test("one substitution: 1 error over 3 reference words", () => {
  const r = wordErrorRate("le chat dort", "le chien dort");
  assert.equal(r.substitutions, 1);
  assert.equal(r.insertions, 0);
  assert.equal(r.deletions, 0);
  assert.equal(r.wer, 1 / 3);
  assert.deepEqual(r.alignment.substitutions, [{ ref: "chat", hyp: "chien" }]);
});

test("one insertion: the denominator stays the REFERENCE length, so WER can exceed nothing yet", () => {
  const r = wordErrorRate("le chat dort", "le petit chat dort");
  assert.equal(r.insertions, 1);
  assert.equal(r.refWords, 3);
  assert.equal(r.hypWords, 4);
  assert.equal(r.wer, 1 / 3);
  assert.deepEqual(r.alignment.insertions, ["petit"]);
});

test("one deletion", () => {
  const r = wordErrorRate("le chat dort", "le dort");
  assert.equal(r.deletions, 1);
  assert.equal(r.wer, 1 / 3);
  assert.deepEqual(r.alignment.deletions, ["chat"]);
});

test("WER is not capped at 1: an engine that invents can score over 100 %", () => {
  // ref 2 words, hyp 6: 2 matches and 4 insertions -> 4/2 = 2.0. A metric that
  // clamped here would hide the single worst failure mode this app has.
  const r = wordErrorRate("bonjour Roch", "bonjour Roch et merci beaucoup vraiment");
  assert.equal(r.refWords, 2);
  assert.equal(r.insertions, 4);
  assert.equal(r.wer, 2);
});

test("ties prefer the smaller, human-readable edit: a deletion, not a substitution plus a deletion", () => {
  const r = alignWords(["a", "b", "c"], ["a", "c"]);
  assert.equal(r.errors, 1);
  assert.equal(r.deletions, 1);
  assert.equal(r.substitutions, 0);
  assert.deepEqual(r.alignment.deletions, ["b"]);
});

test("errors in the order they were said, not in backtrace order", () => {
  const r = alignWords(["un", "deux", "trois", "quatre"], ["un", "DEUX", "trois", "QUATRE"]);
  assert.deepEqual(r.alignment.substitutions, [
    { ref: "deux", hyp: "DEUX" },
    { ref: "quatre", hyp: "QUATRE" },
  ]);
});

// ---------------------------------------------------------------------------
// The three degenerate cases, each with a decision behind it
// ---------------------------------------------------------------------------

test("empty reference with a non-empty hypothesis: WER is NULL, and the invented words are still counted", () => {
  // The hallucination case. A rate over zero words is not a number, so the
  // metric refuses to make one up - but the failure itself is fully reported.
  // Six words after normalization: sous / titres / realises / par / la / communaute.
  const r = wordErrorRate("", "sous-titres réalisés par la communauté");
  assert.equal(r.refWords, 0);
  assert.equal(r.wer, null);
  assert.equal(r.insertions, 6);
  assert.equal(r.errors, 6);
});

test("empty hypothesis with a non-empty reference: everything deleted, WER exactly 1", () => {
  const r = wordErrorRate("le chat dort", "");
  assert.equal(r.deletions, 3);
  assert.equal(r.wer, 1);
  assert.deepEqual(r.alignment.deletions, ["le", "chat", "dort"]);
});

test("both empty: no words, no errors, no rate", () => {
  const r = wordErrorRate("", "");
  assert.equal(r.refWords, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.wer, null);
});

// ---------------------------------------------------------------------------
// Accents, casing, numbers: what folding buys and what it costs
// ---------------------------------------------------------------------------

test("folded: accents and casing are the same word; strict: they are not", () => {
  const folded = wordErrorRate("L'élève a réussi", "l eleve a reussi");
  assert.equal(folded.errors, 0);
  assert.equal(folded.wer, 0);

  const strict = wordErrorRate("L'élève a réussi", "l eleve a reussi", "strict");
  // 4 reference words, and 3 of them differ in writing: L/l, élève/eleve,
  // réussi/reussi. The gap between the two numbers IS the accent-and-case
  // error rate.
  assert.equal(strict.refWords, 4);
  assert.equal(strict.substitutions, 3);
  assert.equal(strict.wer, 0.75);
});

test("punctuation never scores, in either mode", () => {
  assert.equal(wordErrorRate("Bonjour, ça va ?", "Bonjour ça va").errors, 0);
  assert.equal(wordErrorRate("Bonjour, ça va ?", "Bonjour ça va", "strict").errors, 0);
});

test("a number written in digits and the same number said out loud are not an error", () => {
  // The case this module was written for: counting these as errors would
  // measure the bench's own normalization instead of the engine.
  const r = wordErrorRate("il reste 25 énoncés", "il reste vingt-cinq énoncés");
  assert.equal(r.refWords, 5);
  assert.equal(r.errors, 0);

  const other = wordErrorRate("en 2026", "en deux mille vingt-six");
  assert.equal(other.errors, 0);

  // ...and it works in the other direction too, since both sides go through
  // the same expansion.
  assert.equal(wordErrorRate("quatre-vingts dollars", "80 dollars").errors, 0);
});

// ---------------------------------------------------------------------------
// Aggregation over a corpus
// ---------------------------------------------------------------------------

test("corpus WER is a ratio of sums, NOT the mean of the individual rates", () => {
  // Utterance A: 2 reference words, 1 error -> 50 %.
  // Utterance B: 18 reference words, 0 errors -> 0 %.
  // Ratio of sums: 1 / 20 = 5 %. Mean of the rates: 25 %. Five times the truth,
  // from one short sentence - which is why the mean is never used here.
  const shortRef = "bonjour Roch";
  const longRef = Array.from({ length: 18 }, (_, i) => `mot${i}`).join(" ");
  const a = wordErrorRate(shortRef, "bonjour Rock");
  const b = wordErrorRate(longRef, longRef);
  const totals = aggregateWer([a, b]);
  assert.equal(totals.utterances, 2);
  assert.equal(totals.refWords, 20);
  assert.equal(totals.errors, 1);
  assert.equal(totals.wer, 0.05);
  const mean = ((a.wer ?? 0) + (b.wer ?? 0)) / 2;
  assert.equal(mean, 0.25);
});

test("aggregation absorbs a null-WER utterance without inventing a denominator", () => {
  // An utterance whose reference is empty contributes its INSERTIONS to the
  // corpus error count and nothing to the corpus word count - the only handling
  // that neither hides the hallucination nor divides by zero.
  const hallucinated = wordErrorRate("", "merci beaucoup vraiment"); // 3 invented words
  const clean = wordErrorRate("le chat dort", "le chat dort"); // 3 reference words, 0 errors
  const totals = aggregateWer([hallucinated, clean]);
  assert.equal(hallucinated.wer, null);
  assert.equal(totals.refWords, 3);
  assert.equal(totals.errors, 3);
  assert.equal(totals.wer, 1);
});

test("aggregation of nothing at all", () => {
  const totals = aggregateWer([]);
  assert.equal(totals.utterances, 0);
  assert.equal(totals.refWords, 0);
  assert.equal(totals.wer, null);
});

// ---------------------------------------------------------------------------
// Terms: the metric the folded WER is blind to
// ---------------------------------------------------------------------------

test("termHits: exact spelling, capitals and inner punctuation included", () => {
  const hyp = "Le sidecar whisper.cpp tourne pour AGR Labs.";
  const { hit, miss } = termHits(hyp, ["whisper.cpp", "AGR Labs", "Tailscale"]);
  assert.deepEqual(hit, ["whisper.cpp", "AGR Labs"]);
  assert.deepEqual(miss, ["Tailscale"]);
});

test("termHits is case sensitive on purpose: the dictionary exists to fix exactly this", () => {
  // A folded WER scores "agr labs" as perfect. The dictionary's entire job is
  // the difference between these two strings, so the term metric must see it.
  assert.deepEqual(termHits("chez agr labs", ["AGR Labs"]).miss, ["AGR Labs"]);
  assert.equal(wordErrorRate("chez AGR Labs", "chez agr labs").errors, 0);
});
