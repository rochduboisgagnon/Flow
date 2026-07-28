import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DownloadManager } from "../src/main/downloads";
import { listHistory } from "../src/main/longform";

// U5c: the archive's browser-style download flow. Every test below works
// against a temp historyRoot AND a temp downloadsDir - NEVER the real ~/.flow
// or the real OS Downloads folder.

function makeHistory(work: string): { history: string; downloads: string } {
  const history = path.join(work, "history");
  const downloads = path.join(work, "downloads");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  return { history, downloads };
}

function fileRecording(history: string, date: string, title: string, opts: { audio?: boolean } = {}): void {
  const dir = path.join(history, date, title);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${title}.md`), `# ${title}\n\nHello.`);
  if (opts.audio) fs.writeFileSync(path.join(dir, `${title}.wav`), Buffer.from("RIFF0000WAVE"));
}

test("downloadDoc: an unknown/forged id is refused cleanly, never throws", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-unknown-"));
  const { history, downloads } = makeHistory(work);
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });

  const res = await mgr.downloadDoc("not-a-real-id");
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.equal(fs.existsSync(downloads), false, "nothing was written for an id that does not resolve");

  fs.rmSync(work, { recursive: true, force: true });
});

test("downloadAudio: refuses cleanly when the recording exists but has no audio", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-noaudio-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "client-kickoff", { audio: false });
  const id = listHistory(history)[0].id;
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });

  const res = await mgr.downloadAudio(id);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /audio/i);

  fs.rmSync(work, { recursive: true, force: true });
});

test("downloadDoc writes \"YYYY-MM-DD Title.md\" straight into the downloads dir, by streaming (not readFileSync)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-doc-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "client-kickoff", { audio: true });
  const id = listHistory(history)[0].id;
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });

  const res = await mgr.downloadDoc(id);
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 client-kickoff.md"));
  assert.equal(fs.existsSync(res.path!), true);
  assert.equal(fs.readFileSync(res.path!, "utf8"), "# client-kickoff\n\nHello.");
  assert.equal(mgr.lastDownloadedPath(), res.path, "lastDownloadedPath tracks the most recent successful download");

  fs.rmSync(work, { recursive: true, force: true });
});

test("downloadAudio writes the .wav counterpart", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-audio-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "client-kickoff", { audio: true });
  const id = listHistory(history)[0].id;
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });

  const res = await mgr.downloadAudio(id);
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 client-kickoff.wav"));
  assert.equal(fs.existsSync(res.path!), true);

  fs.rmSync(work, { recursive: true, force: true });
});

test("three downloads of the SAME recording in a row never overwrite - browser-style (1), (2) numbering", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-triple-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "weekly-sync", { audio: false });
  const id = listHistory(history)[0].id;
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });

  const first = await mgr.downloadDoc(id);
  const second = await mgr.downloadDoc(id);
  const third = await mgr.downloadDoc(id);

  assert.equal(first.ok, true, first.error ?? "expected ok");
  assert.equal(second.ok, true, second.error ?? "expected ok");
  assert.equal(third.ok, true, third.error ?? "expected ok");
  assert.equal(first.path, path.join(downloads, "2026-07-27 weekly-sync.md"));
  assert.equal(second.path, path.join(downloads, "2026-07-27 weekly-sync (1).md"));
  assert.equal(third.path, path.join(downloads, "2026-07-27 weekly-sync (2).md"));
  // All three genuinely coexist on disk - none clobbered a previous one.
  assert.equal(fs.existsSync(first.path!), true);
  assert.equal(fs.existsSync(second.path!), true);
  assert.equal(fs.existsSync(third.path!), true);

  fs.rmSync(work, { recursive: true, force: true });
});

test("a pre-existing file with the exact target name is never overwritten - a fresh numbered variant is used instead", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-preexist-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "weekly-sync", { audio: false });
  const id = listHistory(history)[0].id;
  fs.mkdirSync(downloads, { recursive: true });
  // A file the USER put there, unrelated to Flow, that happens to share the name.
  const clash = path.join(downloads, "2026-07-27 weekly-sync.md");
  fs.writeFileSync(clash, "not Flow's content - must survive untouched");

  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });
  const res = await mgr.downloadDoc(id);

  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 weekly-sync (1).md"));
  assert.equal(fs.readFileSync(clash, "utf8"), "not Flow's content - must survive untouched", "the pre-existing file was never touched");

  fs.rmSync(work, { recursive: true, force: true });
});

test("a write failure (destination cannot be created) yields {ok:false, error}, never an exception", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-fail-"));
  const { history } = makeHistory(work);
  fileRecording(history, "2026-07-27", "client-kickoff", { audio: false });
  const id = listHistory(history)[0].id;
  // A regular FILE where the downloads directory should be: mkdirSync(recursive)
  // cannot create a directory on top of it, and every attempted write fails.
  const blockedDownloads = path.join(work, "downloads-is-a-file");
  fs.writeFileSync(blockedDownloads, "not a directory");
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => blockedDownloads });

  await assert.doesNotReject(async () => {
    const res = await mgr.downloadDoc(id);
    assert.equal(res.ok, false);
    assert.ok(res.error, "a readable error is returned");
  });

  fs.rmSync(work, { recursive: true, force: true });
});

