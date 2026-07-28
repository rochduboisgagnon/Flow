import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildDictationPrompt,
  promptTerms,
  DICT_PROMPT_BUDGET_CHARS,
  DICT_PROMPT_LABEL,
} from "../src/shared/dictionary";
import type { DictEntry } from "../src/shared/ipcContracts";

// U6b, storey 1: the whisper initial prompt.
//
// ---------------------------------------------------------------------------
// WHY THE NON-LEAK TEST IS SHAPED LIKE THIS
// ---------------------------------------------------------------------------
// The acceptance criterion is behavioural: "a 2 s dictation must not surface a
// dictionary term nobody said". That is a statement about a DECODE, and a
// decode is not replayable here - it needs a model, a GPU, real audio, and it
// is not deterministic across backends. Writing a test that pretends otherwise
// would be worse than writing none: it would be green for reasons unrelated to
// the property.
//
// So the leak is attacked where it is actually decidable, on both sides of the
// model:
//
//   BEFORE (this file) - the prompt is the only channel through which Flow can
//   put a word the user never said in front of the decoder. Every property that
//   makes a leak likely is asserted here: the prompt is BOUNDED no matter how
//   large the dictionary grows, it never carries an alias (a misspelling in the
//   prompt teaches the decoder to write the misspelling), no term is ever
//   truncated into a fragment (a half-word is an invented token), it closes
//   with a terminator rather than trailing off mid-sentence, and an empty
//   dictionary produces the seed BYTE FOR BYTE - the prompt Flow shipped before
//   this feature existed. Storey 1 is bounded by construction; that is the
//   mitigation, and these are its terms.
//
//   AFTER (test/dictionary.test.ts, "NON-LEAK") - storey 2 is the only code
//   that can put a dictionary term into a transcript once the model has
//   answered, and it is fully deterministic. A corpus of short utterances
//   containing none of the terms comes back byte-identical against a dictionary
//   of 65 entries.
//
// What remains unproven by tests is the decoder's own behaviour under a bounded
// prompt, and this comment is the honest place to say so rather than let a
// green suite imply otherwise. The plan's §13 checklist owns that half.

const SEED = "Transcription en français, avec la ponctuation et les accents.";

/** Starred by DEFAULT here, unlike everywhere else: since review constat 6 the
 * prompt carries starred terms only, so a fixture meant to test the budget, the
 * bounding or the leak has to be starred or it tests nothing at all. The tests
 * about the star gate itself pass `starred` explicitly, both ways. */
function entry(over: Partial<DictEntry> = {}): DictEntry {
  return {
    id: over.id ?? "id-1",
    term: over.term ?? "Claude",
    aliases: over.aliases ?? [],
    kind: over.kind ?? "vocabulary",
    starred: over.starred ?? true,
    createdIso: over.createdIso ?? "2026-01-01T00:00:00.000Z",
  };
}

test("NON-LEAK: an empty dictionary yields the seed, byte for byte", () => {
  assert.equal(buildDictationPrompt(SEED, []), SEED);
});

test("NON-LEAK: entries whose terms are blank add nothing either", () => {
  assert.equal(buildDictationPrompt(SEED, [entry({ term: "   " }), entry({ id: "b", term: "\n\t" })]), SEED);
});

test("NON-LEAK: a budget too small for even one term leaves the seed alone", () => {
  assert.equal(buildDictationPrompt(SEED, [entry({ term: "Claude" })], 4), SEED);
});

test("NON-LEAK: the prompt is BOUNDED however large the dictionary gets", () => {
  // The pitfall this budget exists for (plan §14): a heavily loaded prompt makes
  // whisper emit prompt vocabulary on a short clip. A user with 500 terms must
  // get the same size of prompt as a user with 5.
  for (const count of [1, 10, 100, 500]) {
    const entries = Array.from({ length: count }, (_, i) =>
      entry({ id: `id-${i}`, term: `TermeAssezLongPourCompter${i}`, starred: i % 3 === 0 }),
    );
    const prompt = buildDictationPrompt(SEED, entries);
    assert.ok(
      prompt.length <= SEED.length + DICT_PROMPT_BUDGET_CHARS,
      `${count} entries produced a ${prompt.length - SEED.length} char suffix, over the ${DICT_PROMPT_BUDGET_CHARS} budget`,
    );
  }
});

