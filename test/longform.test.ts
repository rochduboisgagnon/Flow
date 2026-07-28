import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  endsInPause,
  findCutPoint,
  hms,
  transcriptLine,
  transcriptHeader,
  recordingBaseName,
  chunkTranscript,
  pushRecent,
  summaryPrompt,
  spliceNotes,
  RECENT_MAX,
  type RecentEntry,
} from "../src/shared/longform";
import { LongRecorder, RECENT_STATE_CACHE_MS } from "../src/main/longform";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

const SR = 16_000;

function tone(ms: number, amp = 6000): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amp);
  return out;
}
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}
// Speech-LIKE audio for the recorder tests: the adaptive VAD (rightly) reads a
// constant tone as background noise, so alternate loud bursts with real gaps
// (a third of the time quiet, like syllables and breaths).
function speechy(ms: number): Int16Array {
  const parts: Int16Array[] = [];
  let left = ms;
  while (left > 0) {
    const burst = Math.min(400, left);
    parts.push(tone(burst, 7000));
    left -= burst;
    if (left > 0) {
      const gap = Math.min(200, left);
      parts.push(silence(gap));
      left -= gap;
    }
  }
  return concat(...parts);
}
function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("endsInPause: true after 1.2 s of trailing silence, false mid-speech", () => {
  assert.equal(endsInPause(concat(tone(3000), silence(1300))), true);
  assert.equal(endsInPause(concat(tone(3000), silence(300))), false);
  assert.equal(endsInPause(tone(4000)), false);
});

test("findCutPoint lands inside the quiet stretch", () => {
  const pcm = concat(tone(10_000), silence(1000), tone(4000));
  const cut = findCutPoint(pcm, 8_000);
  // The silence spans samples [160000, 176000): the cut must fall there.
  assert.ok(cut > 10 * SR && cut < 11.05 * SR, `cut=${cut}`);
});

test("hms and transcript line formatting", () => {
  assert.equal(hms(0), "00:00:00");
  assert.equal(hms(83_000), "00:01:23");
  assert.equal(hms(3_601_000), "01:00:01");
  assert.equal(transcriptLine(83_000, "Bonjour."), "[00:01:23] Bonjour.\n\n");
});

test("recording base name: slug + stamp, accents stripped", () => {
  const d = new Date(2026, 6, 6, 14, 5);
  assert.equal(recordingBaseName("Réunion Équipe #3", d), "reunion-equipe-3-2026-07-06-1405");
  assert.equal(recordingBaseName("", d), "recording-2026-07-06-1405");
});

test("chunkTranscript splits on paragraph boundaries and loses nothing", () => {
  const para = "phrase de test assez longue pour compter.\n\n";
  const transcript = para.repeat(1200); // ~52k chars
  const parts = chunkTranscript(transcript, 24_000);
  assert.ok(parts.length >= 2);
  assert.equal(parts.join(""), transcript);
  for (const p of parts.slice(0, -1)) assert.ok(p.length <= 24_000 + para.length);
});

test("pushRecent caps at RECENT_MAX, newest first", () => {
  let list: RecentEntry[] = [];
  for (let i = 0; i < RECENT_MAX + 3; i++) {
    list = pushRecent(list, {
      title: "t" + i,
      startedIso: "",
      dir: "",
      docPath: "",
      audioPath: "",
      durationMs: 0,
    });
  }
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].title, "t" + (RECENT_MAX + 2));
});

test("summaryPrompt carries the transcript, clean section headings and marks", () => {
  const p = summaryPrompt("TRANSCRIPT BODY", [83_000]);
  assert.ok(p.includes("TRANSCRIPT BODY"));
  assert.ok(p.includes("## Decisions"));
  assert.ok(p.includes("00:01:23"));
  // The lead summary must NOT carry its own heading (it would double the
  // "## Summary" wrapper finalize adds), and no "(bullets)"/"(one paragraph)"
  // instruction parentheticals must leak into the section titles.
  assert.ok(!p.includes("## Resume"), "no ## Resume heading to stack under ## Summary");
  assert.ok(!p.includes("(bullets)"));
  assert.ok(!p.includes("(one paragraph)"));
});

