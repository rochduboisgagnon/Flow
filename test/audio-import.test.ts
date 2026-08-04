import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImportQueue, readWavHead, type ImportDeps } from "../src/main/audioImport";
import { fakeCaptureStore, type FakeCaptureStore } from "./fixtures/capture-store";
import {
  DECODE_SLICE_MS,
  MAX_IMPORT_BATCH,
  PcmSegmenter,
  buildWavHeader,
  decodedBytes,
  fileExtension,
  importProgress,
  importTitle,
  importedHeader,
  isSupportedAudioFile,
  partialImportNote,
  planDecode,
  readWavInfo,
  safeSourceName,
  sanitizeImportRequest,
} from "../src/shared/audioImport";
import { ENGINE_LINE, SEGMENT_MIN_MS, SEGMENT_TARGET_MS, hms } from "../src/shared/longform";
import { SAMPLE_RATE, pcmFromWav } from "../src/shared/wav";
import type { DecodeCall, DecodeResult } from "../src/main/audioDecode";

// V4 D1/D2/D3: importing an audio file. Two halves, in this order:
//
//  (1) the PURE decisions (src/shared/audioImport.ts): what Flow accepts, how a
//      file is planned for decode, how a stream of PCM is cut into segments, and
//      what the finished document says.
//  (2) the PIPELINE (src/main/audioImport.ts), driven end to end against a fake
//      decode window and a fake speech engine, in a temp folder. NEVER the real
//      ~/.flow: every root is injected.
//
// What half (2) is really here to prove is the invariant that dominates the
// feature (plan §5.1.1): AN IMPORT IS A READ. The fixture is a real file, made
// READ-ONLY, and its bytes, its size, its mtime and its whole parent directory
// are compared before and after EVERY path the pipeline can take - success,
// refusal, unreadable format, decode failure mid-way, cancellation before any
// work, cancellation after real work, no speech at all, an engine that fails on
// every segment, and a quit in the middle.
//
// The two halves of that proof, because neither covers the other (both verified
// on this platform rather than assumed): the read-only attribute makes a WRITE or
// a truncation throw EPERM outright, while a DELETE or a RENAME is not blocked by
// it at all - those are caught by the fingerprint, which reads the file back and
// therefore fails loudly the moment it is gone or renamed.

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** PCM that the energy VAD really reads as speech. A constant tone does NOT
 * work and the reason is worth stating: analyzeSpeech's threshold is
 * max(130, floor * 2.5) where floor is the 20th-percentile frame, so a signal
 * with no dynamics can never rise above its own floor. This alternates 300 ms of
 * tone with 200 ms of near-silence, which puts the floor in the quiet frames and
 * the tone far above it - the same shape real speech has. The quiet stretches are
 * deliberately shorter than the segmenter's 1100 ms pause, so segments close on
 * the hard cut at SEGMENT_TARGET_MS and the test stays deterministic. */
function voicedPcm(ms: number): Int16Array {
  const n = Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE));
  const out = new Int16Array(n);
  const cycle = SAMPLE_RATE / 2; // 500 ms
  const loudFor = Math.round(SAMPLE_RATE * 0.3); // 300 ms of the cycle
  for (let i = 0; i < n; i++) {
    out[i] = i % cycle < loudFor ? Math.round(8000 * Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE)) : 20;
  }
  return out;
}

function silentPcm(ms: number): Int16Array {
  return new Int16Array(Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE)));
}

interface Fingerprint {
  sha: string;
  size: number;
  mtimeMs: number;
  siblings: string;
}

/** Everything about a source file that an import must not change: its content,
 * its size, its modification time, and the contents of the folder it sits in (so
 * a stray .tmp or a "-1" copy next to it fails too). */
function fingerprint(p: string): Fingerprint {
  const st = fs.statSync(p);
  return {
    sha: fs.readFileSync(p).toString("base64"),
    size: st.size,
    mtimeMs: st.mtimeMs,
    siblings: fs.readdirSync(path.dirname(p)).sort().join("|"),
  };
}

/** A source file the pipeline is pointed at: real bytes, and READ-ONLY, so an
 * accidental write/rename/delete throws instead of quietly succeeding. */
function sourceFile(dir: string, name: string, bytes = 8192): string {
  const p = path.join(dir, name);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 7 + 11) % 251;
  fs.writeFileSync(p, buf);
  fs.chmodSync(p, 0o444);
  return p;
}

interface Rig {
  store: FakeCaptureStore;
  /** Les identifiants confies a la file de televersement. */
  uploaded: string[];
  work: string;
  /** Le dossier de transit de l'audio decode. B3e : le SEUL dossier qu'un import
   * touche encore - `history/` et `staging/` sont partis avec le document. */
  pending: string;
  src: string;
  queue: ImportQueue;
  /** Mutated by a test to say the user's voice has the engine. */
  claim: { value: "dictation" | "recording" | null };
  calls: { transcribe: number; concurrent: number; maxConcurrent: number; decodes: DecodeCall[] };
  logs: string[];
}

interface FakeDecodeOpts {
  /** What the probe reports. 0 = the container carries no duration. */
  durationMs?: number;
  /** Audio actually produced. Defaults to durationMs. */
  pcmMs?: number;
  /** Produce silence instead of speech. */
  silent?: boolean;
  /** Stop with this failure once that much audio has been handed over. */
  failAfterMs?: number;
  reason?: "format" | "memory" | "internal";
  /** Called after every slice, with the audio handed over so far - the hook a
   * test uses to press the shortcut in the middle of an import. */
  onSlice?(sentMs: number): void;
  /** PCM handed over per slice. The real window ships ~5 s. */
  sliceMs?: number;
}

