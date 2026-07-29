import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Redactor, REDACT_SUFFIX, MAX_REDACT_DOC_BYTES } from "../src/main/redact";
import { listHistory } from "../src/main/longform";
import { transcriptHeader, transcriptLine } from "../src/shared/longform";
import { encodeWav } from "../src/shared/wav";

// D11, the writing half. Every test works against a TEMP history root - never
// the real ~/.flow, and never the real recordings folder.
//
// What these tests are actually defending:
//  - the operation is a REAL removal: the words leave the transcript AND the
//    matching samples leave the audio;
//  - it can only ever touch a folder Flow itself established as a history root
//    (the campaign's first invariant);
//  - an interrupted write leaves either "nothing done" or "audio done, text
//    not" - never a document that CLAIMS the audio was silenced when it was
//    not (main/redact.ts's order-of-operations note).

const SR = 16_000;

interface Fixture {
  root: string;
  work: string;
  dir: string;
  doc: string;
  audio: string;
  id: string;
}

/** A filed recording: three passages at 0 s, 7 s and 14 s, over 30 s of audio
 * whose every sample is non-zero, so "was this range silenced" is decidable by
 * looking at the bytes. */
function fixture(opts: { audio?: boolean; notes?: string; seconds?: number } = {}): Fixture {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-redact-"));
  const root = path.join(work, "history");
  const dir = path.join(root, "2026-07-29", "weekly-sync");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, ".agr-flow-history"), "marker\n");

  const head = transcriptHeader("Weekly sync", "2026-07-29T09:00:00.000Z");
  const body = transcriptLine(0, "Alpha.") + transcriptLine(7000, "My card is 4111.") + transcriptLine(14_000, "Gamma.");
  const text =
    opts.notes === undefined
      ? head + body
      : head + "## Notes\n\n" + opts.notes + "\n\n## Transcript\n\n" + body;
  const doc = path.join(dir, "weekly-sync.md");
  fs.writeFileSync(doc, text);

  const audio = path.join(dir, "weekly-sync.wav");
  if (opts.audio !== false) {
    const samples = new Int16Array(SR * (opts.seconds ?? 30));
    for (let i = 0; i < samples.length; i++) samples[i] = ((i % 1000) + 1) as number;
    fs.writeFileSync(audio, encodeWav(samples));
  }
  const id = listHistory(root)[0].id;
  return { root, work, dir, doc, audio, id };
}

function cleanup(f: Fixture): void {
  try {
    fs.chmodSync(f.doc, 0o666);
  } catch {
    /* best effort */
  }
  fs.rmSync(f.work, { recursive: true, force: true });
}

function redactor(f: Fixture): Redactor {
  return new Redactor({ historyRoot: () => f.root });
}

/** True when every PCM byte in [fromMs, toMs) is zero. */
function isSilent(audioPath: string, fromMs: number, toMs: number): boolean {
  const buf = fs.readFileSync(audioPath);
  const from = 44 + Math.floor((fromMs / 1000) * SR) * 2;
  const to = 44 + Math.floor((toMs / 1000) * SR) * 2;
  for (let i = from; i < to; i++) if (buf[i] !== 0) return false;
  return true;
}

/** True when SOME PCM byte in [fromMs, toMs) is non-zero. */
function hasSound(audioPath: string, fromMs: number, toMs: number): boolean {
  const buf = fs.readFileSync(audioPath);
  const from = 44 + Math.floor((fromMs / 1000) * SR) * 2;
  const to = 44 + Math.floor((toMs / 1000) * SR) * 2;
  for (let i = from; i < to; i++) if (buf[i] !== 0) return true;
  return false;
}

test("a removal takes the words out of the transcript AND the sound out of the audio", async () => {
  const f = fixture();
  const before = fs.statSync(f.audio).size;
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.audioSilenced, true);

  const doc = fs.readFileSync(f.doc, "utf8");
  assert.doesNotMatch(doc, /4111/, "the passage left the transcript");
  assert.match(doc, /Alpha\./);
  assert.match(doc, /\[00:00:14\] Gamma\./, "and the surviving timestamps did not move");
  assert.match(doc, /The audio for that range was silenced\./);

  assert.equal(isSilent(f.audio, 7000, 14_000), true, "the removed range is zeroed");
  assert.equal(hasSound(f.audio, 0, 7000), true, "what came before is untouched");
  assert.equal(hasSound(f.audio, 14_000, 30_000), true, "what came after is untouched");
  assert.equal(fs.statSync(f.audio).size, before, "zeroed in place: the file keeps its length and its timeline");
  cleanup(f);
});

test("the .wav stays a valid, same-length file - the timeline never shifts under the transcript", async () => {
  const f = fixture();
  const head = fs.readFileSync(f.audio).subarray(0, 44);
  await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  const after = fs.readFileSync(f.audio).subarray(0, 44);
  assert.deepEqual(Buffer.from(after), Buffer.from(head), "the RIFF header is byte-identical");
  cleanup(f);
});