test("LongRecorder end to end with a mock engine (one document, audio kept)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-long-"));
  const recent = path.join(work, "recent.json");
  const seen: number[] = [];
  const mockSidecar = {
    transcribe: (wav: Uint8Array) => {
      seen.push(wav.length);
      return Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 });
    },
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => mockSidecar,
    recentPathOverride: recent,
    // C10: start() now runs a retention purge; keep it off the real ~/.agr-flow.
    historyRootOverride: path.join(work, "history"),
  });

  const started = rec.start({ dir: work, title: "Test Meeting", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  assert.ok(started.audioPath && started.audioPath.endsWith(".wav"), "start must hand out the audio path");
  assert.equal(rec.isBusy, true);

  // 10 s of speech then a real pause: the segment closes naturally.
  rec.onChunk(speechy(5000));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.mark();
  rec.gap(7.4);
  // More speech, stopped mid-flow: stop() closes the remainder.
  rec.onChunk(speechy(4000));
  const stopped = rec.stop();
  assert.equal(stopped.ok, true);
  assert.ok(stopped.docPath.endsWith(".md"), "stop returns the one document path");

  // finalizing drains in the background; poll it out.
  for (let i = 0; i < 100 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false, "finalize must complete");

  const st = rec.state();
  assert.ok(st.segments >= 2, `segments=${st.segments}`);
  assert.equal(st.pending, 0);
  const transcript = fs.readFileSync(stopped.docPath, "utf8");
  assert.ok(transcript.includes("# Test Meeting"));
  assert.ok(transcript.includes("[00:00:00] Bonjour tout le monde."));
  assert.ok(transcript.includes("Moment marked at"));
  assert.ok(transcript.includes("Recording paused ~7s"), "the gap must be marked honestly");
  assert.ok(seen.length >= 2, "the mock engine transcribed the segments");

  const recentList = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(recentList.length, 1);
  assert.equal(recentList[0].title, "Test Meeting");
  assert.ok(String(recentList[0].audioPath).endsWith(".wav"), "recent entries carry the audio path");
  fs.rmSync(work, { recursive: true, force: true });
});

test("LongRecorder refuses a missing folder and double starts", () => {
  const rec = new LongRecorder({
    getSidecar: () => null,
    recentPathOverride: path.join(os.tmpdir(), "agrflow-long-none.json"),
    // C10: start() now runs a retention purge; keep it off the real ~/.agr-flow.
    historyRootOverride: path.join(os.tmpdir(), "agrflow-long-none-history"),
  });
  const bad = rec.start({ dir: path.join(os.tmpdir(), "does-not-exist-agrflow") });
  assert.equal(bad.ok, false);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-long2-"));
  assert.equal(rec.start({ dir: work }).ok, true);
  assert.equal(rec.start({ dir: work }).ok, false, "second start must refuse");
  rec.stop();
  fs.rmSync(work, { recursive: true, force: true });
});

test("v6 c8: only the last recording is remembered (RECENT_MAX=1)", () => {
  assert.equal(RECENT_MAX, 1);
  let list: RecentEntry[] = [];
  for (const t of ["a", "b", "c"]) {
    list = pushRecent(list, { title: t, startedIso: "", dir: "", docPath: "", audioPath: "", durationMs: 0 });
  }
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "c", "the last capture replaces the previous one");
});

// U4a piege 1: state().recent is a synchronous read (existingRecent(loadRecent())).
// GET /long/state and the UI_LONG_STATE IPC channel now poll state() at up to
// 1 Hz (main/uiBridge.ts, main/api.ts), so LongRecorder caches `recent` for
// RECENT_STATE_CACHE_MS instead of re-reading recent.json (and re-stat'ing its
// entry's docPath) on every single call.
test("U4a: state().recent is cached briefly, not re-read from disk on every call", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-recent-cache-"));
  const recent = path.join(work, "recent.json");
  const docA = path.join(work, "a.md");
  const docB = path.join(work, "b.md");
  fs.writeFileSync(docA, "# A");
  fs.writeFileSync(docB, "# B");
  const entryA: RecentEntry = { title: "A", startedIso: "", dir: work, docPath: docA, audioPath: "", durationMs: 1 };
  const entryB: RecentEntry = { title: "B", startedIso: "", dir: work, docPath: docB, audioPath: "", durationMs: 2 };
  fs.writeFileSync(recent, JSON.stringify([entryA]));

  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent });
  const first = rec.state().recent;
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "A");

  // Mutate recent.json directly on disk (as another process/save() would). A
  // call still inside the cache window must serve the STALE cached value, not
  // re-read the file.
  fs.writeFileSync(recent, JSON.stringify([entryB]));
  const second = rec.state().recent;
  assert.equal(second[0].title, "A", "state() must serve the cached list within the cache window, not re-read on every call");

  // Past the window the cache refreshes and picks up the new content - it
  // must never freeze forever.
  await new Promise((r) => setTimeout(r, RECENT_STATE_CACHE_MS + 200));
  const third = rec.state().recent;
  assert.equal(third[0].title, "B", "the cache must still refresh once its window has elapsed");

  fs.rmSync(work, { recursive: true, force: true });
});

