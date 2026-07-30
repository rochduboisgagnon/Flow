import test from "node:test";
import assert from "node:assert/strict";
import {
  compileFunctions,
  detectCommand,
  defaultFunctions,
  explainNoMatch,
  cleanModelOutput,
  buildFunctionPrompt,
  MIN_PAYLOAD_WORDS,
  MIN_PAYLOAD_CHARS,
  MAX_PAYLOAD_CHARS,
} from "../src/shared/functions";

// V5, the safety half. These tests exist for ONE property, and it is the one
// that decides whether this feature is usable at all:
//
//   ordinary dictation must NEVER be taken for a command.
//
// The asymmetry is deliberate and it is the whole design. A command that fails
// to fire is an inconvenience - you say it again. Text silently rewritten by a
// model you did not invoke is a LOSS: the words you dictated are gone, and you
// may not notice until much later. So every gate below is written to refuse,
// and each test here pins one refusal in place. A future change that makes
// detection "smarter" has to break one of these first.
//
// The tests drive the real compiled defaults wherever possible, not hand-built
// fixtures, so they measure what Roch will actually have installed.

const ID = () => "id-" + Math.random().toString(36).slice(2, 8);
const shipped = defaultFunctions(ID, "2026-07-30T00:00:00.000Z");
// The detection tests need enabled functions; the shipped ones are off (see the
// test right below, which is why). Enabling them HERE, in the test, is also the
// honest way round: it proves the gates hold for the exact triggers Roch would
// be turning on, not for fixtures invented to pass.
const compiled = compileFunctions(shipped.map((f) => ({ ...f, enabled: true })));

test("the shipped functions arrive DISABLED, so nothing rewrites text until asked", () => {
  assert.ok(shipped.length > 0, "defaultFunctions must ship something to turn on");
  assert.ok(
    shipped.every((f) => f.enabled === false),
    "a function that shipped enabled would start transforming dictation on first launch",
  );
  assert.equal(compileFunctions(shipped).length, 0, "disabled must mean UNDETECTABLE, not merely hidden");
});

test("once enabled, every shipped function has a trigger that can actually fire", () => {
  assert.ok(compiled.length > 0);
  assert.ok(
    compiled.every((f) => f.triggers.length > 0),
    "a function with no compiled trigger can never fire and would be a dead control",
  );
});

test("with no enabled functions, nothing is EVER a command", () => {
  const r = detectCommand("traduis ceci en anglais, le rapport est pret", []);
  assert.equal(r.match, null);
  assert.equal(r.reason, "no-enabled-functions");
});

// ---- the head rule: this is the gate that saves an email ----

test("THE CASE THAT MATTERS: a command phrase in the MIDDLE of a sentence stays dictation", () => {
  // Roch dictating an email. The words "traduis ça en anglais" appear, but they
  // are something he is SAYING, not something he is asking for. If this ever
  // returns a match, dictated text gets replaced by a translation of itself.
  const sentences = [
    "je vais lui demander de traduire ceci en anglais avant la reunion",
    "peux-tu traduis ceci en anglais quand tu auras le temps",
    "elle a dit resume ceci en trois points et je trouve que c'est une bonne idee",
    "la consigne etait claire, ecris un courriel a l'equipe avant midi",
  ];
  for (const s of sentences) {
    const r = detectCommand(s, compiled);
    assert.equal(r.match, null, `must stay dictation: ${JSON.stringify(s)}`);
  }
});

test("a trigger with NOTHING after it is someone dictating that phrase", () => {
  for (const f of compiled) {
    for (const t of f.triggers) {
      const r = detectCommand(t.raw.replace("{lang}", "anglais"), compiled);
      assert.equal(r.match, null, `a bare trigger must not fire: ${t.raw}`);
      assert.equal(r.reason, "payload-too-short");
    }
  }
});

test("a payload that CONTINUES the sentence is dictation, not a command", () => {
  // "resume ceci et envoie-le" - the "et" says the speaker is still building a
  // sentence, so the words after the trigger are not a payload.
  const r = detectCommand("resume ceci et ensuite envoie-le a toute l'equipe", compiled);
  assert.equal(r.match, null);
  assert.equal(r.reason, "payload-continues-the-sentence");
});

// ---- payload thresholds: both bounds are refusals ----

test("a payload shorter than the floor is refused, by words AND by characters", () => {
  const short = detectCommand("resume ceci: oui non", compiled);
  assert.equal(short.match, null, "two words cannot be a document to act on");
  assert.equal(short.reason, "payload-too-short");
  assert.ok(MIN_PAYLOAD_WORDS >= 3 && MIN_PAYLOAD_CHARS >= 12, "the floors must stay meaningful");
});

test("a payload past the ceiling is refused rather than silently truncated", () => {
  const huge = "resume ceci: " + "mot ".repeat(MAX_PAYLOAD_CHARS);
  const r = detectCommand(huge, compiled);
  assert.equal(r.match, null);
  assert.equal(r.reason, "payload-too-long");
  // Truncating would hand the model a document cut mid-sentence and return its
  // summary as if it had seen the whole thing - a quiet lie about what was read.
});

// ---- every refusal must be explainable to a human ----

test("every refusal reason has a sentence, so the page cannot describe a gate that does not exist", () => {
  const reasons = [
    "no-enabled-functions",
    "no-trigger-at-head",
    "not-separated",
    "payload-too-short",
    "payload-too-long",
    "payload-continues-the-sentence",
  ] as const;
  for (const r of reasons) {
    const s = explainNoMatch(r);
    assert.ok(typeof s === "string" && s.length > 10, `${r} must explain itself: ${JSON.stringify(s)}`);
  }
});

// ---- the model's answer is never trusted blindly ----

test("cleanModelOutput refuses an empty or whitespace-only answer instead of erasing the text", () => {
  assert.equal(cleanModelOutput(""), null);
  assert.equal(cleanModelOutput("   \n\t  "), null);
  // Returning "" here would replace the user's selection with nothing: a model
  // that failed would look exactly like a model that deleted your paragraph.
});

test("buildFunctionPrompt carries the payload verbatim", () => {
  const payload = "Bonjour, ceci est le corps du message avec des accents: eleve, ete.";
  const p = buildFunctionPrompt("Traduis en {lang}", "anglais", payload);
  assert.ok(p.includes(payload), "the payload must reach the model unmodified");
});