test("NON-LEAK: aliases NEVER reach the prompt - only canonical terms do", () => {
  // An alias is the WRONG spelling. Prompting "cloud code" would teach the
  // decoder to produce the exact string the entry exists to eliminate.
  const prompt = buildDictationPrompt(SEED, [
    entry({ term: "Claude Code", kind: "replacement", aliases: ["cloud code", "clode code"], starred: true }),
    entry({ id: "b", term: "Loi 25", kind: "replacement", aliases: ["loi vingt-cinq"] }),
  ]);
  assert.match(prompt, /Claude Code/);
  assert.match(prompt, /Loi 25/);
  for (const alias of ["cloud code", "clode code", "loi vingt-cinq"]) {
    assert.equal(prompt.includes(alias), false, `the alias ${JSON.stringify(alias)} leaked into the prompt`);
  }
});

test("NON-LEAK: a term is either in the prompt WHOLE or not at all - never a fragment", () => {
  // Half a term is an invented token: the leak in miniature. Budget pressure
  // must drop terms, never cut them.
  const entries = Array.from({ length: 40 }, (_, i) => entry({ id: `id-${i}`, term: `Xénophanoscopie${i}` }));
  const prompt = buildDictationPrompt(SEED, entries);
  const suffix = prompt.slice(SEED.length);
  const listed = suffix.replace(` ${DICT_PROMPT_LABEL}`, "").replace(/\.$/, "").split(", ");
  const known = new Set(entries.map((e) => e.term));
  for (const term of listed) {
    assert.ok(known.has(term), `${JSON.stringify(term)} is not one of the stored terms - it was cut`);
  }
});

test("NON-LEAK: the prompt closes with a terminator instead of trailing off mid-sentence", () => {
  // whisper CONTINUES its initial prompt. A prompt that stops mid-phrase is an
  // invitation to finish it, in the user's transcript.
  const prompt = buildDictationPrompt(SEED, [entry({ term: "Tailscale" })]);
  assert.ok(prompt.endsWith("."), prompt);
});

test("the budget covers the WHOLE suffix, label and punctuation included", () => {
  // Otherwise "bounded" would be a promise about the terms and a surprise about
  // everything wrapped around them.
  const entries = Array.from({ length: 50 }, (_, i) => entry({ id: `id-${i}`, term: `Terme${i}` }));
  for (const budget of [20, 40, 80, 160, 320]) {
    const suffix = buildDictationPrompt(SEED, entries, budget).slice(SEED.length);
    assert.ok(suffix.length <= budget, `budget ${budget} produced a ${suffix.length} char suffix`);
  }
});

// ---------------------------------------------------------------------------
// Review constat 6: the star decides, and the page can know what it decided
// ---------------------------------------------------------------------------
// The builder used to walk the starred terms and then keep going through the
// unstarred ones until the budget filled, while the page told the user the
// starred ones were what the engine hears about. An unstarred term therefore
// rode into the prompt on the strength of a control that said the opposite. The
// star now decides: it is the user's only say over the one channel that can put
// a word he never said in front of the decoder.

test("ONLY starred terms are sent - an unstarred term never reaches the prompt", () => {
  const entries = [
    entry({ id: "u1", term: "Ordinaire", starred: false }),
    entry({ id: "s1", term: "Prioritaire", starred: true }),
    entry({ id: "u2", term: "Autre", starred: false }),
  ];
  const prompt = buildDictationPrompt(SEED, entries);
  assert.match(prompt, /Prioritaire/);
  assert.equal(prompt.includes("Ordinaire"), false, "an unstarred term filled the budget the star was supposed to govern");
  assert.equal(prompt.includes("Autre"), false);
  assert.deepEqual(promptTerms(entries), ["Prioritaire"]);
});

