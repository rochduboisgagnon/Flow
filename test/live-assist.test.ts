import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIST_CONTEXT_MAX_CHARS,
  ASSIST_MAX_ITEMS,
  ASSIST_MAX_ITEM_CHARS,
  ASSIST_MIN_INTERVAL_MS,
  ASSIST_MIN_NEW_SEGMENTS,
  ASSIST_NOTHING,
  ASSIST_UNAVAILABLE,
  ASSIST_WAIT_TEXT,
  assistPrompt,
  decideAssist,
  isSuggestionLine,
  mustYield,
  parseAssistItems,
  sanitizeSuggestionText,
  slidingContext,
  speechBlocks,
  suggestionLine,
  type AssistGateInput,
  type AssistWait,
} from "../src/shared/liveAssist";
import { transcriptHeader, transcriptLine, markLine, gapLine } from "../src/shared/longform";
import { parseTranscriptPassages } from "../src/shared/redact";

// U8: everything the live-assistance feature decides, tested without Electron,
// without Ollama and without a recorder - the same discipline as
// test/long-start.test.ts. The class in main/liveAssist.ts owns no rule of its
// own; it is these functions plus a clock.

// ---- the priority gate: dictation, then the meeting, then this ----

/** A gate input where everything is clear and a round SHOULD run. Each test
 * below changes exactly one field, so what it proves is unambiguous. */
function clear(over: Partial<AssistGateInput> = {}): AssistGateInput {
  return {
    enabled: true,
    modelReady: true,
    recordingActive: true,
    finalizing: false,
    dictating: false,
    transcribing: false,
    otherEngineWork: false,
    generating: false,
    msSinceLastRound: ASSIST_MIN_INTERVAL_MS + 1,
    newSegments: ASSIST_MIN_NEW_SEGMENTS,
    ...over,
  };
}

test("with the machine free and enough new speech, a round runs", () => {
  assert.deepEqual(decideAssist(clear()), { run: true, wait: "ready" });
});

test("OFF is the first thing tested: nothing else can make a round run", () => {
  // Every other input set to "yes, go" - the switch alone stops it.
  assert.deepEqual(decideAssist(clear({ enabled: false })), { run: false, wait: "off" });
});

test("a dictation in flight refuses a round - dictation always goes first", () => {
  const v = decideAssist(clear({ dictating: true }));
  assert.equal(v.run, false);
  assert.equal(v.wait, "dictation");
});

test("the meeting's own transcription refuses a round - it outranks the assistance", () => {
  const v = decideAssist(clear({ transcribing: true }));
  assert.equal(v.run, false);
  assert.equal(v.wait, "transcribing");
});

test("an import or a model download refuses a round", () => {
  const v = decideAssist(clear({ otherEngineWork: true }));
  assert.equal(v.run, false);
  assert.equal(v.wait, "engine");
});

test("dictation outranks the transcription, which outranks the import: the reported reason is the HIGHEST claim", () => {
  // All three at once. The user must be told the strongest reason, and the
  // ordering here is the ordering plan-design §15.3 fixes.
  assert.equal(
    decideAssist(clear({ dictating: true, transcribing: true, otherEngineWork: true })).wait,
    "dictation",
  );
  assert.equal(decideAssist(clear({ transcribing: true, otherEngineWork: true })).wait, "transcribing");
});

test("a dictation refuses a round even when the model is still being probed - the engine order does not wait on a probe", () => {
  // modelReady null answers "checking" (nothing has been asked of the engine
  // yet), and that must NOT be mistaken for permission.
  assert.equal(decideAssist(clear({ modelReady: null })).run, false);
  assert.equal(decideAssist(clear({ modelReady: null })).wait, "checking");
  assert.equal(decideAssist(clear({ modelReady: false })).wait, "no-model");
});

test("no recording, or a recording being finalized, means no round", () => {
  assert.equal(decideAssist(clear({ recordingActive: false })).wait, "idle");
  // finalizing is reported ahead of idle: both have recordingActive false, and
  // "being finished" is the informative one.
  assert.equal(decideAssist(clear({ recordingActive: false, finalizing: true })).wait, "finishing");
});