test("v6 c7 + C10: no dir -> stage, finalize files it into history, then save() files it out (nothing deleted)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-stage-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const recent = path.join(work, "recent.json");
  const mockSidecar = {
    transcribe: () => Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 }),
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => mockSidecar,
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });
  // No dir given: the engine records into staging (v6 c7).
  const started = rec.start({ title: "Client kickoff", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  assert.ok(started.docPath!.startsWith(staging), "the document must live under the staging root while recording");
  rec.onChunk(speechy(5000));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  const stopped = rec.stop();
  // The .wav is normally written by the Pilot server as chunks stream; stand in for it here,
  // BEFORE finalize files the recording away (C10 moves the doc AND the .wav together).
  fs.writeFileSync(started.audioPath!, Buffer.from("RIFF0000WAVE"));
  for (let i = 0; i < 100 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false, "finalize must complete");
  let list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list.length, 1);
  assert.equal(list[0].staged, true, "not yet filed by the user - still needs a Save");
  // C10: finalize() files a staged recording OUT of staging and INTO history as
  // its default landing spot - it no longer sits in staging indefinitely.
  assert.equal(fs.existsSync(stopped.docPath), false, "the doc left the staging location");
  assert.equal(fs.existsSync(path.dirname(started.docPath!)), false, "the emptied staging session folder is cleaned");
  assert.ok(String(list[0].docPath).startsWith(history), "recent.json now points into history");
  assert.equal(fs.existsSync(list[0].docPath), true, "the document really is in history");
  assert.equal(fs.existsSync(list[0].audioPath), true, "the audio moved into history too");
  // File it into the user's folder from history.
  const res = (await rec.save(dest)) as { ok: boolean; error?: string; docPath?: string; audioPath?: string };
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(fs.existsSync(list[0].docPath), false, "the document moved out of history");
  // 2026-07-21: each capture gets its own subfolder <name>-<date> in the chosen dir.
  const sub = path.dirname(res.docPath!);
  assert.equal(path.dirname(sub), dest, "the capture folder sits in the chosen folder");
  assert.equal(path.basename(sub), path.basename(res.docPath!, ".md"), "the folder carries the capture's name+date");
  assert.equal(path.dirname(res.audioPath!), sub, "the audio lives in the same capture folder");
  list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list.length, 1);
  assert.equal(list[0].staged, false, "the saved recording is no longer staged");
  assert.equal(list[0].dir, sub);
  fs.rmSync(work, { recursive: true, force: true });
});

test("v6 c7: save() never reuses an existing folder in the destination (uniqueDir suffix)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-save-"));
  const staging = path.join(work, "st");
  fs.mkdirSync(staging);
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const recent = path.join(work, "recent.json");
  const doc = path.join(staging, "note.md");
  fs.writeFileSync(doc, "NEW");
  // A folder of the same name already there (the user's own, or a previous
  // same-titled capture): the new capture must NOT move in with it.
  fs.mkdirSync(path.join(dest, "note"));
  fs.writeFileSync(path.join(dest, "note", "keep.md"), "KEEP");
  fs.writeFileSync(
    recent,
    JSON.stringify([{ title: "T", startedIso: "", dir: staging, docPath: doc, audioPath: "", durationMs: 0, staged: true }]),
  );
  const rec = new LongRecorder({
    getSidecar: () => null,
    recentPathOverride: recent,
    stagingRootOverride: staging,
  });
  const res = (await rec.save(dest)) as { ok: boolean; error?: string; docPath?: string };
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(fs.readFileSync(path.join(dest, "note", "keep.md"), "utf8"), "KEEP", "the existing folder is untouched");
  assert.equal(fs.readFileSync(path.join(dest, "note-1", "note.md"), "utf8"), "NEW", "the capture got its own suffixed folder");
  fs.rmSync(work, { recursive: true, force: true });
});