// ---- U5 review, constat 1: a failed copy must leave NOTHING behind ----
//
// downloadsDir() is called AFTER resolveHistoryEntry has already answered, so a
// test dep can sabotage the source in exactly the window the app really has:
// the retention purge runs at startup and at every start(), and can delete the
// date folder between the resolution and the copy. No stubbed filesystem is
// involved below - the source is genuinely gone / genuinely unreadable.

/** A DownloadManager whose downloadsDir() runs `sabotage` once, on its first
 * call, i.e. right after the id has been resolved to real paths. */
function managerSabotagingSource(history: string, downloads: string, sabotage: () => void): DownloadManager {
  let armed = true;
  return new DownloadManager({
    historyRoot: () => history,
    downloadsDir: () => {
      if (armed) {
        armed = false;
        sabotage();
      }
      return downloads;
    },
  });
}

test("U5 constat 1: a source that VANISHED leaves no 0-byte corpse, and the canonical name stays free", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-vanished-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "reunion", { audio: true });
  const id = listHistory(history)[0].id;
  const wav = path.join(history, "2026-07-27", "reunion", "reunion.wav");
  const canonical = path.join(downloads, "2026-07-27 reunion.wav");

  const mgr = managerSabotagingSource(history, downloads, () => fs.rmSync(wav));
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, false, "a source that disappeared cannot be downloaded");
  assert.deepEqual(fs.readdirSync(downloads), [], "no file at all is left in the destination folder");
  assert.equal(fs.existsSync(canonical), false, "and specifically not a 0-byte file under the canonical name");
  assert.equal(mgr.lastDownloadedPath(), null, "a failed download is never remembered as the last one");

  // The regression that made this MAJOR: the corpse squatted the canonical
  // name, so the first SUCCESSFUL download landed on "... (1)" instead.
  fs.writeFileSync(wav, Buffer.from("RIFF0000WAVE"));
  const retry = await mgr.downloadAudio(id);
  assert.equal(retry.ok, true, retry.error ?? "expected ok");
  assert.equal(retry.path, canonical, "the retry gets the canonical name, not \" (1)\"");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 constat 1: a source that cannot be READ (locked/unreadable) leaves no debris either", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-locked-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "reunion", { audio: true });
  const id = listHistory(history)[0].id;
  const wav = path.join(history, "2026-07-27", "reunion", "reunion.wav");

  // A directory where the .wav was: opening/reading it fails (EISDIR/EPERM),
  // which is how an antivirus-locked or unhydrated OneDrive placeholder source
  // presents itself to the copy - an error event, after the destination has
  // already been created.
  const mgr = managerSabotagingSource(history, downloads, () => {
    fs.rmSync(wav);
    fs.mkdirSync(wav);
  });
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, false, "an unreadable source cannot be downloaded");
  assert.ok(res.error, "and says so");
  assert.deepEqual(fs.readdirSync(downloads), [], "no file at all is left in the destination folder");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 constat 1 (the trap): a failing copy removes ITS OWN debris and never the user's pre-existing file", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-trap-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "reunion", { audio: true });
  const id = listHistory(history)[0].id;
  const wav = path.join(history, "2026-07-27", "reunion", "reunion.wav");
  fs.mkdirSync(downloads, { recursive: true });
  // The user's own file already holds the canonical name: the copy will get
  // EEXIST on it and move to " (1)" - and THAT is the one it created and may
  // clean up. An unconditional rm(dest) would have destroyed the file below.
  const mine = path.join(downloads, "2026-07-27 reunion.wav");
  fs.writeFileSync(mine, "the user's own file - must survive untouched");

  const mgr = managerSabotagingSource(history, downloads, () => fs.rmSync(wav));
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, false, "the copy failed");
  assert.equal(fs.readFileSync(mine, "utf8"), "the user's own file - must survive untouched");
  assert.deepEqual(
    fs.readdirSync(downloads),
    ["2026-07-27 reunion.wav"],
    "the user's file is the ONLY thing left: the \" (1)\" we created was cleaned up",
  );

  fs.rmSync(work, { recursive: true, force: true });
});

test("downloadDoc/downloadAudio never let the renderer supply a path - only an id is accepted", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-noPath-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "client-kickoff", { audio: true });
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });

  // A raw filesystem path passed AS an id must not resolve to anything (the
  // id scheme is base64url of "<date>/<title>", never a real path).
  const res = await mgr.downloadDoc(path.join(history, "2026-07-27", "client-kickoff", "client-kickoff.md"));
  assert.equal(res.ok, false, "a raw path is not a valid id and must be refused");

  fs.rmSync(work, { recursive: true, force: true });
});