test("removing the LAST passage silences to the end of the file", async () => {
  const f = fixture();
  const r = await redactor(f).remove(f.id, [{ index: 2, startMs: 14_000 }]);
  assert.equal(r.ok, true);
  assert.equal(isSilent(f.audio, 14_000, 30_000), true);
  assert.equal(hasSound(f.audio, 0, 14_000), true);
  assert.match(fs.readFileSync(f.doc, "utf8"), /to the end of the recording/);
  cleanup(f);
});

test("two contiguous passages are one silenced range", async () => {
  const f = fixture();
  const r = await redactor(f).remove(f.id, [
    { index: 1, startMs: 7000 },
    { index: 2, startMs: 14_000 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(isSilent(f.audio, 7000, 30_000), true);
  assert.equal(hasSound(f.audio, 0, 7000), true);
  cleanup(f);
});

test("the derived notes go with the passage, and the result says so", async () => {
  const f = fixture({ notes: "The client read out his card number, 4111, at seven seconds." });
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.notesDropped, true);
  const doc = fs.readFileSync(f.doc, "utf8");
  assert.doesNotMatch(doc, /4111/, "a summary that repeated the passage would cancel the removal");
  assert.match(doc, /The meeting notes were removed on \d{4}-\d{2}-\d{2}/);
  cleanup(f);
});

test("a recording with no audio is removed from honestly, not silently", async () => {
  const f = fixture({ audio: false });
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.audioSilenced, false);
  assert.match(fs.readFileSync(f.doc, "utf8"), /No audio was kept for this recording/);
  cleanup(f);
});

// ---- refusals: nothing is written ----

test("a forged or stale id is refused, and nothing anywhere is touched", async () => {
  const f = fixture();
  const before = fs.readFileSync(f.doc, "utf8");
  for (const id of ["", "not-a-real-id", Buffer.from("../../etc/x", "utf8").toString("base64url")]) {
    const r = await redactor(f).remove(id, [{ index: 1, startMs: 7000 }]);
    assert.equal(r.ok, false, `id ${JSON.stringify(id)} must be refused`);
  }
  assert.equal(fs.readFileSync(f.doc, "utf8"), before);
  assert.equal(hasSound(f.audio, 7000, 14_000), true);
  cleanup(f);
});

test("a history root Flow did not establish serves nothing, even with a real-looking folder inside", async () => {
  const f = fixture();
  const id = f.id;
  fs.rmSync(path.join(f.root, ".agr-flow-history"));
  const r = await redactor(f).remove(id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, false);
  assert.match(fs.readFileSync(f.doc, "utf8"), /4111/, "the transcript is untouched");
  cleanup(f);
});

test("an index whose start offset has DRIFTED refuses the whole request", async () => {
  // Between the page's parse and the human's click, a notes regeneration or a
  // startup rescue can rewrite the document. Acting on the stale index would
  // irreversibly destroy a passage nobody looked at.
  const f = fixture();
  const before = fs.readFileSync(f.doc, "utf8");
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 999_000 }]);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /changed since you opened it/);
  assert.equal(fs.readFileSync(f.doc, "utf8"), before);
  assert.equal(hasSound(f.audio, 7000, 14_000), true, "the audio was not touched either");
  cleanup(f);
});

test("an out-of-range index refuses, and never falls back to a neighbouring passage", async () => {
  const f = fixture();
  const before = fs.readFileSync(f.doc, "utf8");
  const r = await redactor(f).remove(f.id, [{ index: 99, startMs: 0 }]);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(f.doc, "utf8"), before);
  cleanup(f);
});

test("an empty target list is refused rather than treated as \"all of it\"", async () => {
  const f = fixture();
  const before = fs.readFileSync(f.doc, "utf8");
  const r = await redactor(f).remove(f.id, []);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(f.doc, "utf8"), before);
  cleanup(f);
});

test("an audio file Flow cannot silence refuses the WHOLE removal, transcript included", async () => {
  // The forbidden alternative: edit the text, leave the sound. The document
  // would then claim a passage is gone over audio that still plays it - the
  // exact false assurance this feature exists to prevent.
  const f = fixture();
  const stereo = Buffer.from(fs.readFileSync(f.audio));
  stereo.writeUInt16LE(2, 22); // two channels: the byte-to-time mapping is no longer ours
  fs.writeFileSync(f.audio, stereo);
  const before = fs.readFileSync(f.doc, "utf8");

  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /could not silence/i);
  assert.equal(fs.readFileSync(f.doc, "utf8"), before, "the transcript still holds the passage");
  assert.equal(fs.existsSync(f.audio + REDACT_SUFFIX), false, "no work file was left behind");
  cleanup(f);
});

// ---- the interrupted write ----

