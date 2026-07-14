import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LongRecorder, historyRoot, listHistory, resolveHistoryEntry } from "../src/main/longform";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

// C10: recording history (3-month retention). A staged recording (no
// destination chosen at Stop) is filed into <historyRoot>/<YYYY-MM-DD>/<title>/
// at finalize instead of sitting invisible in the app-owned staging folder
// forever; save() still works from there; a background purge removes
// date-named folders older than 90 days, under strict guardrails.

const SR = 16_000;

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

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("C10 (a): a staged recording without a destination is filed into history at finalize, not left in staging", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-hist-a-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  const mockSidecar = {
    transcribe: () => Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 }),
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => mockSidecar,
    cleanupModel: () => "",
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });

  const started = rec.start({ title: "Client Kickoff", keepAudio: true });
  assert.equal(started.ok, true, started.error);
  const stagingDoc = started.docPath!;
  assert.ok(stagingDoc.startsWith(staging), "recording starts in staging");

  rec.onChunk(speechy(5000));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  // Stand in for the Pilot server writing chunks as they stream (device mode),
  // BEFORE finalize files the recording away.
  fs.writeFileSync(started.audioPath!, Buffer.from("RIFF0000WAVE"));
  for (let i = 0; i < 100 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false, "finalize must complete");

  assert.equal(fs.existsSync(stagingDoc), false, "the staging doc is gone");
  assert.equal(fs.existsSync(path.dirname(stagingDoc)), false, "the emptied staging session folder is cleaned");

  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list.length, 1);
  assert.equal(list[0].staged, true, "still not filed by the user - just parked in history");
  const docPath: string = list[0].docPath;
  assert.ok(docPath.startsWith(history), "recent.json now points into history");
  assert.ok(docPath.startsWith(path.join(history, ymd(new Date()))), "filed under today's date folder");
  assert.equal(fs.existsSync(docPath), true, "the document really is on disk in history");
  assert.ok(docPath.endsWith(".md"));
  assert.ok(String(list[0].audioPath).length > 0, "the .wav path is preserved in history");
  assert.ok(String(list[0].audioPath).startsWith(history), "the .wav itself lives in history");
  assert.equal(fs.existsSync(list[0].audioPath), true, "the .wav really is on disk in history");

  fs.rmSync(work, { recursive: true, force: true });
});

test("C10 (b): save() files a history entry into the chosen folder and cleans the emptied date folder (bounded to historyRoot)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-hist-b-"));
  const history = path.join(work, "history");
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest, { recursive: true });
  const recent = path.join(work, "recent.json");
  const dateDir = path.join(history, "2026-01-01");
  const recDir = path.join(dateDir, "meeting-note");
  fs.mkdirSync(recDir, { recursive: true });
  const doc = path.join(recDir, "meeting-note.md");
  fs.writeFileSync(doc, "# hi");
  fs.writeFileSync(
    recent,
    JSON.stringify([{ title: "T", startedIso: "", dir: recDir, docPath: doc, audioPath: "", durationMs: 0, staged: true }]),
  );
  const rec = new LongRecorder({
    getSidecar: () => null,
    cleanupModel: () => "",
    recentPathOverride: recent,
    historyRootOverride: history,
  });

  const res = (await rec.save(dest)) as { ok: boolean; error?: string; docPath?: string };
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.existsSync(path.join(dest, "meeting-note.md")), true, "the document is filed into the chosen folder");
  assert.equal(fs.existsSync(recDir), false, "the emptied per-recording folder is gone");
  assert.equal(fs.existsSync(dateDir), false, "the emptied date folder is gone too");
  assert.equal(fs.existsSync(history), true, "historyRoot itself is never removed");

  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(list[0].staged, false);
  assert.equal(list[0].dir, dest);

  fs.rmSync(work, { recursive: true, force: true });
});