/** A stand-in for the hidden decode window. It READS the file the same way the
 * real one does (the range too, when the plan asked for a slice), reports a
 * duration through `accept`, then streams synthetic PCM through onPcm - awaiting
 * it, which is the backpressure the real window applies. */
function fakeDecode(rig: () => Rig, opts: FakeDecodeOpts): ImportDeps["decode"] {
  return async (call: DecodeCall): Promise<DecodeResult> => {
    rig().calls.decodes.push(call);
    // Read-only, exactly like main/audioDecode.ts's stream.
    const fd = fs.openSync(call.source.path, "r");
    try {
      const start = call.source.start ?? 0;
      const end = call.source.end;
      const len = end === undefined ? Math.max(0, fs.fstatSync(fd).size - start) : end - start + 1;
      const buf = Buffer.alloc(Math.min(len, 4096));
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const durationMs = opts.durationMs ?? 0;
    if (call.probe) {
      const verdict = call.accept ? call.accept(durationMs) : { ok: true as const };
      if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail };
    }
    // A decoder that refuses the file outright: no audio ever comes out of it.
    if (opts.failAfterMs !== undefined && opts.failAfterMs <= 0) {
      return { ok: false, reason: opts.reason ?? "format", detail: "the decoder gave up" };
    }
    const total = opts.pcmMs ?? durationMs;
    const sliceMs = opts.sliceMs ?? 5_000;
    let sent = 0;
    while (sent < total) {
      if (call.isCancelled?.()) return { ok: false, reason: "cancelled", detail: "cancelled by the user" };
      const ms = Math.min(sliceMs, total - sent);
      await call.onPcm(opts.silent ? silentPcm(ms) : voicedPcm(ms));
      sent += ms;
      opts.onSlice?.(sent);
      if (opts.failAfterMs !== undefined && sent >= opts.failAfterMs) {
        return { ok: false, reason: opts.reason ?? "format", detail: "the decoder gave up" };
      }
    }
    return {
      ok: true,
      frames: Math.round((total / 1000) * SAMPLE_RATE),
      durationMs,
      channels: 1,
    };
  };
}

function rig(opts: {
  decode?: FakeDecodeOpts;
  decodeFn?: ImportDeps["decode"];
  transcribe?: ImportDeps["transcribe"];
  summarize?: ImportDeps["summarize"];
  summaryModel?: string;
  sourceName?: string;
  sourceBytes?: number;
  budgetBytes?: number;
  keepSource?: boolean;
} = {}): Rig {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-import-"));
  const pending = path.join(work, "pending-audio");
  const drop = path.join(work, "drop");
  fs.mkdirSync(drop, { recursive: true });
  fs.mkdirSync(pending, { recursive: true });
  const src = sourceFile(drop, opts.sourceName ?? "reunion-client_2026-07-12.m4a", opts.sourceBytes ?? 8192);
  const holder: { r?: Rig } = {};
  const calls = { transcribe: 0, concurrent: 0, maxConcurrent: 0, decodes: [] as DecodeCall[] };
  const claim: { value: "dictation" | "recording" | null } = { value: null };
  const logs: string[] = [];
  // B3e : le magasin du compte remplace les deux dossiers.
  const store = fakeCaptureStore();
  const uploaded: string[] = [];
  const queue = new ImportQueue({
    decode: opts.decodeFn ?? fakeDecode(() => holder.r as Rig, opts.decode ?? { durationMs: 30_000 }),
    transcribe:
      opts.transcribe ??
      (async () => {
        calls.transcribe++;
        calls.concurrent++;
        calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
        await new Promise((r) => setTimeout(r, 1));
        calls.concurrent--;
        return { text: `line ${calls.transcribe}` };
      }),
    userEngineClaim: () => claim.value,
    store,
    audioDir: () => pending,
    summaryModel: () => opts.summaryModel ?? "",
    ollamaModels: async () => (opts.summarize ? ["llama"] : null),
    summarize: opts.summarize,
    log: (m) => logs.push(m),
    decodeBudgetBytes: opts.budgetBytes === undefined ? undefined : () => opts.budgetBytes as number,
  });
  const r: Rig = { work, pending, src, queue, claim, calls, logs, store, uploaded };
  holder.r = r;
  built.push(r);
  return r;
}

// The fixtures are read-only, so removing them means clearing that first -
// otherwise every run leaves a temp folder Windows will not delete.
const built: Rig[] = [];
after(() => {
  for (const r of built) {
    try {
      for (const f of fs.readdirSync(path.join(r.work, "drop"))) {
        fs.chmodSync(path.join(r.work, "drop", f), 0o666);
      }
    } catch {
      /* nothing to unlock */
    }
    try {
      fs.rmSync(r.work, { recursive: true, force: true });
    } catch {
      /* a temp folder left behind is not a test failure */
    }
  }
});

async function drain(q: ImportQueue, timeoutMs = 20_000): Promise<void> {
  const stop = Date.now() + timeoutMs;
  while (q.snapshot().busy && Date.now() < stop) await new Promise((r) => setTimeout(r, 5));
  assert.equal(q.snapshot().busy, false, "the queue should have drained");
}

