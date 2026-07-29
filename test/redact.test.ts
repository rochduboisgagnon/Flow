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
} from "../src/shared/redact";
import { transcriptHeader, transcriptLine, markLine, ENGINE_LINE, spliceNotes } from "../src/shared/longform";
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
  const data = { dataOffset: 44, dataBytes: 32_000 }; // exactly one second
  const r = byteRangeFor({ startMs: 250, endMs: 750 }, data);
  assert.equal(r.from, 44 + 250 * 32);
  assert.equal(r.to, 44 + 750 * 32);
  assert.equal((r.from - 44) % 2, 0, "never lands mid-sample");
  assert.equal((r.to - 44) % 2, 0);
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