test("C10 (d): a staged recording keeps its .wav in history even with keepAudio off (safety net)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-hist-d-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const recent = path.join(work, "recent.json");
  const mockSidecar = {
    transcribe: () => Promise.resolve({ text: "Bonjour.", ms: 5 }),
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => mockSidecar,
    cleanupModel: () => "",
    recentPathOverride: recent,
    stagingRootOverride: staging,
    historyRootOverride: history,
  });

  // keepAudio explicitly OFF, and no destination: the staged safety net must
  // still hand out an audio path so the wav gets captured by the caller
  // (device mode: AGR Pilot's server writes the bytes to the path we return).
  const started = rec.start({ title: "No Audio Please", keepAudio: false });
  assert.equal(started.ok, true, started.error);
  assert.ok(started.audioPath && started.audioPath.length > 0, "staged recordings get an audio path even with keepAudio off");

  // Stand in for the Pilot server writing chunks as they stream (device mode),
  // BEFORE finalize files the recording away.
  fs.writeFileSync(started.audioPath!, Buffer.from("RIFF0000WAVE"));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  for (let i = 0; i < 100 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false);

  const list = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.ok(String(list[0].audioPath).length > 0, "the .wav is still referenced");
  assert.ok(String(list[0].audioPath).startsWith(history), "the .wav lives in history");
  assert.equal(fs.existsSync(list[0].audioPath), true, "the wav really landed in history");

  fs.rmSync(work, { recursive: true, force: true });
});

test("C10 (c): purgeHistory removes only date-named folders older than 90 days, never symlink targets or non-date names", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-purge-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  // Review C10 F1: the purge only operates on a root the app established (marker file).
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "test marker\n");
  const dayMs = 24 * 60 * 60 * 1000;

  const old91 = ymd(new Date(Date.now() - 91 * dayMs));
  const keep89 = ymd(new Date(Date.now() - 89 * dayMs));
  const oldDir = path.join(history, old91);
  const keepDir = path.join(history, keep89);
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, "note.md"), "old");
  fs.mkdirSync(keepDir);
  fs.writeFileSync(path.join(keepDir, "note.md"), "keep");

  // A non-date-named folder must NEVER be touched, no matter how old.
  const junk = path.join(history, "not-a-date-folder");
  fs.mkdirSync(junk);
  fs.writeFileSync(path.join(junk, "note.md"), "junk");

  // A symlink NAMED like an old date, pointing at a folder that must never be touched.
  const target = path.join(work, "sensitive-target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "do-not-delete.txt"), "precious");
  const linkOldName = ymd(new Date(Date.now() - 200 * dayMs));
  const linkPath = path.join(history, linkOldName);
  let symlinked = true;
  try {
    fs.symlinkSync(target, linkPath, "junction");
  } catch {
    symlinked = false; // not every environment allows creating a link; the rest of the test still holds
  }

  const rec = new LongRecorder({ getSidecar: () => null, cleanupModel: () => "", historyRootOverride: history });
  rec.purgeHistory();

  assert.equal(fs.existsSync(oldDir), false, "older than 90 days is removed");
  assert.equal(fs.existsSync(keepDir), true, "within 90 days is kept");
  assert.equal(fs.existsSync(junk), true, "a non-date name is never touched, no matter how old");
  assert.equal(fs.existsSync(path.join(target, "do-not-delete.txt")), true, "a symlink's TARGET is never touched");
  if (symlinked) assert.equal(fs.existsSync(linkPath), false, "the stale symlink entry itself is removed");

  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test("C10 F1: a folder WITHOUT the app marker is never purged, whatever dated subfolders it holds", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-purge-nomarker-"));
  const dayMs = 24 * 60 * 60 * 1000;
  const oldDir = path.join(work, ymd(new Date(Date.now() - 200 * dayMs)));
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, "real-user-file.md"), "someone's real export");
  const rec = new LongRecorder({ getSidecar: () => null, cleanupModel: () => "", historyRootOverride: work });
  rec.purgeHistory();
  assert.equal(fs.existsSync(path.join(oldDir, "real-user-file.md")), true, "no marker = not our folder = untouched");
  fs.rmSync(work, { recursive: true, force: true });
});