/** La reunion que l'import a produite, relue depuis le compte.
 *
 * B3e : c'etait une lecture de l'archive disque (lister, resoudre l'identifiant,
 * lire le fichier). C'est maintenant une lecture de ligne - et `hasAudio` se lit
 * sur le CHEMIN de l'objet, comme partout ailleurs. Ne rend que les reunions
 * TERMINEES : une ligne encore ouverte est un import en cours, pas un livrable. */
function filedDoc(store: FakeCaptureStore): { id: string; text: string; hasAudio: boolean } | null {
  const rows = [...store.rows.values()].filter((r) => r.endedIso);
  if (rows.length === 0) return null;
  // 2026-08-04 : sur les OCTETS et non sur le chemin d'objet. Un import garde sa
  // copie audio sur la machine, donc aucune ligne ne cite plus d'objet.
  return { id: rows[0].id, text: rows[0].doc, hasAudio: rows[0].audioBytes > 0 };
}

/** Combien de reunions terminees le compte detient. Le remplacant de
 * `listHistory(root).length`. */
function filedCount(store: FakeCaptureStore): number {
  return [...store.rows.values()].filter((r) => r.endedIso).length;
}

/** Files left in the app-owned staging root (the folder a document is built in
 * before it is filed). Anything still here after a drained queue is debris. */