test("v6 c7: save() refuses a missing destination and an empty recent list", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-save2-"));
  const recent = path.join(work, "recent.json");
  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent });
  assert.equal(((await rec.save(path.join(work, "nope"))) as { ok: boolean }).ok, false, "a missing dir is refused");
  fs.writeFileSync(recent, "[]");
  assert.equal(((await rec.save(work)) as { ok: boolean }).ok, false, "no finished recording is refused");
  fs.rmSync(work, { recursive: true, force: true });
});

test("v6 c7: save() tolerates a phantom .wav (keepAudio on but the file was never written)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-save3-"));
  const staging = path.join(work, "st");
  fs.mkdirSync(staging);
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const recent = path.join(work, "recent.json");
  const doc = path.join(staging, "note.md");
  fs.writeFileSync(doc, "# hi");
  const phantomWav = path.join(staging, "note.wav"); // recorded in recent.json but never created on disk
  fs.writeFileSync(
    recent,
    JSON.stringify([{ title: "T", startedIso: "", dir: staging, docPath: doc, audioPath: phantomWav, durationMs: 0, staged: true }]),
  );
  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent, stagingRootOverride: staging });
  const res = (await rec.save(dest)) as { ok: boolean; error?: string; docPath?: string; audioPath?: string };
  assert.equal(res.ok, true, res.error ?? "expected ok"); // the missing .wav must not fail the save
  assert.equal(res.audioPath, "", "a phantom .wav is dropped, not treated as saved");
  assert.equal(fs.existsSync(path.join(dest, "note", "note.md")), true, "the document is filed in its capture folder");
  assert.equal(fs.existsSync(path.join(dest, "note", "note.wav")), false, "no bogus .wav is created in the destination");
  fs.rmSync(work, { recursive: true, force: true });
});

test("v6 c7: save() with a vanished document refuses and leaves recent.json untouched (no orphaning)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-save4-"));
  const staging = path.join(work, "st");
  fs.mkdirSync(staging);
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const recent = path.join(work, "recent.json");
  const doc = path.join(staging, "gone.md"); // referenced but not on disk
  const entry = { title: "T", startedIso: "", dir: staging, docPath: doc, audioPath: "", durationMs: 0, staged: true };
  fs.writeFileSync(recent, JSON.stringify([entry]));
  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent, stagingRootOverride: staging });
  const res = (await rec.save(dest)) as { ok: boolean };
  assert.equal(res.ok, false, "a vanished source is refused, not half-committed");
  assert.deepEqual(JSON.parse(fs.readFileSync(recent, "utf8")), [entry], "recent.json is left exactly as it was");
  fs.rmSync(work, { recursive: true, force: true });
});

test("2026-07-21: a failed save() rolls the capture folder back out of the destination", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-save5-"));
  const staging = path.join(work, "st");
  fs.mkdirSync(staging);
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const recent = path.join(work, "recent.json");
  const doc = path.join(staging, "note.md");
  fs.writeFileSync(doc, "NEW");
  // audioPath pointing at a DIRECTORY: existsSync says yes, copyFileSync throws
  // (EISDIR/EPERM) after the doc already copied - the two-phase rollback runs.
  const badWav = path.join(staging, "not-a-file.wav");
  fs.mkdirSync(badWav);
  const entry = { title: "T", startedIso: "", dir: staging, docPath: doc, audioPath: badWav, durationMs: 0, staged: true };
  fs.writeFileSync(recent, JSON.stringify([entry]));
  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent, stagingRootOverride: staging });
  const res = (await rec.save(dest)) as { ok: boolean };
  assert.equal(res.ok, false, "the failed copy is reported");
  assert.deepEqual(fs.readdirSync(dest), [], "no capture folder (or partial copy) is left in the destination");
  assert.equal(fs.readFileSync(doc, "utf8"), "NEW", "the source is untouched for a clean retry");
  assert.deepEqual(JSON.parse(fs.readFileSync(recent, "utf8")), [entry], "recent.json is left exactly as it was");
  fs.rmSync(work, { recursive: true, force: true });
});

