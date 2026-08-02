import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTranscriptPassages,
  planRedaction,
  transcriptStart,
  locateWavData,
  byteRangeFor,
  hms,
  MAX_WAV_HEADER_BYTES,
  STAMP_TRUNCATION_SLACK_MS,
} from "../src/shared/redact";
import { transcriptHeader, transcriptLine, markLine, ENGINE_LINE, spliceNotes, defangStructureMarkers } from "../src/shared/longform";
import { encodeWav } from "../src/shared/wav";

// D11, the pure half: what a removal MEANS. Nothing here touches a disk - the
// writing side is test/redact-write.test.ts.
//
// The four decisions under test (shared/redact.ts's module note): the audio
// range is computed, the derived notes go whole, the timestamps do not move,
// and nothing is kept.

function doc(lines: Array<[number, string]>, opts: { notes?: string } = {}): string {
  const head = transcriptHeader("Weekly sync", "2026-07-29T09:00:00.000Z");
  const body = lines.map(([ms, text]) => transcriptLine(ms, text)).join("");
  return opts.notes === undefined ? head + body : spliceNotes(head + body, head, opts.notes);
}

// ---------------------------------------------------------------------------
// Security scan F9 (MEDIUM, 3/3, 2026-08-02). A meeting participant dictates an
// instruction to the summariser - out loud, or planted in an audio file the user
// imports - and the local model repeats a `## Transcript` line into its notes.
// The document then holds two, and every consumer here takes the FIRST: a
// passage removal cut the notes block in half, left the model's retelling of the
// erased passage on disk, and wrote a tombstone claiming the notes were gone.
// ---------------------------------------------------------------------------

const POISON = [
  "Resume of the meeting.",
  "",
  "## Transcript",
  "",
  "The card number discussed was restated here by the model.",
].join("\n");

test("F9: a forged '## Transcript' in the model's notes cannot move the transcript boundary", () => {
  const d = doc(
    [
      [0, "hello"],
      [20_000, "the card number is one two three"],
      [40_000, "moving on"],
    ],
    { notes: POISON },
  );
  // Exactly one real boundary survives in the document.
  assert.equal(d.split("\n## Transcript\n").length - 1, 1, "the forged marker must not survive as a heading");
  // ...and the transcript starts where the recorder put it, not inside the notes.
  const start = transcriptStart(d);
  assert.ok(d.slice(start).trimStart().startsWith("[00:00:00] hello"), "the scan begins at the real first segment");
  // The model's words are still THERE - defanging is not censoring, it only
  // removes the '##' that made a sentence into structure.
  assert.ok(d.includes("The card number discussed was restated here by the model."));
});

test("F9: the passage list is unaffected by the forged marker - three segments, not more", () => {
  const clean = doc([[0, "a"], [10_000, "b"], [20_000, "c"]], { notes: "Plain notes." });
  const poisoned = doc([[0, "a"], [10_000, "b"], [20_000, "c"]], { notes: POISON });
  assert.equal(parseTranscriptPassages(poisoned).length, parseTranscriptPassages(clean).length);
  assert.equal(parseTranscriptPassages(poisoned).length, 3);
});

