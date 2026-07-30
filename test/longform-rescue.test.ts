import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LongRecorder, listHistory } from "../src/main/longform";
import { transcriptHeader, interruptedNote } from "../src/shared/longform";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

// U4 (blocking finding): a recording interrupted by a quit, a crash or a power
// cut used to stay in <dataDir>/staging - a folder nothing lists, nothing
// rescans and nothing purges. The meeting existed on disk and was invisible
// from every surface of the app. Two nets, both tested here:
//   1. rescueOnQuit(), strictly SYNCHRONOUS, called from before-quit (async
//      finalize() never gets to run there: Electron awaits nothing).
//   2. rescueOrphanedStaging(), at boot, which covers everything before-quit
//      never sees at all.
// Every test runs against a temporary data folder, never the real ~/.flow.

const SR = 16_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function tone(ms: number, amp = 6000): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amp);
  return out;
}
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}
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

/** A staging folder exactly as a killed session leaves one behind: the folder
 * named "<epoch ms>-<random>" (start()'s own naming), the incrementally written
 * document with its header, and the .wav the capture was streaming into. */
function orphanStagingFolder(
  staging: string,
  opts: { title: string; startedMs: number; withAudio?: boolean; base?: string },
): { dir: string; doc: string; audio: string } {
  const dir = path.join(staging, String(opts.startedMs) + "-abc123");
  fs.mkdirSync(dir, { recursive: true });
  const base = opts.base ?? "orphan-meeting";
  const doc = path.join(dir, base + ".md");
  fs.writeFileSync(
    doc,
    transcriptHeader(opts.title, new Date(opts.startedMs).toISOString()) + "[00:00:00] Bonjour tout le monde.\n\n",
  );
  const audio = path.join(dir, base + ".wav");
  if (opts.withAudio !== false) fs.writeFileSync(audio, Buffer.alloc(44 + SR * 2 * 3)); // 3 s of PCM
  return { dir, doc, audio };
}