test("a dictionary with nothing starred yields the seed, byte for byte", () => {
  // The honest consequence of the rule above, and the one the page has to say
  // out loud: a vocabulary entry acts ONLY through this prompt, so an unstarred
  // one does nothing whatsoever. Storey 2 is unaffected - a replacement still
  // works after the fact, at no cost to the prompt.
  const entries = [
    entry({ id: "a", term: "Ordinaire", starred: false }),
    entry({ id: "b", term: "Loi 25", kind: "replacement", aliases: ["loi vingt-cinq"], starred: false }),
  ];
  assert.equal(buildDictationPrompt(SEED, entries), SEED);
  assert.deepEqual(promptTerms(entries), []);
});

test("starred terms keep the user's own list order - starring IS the priority statement", () => {
  const entries = [
    entry({ id: "old", term: "Ancien", starred: true }),
    entry({ id: "mid", term: "Milieu", starred: false }),
    entry({ id: "new", term: "Recent", starred: true }),
  ];
  assert.deepEqual(promptTerms(entries), ["Ancien", "Recent"]);
  const prompt = buildDictationPrompt(SEED, entries);
  assert.ok(prompt.indexOf("Ancien") < prompt.indexOf("Recent"));
});

test("promptTerms is what the page must count: the budget can still drop starred terms", () => {
  // "N starred terms are sent" read off entries.filter(starred) is a claim about
  // a different quantity. With more stars than budget, the two numbers part
  // company - and the page has to show the one that is true.
  const entries = Array.from({ length: 60 }, (_, i) =>
    entry({ id: `id-${i}`, term: `TermeAssezLongPourCompter${i}`, starred: true }),
  );
  const sent = promptTerms(entries);
  assert.ok(sent.length > 0 && sent.length < entries.length, `${sent.length} of ${entries.length} sent`);
  // ...and it is EXACTLY what the prompt carries, in order.
  const prompt = buildDictationPrompt(SEED, entries);
  assert.equal(prompt, `${SEED} ${DICT_PROMPT_LABEL}${sent.join(", ")}.`);
});

test("promptTerms never depends on the seed it will be appended to", () => {
  // The page has no idea what index.ts's French seed is; its number would be a
  // guess if the count moved with it.
  const entries = [entry({ term: "Tailscale", starred: true })];
  assert.deepEqual(promptTerms(entries), promptTerms(entries, DICT_PROMPT_BUDGET_CHARS));
  assert.deepEqual(buildDictationPrompt("", entries).includes("Tailscale"), true);
});

test("a duplicated term spends the budget once", () => {
  // Two entries for the same word (one starred, one not; "AGR Labs" and "agr
  // labs") would otherwise both be listed, wasting budget and over-weighting one
  // word in the decoder's context.
  const prompt = buildDictationPrompt(SEED, [
    entry({ id: "a", term: "AGR Labs", starred: true }),
    entry({ id: "b", term: "agr labs" }),
  ]);
  assert.equal(prompt.match(/[Aa][Gg][Rr] [Ll]abs/g)?.length, 1, prompt);
});

test("a term carrying a newline can never break the prompt into two lines", () => {
  // A stored term is tidied at the store boundary, but the builder is the last
  // line of defence: a raw newline here would turn one aside into what reads as
  // a second sentence of transcript.
  const prompt = buildDictationPrompt(SEED, [entry({ term: "Deux\nLignes" })]);
  assert.equal(prompt.includes("\n"), false, JSON.stringify(prompt));
  assert.match(prompt, /Deux Lignes/);
});

test("the seed still rides only for an explicit French language - the guard the dictionary inherits", () => {
  // The widest leak surface storey 1 could have had is a clip whose language
  // nobody declared. sidecar.ts sends the prompt ONLY for lang === "fr", and the
  // dictionary is inside that same prompt, so it inherits the guard. Asserted on
  // the source, like test/ui-bridge.test.ts does for the IPC gate: this file
  // cannot spin up a whisper-server, and the property is structural.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "asr", "sidecar.ts"), "utf8");
  const decl = /const prompt =[\s\S]*?;/.exec(src);
  assert.ok(decl, "the per-request prompt must still be built in one place");
  assert.match(decl[0], /lang === "fr"/, "the dictionary must not be able to ride on an undeclared language");
});