// ---- meeting notes (2026-07-21): spliceNotes + notesSplice ----

test("spliceNotes: a bare transcript (no Ollama) gains ## Notes and ## Transcript", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = header + "[00:00:00] Bonjour.\n\n[00:00:05] On commence.\n\n";
  const out = spliceNotes(doc, header, "## Resume\n\nCourt.");
  assert.equal(out, header + "## Notes\n\n## Resume\n\nCourt.\n\n## Transcript\n\n[00:00:00] Bonjour.\n\n[00:00:05] On commence.\n\n");
});

test("spliceNotes: an Ollama ## Summary block is replaced, never stacked", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = header + "## Summary\n\nvieux resume\n\n## Transcript\n\n[00:00:00] Bonjour.\n\n";
  const out = spliceNotes(doc, header, "notes fraiches");
  assert.ok(!out.includes("## Summary"), "the old summary is gone");
  assert.ok(!out.includes("vieux resume"));
  assert.ok(out.includes("## Notes\n\nnotes fraiches\n\n## Transcript\n\n[00:00:00] Bonjour."));
});

test("spliceNotes is idempotent: a regenerate replaces the previous ## Notes", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = header + "[00:00:00] Bonjour.\n\n";
  const once = spliceNotes(doc, header, "v1");
  const twice = spliceNotes(once, header, "v2");
  assert.ok(!twice.includes("v1"), "the first notes are replaced");
  assert.equal(twice, spliceNotes(doc, header, "v2"), "regenerate lands on the same canonical form");
});

test("spliceNotes: a hand-edited title falls back to the engine line, transcript intact", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = "# Titre change a la main\n\n- recorded: 2026-07-21T09:00:00.000Z\n- engine: AGR Flow (100% local)\n\n[00:00:00] Bonjour.\n\n";
  const out = spliceNotes(doc, header, "notes");
  assert.ok(out.startsWith("# Titre change a la main"), "the user's edited header wins");
  assert.ok(out.includes("## Notes\n\nnotes\n\n## Transcript\n\n[00:00:00] Bonjour."));
});

test("notesSplice: writes the notes, resolves the target from recent.json", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-notes-"));
  const recent = path.join(work, "recent.json");
  const doc = path.join(work, "kickoff.md");
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  fs.writeFileSync(doc, header + "[00:00:00] Bonjour.\n\n");
  fs.writeFileSync(
    recent,
    JSON.stringify([{ title: "Kickoff", startedIso: "2026-07-21T09:00:00.000Z", dir: work, docPath: doc, audioPath: "", durationMs: 0 }]),
  );
  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent });
  const res = rec.notesSplice(doc, "## Resume\n\nCourt.");
  assert.equal(res.ok, true, res.error ?? "expected ok");
  const out = fs.readFileSync(doc, "utf8");
  assert.ok(out.includes("## Notes\n\n## Resume\n\nCourt.\n\n## Transcript\n\n[00:00:00] Bonjour."));
  // Empty notes and empty docPath are refused without touching the file.
  assert.equal(rec.notesSplice(doc, "   ").ok, false);
  assert.equal(rec.notesSplice("", "x").ok, false);
  fs.rmSync(work, { recursive: true, force: true });
});

test("notesSplice: a stale docPath (save moved the capture) answers movedTo instead of writing", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-notes2-"));
  const recent = path.join(work, "recent.json");
  const newDoc = path.join(work, "kickoff.md");
  fs.writeFileSync(newDoc, transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z") + "[00:00:00] Bonjour.\n\n");
  fs.writeFileSync(
    recent,
    JSON.stringify([{ title: "Kickoff", startedIso: "2026-07-21T09:00:00.000Z", dir: work, docPath: newDoc, audioPath: "", durationMs: 0 }]),
  );
  const rec = new LongRecorder({ getSidecar: () => null, recentPathOverride: recent });
  const res = rec.notesSplice(path.join(work, "old-location.md"), "notes");
  assert.equal(res.ok, false);
  assert.equal(res.movedTo, newDoc, "the caller is pointed at the new location");
  assert.ok(!fs.readFileSync(newDoc, "utf8").includes("## Notes"), "nothing was written on the stale call");
  // Re-splice on movedTo succeeds (the notes were already computed).
  assert.equal(rec.notesSplice(res.movedTo!, "notes").ok, true);
  fs.rmSync(work, { recursive: true, force: true });
});