test("a round already in flight is not doubled", () => {
  const v = decideAssist(clear({ generating: true }));
  assert.equal(v.run, false);
  assert.equal(v.wait, "thinking");
});

test("the cooldown holds: a round that just finished does not immediately run again", () => {
  assert.equal(decideAssist(clear({ msSinceLastRound: ASSIST_MIN_INTERVAL_MS - 1 })).wait, "cooldown");
  assert.equal(decideAssist(clear({ msSinceLastRound: ASSIST_MIN_INTERVAL_MS })).run, true);
});

test("without new speech since the last round there is nothing to look at", () => {
  assert.equal(decideAssist(clear({ newSegments: ASSIST_MIN_NEW_SEGMENTS - 1 })).wait, "waiting-speech");
  assert.equal(decideAssist(clear({ newSegments: 0 })).wait, "waiting-speech");
});

test("every wait state has a sentence, and only 'ready' is silent", () => {
  const states = Object.keys(ASSIST_WAIT_TEXT) as AssistWait[];
  assert.ok(states.length >= 11);
  for (const s of states) {
    if (s === "ready") {
      assert.equal(ASSIST_WAIT_TEXT[s], "");
      continue;
    }
    assert.ok(ASSIST_WAIT_TEXT[s].length > 20, `${s} needs a real sentence, not a label`);
  }
  // The two states that name an engine claim must say WHICH one, in words the
  // user can act on.
  assert.match(ASSIST_WAIT_TEXT.dictation, /dictation/i);
  assert.match(ASSIST_WAIT_TEXT.transcribing, /transcription/i);
  // The missing-model sentence has to admit Flow embeds no model of its own.
  assert.match(ASSIST_WAIT_TEXT["no-model"], /Ollama/);
});

test("mustYield covers exactly the states that outrank a round in flight", () => {
  assert.ok(mustYield("dictation"));
  assert.ok(mustYield("transcribing"));
  assert.ok(mustYield("engine"));
  assert.ok(mustYield("finishing"));
  for (const w of ["off", "checking", "no-model", "idle", "thinking", "cooldown", "waiting-speech", "ready"] as AssistWait[]) {
    assert.equal(mustYield(w), false, `${w} must not abort a round in flight`);
  }
});

test("the refused-sender fallback claims nothing: off, no model, no suggestions", () => {
  assert.equal(ASSIST_UNAVAILABLE.ok, false);
  assert.equal(ASSIST_UNAVAILABLE.enabled, false);
  assert.equal(ASSIST_UNAVAILABLE.modelReady, false);
  assert.equal(ASSIST_UNAVAILABLE.recording, false);
  assert.deepEqual(ASSIST_UNAVAILABLE.suggestions, []);
});

// ---- reading the document back: only speech, never the machine's own words ----

const HEADER = transcriptHeader("Weekly sync", "2026-07-29T10:00:00.000Z");

test("only the recorder's timestamped lines are read as speech", () => {
  const doc =
    HEADER +
    transcriptLine(7_000, "Bonjour tout le monde.") +
    markLine(12_000) +
    transcriptLine(15_000, "On commence par le budget.") +
    gapLine(20_000, 4);
  const blocks = speechBlocks(doc);
  assert.deepEqual(blocks, [
    { offsetMs: 7_000, text: "Bonjour tout le monde." },
    { offsetMs: 15_000, text: "On commence par le budget." },
  ]);
});

test("THE SELF-FEEDING GUARD: a kept suggestion in the document is never read back as speech", () => {
  // The defect this prevents: the assistant reads the tail of the document to
  // build its context. If its OWN kept output came back as speech, it would
  // start suggesting things "because someone said them" - when nobody did.
  const kept = suggestionLine(30_000, 28_000, "Ask who owns the migration");
  const doc = HEADER + transcriptLine(7_000, "Bonjour.") + kept;
  assert.ok(isSuggestionLine(kept));
  const blocks = speechBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Bonjour.");
  assert.ok(
    !JSON.stringify(blocks).includes("migration"),
    "the assistant must never see its own suggestion as something that was said",
  );
});