test("F9: defanging is line-anchored - prose that merely mentions a transcript is untouched", () => {
  const notes = [
    "They asked for the transcript of the call.",
    "Summary: shipping slipped a week.", // not a heading: no leading #
    "  ## Notes", // indented, but a parser reading line starts still sees a heading
  ].join("\n");
  const d = doc([[0, "x"]], { notes });
  assert.ok(d.includes("They asked for the transcript of the call."), "ordinary prose is left alone");
  assert.ok(d.includes("Summary: shipping slipped a week."), "a colon is not a heading");
  // The ONE "## Notes" left is the heading spliceNotes writes itself, at column
  // zero. The model's indented copy must be gone.
  assert.equal(d.match(/^[ \t]*#{1,6}[ \t]*Notes\b/gm)?.length, 1, "only Flow's own heading survives");
  assert.ok(d.includes("  Notes"), "and the model's words are kept, minus the hashes");
});

test("F9: defangStructureMarkers is idempotent and keeps every word", () => {
  const once = defangStructureMarkers(POISON);
  assert.equal(defangStructureMarkers(once), once, "re-splicing a document must not erode it");
  for (const word of ["Resume", "Transcript", "card", "model"]) {
    assert.ok(once.includes(word), `${word} must survive: this defangs structure, it does not censor`);
  }
});

// ---- the parser ----

test("the parser is pinned to the recorder's own header line", () => {
  // shared/redact.ts re-declares ENGINE_LINE as a literal rather than importing
  // it. If the recorder ever changes that line, transcriptStart falls back to
  // offset 0 and would start offering the header as a passage - this test is
  // what makes that change loud instead of silent.
  const d = transcriptHeader("T", "2026-07-29T09:00:00.000Z");
  assert.equal(transcriptStart(d), d.indexOf(ENGINE_LINE) + ENGINE_LINE.length);
});

test("passages carry their timestamp, their text, and the NEXT one's start as their end", () => {
  const ps = parseTranscriptPassages(doc([[0, "Hello."], [7000, "The card number is redacted."], [14_000, "Bye."]]));
  assert.equal(ps.length, 3);
  assert.deepEqual(ps.map((p) => p.startMs), [0, 7000, 14_000]);
  assert.deepEqual(ps.map((p) => p.endMs), [7000, 14_000, null]);
  assert.match(ps[1].text, /The card number is redacted\./);
});

test("the LAST passage has no end: the transcript names none and we never invent one", () => {
  const ps = parseTranscriptPassages(doc([[0, "Only line."]]));
  assert.equal(ps[0].endMs, null);
});

test("a marked moment travels with the passage it follows, never orphaned by a removal", () => {
  const head = transcriptHeader("T", "2026-07-29T09:00:00.000Z");
  const d = head + transcriptLine(0, "Alpha.") + markLine(3000) + transcriptLine(7000, "Beta.");
  const ps = parseTranscriptPassages(d);
  assert.equal(ps.length, 2);
  assert.match(ps[0].text, /Moment marked/);
  assert.doesNotMatch(ps[1].text, /Moment marked/);
});

test("a timestamp INSIDE the notes block is not a passage", () => {
  // The notes are model-written prose; one that opens a line with a timestamp
  // would otherwise be offered as a removable passage, and removing it would
  // edit the summary and silence an audio range nobody pointed at.
  const d = doc([[0, "Real line."]], { notes: "[00:00:05] The model quoted a timestamp here.\n\nAnd more." });
  const ps = parseTranscriptPassages(d);
  assert.equal(ps.length, 1);
  assert.match(ps[0].text, /Real line\./);
});

test("indices are prefix-stable, so an index parsed on a TRUNCATED copy still names the same passage", () => {
  // readHistoryDoc caps its read at 5 MB for display; main re-parses the whole
  // file. That only works because passage N depends solely on the document up
  // to passage N+1.
  const full = doc([[0, "A."], [7000, "B."], [14_000, "C."], [21_000, "D."]]);
  const cut = full.slice(0, full.indexOf("C."));
  const a = parseTranscriptPassages(cut);
  const b = parseTranscriptPassages(full);
  for (const p of a) {
    assert.equal(b[p.index].startMs, p.startMs);
    assert.equal(b[p.index].from, p.from);
  }
});

// ---- the plan ----

test("removing a passage takes the text out and leaves a tombstone naming the range", () => {
  const d = doc([[0, "Alpha."], [7000, "My card is 4111 1111 1111 1111."], [14_000, "Gamma."]]);
  const plan = planRedaction(d, [1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.doesNotMatch(plan.doc, /4111/, "the passage is gone from the document");
  assert.match(plan.doc, /Alpha\./);
  assert.match(plan.doc, /Gamma\./);
  assert.match(plan.doc, /Passage removed from 00:00:07 to 00:00:14, on 2026-07-29\./);
  assert.match(plan.doc, /The audio for that range was silenced\./);
  assert.deepEqual(plan.ranges, [{ startMs: 7000, endMs: 14_000 }]);
  assert.deepEqual(plan.removedText.length, 1);
  assert.match(plan.removedText[0], /4111/);
});

test("DECISION 3: the surviving timestamps are untouched - a hole, never a shift", () => {
  const d = doc([[0, "Alpha."], [7000, "Secret."], [14_000, "Gamma."]]);
  const plan = planRedaction(d, [1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.match(plan.doc, /\[00:00:14\] Gamma\./, "Gamma still points at second 14 of the audio");
  assert.doesNotMatch(plan.doc, /\[00:00:07\] Gamma/);
});

test("the tombstone tells the truth when no audio was kept", () => {
  const d = doc([[0, "Alpha."], [7000, "Secret."]]);
  const plan = planRedaction(d, [1], { hasAudio: false, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.match(plan.doc, /No audio was kept for this recording, so there was none to silence\./);
  assert.doesNotMatch(plan.doc, /was silenced\./);
});

test("removing the LAST passage says so: the range runs to the end of the recording", () => {
  const d = doc([[0, "Alpha."], [7000, "Secret."]]);
  const plan = planRedaction(d, [1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.deepEqual(plan.ranges, [{ startMs: 7000, endMs: null }]);
  assert.match(plan.doc, /from 00:00:07 to the end of the recording/);
});

test("DECISION 2: the derived notes are dropped WHOLE, and the document says why", () => {
  const d = doc([[0, "Alpha."], [7000, "My card is 4111."]], {
    notes: "The client gave his card number, 4111, during the call.",
  });
  const plan = planRedaction(d, [1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.equal(plan.notesDropped, true);
  assert.doesNotMatch(plan.doc, /4111/, "the notes cannot be allowed to repeat what was erased");
  assert.match(plan.doc, /The meeting notes were removed on 2026-07-29/);
  assert.match(plan.doc, /## Transcript/, "the transcript section marker survives");
  assert.match(plan.doc, /Alpha\./);
});

test("a document with no notes block reports notesDropped false and keeps its shape", () => {
  const d = doc([[0, "Alpha."], [7000, "Secret."]]);
  const plan = planRedaction(d, [1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.equal(plan.notesDropped, false);
  assert.doesNotMatch(plan.doc, /meeting notes were removed/);
});

test("contiguous passages merge into ONE range and ONE tombstone", () => {
  const d = doc([[0, "A."], [7000, "B."], [14_000, "C."], [21_000, "D."]]);
  const plan = planRedaction(d, [1, 2], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.deepEqual(plan.ranges, [{ startMs: 7000, endMs: 21_000 }]);
  assert.equal(plan.doc.match(/Passage removed/g)?.length, 1);
  assert.doesNotMatch(plan.doc, /\bB\.|\bC\./);
  assert.match(plan.doc, /\bA\./);
  assert.match(plan.doc, /\bD\./);
});

test("non-contiguous passages produce two ranges and two tombstones, in document order", () => {
  const d = doc([[0, "A."], [7000, "B."], [14_000, "C."], [21_000, "D."]]);
  const plan = planRedaction(d, [3, 1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.deepEqual(plan.ranges, [
    { startMs: 7000, endMs: 14_000 },
    { startMs: 21_000, endMs: null },
  ]);
  assert.equal(plan.doc.match(/Passage removed/g)?.length, 2);
  assert.ok(plan.doc.indexOf("00:00:07") < plan.doc.indexOf("00:00:21"));
});

test("a duplicated index is not a second removal", () => {
  const d = doc([[0, "A."], [7000, "B."], [14_000, "C."]]);
  const plan = planRedaction(d, [1, 1, 1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.equal(plan.ranges.length, 1);
});

test("an index that names no passage is REFUSED, never rounded to a neighbour", () => {
  const d = doc([[0, "A."], [7000, "B."]]);
  for (const bad of [2, -1, 1.5, Number.NaN]) {
    const plan = planRedaction(d, [bad], { hasAudio: true, dateIso: "2026-07-29" });
    assert.ok("error" in plan, `index ${bad} must be refused`);
  }
});

test("an empty selection, and a transcript with nothing to remove, both refuse", () => {
  const d = doc([[0, "A."]]);
  assert.ok("error" in planRedaction(d, [], { hasAudio: true, dateIso: "2026-07-29" }));
  assert.ok("error" in planRedaction("# Nothing\n\n", [0], { hasAudio: true, dateIso: "2026-07-29" }));
});

test("removing every passage leaves a document that is still a document", () => {
  const d = doc([[0, "A."], [7000, "B."]]);
  const plan = planRedaction(d, [0, 1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  assert.match(plan.doc, /^# Weekly sync/);
  assert.match(plan.doc, /Passage removed from 00:00:00 to the end of the recording/);
  assert.equal(parseTranscriptPassages(plan.doc).length, 0);
});

test("a removal is idempotent in shape: re-parsing the result finds only the survivors", () => {
  const d = doc([[0, "A."], [7000, "B."], [14_000, "C."]]);
  const plan = planRedaction(d, [1], { hasAudio: true, dateIso: "2026-07-29" });
  assert.ok(!("error" in plan));
  const again = parseTranscriptPassages(plan.doc);
  assert.deepEqual(again.map((p) => p.startMs), [0, 14_000]);
});

// ---- the audio range ----

test("locateWavData finds our own encoder's payload", () => {
  const wav = encodeWav(new Int16Array(16_000));
  const got = locateWavData(wav, wav.length);
  assert.ok(!("error" in got));
  assert.equal(got.dataOffset, 44);
  assert.equal(got.dataBytes, 32_000);
});

test("locateWavData walks past a LIST chunk, the way external writers emit one", () => {
  const base = encodeWav(new Int16Array(1600));
  const list = Buffer.alloc(8 + 8);
  list.write("LIST", 0);
  list.writeUInt32LE(8, 4);
  const withList = Buffer.concat([
    Buffer.from(base.subarray(0, 36)),
    list,
    Buffer.from(base.subarray(36)),
  ]);
  const got = locateWavData(withList, withList.length);
  assert.ok(!("error" in got));
  assert.equal(got.dataOffset, 44 + 16);
  assert.equal(got.dataBytes, 3200);
});

test("locateWavData REFUSES a format whose bytes do not map to time the way ours do", () => {
  const wav = Buffer.from(encodeWav(new Int16Array(1600)));
  wav.writeUInt16LE(2, 22); // stereo
  const got = locateWavData(wav, wav.length);
  assert.ok("error" in got);
  assert.match(got.error, /16 kHz mono 16-bit/);
});

test("locateWavData trusts the FILE over the declared size (a killed recorder overstates it)", () => {
  const wav = Buffer.from(encodeWav(new Int16Array(16_000)));
  wav.writeUInt32LE(999_999, 40); // the placeholder a crash leaves behind
  const got = locateWavData(wav, wav.length);
  assert.ok(!("error" in got));
  assert.equal(got.dataBytes, wav.length - 44, "clamped to what is really there");
});

test("locateWavData never spins forever on a zero-size chunk", () => {
  const junk = Buffer.alloc(200);
  junk.write("RIFF", 0);
  junk.write("WAVE", 8);
  junk.write("junk", 12); // size stays 0
  const got = locateWavData(junk, junk.length);
  assert.ok("error" in got);
});

test("locateWavData refuses garbage and short files instead of throwing", () => {
  assert.ok("error" in locateWavData(Buffer.alloc(4), 4));
  assert.ok("error" in locateWavData(Buffer.from("not a wav at all!!!!"), 20));
});

test("MAX_WAV_HEADER_BYTES bounds how far we look before giving up", () => {
  assert.ok(MAX_WAV_HEADER_BYTES > 44 && MAX_WAV_HEADER_BYTES <= 1024 * 1024);
});

test("byteRangeFor maps milliseconds onto 16 kHz mono 16-bit samples, sample-aligned", () => {
  const data = { dataOffset: 44, dataBytes: 320_000 }; // ten seconds
  const r = byteRangeFor({ startMs: 250, endMs: 750 }, data);
  assert.equal(r.from, 44 + 250 * 32);
  // F6: the end carries one second of slack, because the stamp it came from was
  // truncated to the whole second. See STAMP_TRUNCATION_SLACK_MS.
  assert.equal(r.to, 44 + (750 + STAMP_TRUNCATION_SLACK_MS) * 32);
  assert.equal((r.from - 44) % 2, 0, "never lands mid-sample");
  assert.equal((r.to - 44) % 2, 0);
});

// ---------------------------------------------------------------------------
// Security scan F6 (MEDIUM, 3/3, 2026-08-02). The transcript writes stamps
// truncated to the whole second; the real segment offsets are arbitrary
// milliseconds. A passage's end is read off the NEXT passage's stamp, so
// silencing exactly to that number left up to 999 ms of the destroyed passage
// audible - under a tombstone stating it had been silenced.
// ---------------------------------------------------------------------------

test("F6: the scan's exact case - a segment truly starting at 20.900 s is fully covered", () => {
  // The transcript says [00:00:20] for a segment that really begins at 20,900 ms.
  // The passage before it is removed: silencing to 20,000 ms used to leave
  // 20.000-20.900 s - the end of the erased sentence - intact in the .wav.
  const data = { dataOffset: 44, dataBytes: 32_000 * 60 }; // a minute, room to spare
  const r = byteRangeFor({ startMs: 15_000, endMs: 20_000 }, data);
  const realEndOfRemovedAudioMs = 20_900;
  assert.ok(
    r.to >= 44 + realEndOfRemovedAudioMs * 32,
    `the silenced range must reach ${realEndOfRemovedAudioMs} ms, not stop at the printed stamp`,
  );
});

test("F6: the slack covers the worst truncation there can be, and no more", () => {
  const data = { dataOffset: 44, dataBytes: 32_000 * 60 };
  const endMs = 30_000;
  const r = byteRangeFor({ startMs: 10_000, endMs }, data);
  // Worst case: the next segment really starts at endMs + 999.999 ms.
  assert.ok(r.to >= 44 + (endMs + 999) * 32, "covers the largest possible truncation");
  // And the over-removal is bounded: never more than one second past the stamp,
  // because every millisecond beyond that is somebody else's speech.
  assert.equal(r.to, 44 + (endMs + 1000) * 32, "and stops there - the cost is bounded at one second");
});

test("F6: the start is NOT pushed out - a truncated start already over-removes", () => {
  const data = { dataOffset: 44, dataBytes: 32_000 * 60 };
  const r = byteRangeFor({ startMs: 12_000, endMs: 15_000 }, data);
  assert.equal(r.from, 44 + 12_000 * 32, "pulling the start back would eat the previous passage for nothing");
});

test("byteRangeFor with a null end runs to the end of the payload - the deliberate over-removal", () => {
  const data = { dataOffset: 44, dataBytes: 32_000 };
  const r = byteRangeFor({ startMs: 500, endMs: null }, data);
  assert.equal(r.to, 44 + 32_000);
});

test("byteRangeFor clamps a range that runs past a shorter-than-expected file", () => {
  const data = { dataOffset: 44, dataBytes: 3200 }; // 100 ms of audio
  const r = byteRangeFor({ startMs: 5000, endMs: 9000 }, data);
  assert.equal(r.from, 44 + 3200);
  assert.equal(r.to, 44 + 3200);
});

test("hms matches the shape the recorder writes", () => {
  assert.equal(hms(0), "00:00:00");
  assert.equal(hms(3_661_000), "01:01:01");
  assert.equal(hms(-5), "00:00:00");
});