test("C10 F1: purgeHistory refuses an immediate child of the user profile (Documents-like)", () => {
  const logs: string[] = [];
  const rec = new LongRecorder({
    getSidecar: () => null,
    cleanupModel: () => "",
    historyRootOverride: path.join(os.homedir(), "Documents"),
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.ok(logs.some((m) => /refused/i.test(m)), "a profile child (Documents, Desktop, OneDrive) must be refused");
});

test("C10: purgeHistory refuses to operate on the user's profile root", () => {
  const logs: string[] = [];
  const rec = new LongRecorder({
    getSidecar: () => null,
    cleanupModel: () => "",
    historyRootOverride: os.homedir(),
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.ok(logs.some((m) => /refused/i.test(m)), "the profile root must be refused, never scanned");
});

test("C10: purgeHistory refuses to operate on a filesystem/volume root", () => {
  const logs: string[] = [];
  const root = path.parse(process.cwd()).root; // e.g. "C:\\" on Windows, "/" elsewhere
  const rec = new LongRecorder({
    getSidecar: () => null,
    cleanupModel: () => "",
    historyRootOverride: root,
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.ok(logs.some((m) => /refused/i.test(m)), "a volume root must be refused, never scanned");
});

test("C10: purgeHistory is a silent no-op when the history folder does not exist yet", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-purge-empty-"));
  const history = path.join(work, "history"); // never created
  const logs: string[] = [];
  const rec = new LongRecorder({
    getSidecar: () => null,
    cleanupModel: () => "",
    historyRootOverride: history,
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.equal(logs.length, 0, "nothing to purge, nothing to log");
  fs.rmSync(work, { recursive: true, force: true });
});

test("C10: historyRoot() defaults under dataDir(), and settings.historyDir overrides it", () => {
  assert.ok(historyRoot("").endsWith(path.join(".agr-flow", "history")), "default lives under ~/.agr-flow/history");
  assert.equal(historyRoot("D:\\Recordings\\History"), "D:\\Recordings\\History", "a configured historyDir wins");
  assert.equal(historyRoot("  "), historyRoot(""), "a blank/whitespace-only override falls back to the default");
});

// ---- Archive 2026-07-14: history browsing (listHistory + resolveHistoryEntry) ----

test("Archive: listHistory enumerates a marked root's dated/title recordings, empty for an unmarked root", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-list-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });

  // Unmarked root: never enumerated, even with a perfectly shaped dated folder.
  const unmarkedRec = path.join(history, "2026-02-01", "some-meeting");
  fs.mkdirSync(unmarkedRec, { recursive: true });
  fs.writeFileSync(path.join(unmarkedRec, "some-meeting.md"), "# hi");
  assert.deepEqual(listHistory(history), [], "no marker file = never enumerated");

  // Mark the root (same marker fileIntoHistory writes) and add a real recording.
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  const recDir = path.join(history, "2026-03-05", "client-kickoff");
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, "client-kickoff.md"), "# Client Kickoff\n\nHello.");
  fs.writeFileSync(path.join(recDir, "client-kickoff.wav"), Buffer.from("RIFF0000WAVE"));

  // Marking the root does not retroactively hide the folder created before the
  // marker existed - the gate is on the root, not on per-item creation time -
  // so both recordings are now enumerated.
  const items = listHistory(history);
  assert.equal(items.length, 2);
  const kickoff = items.find((it) => it.title === "client-kickoff");
  assert.ok(kickoff, "the freshly added recording is enumerated");
  assert.equal(kickoff!.date, "2026-03-05");
  assert.equal(kickoff!.hasAudio, true);
  assert.ok(kickoff!.audioBytes > 0, "audioBytes reflects the .wav size");
  assert.ok(kickoff!.docBytes > 0, "docBytes reflects the .md size");
  assert.ok(kickoff!.id.length > 0);
  assert.ok(!kickoff!.id.includes("client-kickoff"), "the id is opaque, never the raw folder name");

  fs.rmSync(work, { recursive: true, force: true });
});

test("Archive: listHistory sorts newest first and skips a recording folder with no transcript", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-list2-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");

  const older = path.join(history, "2026-01-01", "older-meeting");
  fs.mkdirSync(older, { recursive: true });
  fs.writeFileSync(path.join(older, "older-meeting.md"), "# older");

  const newer = path.join(history, "2026-06-01", "newer-meeting");
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(newer, "newer-meeting.md"), "# newer");

  // A recording folder with no .md at all must be skipped, not crash the scan.
  const noDoc = path.join(history, "2026-06-01", "audio-only-no-transcript");
  fs.mkdirSync(noDoc, { recursive: true });
  fs.writeFileSync(path.join(noDoc, "audio-only-no-transcript.wav"), Buffer.from("RIFF"));

  const items = listHistory(history);
  assert.equal(items.length, 2, "the doc-less folder is skipped");
  assert.equal(items[0].title, "newer-meeting", "newest first");
  assert.equal(items[1].title, "older-meeting");

  fs.rmSync(work, { recursive: true, force: true });
});