test("a tail cut mid-document drops its first, incomplete block", () => {
  const full = HEADER + transcriptLine(7_000, "premiere phrase") + transcriptLine(14_000, "deuxieme phrase");
  const tail = full.slice(full.indexOf("premiere") + 3); // cut inside the first line
  const blocks = speechBlocks(tail, true);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "deuxieme phrase");
});

test("a multi-line transcribed block keeps all its words, on one line", () => {
  const doc = HEADER + "[00:00:07] premiere ligne\nsuite de la phrase\n\n";
  const blocks = speechBlocks(doc);
  assert.deepEqual(blocks, [{ offsetMs: 7_000, text: "premiere ligne suite de la phrase" }]);
});

// ---- the sliding window: constant size whatever the meeting's length ----

/** `minutes` of transcript, one 7 s block at a time. */
function longTranscript(minutes: number): Array<{ offsetMs: number; text: string }> {
  const out: Array<{ offsetMs: number; text: string }> = [];
  for (let ms = 0; ms < minutes * 60_000; ms += 7_000) {
    out.push({ offsetMs: ms, text: "Une phrase de reunion assez ordinaire, avec quelques mots de plus." });
  }
  return out;
}

test("A TWO-HOUR MEETING DOES NOT GROW THE PROMPT: same bound at minute 5 and minute 120", () => {
  const short = slidingContext(longTranscript(5));
  const long = slidingContext(longTranscript(120));
  assert.ok(short.text.length <= ASSIST_CONTEXT_MAX_CHARS);
  assert.ok(long.text.length <= ASSIST_CONTEXT_MAX_CHARS);
  // And the prompt built from it is bounded too - the whole point.
  assert.ok(assistPrompt(long).length < ASSIST_CONTEXT_MAX_CHARS + 2_000);
  // The window slides: the excerpt is about the END of the meeting.
  assert.ok(long.upToMs > 119 * 60_000, "the newest speech must be in the excerpt");
  assert.ok(long.fromMs > 100 * 60_000, "the excerpt must not reach back to the start of the meeting");
});

test("the window is bounded by TIME as well as by size: a long pause is not reached back through", () => {
  const blocks = [
    { offsetMs: 0, text: "tres vieille phrase" },
    { offsetMs: 60 * 60_000, text: "une heure plus tard" },
  ];
  const ctx = slidingContext(blocks);
  assert.equal(ctx.blocks, 1);
  assert.equal(ctx.text, "une heure plus tard");
});

test("an empty transcript yields an empty context, not a prompt about nothing", () => {
  const ctx = slidingContext([]);
  assert.equal(ctx.text, "");
  assert.equal(ctx.blocks, 0);
});

test("the prompt tells the model how to say nothing, and forbids inventing", () => {
  const p = assistPrompt(slidingContext(longTranscript(2)));
  assert.ok(p.includes(ASSIST_NOTHING), "the model needs a way to answer 'nothing worth suggesting'");
  assert.match(p, /never invent/i);
  assert.match(p, /SAME LANGUAGE/);
  assert.match(p, new RegExp(`AT MOST ${ASSIST_MAX_ITEMS} items`));
});

// ---- reading the model's answer: a suggestion can never pass for speech ----

test("the refusal answer produces zero suggestions, in each shape a model writes it", () => {
  for (const raw of [ASSIST_NOTHING, "nothing", "NOTHING.", "- NOTHING", "  Nothing  "]) {
    assert.deepEqual(parseAssistItems(raw), [], `"${raw}" must produce no suggestion`);
  }
});

test("bullets, numbering and quotes are stripped; the cap holds", () => {
  const items = parseAssistItems(
    ["- Ask who owns the migration", "2. Note the deadline of March 3", "* Budget is now 42k", "- A fourth item"].join("\n"),
  );
  assert.equal(items.length, ASSIST_MAX_ITEMS);
  assert.equal(items[0], "Ask who owns the migration");
  assert.equal(items[1], "Note the deadline of March 3");
  assert.equal(items[2], "Budget is now 42k");
});