test("U4-1: an orphaned staging folder is filed into history at boot and becomes listable", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-boot-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  const startedMs = Date.now() - 90 * 60_000; // a meeting from an hour and a half ago
  const orphan = orphanStagingFolder(staging, { title: "Board meeting", startedMs });

  const logs: string[] = [];
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
    log: (m) => logs.push(m),
  });
  assert.equal(rec.rescueOrphanedStaging(), 1, "one recording rescued");

  // It left staging entirely, folder and all.
  assert.equal(fs.existsSync(orphan.doc), false, "the document left staging");
  assert.equal(fs.existsSync(orphan.dir), false, "the emptied staging session folder is cleaned up");

  // And it is a first-class archive entry, visible from the app's own listing.
  const items = listHistory(history);
  assert.equal(items.length, 1, "the rescued recording shows up in the archive");
  assert.equal(items[0].hasAudio, true, "a recovery keeps the audio it cannot attribute");
  assert.ok(items[0].docBytes > 0);
  assert.ok(logs.some((m) => /recovered an interrupted recording/.test(m)), "the rescue is journalled");

  // The document says, at the top, that it was interrupted.
  const filed = path.join(history, items[0].date, items[0].title);
  const doc = fs.readFileSync(path.join(filed, fs.readdirSync(filed).find((f) => f.endsWith(".md"))!), "utf8");
  assert.ok(doc.includes("Interrupted recording"), "the document is honest about how it ended");
  assert.ok(
    doc.indexOf("Interrupted recording") < doc.indexOf("[00:00:00]"),
    "the note sits above the transcript, not buried at the end of a three-hour document",
  );
  assert.ok(doc.includes("# Board meeting"), "the header is preserved");

  // recent.json points at the rescued recording, still flagged as unfiled.
  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Board meeting");
  assert.equal(list[0].staged, true, "it still deserves a 'Save to...' - the user never filed it");
  assert.ok(list[0].durationMs > 0, "the duration is read back off the .wav rather than shown as 0:00");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: the boot rescan is a silent no-op when staging is empty or absent", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-none-"));
  const logs: string[] = [];
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: path.join(work, "staging"), // never created
    historyRootOverride: path.join(work, "history"),
    log: (m) => logs.push(m),
  });
  assert.equal(rec.rescueOrphanedStaging(), 0);
  assert.deepEqual(logs, [], "nothing to rescue, nothing to say");
  assert.equal(fs.existsSync(path.join(work, "history")), false, "and no history root is created for nothing");

  fs.mkdirSync(path.join(work, "staging"), { recursive: true });
  assert.equal(rec.rescueOrphanedStaging(), 0, "an empty staging folder rescues nothing");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: a recovered recording is never filed into a date the very next purge would delete", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-date-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  // A machine that sat off for months: filing this under its real date would
  // hand it straight to the retention purge - rescued into the bin.
  const orphan = orphanStagingFolder(staging, { title: "Very old meeting", startedMs: Date.now() - 200 * DAY_MS });

  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });
  assert.equal(rec.rescueOrphanedStaging(), 1);
  const items = listHistory(history);
  assert.equal(items.length, 1);

  // The purge that runs right after the rescan at boot (and at every start())
  // must leave it alone.
  rec.purgeHistory();
  assert.deepEqual(
    listHistory(history).map((i) => i.title),
    items.map((i) => i.title),
    "a recording rescued an instant ago is not immediately purgeable",
  );
  assert.equal(fs.existsSync(orphan.dir), false, "and it really did leave staging");

  // A rescued recording is filed under ITS OWN date, not today's.
  //
  // U5 review (blocking): this used to build the expected date from
  // Date.now() at assertion time while the fixture started an hour EARLIER.
  // Between 00:00 and 01:00 those are two different days, so the test failed
  // for one hour out of every twenty-four - and CI runs in UTC, which is
  // exactly where it caught us: the v1.5.0 release was refused by a clock,
  // not by a defect. Both sides now derive from the SAME instant.
  const startedMs = Date.now() - 60 * 60_000;
  orphanStagingFolder(staging, { title: "Today", startedMs, base: "today-meeting" });
  rec.rescueOrphanedStaging();
  const today = listHistory(history).find((i) => i.title.startsWith("today-meeting"));
  const pad = (n: number) => String(n).padStart(2, "0");
  const started = new Date(startedMs);
  assert.equal(today!.date, `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`);

  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: the rescue files even while the retention purge is suspended", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-suspended-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  orphanStagingFolder(staging, { title: "Suspended-purge meeting", startedMs: Date.now() - 60_000 });
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: staging,
    historyRootOverride: history,
    historyPurgeSuspended: () => true, // U2c: nothing is ever DELETED here...
  });
  assert.equal(rec.rescueOrphanedStaging(), 1, "...but classifying a recording is not deleting one");
  assert.equal(listHistory(history).length, 1);
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: a boot rescue never demotes a capture the user finished later", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-recent-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  const saved = path.join(work, "saved.md");
  fs.writeFileSync(saved, "# already saved");
  const head = {
    title: "Newer, already saved",
    startedIso: new Date().toISOString(),
    dir: work,
    docPath: saved,
    audioPath: "",
    durationMs: 10,
    staged: false,
  };
  fs.writeFileSync(recent, JSON.stringify([head]));
  orphanStagingFolder(staging, { title: "Older orphan", startedMs: Date.now() - 5 * DAY_MS });

  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });
  assert.equal(rec.rescueOrphanedStaging(), 1);
  assert.equal(listHistory(history).length, 1, "the older orphan is still archived");
  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list[0].title, "Newer, already saved", "recent.json still names the last real capture");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: quitting mid-recording files the meeting into history with its interruption note", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-quit-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  // A sidecar that NEVER answers: the ASR backlog can therefore not drain,
  // which is exactly the state a real quit interrupts (and the reason the
  // async finalize() path cannot be the rescue).
  const wedged = {
    transcribe: () => new Promise<{ text: string; ms: number }>(() => {}),
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    transcribeSegment: (wav) => wedged.transcribe(wav),
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });

  const started = rec.start({ title: "Interrupted client call", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  fs.writeFileSync(started.audioPath!, Buffer.alloc(44 + SR * 2 * 5));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(3000), silence(1500))); // closes a segment into the wedged queue
  assert.equal(rec.isBusy, true);

  // What app.on("before-quit") does now, synchronously.
  assert.equal(rec.rescueOnQuit(), true, "the rescue reports that it saved something");

  // The meeting is in the archive, not buried in staging.
  const items = listHistory(history);
  assert.equal(items.length, 1, "the interrupted meeting is a normal archive entry");
  assert.equal(fs.existsSync(started.docPath!), false, "nothing is left behind in staging");
  const dir = path.join(history, items[0].date, items[0].title);
  const doc = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".md"))!), "utf8");
  assert.ok(doc.includes("# Interrupted client call"));
  assert.ok(doc.includes("Flow was closed while this recording was still running"), "the document says how it ended");
  assert.ok(doc.includes("no summary was generated"), "and that it has no summary");
  assert.ok(/still queued for transcription/.test(doc), "and that queued segments were never transcribed");

  // recent.json points at the rescued document, so every surface can find it.
  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Interrupted client call");
  assert.ok(String(list[0].docPath).startsWith(history), "recent.json points into history");
  assert.equal(fs.existsSync(list[0].docPath), true);
  assert.equal(fs.existsSync(list[0].audioPath), true, "keepAudio was on: the .wav came along");

  // The recorder is no longer busy, and the finalize() that was left hanging
  // must not file the same recording a second time when it wakes up.
  assert.equal(rec.isBusy, false, "the engine is not left looking busy forever");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(listHistory(history).length, 1, "no duplicate entry from the abandoned finalize()");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1 + U4-2: a quit rescue honours keepAudio off, and drops the .wav only after the document is filed", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-quit-noaudio-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });
  const started = rec.start({ title: "No audio please", keepAudio: false });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  fs.writeFileSync(started.audioPath!, Buffer.alloc(44 + SR * 2 * 5));
  rec.onChunk(speechy(3000));

  assert.equal(rec.rescueOnQuit(), true);
  const items = listHistory(history);
  assert.equal(items.length, 1, "the document is filed");
  assert.equal(items[0].hasAudio, false, "keepAudio off: no .wav in the archive");
  assert.equal(fs.existsSync(started.audioPath!), false, "and none left in staging either");
  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list[0].audioPath, "", "recent.json does not advertise audio that no longer exists");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: rescueOnQuit does nothing when no recording is in flight", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-idle-"));
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: path.join(work, "staging"),
    historyRootOverride: path.join(work, "history"),
  });
  assert.equal(rec.rescueOnQuit(), false, "an idle engine has nothing to rescue");
  assert.equal(fs.existsSync(path.join(work, "history")), false, "and creates no history root on the way out");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: a rescue that cannot write its destination destroys nothing and never throws", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-fail-"));
  const staging = path.join(work, "staging");
  const recent = path.join(work, "recent.json");
  // The history root is a FILE: every mkdir under it fails, on every platform.
  const history = path.join(work, "history");
  fs.writeFileSync(history, "not a folder");

  const logs: string[] = [];
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
    log: (m) => logs.push(m),
  });

  // (a) the quit path.
  const started = rec.start({ title: "Doomed", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  fs.writeFileSync(started.audioPath!, Buffer.alloc(44 + SR * 2 * 2));
  rec.onChunk(speechy(3000));
  assert.doesNotThrow(() => rec.rescueOnQuit(), "a failed rescue must never keep the app from dying");
  assert.equal(fs.existsSync(started.docPath!), true, "the document is still in staging, intact");
  assert.equal(fs.existsSync(started.audioPath!), true, "the audio is still there too: nothing was destroyed");
  assert.ok(fs.readFileSync(started.docPath!, "utf8").includes("# Doomed"), "and it is still readable");
  assert.ok(logs.some((m) => /cannot prepare the history folder/.test(m)), "the failure is journalled, not silent");

  // (b) the startup path, on the very same folder: it must survive too, and
  // leave the recording exactly where the failed quit left it.
  logs.length = 0;
  assert.doesNotThrow(() => assert.equal(rec.rescueOrphanedStaging(), 0));
  assert.equal(fs.existsSync(started.docPath!), true, "still in staging, for the next boot to try again");
  assert.equal(fs.readFileSync(history, "utf8"), "not a folder", "and nothing outside the app's roots was touched");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-1: a staging folder with no transcript is left exactly where it is", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-rescue-nodoc-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const dir = path.join(staging, String(Date.now()) + "-zzz999");
  fs.mkdirSync(dir, { recursive: true });
  const stray = path.join(dir, "audio-only.wav");
  fs.writeFileSync(stray, Buffer.alloc(64));
  const logs: string[] = [];
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    recentPathOverride: path.join(work, "recent.json"),
    stagingRootOverride: staging,
    historyRootOverride: history,
    log: (m) => logs.push(m),
  });
  assert.equal(rec.rescueOrphanedStaging(), 0, "nothing to file without a document");
  assert.equal(fs.existsSync(stray), true, "Flow never deletes what it does not understand");
  assert.ok(logs.some((m) => /without a transcript/.test(m)), "it says so instead of failing silently");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4: the interruption note tells the truth about what was and was not transcribed", () => {
  const quitPending = interruptedNote("quit", 3);
  assert.ok(quitPending.includes("Flow was closed while this recording was still running"));
  assert.ok(quitPending.includes("the last 3 audio segments were still queued"));
  assert.ok(quitPending.includes("no summary was generated"));

  assert.ok(interruptedNote("quit", 1).includes("the last 1 audio segment was still queued"));
  assert.ok(interruptedNote("quit", 0).includes("nothing was left waiting for transcription"));

  const recovered = interruptedNote("recovered", -1);
  assert.ok(recovered.includes("crash, power loss or forced quit"));
  assert.ok(recovered.includes("anything still waiting for transcription at that moment was lost"));

  // A markdown blockquote followed by a blank line, like every other note the
  // transcript carries (markLine, gapLine): it must not glue itself to the
  // header or to the first transcript line.
  for (const note of [quitPending, recovered]) {
    assert.ok(note.startsWith("> ["), "a blockquote, like the marks and gaps");
    assert.ok(note.endsWith("]\n\n"), "and a blank line after it");
  }
});