function stagingEntries(staging: string): string[] {
  try {
    return fs.readdirSync(staging);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// (1) the pure decisions
// ---------------------------------------------------------------------------

test("what Flow accepts is decided by the extension, case-insensitively, and video is not audio", () => {
  assert.equal(isSupportedAudioFile("memo.m4a"), true);
  assert.equal(isSupportedAudioFile("MEMO.MP3"), true);
  assert.equal(isSupportedAudioFile("call.WAV"), true);
  assert.equal(isSupportedAudioFile("standup.mp4"), false, "extracting a video's audio track is out of this wave");
  assert.equal(isSupportedAudioFile("notes.txt"), false);
  assert.equal(isSupportedAudioFile("noextension"), false);
  assert.equal(fileExtension(".hidden"), "", "a leading dot is not an extension");
});

test("a file name never forges header lines: control characters and length are cut", () => {
  assert.equal(safeSourceName("a\nb\tc.m4a"), "a b c.m4a");
  assert.equal(safeSourceName("- source file: fake\n- imported: 1999"), "- source file: fake - imported: 1999");
  assert.ok(safeSourceName("x".repeat(400)).length <= 120);
  assert.equal(safeSourceName("   "), "audio file", "never empty");
});

test("the title reads like a title, not like a file name", () => {
  assert.equal(importTitle("reunion-client_2026-07-12.m4a"), "reunion client 2026 07 12");
  assert.equal(importTitle("___.mp3"), "Imported recording", "never empty");
});

test("the header states the source FILE and the import instant, and never a path", () => {
  const head = importedHeader("Weekly sync", {
    fileName: "weekly-sync.m4a",
    importedIso: "2026-07-29T12:00:00.000Z",
    durationMs: 3_600_000,
  });
  assert.match(head, /^# Weekly sync\n/);
  assert.match(head, /^- imported: 2026-07-29T12:00:00\.000Z$/m);
  assert.match(head, /^- source file: weekly-sync\.m4a$/m);
  assert.match(head, /^- source length: 01:00:00$/m);
  assert.ok(head.endsWith(ENGINE_LINE), "spliceNotes anchors on the engine line, so it must close the header");
  assert.ok(!/- recorded:/.test(head), "Flow does not know when the audio was recorded and must not imply it does");
});

test("a partial document says WHICH way it ended, how far it got, and that the source is intact", () => {
  const cancelled = partialImportNote("cancelled", 600_000, 3_600_000);
  assert.match(cancelled, /You cancelled this import\./);
  assert.match(cancelled, /Only the first 00:10:00 of 01:00:00 was transcribed/);
  assert.match(cancelled, /source file was not modified/);
  assert.match(partialImportNote("interrupted", 1000, 2000), /Flow closed before this import finished\./);
  assert.match(partialImportNote("failed", 1000, 2000), /could not read the whole file/);
  assert.match(
    partialImportNote("cancelled", 600_000, 0),
    /Only the first 00:10:00 was transcribed/,
    "an unknown total is never reported as a number",
  );
});

test("planDecode: a two-hour stereo meeting decodes in one pass", () => {
  const plan = planDecode({ fileName: "m.m4a", durationMs: 2 * 3_600_000, channels: 2 });
  assert.equal(plan.mode, "one-shot");
  assert.ok(decodedBytes(2 * 3_600_000, 2) < 1024 * 1024 * 1024);
});

test("planDecode: a file past the budget with nothing to slice is REFUSED, with the numbers in the sentence", () => {
  const plan = planDecode({ fileName: "six-hours.m4a", durationMs: 6 * 3_600_000, channels: 2 });
  assert.equal(plan.mode, "refuse");
  if (plan.mode !== "refuse") return;
  assert.match(plan.message, /six-hours\.m4a/);
  assert.match(plan.message, /6\.0 h/);
  assert.match(plan.message, /Nothing was read from the file/);
});

test("planDecode: an unknown duration is never a licence to decode blind, it is one pass", () => {
  const plan = planDecode({ fileName: "stream.ogg", durationMs: 0 });
  assert.deepEqual(plan, { mode: "one-shot", durationMs: 0 });
});

test("planDecode: a long linear WAV is sliced, and the slices cover every frame exactly once", () => {
  const wav = readWavInfo(header1kHz(1_500_000), 44 + 1_500_000 * 2);
  assert.ok(wav);
  const plan = planDecode({ fileName: "long.wav", durationMs: wav.durationMs, wav, budgetBytes: 1024 });
  assert.equal(plan.mode, "slices");
  if (plan.mode !== "slices") return;
  const framesPerSlice = (DECODE_SLICE_MS / 1000) * wav.sampleRate;
  assert.ok(plan.slices.length > 1, "the point of the fixture is to produce several slices");
  let expected = 0;
  for (const s of plan.slices) {
    assert.equal(s.startFrame, expected, "slices are contiguous: no frame is skipped or read twice");
    assert.ok(s.frames <= framesPerSlice);
    expected += s.frames;
  }
  assert.equal(expected, wav.frames, "the slices together are the whole file");
});

test("a WAV whose declared data size overruns the real file is clamped to the bytes that exist", () => {
  const head = header1kHz(1_000_000); // claims 1 000 000 frames
  const info = readWavInfo(head, 44 + 2000); // the file only holds 1000 frames
  assert.ok(info);
  assert.equal(info.frames, 1000, "a truncated recording must not make us read past the end");
  assert.equal(info.sliceable, true);
  assert.equal(readWavInfo(new Uint8Array(64), 64), null, "not a RIFF/WAVE at all");
});

test("a rebuilt slice header is a valid WAV of the same format", () => {
  const info = readWavInfo(header1kHz(1000), 44 + 2000);
  assert.ok(info);
  const built = buildWavHeader(info, 400);
  const reparsed = readWavInfo(built, 44 + 400);
  assert.ok(reparsed);
  assert.equal(reparsed.sampleRate, info.sampleRate);
  assert.equal(reparsed.channels, info.channels);
  assert.equal(reparsed.bitsPerSample, info.bitsPerSample);
  assert.equal(reparsed.frames, 200);
});

test("PcmSegmenter cuts where the long recorder cuts, and the offsets cover the audio exactly once", () => {
  const seg = new PcmSegmenter();
  const out: Array<{ pcm: Int16Array; offsetMs: number }> = [];
  for (let i = 0; i < 6; i++) out.push(...seg.push(voicedPcm(5000)));
  const tail = seg.flush();
  if (tail) out.push(tail);
  assert.ok(out.length >= 3, "30 s of speech with no long pause closes several segments");
  let frames = 0;
  for (const s of out) {
    assert.equal(Math.round((frames / SAMPLE_RATE) * 1000), s.offsetMs, "offsets follow the audio consumed so far");
    frames += s.pcm.length;
  }
  assert.equal(frames, 6 * 5 * SAMPLE_RATE, "every sample handed in comes back out exactly once");
  // A hard cut is searched in the TAIL past the minimum length, so the closed
  // segment is never shorter than the minimum and never longer than the buffer it
  // was cut out of - which is what keeps a sub-250 ms fragment (that the pump
  // drops) from ever being produced.
  const first = (out[0].pcm.length / SAMPLE_RATE) * 1000;
  assert.ok(first >= SEGMENT_MIN_MS, `a closed segment is never under the minimum (${first} ms)`);
  assert.ok(first <= 10_000, `and never longer than the audio it was cut from (${first} ms)`);
  assert.ok(first > SEGMENT_TARGET_MS - SEGMENT_MIN_MS, `the cut is looked for past the minimum (${first} ms)`);
});

test("PcmSegmenter closes on a natural pause, before the target length", () => {
  const seg = new PcmSegmenter();
  const speech = voicedPcm(3000);
  const pause = silentPcm(1500);
  const joined = new Int16Array(speech.length + pause.length);
  joined.set(speech);
  joined.set(pause, speech.length);
  const out = seg.push(joined);
  assert.equal(out.length, 1, "a 1.5 s silence closes the segment well before 7 s");
});

test("sanitizeImportRequest: duplicates dropped, batch capped, notes on by default, keepAudio off", () => {
  const r = sanitizeImportRequest({ paths: ["a.m4a", "a.m4a", " ", 7, "b.mp3"] });
  assert.deepEqual(r.paths, ["a.m4a", "b.mp3"]);
  assert.equal(r.notes, true, "notes are the point of an import: opt OUT, not in");
  assert.equal(r.keepAudio, false, "the user's own file is still where it was; a copy is opt-in");
  const many = sanitizeImportRequest({ paths: Array.from({ length: 50 }, (_, i) => `f${i}.m4a`) });
  assert.equal(many.paths.length, MAX_IMPORT_BATCH);
  assert.deepEqual(sanitizeImportRequest(null).paths, []);
});

test("importProgress never runs ahead of the work: the read is a fraction, done is 1", () => {
  assert.equal(importProgress("queued", 0, 60_000), 0);
  assert.ok(importProgress("reading", 60_000, 60_000) <= 0.15, "a finished READ is not a finished import");
  const a = importProgress("transcribing", 10_000, 60_000);
  const b = importProgress("transcribing", 40_000, 60_000);
  assert.ok(a > 0.15 && b > a && b < 1);
  assert.equal(importProgress("done", 0, 60_000), 1);
  assert.equal(importProgress("transcribing", 10_000, 0), 0, "no denominator means no claim");
});

/** A 1 kHz mono 16-bit WAV header claiming `frames` frames. The odd sample rate
 * is what lets a 1 MB fixture produce SEVERAL 10-minute decode slices instead of
 * requiring a real 25-minute recording on disk. */
function header1kHz(frames: number): Uint8Array {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + frames * 2, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(1000, 24); // 1 kHz
  head.writeUInt32LE(2000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(frames * 2, 40);
  return new Uint8Array(head);
}

// ---------------------------------------------------------------------------
// (2) the pipeline
// ---------------------------------------------------------------------------

test("an import produces the SAME document shape as a live capture, filed in the archive", async () => {
  const r = rig({
    decode: { durationMs: 30_000 },
    summarize: async () => "## Points cles\n\n- something was decided",
    summaryModel: "llama",
  });
  const before = fingerprint(r.src);
  const started = r.queue.start({ paths: [r.src] });
  assert.equal(started.ok, true);
  assert.equal(started.accepted.length, 1);
  await drain(r.queue);

  const doc = filedDoc(r.store);
  assert.ok(doc, "the finished document must be in the archive");
  assert.match(doc.text, /^# reunion client 2026 07 12$/m);
  assert.match(doc.text, /^- source file: reunion-client_2026-07-12\.m4a$/m);
  assert.match(doc.text, /^- imported: \d{4}-\d{2}-\d{2}T/m);
  assert.match(doc.text, /^- source length: 00:00:30$/m);
  assert.match(doc.text, /## Notes/);
  assert.match(doc.text, /Points cles/);
  assert.match(doc.text, /## Transcript/);
  assert.match(doc.text, /^\[00:00:00\] line 1$/m, "a timestamped transcript, exactly like a capture's");
  assert.ok(!/Partial import/.test(doc.text), "a complete import must not claim to be partial");

  const row = r.queue.snapshot().items[0];
  assert.equal(row.phase, "done");
  assert.equal(row.progress, 1);
  assert.equal(row.partial, undefined);
  assert.equal(row.historyId, doc.id, "the row points at the entry the page can open");
  assert.deepEqual(stagingEntries(r.pending), [], "nothing is left in staging once the document is filed");
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("neither the document nor the queue snapshot ever carries the source PATH", async () => {
  const r = rig({ decode: { durationMs: 12_000 } });
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc);
  assert.ok(!doc.text.includes(r.src), "the path is not stable; only the file NAME belongs in the document");
  assert.ok(!doc.text.includes(path.dirname(r.src)));
  const json = JSON.stringify(r.queue.snapshot());
  assert.ok(!json.includes(r.src.replace(/\\/g, "\\\\")) && !json.includes(path.dirname(r.src).replace(/\\/g, "\\\\")));
});

test("keepAudio off keeps no audio; keepAudio on keeps a 16 kHz mono wav of the right length", async () => {
  const off = rig({ decode: { durationMs: 12_000 } });
  off.queue.start({ paths: [off.src] });
  await drain(off.queue);
  assert.equal(filedDoc(off.store)?.hasAudio, false, "the user's own file is the archive of the audio");

  const on = rig({ decode: { durationMs: 12_000 } });
  const before = fingerprint(on.src);
  on.queue.start({ paths: [on.src], keepAudio: true });
  await drain(on.queue);
  const doc = filedDoc(on.store);
  assert.equal(doc?.hasAudio, true);
  // 2026-08-04 : le .wav decode RESTE dans le dossier audio, sous l'identifiant de
  // sa ligne. Il n'est confie a personne : il est deja a sa place definitive.
  assert.equal(on.uploaded.length, 0, "rien n'est confie a une file de televersement : il n'y en a plus");
  const pcm = pcmFromWav(fs.readFileSync(path.join(on.pending, doc!.id + ".wav")));
  assert.equal(pcm.length, 12 * SAMPLE_RATE, "the kept wav holds exactly the decoded audio, and parses as 16 kHz mono");
  assert.deepEqual(fingerprint(on.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("cancelled before any transcription: nothing is filed, nothing is left, nothing is claimed", async () => {
  let id = "";
  const r = rig({
    decode: {
      durationMs: 60_000,
      onSlice: () => {
        if (id) r.queue.cancel(id);
      },
    },
  });
  const before = fingerprint(r.src);
  id = r.queue.start({ paths: [r.src] }).accepted[0];
  await drain(r.queue);
  assert.equal(filedCount(r.store), 0, "a cancellation with no work behind it files nothing");
  assert.deepEqual(stagingEntries(r.pending), [], "and leaves nothing behind either");
  const row = r.queue.snapshot().items[0];
  assert.equal(row.phase, "cancelled");
  assert.equal(row.partial, undefined);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("cancelled after real work: ONE document, filed, and it SAYS it is partial and how far it got", async () => {
  let id = "";
  const r = rig({
    // 60 s of audio, cancelled once 20 s have been handed over.
    decode: {
      durationMs: 60_000,
      onSlice: (sent) => {
        if (sent >= 20_000 && id) r.queue.cancel(id);
      },
    },
    summarize: async () => "notes that must NOT be written",
    summaryModel: "llama",
  });
  const before = fingerprint(r.src);
  id = r.queue.start({ paths: [r.src] }).accepted[0];
  await drain(r.queue);

  const doc = filedDoc(r.store);
  assert.ok(doc, "work that exists is kept");
  const note = doc.text.indexOf("[Partial import:");
  assert.ok(note > 0, "the document says it is partial");
  assert.ok(note < doc.text.indexOf("[00:00:00]"), "and says it ABOVE the transcript, not at the bottom");
  assert.match(doc.text, /You cancelled this import\./);
  assert.match(doc.text, /Only the first 00:00:\d\d of 00:01:00 was transcribed/);
  assert.ok(!/## Notes/.test(doc.text), "no notes for half a meeting: they would read as notes on the whole");
  const row = r.queue.snapshot().items[0];
  assert.equal(row.phase, "cancelled");
  assert.equal(row.partial, true, "the page must be able to say it too");
  assert.ok(row.progress > 0 && row.progress < 1, "the progress freezes at what was really covered");
  assert.deepEqual(stagingEntries(r.pending), []);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("a decode that breaks half way keeps the work and labels it, and never touches the source", async () => {
  const r = rig({ decode: { durationMs: 60_000, failAfterMs: 20_000, reason: "format" } });
  const before = fingerprint(r.src);
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc);
  assert.match(doc.text, /Flow could not read the whole file\./);
  const row = r.queue.snapshot().items[0];
  assert.equal(row.phase, "failed");
  assert.equal(row.partial, true);
  assert.match(row.error ?? "", /reunion-client_2026-07-12\.m4a/);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("a file too long to decode is refused before anything is written, and the file is only read", async () => {
  // The probe answers six hours: planDecode refuses, the decode never allocates.
  const r = rig({ decode: { durationMs: 6 * 3_600_000, pcmMs: 0 } });
  const before = fingerprint(r.src);
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  assert.equal(filedCount(r.store), 0);
  assert.deepEqual(stagingEntries(r.pending), []);
  const row = r.queue.snapshot().items[0];
  assert.equal(row.phase, "failed");
  // planDecode's own sentence, word for word: it names the length, the limit and
  // the two ways out, and nothing wraps it in a second sentence.
  assert.match(row.error ?? "", /6\.0 h, which is more than Flow can decode in one pass/);
  assert.match(row.error ?? "", /Nothing was read from the file/);
  assert.match(row.error ?? "", /convert it to WAV/);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("an undecodable format is refused in words a human can act on, never an exception's text", async () => {
  const r = rig({ decode: { durationMs: 10_000, pcmMs: 0, failAfterMs: 0 } });
  const before = fingerprint(r.src);
  // A format failure with no audio at all: onPcm is never called.
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  const row = r.queue.snapshot().items[0];
  assert.equal(row.phase, "failed");
  assert.match(row.error ?? "", /could not be read/);
  assert.match(row.error ?? "", /M4A/, "the sentence names the format the user chose");
  assert.equal(filedCount(r.store), 0);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("what is refused up front: the wrong extension, a folder, a file that is not there", async () => {
  const r = rig({ sourceName: "notes.txt" });
  const before = fingerprint(r.src);
  const res = r.queue.start({
    paths: [r.src, path.dirname(r.src), path.join(r.work, "gone.m4a")],
  });
  assert.equal(res.ok, false);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected.length, 3);
  assert.match(res.rejected[0].reason, /could not be read/);
  assert.match(res.rejected[1].reason, /not a file/);
  assert.match(res.rejected[2].reason, /not there any more/);
  assert.equal(r.queue.snapshot().busy, false, "a refused batch never becomes a running import");
  assert.equal(filedCount(r.store), 0);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("a file with no speech in it files nothing, and says which of the two silences it was", async () => {
  const quiet = rig({ decode: { durationMs: 20_000, silent: true } });
  const before = fingerprint(quiet.src);
  quiet.queue.start({ paths: [quiet.src] });
  await drain(quiet.queue);
  assert.equal(filedCount(quiet.store), 0, "an empty document in the archive is worse than a refusal");
  assert.deepEqual(stagingEntries(quiet.pending), []);
  assert.match(quiet.queue.snapshot().items[0].error ?? "", /found no speech/);
  assert.deepEqual(fingerprint(quiet.src), before, "THE SOURCE FILE IS UNTOUCHED");

  const broken = rig({
    decode: { durationMs: 20_000 },
    transcribe: async () => {
      throw new Error("whisper is down");
    },
  });
  broken.queue.start({ paths: [broken.src] });
  await drain(broken.queue);
  assert.equal(filedCount(broken.store), 0);
  assert.match(
    broken.queue.snapshot().items[0].error ?? "",
    /failed on every segment/,
    "an engine that broke and a file with nothing in it are different news",
  );
});

test("one failed segment is an honest gap, and the import goes on", async () => {
  let n = 0;
  const r = rig({
    decode: { durationMs: 30_000 },
    transcribe: async () => {
      n++;
      if (n === 2) throw new Error("one bad decode");
      return { text: `line ${n}` };
    },
  });
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc);
  assert.match(doc.text, /could not be transcribed/);
  assert.match(doc.text, /^\[00:00:00\] line 1$/m);
  assert.equal(r.queue.snapshot().items[0].phase, "done");
});

test("THE DICTATION WINS: an import stands aside while the user's voice owns the engine, and says so", async () => {
  const r = rig({ decode: { durationMs: 20_000 } });
  r.claim.value = "dictation";
  r.queue.start({ paths: [r.src] });
  // Long enough for many poll intervals: the import must not sneak a segment in.
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(r.calls.transcribe, 0, "not one segment reached the engine while a dictation was in flight");
  const waiting = r.queue.snapshot().items[0];
  assert.equal(waiting.waitingFor, "dictation", "and the page can say WHY nothing is moving");
  r.claim.value = "recording";
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(r.calls.transcribe, 0, "a live recording outranks an import too");
  assert.equal(r.queue.snapshot().items[0].waitingFor, "recording");
  r.claim.value = null;
  await drain(r.queue);
  assert.ok(r.calls.transcribe > 0, "and it finishes on its own once the engine is free");
  assert.equal(r.queue.snapshot().items[0].phase, "done");
  assert.equal(r.queue.snapshot().items[0].waitingFor, undefined);
});

test("a cancellation is honoured even while the import is standing aside for a dictation", async () => {
  const r = rig({ decode: { durationMs: 60_000 } });
  const id = r.queue.start({ paths: [r.src] }).accepted[0];
  r.claim.value = "dictation";
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.queue.cancel(id).ok, true);
  // The claim is NEVER released: a user who gives up mid-meeting must not have
  // to wait for the meeting to end before the row settles.
  await drain(r.queue, 5_000);
  assert.equal(r.queue.snapshot().items[0].phase, "cancelled");
});

test("one transcription at a time, and the files run in the order they were dropped", async () => {
  const r = rig({ decode: { durationMs: 12_000 } });
  const second = sourceFile(path.dirname(r.src), "standup.mp3");
  const before = [fingerprint(r.src), fingerprint(second)];
  const res = r.queue.start({ paths: [r.src, second] });
  assert.deepEqual(res.accepted.length, 2);
  assert.equal(r.queue.snapshot().items.map((i) => i.fileName).join(","), "reunion-client_2026-07-12.m4a,standup.mp3");
  await drain(r.queue);
  assert.equal(r.calls.maxConcurrent, 1, "whisper is one bottleneck: never two segments at once");
  assert.equal(filedCount(r.store), 2, "both documents are filed");
  assert.deepEqual([fingerprint(r.src), fingerprint(second)], before, "BOTH SOURCE FILES ARE UNTOUCHED");
});

test("the same file cannot be queued twice while it is still pending", async () => {
  const r = rig({ decode: { durationMs: 20_000 } });
  r.claim.value = "dictation"; // hold it in the queue so the second attempt overlaps
  r.queue.start({ paths: [r.src] });
  const again = r.queue.start({ paths: [r.src] });
  assert.equal(again.ok, false);
  assert.match(again.rejected[0].reason, /already in the queue/);
  r.claim.value = null;
  await drain(r.queue);
});

test("quitting mid-import files the work with the note that says the app closed", async () => {
  const r = rig({ decode: { durationMs: 60_000, onSlice: (sent) => { if (sent >= 20_000) r.queue.rescueOnQuit(); } } });
  const before = fingerprint(r.src);
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc, "a quit must not bury the work in a folder nothing lists");
  assert.match(doc.text, /Flow closed before this import finished\./);
  assert.equal(r.queue.snapshot().items[0].partial, true);
  assert.deepEqual(stagingEntries(r.pending), []);
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("quitting before any transcription leaves nothing at all", async () => {
  const r = rig({ decode: { durationMs: 60_000, onSlice: () => r.queue.rescueOnQuit() } });
  const before = fingerprint(r.src);
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  assert.equal(filedCount(r.store), 0);
  assert.deepEqual(stagingEntries(r.pending), [], "no orphan folder for the next boot to puzzle over");
  assert.deepEqual(fingerprint(r.src), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("a WAV past the budget is decoded in slices, read-only ranges, and ONE continuous transcript", async () => {
  const r = rig({ budgetBytes: 1024, decode: { durationMs: 0, pcmMs: 9_000, sliceMs: 9_000 } });
  // A real (if odd) 1 kHz WAV: three 10-minute slices out of a 1.2 MB file.
  const frames = 1_500_000;
  const wavPath = path.join(path.dirname(r.src), "long-take.wav");
  fs.writeFileSync(wavPath, Buffer.concat([Buffer.from(header1kHz(frames)), Buffer.alloc(frames * 2, 3)]));
  fs.chmodSync(wavPath, 0o444);
  const before = fingerprint(wavPath);

  const info = readWavHead(wavPath, fs.statSync(wavPath).size);
  assert.ok(info?.sliceable, "the fixture has to be a WAV Flow can cut");

  r.queue.start({ paths: [wavPath] });
  await drain(r.queue);

  assert.ok(r.calls.decodes.length >= 3, `the file was decoded in slices (${r.calls.decodes.length} calls)`);
  let prevStart = -1;
  for (const call of r.calls.decodes) {
    assert.ok(call.source.prefix && call.source.prefix.length === 44, "each slice carries a rebuilt WAV header");
    assert.ok(typeof call.source.start === "number" && (call.source.start as number) > prevStart, "ranges advance");
    prevStart = call.source.start as number;
  }
  const doc = filedDoc(r.store);
  assert.ok(doc);
  const stamps = [...doc.text.matchAll(/^\[(\d\d):(\d\d):(\d\d)\]/gm)].map(
    (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
  );
  assert.ok(stamps.length >= 3);
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] > stamps[i - 1], "the timestamps never restart at a slice boundary");
  }
  assert.deepEqual(fingerprint(wavPath), before, "THE SOURCE FILE IS UNTOUCHED");
});

test("a container that carries no duration gets the MEASURED length in its header, not 00:00:00", async () => {
  const r = rig({ sourceName: "stream.ogg", decode: { durationMs: 0, pcmMs: 21_000 } });
  r.queue.start({ paths: [r.src] });
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc);
  assert.match(doc.text, new RegExp(`^- source length: ${hms(21_000)}$`, "m"));
  assert.equal(r.queue.snapshot().items[0].durationMs, 21_000);
});

test("a partial import of a file with no stated duration says the length is unknown, not a number", async () => {
  let id = "";
  const r = rig({
    sourceName: "stream.ogg",
    decode: {
      durationMs: 0,
      pcmMs: 60_000,
      onSlice: (sent) => {
        if (sent >= 20_000 && id) r.queue.cancel(id);
      },
    },
  });
  id = r.queue.start({ paths: [r.src] }).accepted[0];
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc);
  assert.match(doc.text, /^- source length: unknown$/m, "the part is never reported as the whole");
});

test("dismissing a finished row removes it from the queue and touches nothing on disk", async () => {
  const r = rig({ decode: { durationMs: 12_000 } });
  const id = r.queue.start({ paths: [r.src] }).accepted[0];
  await drain(r.queue);
  const doc = filedDoc(r.store);
  assert.ok(doc);
  assert.equal(r.queue.cancel(id).ok, true, "the button must do something");
  assert.equal(r.queue.snapshot().items.length, 0, "and what it does is visible");
  assert.equal(filedCount(r.store), 1, "dismissing a row is bookkeeping, never a deletion");
  assert.equal(r.queue.cancel(id).ok, false, "an unknown id is refused, not invented");
});

test("the queue reports itself busy while work is pending, and idle when it is not", async () => {
  const r = rig({ decode: { durationMs: 12_000 } });
  assert.equal(r.queue.isBusy, false);
  r.claim.value = "dictation";
  r.queue.start({ paths: [r.src] });
  assert.equal(r.queue.isBusy, true, "an import held back by a dictation is still work in flight");
  r.claim.value = null;
  await drain(r.queue);
  assert.equal(r.queue.isBusy, false);
});

// ---------------------------------------------------------------------------
// structural guards: the two rules a future edit could break silently
// ---------------------------------------------------------------------------

const PIPELINE_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "audioImport.ts"), "utf8");
const DECODE_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "audioDecode.ts"), "utf8");

test("the import never feeds the dictation statistics (plan §5.1.2)", () => {
  assert.ok(
    !/from ["']\.\/stats["']/.test(PIPELINE_SRC),
    "imported audio is other people's voices: counting it as dictated words would corrupt both the words-per-minute reading and the streak",
  );
  assert.ok(!/\bstats\.\w+\(/.test(PIPELINE_SRC), "no call into the counter store, on any path");
});

test("every file handle the import opens is read-only, except its OWN copy of the audio", () => {
  const opens = [...PIPELINE_SRC.matchAll(/fs\.openSync\(\s*([A-Za-z0-9_.]+)\s*,\s*"([^"]+)"/g)];
  assert.ok(opens.length > 0, "the WAV head read is the one place this module opens the source");
  for (const [, arg, flag] of opens) {
    if (flag === "r") continue;
    assert.equal(
      arg,
      "job.audioPath",
      `only Flow's own copy of the decoded audio may be opened for writing (found "${flag}" on ${arg})`,
    );
  }
  // The one other reader of the source is the decode window's stream.
  assert.match(
    DECODE_SRC,
    /createReadStream\([\s\S]*?flags: "r"/,
    "the decode window streams the source with flags \"r\" and nothing else",
  );
  for (const bad of ["renameSync", "unlinkSync", "rmSync", "truncateSync", "copyFileSync", "appendFile"]) {
    assert.ok(!DECODE_SRC.includes(bad), `main/audioDecode.ts must hold no ${bad}: it only ever READS`);
  }
});

test("B3e: la SEULE suppression du pipeline est bornee au dossier de transit qu'il remplit lui-meme", () => {
  // La garde n'a pas change de nature en changeant de dossier : elle existe pour
  // que « un import qui n'a rien produit ne laisse rien » soit une suppression qui
  // ne peut JAMAIS atteindre un fichier de l'utilisateur. Le fichier source, lui,
  // n'est meme pas dans le perimetre.
  const rm = /private discard\(job: Job\): void \{[\s\S]*?\n {2}\}/.exec(PIPELINE_SRC);
  assert.ok(rm, "discard() is the one place this module removes anything");
  assert.match(rm[0], /this\.underPendingAudio\(audio\)/, "et elle refuse tout chemin hors du dossier de transit");
  const all = [...PIPELINE_SRC.matchAll(/fs\.(rmSync|rmdirSync|unlinkSync|renameSync)\(/g)].map((m) => m[1]);
  assert.deepEqual(
    all.sort(),
    ["rmSync"],
    "une seule : celle de discard(). Les deux renommages atomiques de document sont partis avec le fichier - le document est un tampon en memoire, personne ne peut le surprendre a moitie ecrit",
  );
});