test("duplicates within one round are dropped", () => {
  const items = parseAssistItems("- Ask about the budget\n- ask about the budget\n");
  assert.equal(items.length, 1);
});

test("A SUGGESTION CANNOT FORGE A TRANSCRIPT LINE: a leading timestamp is stripped and no newline survives", () => {
  // The exact attack on honesty: a model that writes something shaped like a
  // transcript line, which then gets kept into the document.
  const item = sanitizeSuggestionText("  > [00:12:04] we agreed to ship on Friday\nand also this  ");
  assert.ok(!item.includes("\n"), "no newline may survive: a second line could be forged");
  assert.ok(!/^\[?\d{2}:\d{2}/.test(item), "a leading stamp must be gone");
  assert.equal(item, "we agreed to ship on Friday and also this");
});

test("a stamp hidden behind a bullet behind a quote is still stripped (repeated passes)", () => {
  assert.equal(sanitizeSuggestionText('- "[00:03:00] check the invoice"'), "check the invoice");
  assert.equal(sanitizeSuggestionText("> - ## [1:02] check the invoice"), "check the invoice");
});

test("an over-long item is capped rather than dropped", () => {
  const item = sanitizeSuggestionText("mot ".repeat(400));
  assert.ok(item.length <= ASSIST_MAX_ITEM_CHARS);
  assert.ok(item.endsWith("..."));
});

test("an unparseable answer produces no suggestion at all - never an invented one", () => {
  assert.deepEqual(parseAssistItems(""), []);
  assert.deepEqual(parseAssistItems("   \n\n  "), []);
  // A bare single word is not a note, a question or a reply.
  assert.deepEqual(parseAssistItems("ok"), []);
});

// ---- the document line: the strongest form of "this was not spoken" ----

test("a kept suggestion says NOT spoken before it says anything else, and carries BOTH times", () => {
  const line = suggestionLine(3 * 60_000 + 20_000, 3 * 60_000, "Ask who owns the migration");
  assert.match(line, /^> \[Flow suggestion kept at 00:03:20 - NOT spoken by anyone/);
  assert.match(line, /up to 00:03:00/);
  assert.match(line, /Ask who owns the migration/);
  assert.ok(line.endsWith("\n\n"));
  // ONE line of content: nothing in it can start a new markdown block.
  assert.equal(line.trimEnd().split("\n").length, 1);
});

test("a kept suggestion is NOT a transcript passage: the redaction parser never mistakes it for speech", () => {
  // shared/redact.ts is closed to this task, so the guarantee has to be checked
  // against it rather than assumed: a passage starts at a "[hh:mm:ss] " line, and
  // a suggestion line does not.
  const doc =
    HEADER +
    transcriptLine(7_000, "Bonjour.") +
    suggestionLine(10_000, 7_000, "[00:00:07] Ask who owns the migration") +
    transcriptLine(14_000, "Ensuite le budget.");
  const passages = parseTranscriptPassages(doc);
  assert.equal(passages.length, 2, "only the two real segments are passages");
  assert.equal(passages[0].startMs, 7_000);
  assert.equal(passages[1].startMs, 14_000);
});

test("a suggestion whose text is itself shaped like a transcript line still cannot become one", () => {
  const line = suggestionLine(30_000, 20_000, "[00:00:07] Bonjour tout le monde");
  // Inside the blockquote, and with the forged stamp neutralized.
  assert.ok(line.startsWith("> [Flow suggestion kept at"));
  const blocks = speechBlocks(HEADER + line);
  assert.deepEqual(blocks, [], "it must not read back as speech");
});

test("square brackets inside a suggestion cannot close the document's own bracket early", () => {
  const line = suggestionLine(1_000, 0, "check [this] and] that");
  assert.equal((line.match(/\]/g) ?? []).length, 1, "exactly the bracket that closes the note");
});

// ---------------------------------------------------------------------------
// The test the rank 9-10 review earned, and the gap it exposed in this file.
//
// This suite already proved `speechBlocks` drops the suggestion lines before the
// live assistant reads them - the module's own comment says why: an assistant
// that read the document back "would feed itself its own output as if someone
// had said it". What it never covered was `summaryPrompt`, which received the
// SAME document with no equivalent instruction. The review followed that through
// and found the whole chain: a summary bullet repeating the model's own
// suggestion, citing a real neighbouring timestamp, surviving citation checking,
// and rendering in the Notes page as a clickable jump to a passage that never
// contained the claim. The notes block is what a human reads and what a
// connector will consume, so it landed exactly where it hurts.
// ---------------------------------------------------------------------------

test("REVIEW: summaryPrompt warns the model that suggestion lines were spoken by nobody", async () => {
  const { summaryPrompt } = await import("../src/shared/longform");

  const withSuggestion =
    "[00:05:00] Le budget du trimestre est de quarante mille dollars.\n" +
    "> [Flow suggestion kept at 00:05:10 - NOT spoken by anyone: written by the local model " +
    "on what it heard] On pourrait demander une rallonge au comite.\n";
  const p = summaryPrompt(withSuggestion, []);
  assert.match(p, /Flow suggestion kept at/, "the prompt must NAME the marker it is warning about");
  assert.match(p, /spoken by NOBODY/i, "and say plainly that nobody said it");

  // And the rule must not appear when there is nothing to warn about: a prompt
  // that always carried it would spend budget describing an absent hazard, and
  // would teach the model a marker it is about to see nowhere.
  const clean = summaryPrompt("[00:00:01] Bonjour tout le monde.\n", []);
  assert.doesNotMatch(clean, /Flow suggestion kept at/);
});

// ---------------------------------------------------------------------------
// P7 (vague P). The fourth wait state.
//
// "no-model" would tell a lie in the one case that matters most: you picked
// Claude Code and it is not on this machine. That sentence sends someone to
// install Ollama to fix a problem that is not theirs.
//
// The fourth state enters through modelReady, which was already tri-state,
// rather than through a new `provider` argument to decideAssist - that function
// is pure and tested branch by branch, and a provider argument would turn a
// dozen tests into a matrix. The plan says so and it is right.
// ---------------------------------------------------------------------------

test("P7: a chosen provider that is not usable says so, and does NOT say 'no local model'", () => {
  const d = decideAssist({
    ...clear(),
    enabled: true,
    modelReady: "provider-unavailable",
  });
  assert.equal(d.run, false);
  assert.equal(d.wait, "provider-unavailable");
  assert.notEqual(d.wait, "no-model", "that sentence would send someone to install the wrong thing");
});

test("P7: the three existing model states are untouched", () => {
  assert.equal(decideAssist({ ...clear({ enabled: true }), modelReady: null }).wait, "checking");
  assert.equal(decideAssist({ ...clear({ enabled: true }), modelReady: false }).wait, "no-model");
  assert.equal(decideAssist({ ...clear({ enabled: true }), modelReady: true }).run, true);
});

test("P7: the text for the fourth state says WHAT is wrong and that NOTHING LEFT", () => {
  const t = ASSIST_WAIT_TEXT["provider-unavailable"];
  assert.match(t, /Settings > Local AI/, "it points at the thing that fixes it");
  assert.match(t, /[Nn]othing was sent/, "someone whose meeting just failed needs to know this");
  assert.match(t, /transcrib/i, "and that the meeting itself is still being transcribed in full");
  assert.ok(!t.includes("—"), "no em-dash in anything a user reads");
});

test("P7: every wait state has a sentence - a silent panel is never acceptable", () => {
  const states: AssistWait[] = [
    "off", "checking", "no-model", "provider-unavailable", "idle", "finishing",
    "dictation", "transcribing", "engine", "thinking", "cooldown", "waiting-speech",
  ];
  for (const s of states) {
    assert.ok(ASSIST_WAIT_TEXT[s] && ASSIST_WAIT_TEXT[s].length > 20, `${s} has no sentence`);
  }
});