// ---- U4 (review): the two ways state() told the truth late, or not at all ----

test("U4: the duration stays at what the recording reached, through finalizing and after", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-duration-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  // A sidecar that answers slowly: finalize() stays busy long enough to observe
  // the state the Record page shows for minutes on a real meeting.
  const slow = {
    transcribe: () => new Promise<{ text: string; ms: number }>((r) => setTimeout(() => r({ text: "Bonjour.", ms: 5 }), 400)),
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => slow,
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: staging,
    historyRootOverride: history,
  });

  const started = rec.start({ title: "Duration", keepAudio: false });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  await new Promise((r) => setTimeout(r, 120)); // let the wall clock actually move
  rec.onChunk(concat(speechy(4000), silence(1500)));
  const live = rec.state().durationMs;
  assert.ok(live >= 100, `a running recording reports its elapsed time (got ${live})`);

  rec.stop();
  const whileFinalizing = rec.state();
  assert.equal(whileFinalizing.finalizing, true, "the recorder is still finishing the transcript");
  assert.ok(
    whileFinalizing.durationMs >= live,
    `the biggest number on the page must not fall to 00:00:00 the instant Stop is pressed (got ${whileFinalizing.durationMs})`,
  );

  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(rec.isBusy, false, "finalize must complete");
  const idle = rec.state();
  assert.equal(idle.active, false);
  assert.equal(idle.finalizing, false);
  assert.equal(idle.durationMs, whileFinalizing.durationMs, "and it stays that length once idle: it is a fact about the recording");

  // A new recording is the only thing that resets it.
  const again = rec.start({ title: "Second", keepAudio: false });
  assert.equal(again.ok, true, again.error ?? "expected ok");
  assert.ok(rec.state().durationMs < 1000, "a fresh recording starts from zero, not from the previous one's length");
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 25));

  fs.rmSync(work, { recursive: true, force: true });
});

test("U4: every write of recent.json made HERE drops the state() cache (save no longer advertises a deleted path)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-cache-invalidate-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const mockSidecar = {
    transcribe: () => Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 }),
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => mockSidecar,
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: staging,
    historyRootOverride: history,
  });

  // Warm the cache on an EMPTY recent list, then record: finalize's own write
  // has to be visible immediately, not up to RECENT_STATE_CACHE_MS later.
  assert.deepEqual(rec.state().recent, []);
  const started = rec.start({ title: "Cache", keepAudio: false });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  rec.onChunk(concat(speechy(4000), silence(1500)));
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 25));
  const afterFinalize = rec.state().recent;
  assert.equal(afterFinalize.length, 1, "finalize's write is visible at once, not three seconds later");
  const filed = afterFinalize[0].docPath;
  assert.equal(fs.existsSync(filed), true);

  // The one that used to be plainly WRONG rather than late: save() moves the
  // document and deletes the original, and state() went on serving the old path.
  const res = (await rec.save(dest)) as { ok: boolean; error?: string; docPath?: string };
  assert.equal(res.ok, true, res.error ?? "expected ok");
  const afterSave = rec.state().recent;
  assert.equal(afterSave.length, 1);
  assert.equal(afterSave[0].docPath, res.docPath, "state() names where the recording IS, the instant it moved");
  assert.notEqual(afterSave[0].docPath, filed, "and never the path save() just deleted");
  assert.equal(fs.existsSync(afterSave[0].docPath), true);

  fs.rmSync(work, { recursive: true, force: true });
});

test("U4: the boot rescan's own write is visible to state() immediately too", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-cache-rescue-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const dir = path.join(staging, String(Date.now() - 60_000) + "-cache01");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "orphan.md"),
    transcriptHeader("Orphan", new Date(Date.now() - 60_000).toISOString()) + "[00:00:00] Bonjour.\n\n",
  );
  const rec = new LongRecorder({
    getSidecar: () => null,
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: staging,
    historyRootOverride: history,
  });
  assert.deepEqual(rec.state().recent, [], "nothing indexed yet - and the cache now holds that");
  assert.equal(rec.rescueOrphanedStaging(), 1);
  assert.equal(rec.state().recent.length, 1, "a recovered recording is findable at once, not after the cache expires");

  fs.rmSync(work, { recursive: true, force: true });
});