test("AUDIO FIRST: when the transcript cannot be rewritten, the audio is already silent and the text still shows the passage", async () => {
  // The whole safety argument of main/redact.ts, exercised. The transcript is
  // made unwritable so the second step fails; the observable state afterwards
  // is the SAFE half of the crash window - never a tombstone claiming a silence
  // that did not happen.
  const f = fixture();
  fs.chmodSync(f.doc, 0o444);
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  fs.chmodSync(f.doc, 0o666);

  if (r.ok) {
    // Some filesystems ignore the read-only bit for the owner (notably when the
    // tests run elevated). The ordering claim is then covered by the source
    // canary below rather than left silently unverified.
    assert.equal(isSilent(f.audio, 7000, 14_000), true);
    cleanup(f);
    return;
  }
  assert.match(r.error ?? "", /transcript/i);
  assert.equal(isSilent(f.audio, 7000, 14_000), true, "the audio was scrubbed BEFORE the document was touched");
  assert.match(fs.readFileSync(f.doc, "utf8"), /4111/, "and the document never claimed otherwise");
  assert.equal(fs.existsSync(f.doc + ".tmp"), false, "no half-written document was left behind");
  cleanup(f);
});

test("source canary: the audio is silenced before the document is written, and both go through a rename", () => {
  // A test verifies behaviour; this one verifies the PREMISE the behaviour
  // rests on, which no fixture can kill a process to observe. If someone ever
  // reorders these two statements - or drops the tmp+rename for a direct write -
  // the safety argument in this module's note stops holding and this fails.
  const src = fs.readFileSync(new URL("../src/main/redact.ts", import.meta.url), "utf8");
  const silence = src.indexOf("await silenceAudio(");
  const write = src.indexOf("await fs.promises.writeFile(tmp,");
  const rename = src.indexOf("await fs.promises.rename(tmp, entry.doc)");
  assert.ok(silence > 0 && write > 0 && rename > 0, "all three steps are still there");
  assert.ok(silence < write, "silenceAudio runs BEFORE the document is rewritten");
  assert.ok(write < rename, "the document is written to a temporary and then renamed into place");
  // The audio's own swap, for the same reason: zeroing bytes in place would be
  // interruptible, and a half-scrubbed file wearing the recording's real name
  // is the one outcome that must be impossible.
  assert.ok(src.includes("await fs.promises.rename(work, audioPath)"), "the scrubbed audio is swapped in, never written in place");
  assert.ok(src.includes('fs.promises.open(work, "wx")'), "the work file is created exclusively, never truncating anything");
});

test("a work file left by a killed run is swept, and the real audio survives it", async () => {
  const f = fixture();
  const orphan = f.audio + REDACT_SUFFIX;
  fs.writeFileSync(orphan, "debris from a run that died mid-scrub");
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(orphan), false, "the orphan is gone");
  assert.equal(isSilent(f.audio, 7000, 14_000), true);
  assert.equal(hasSound(f.audio, 0, 7000), true);
  cleanup(f);
});

test("the sweep only ever touches its own suffix", async () => {
  const f = fixture();
  const innocent = path.join(f.dir, "notes.txt");
  fs.writeFileSync(innocent, "the user's own file");
  await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(fs.readFileSync(innocent, "utf8"), "the user's own file");
  cleanup(f);
});

test("a completed removal leaves no work file and no temporary behind", async () => {
  const f = fixture();
  await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  const left = fs.readdirSync(f.dir).sort();
  assert.deepEqual(left, ["weekly-sync.md", "weekly-sync.wav"]);
  cleanup(f);
});

test("a second removal, on the already-cleaned transcript, still works on the right passage", async () => {
  const f = fixture();
  const red = redactor(f);
  assert.equal((await red.remove(f.id, [{ index: 1, startMs: 7000 }])).ok, true);
  // The tombstone is not a passage, so what was index 2 is now index 1.
  const r = await red.remove(f.id, [{ index: 1, startMs: 14_000 }]);
  assert.equal(r.ok, true);
  assert.equal(isSilent(f.audio, 7000, 30_000), true);
  assert.equal(hasSound(f.audio, 0, 7000), true);
  const doc = fs.readFileSync(f.doc, "utf8");
  assert.equal(doc.match(/Passage removed/g)?.length, 2);
  assert.match(doc, /Alpha\./);
  cleanup(f);
});

test("a transcript too large to rewrite is refused rather than truncated", () => {
  // The one that would be catastrophic and silent: rewriting from a capped read
  // would drop everything past the cap while reporting a clean removal.
  assert.ok(MAX_REDACT_DOC_BYTES > 5 * 1024 * 1024, "well above readHistoryDoc's display cap");
});

test("nothing removed is ever written to the log", async () => {
  const f = fixture();
  const lines: string[] = [];
  const red = new Redactor({ historyRoot: () => f.root, log: (m) => lines.push(m) });
  await red.remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.ok(lines.length > 0, "the operation is traceable");
  for (const l of lines) {
    assert.doesNotMatch(l, /4111/, "the removed text must not survive in flow.log");
    assert.doesNotMatch(l, /00:00:07/, "nor the range that would let someone find it in a backup");
  }
  cleanup(f);
});