test("Archive: resolveHistoryEntry accepts a real id and resolves the doc + audio paths, inside historyRoot", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-resolve-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  const recDir = path.join(history, "2026-04-10", "weekly-sync");
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, "weekly-sync.md"), "# Weekly Sync");
  fs.writeFileSync(path.join(recDir, "weekly-sync.wav"), Buffer.from("RIFF0000WAVE"));

  const items = listHistory(history);
  assert.equal(items.length, 1);
  const entry = resolveHistoryEntry(items[0].id, history);
  assert.ok(entry, "a real id resolves");
  assert.equal(path.resolve(entry!.dir), path.resolve(recDir));
  assert.equal(entry!.doc, path.join(recDir, "weekly-sync.md"));
  assert.equal(entry!.audio, path.join(recDir, "weekly-sync.wav"));
  const resolvedRoot = path.resolve(history);
  assert.ok(
    path.resolve(entry!.doc!).startsWith(resolvedRoot + path.sep),
    "the resolved doc path stays contained inside historyRoot",
  );

  fs.rmSync(work, { recursive: true, force: true });
});

test("Archive: resolveHistoryEntry rejects a traversal id (../../etc), an unmarked root, and a stale/unknown id", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-resolve-bad-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  const recDir = path.join(history, "2026-05-01", "real-one");
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, "real-one.md"), "# real");

  const traversal = Buffer.from("../../etc", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(traversal, history), null, "a base64url of ../../etc is rejected");

  const dotdotFolder = Buffer.from("2026-01-01/..", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(dotdotFolder, history), null, "a folder segment of .. is rejected");

  const backslash = Buffer.from("2026-05-01\\real-one", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(backslash, history), null, "a backslash-separated id is rejected");

  const drive = Buffer.from("2026-05-01/C:\\Windows", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(drive, history), null, "a drive-prefixed segment is rejected");

  assert.equal(resolveHistoryEntry("not-valid-base64url-id", history), null, "a garbage id is rejected");
  assert.equal(resolveHistoryEntry("", history), null, "an empty id is rejected");

  // A syntactically valid id for a folder that does not exist on disk.
  const nonExistent = Buffer.from("2026-05-01/does-not-exist", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(nonExistent, history), null, "a stale/unknown id is rejected");

  // A real, well-formed id but against an UNMARKED root: must never resolve.
  const unmarked = path.join(work, "unmarked-history");
  const unmarkedRec = path.join(unmarked, "2026-05-01", "real-one");
  fs.mkdirSync(unmarkedRec, { recursive: true });
  fs.writeFileSync(path.join(unmarkedRec, "real-one.md"), "# real");
  const realId = Buffer.from("2026-05-01/real-one", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(realId, unmarked), null, "an unmarked root never resolves, marker gate applies here too");
  // But the SAME id resolves fine against the real, marked root.
  assert.ok(resolveHistoryEntry(realId, history), "the identical id resolves against the marked root");

  fs.rmSync(work, { recursive: true, force: true });
});

test("Archive: a symlinked date directory is neither enumerated by listHistory nor resolvable", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-symlink-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");

  const target = path.join(work, "sensitive-target");
  const targetRec = path.join(target, "linked-meeting");
  fs.mkdirSync(targetRec, { recursive: true });
  fs.writeFileSync(path.join(targetRec, "linked-meeting.md"), "# should never be served");

  const linkPath = path.join(history, "2026-06-15"); // named like a legit date dir
  let symlinked = true;
  try {
    fs.symlinkSync(target, linkPath, "junction");
  } catch {
    symlinked = false; // not every environment permits creating a link; skip gracefully
  }

  if (symlinked) {
    assert.deepEqual(listHistory(history), [], "a symlinked date dir is never enumerated");
    const forgedId = Buffer.from("2026-06-15/linked-meeting", "utf8").toString("base64url");
    assert.equal(resolveHistoryEntry(forgedId, history), null, "a symlinked date dir never resolves either");
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});
