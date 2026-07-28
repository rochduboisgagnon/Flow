import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DownloadManager, PART_SUFFIX } from "../src/main/downloads";
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
  assert.deepEqual(
    fs.readdirSync(downloads),
    ["2026-07-27 client-kickoff.md"],
    "a finished download leaves the canonical name and NOTHING else - no work file",
  );

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

// ---- U5 review, MAJEUR 1 + 2: the canonical name is only ever a WHOLE file ----
//
// The failure the first version could not cover: not an error, a DEATH. The
// updater relaunches Flow mid-transfer (a download is not part of engineBusy()),
// before-quit knows nothing about a copy in flight, and a power loss asks
// nobody. What survived was a file bearing the exact expected name, playable
// for its first minutes and then cut off - and it squatted the canonical name,
// so the retry landed on " (1)" and retention eventually left the amputated
// copy as the only one. Hence the work file + verified size + atomic publish.

/** How big the source of the kill test is. Big enough that the copy spans many
 * event-loop turns (the child kills itself on the first non-empty work file),
 * small enough to write and copy in well under a second. */
const KILL_TEST_BYTES = 32 * 1024 * 1024;

test("U5 MAJEUR 1: a copy killed mid-flight leaves NOTHING under the canonical name", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-killed-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "reunion", { audio: true });
  const wav = path.join(history, "2026-07-27", "reunion", "reunion.wav");
  fs.writeFileSync(wav, Buffer.alloc(KILL_TEST_BYTES, 7));
  const id = listHistory(history)[0].id;
  const canonical = path.join(downloads, "2026-07-27 reunion.wav");
  fs.mkdirSync(downloads, { recursive: true });

  // A real child process, hard-killed while the copy runs: no exit hook, no
  // finally, no cleanup of ours gets to run. Simulating this with a stream
  // error would have tested the one path that already worked.
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(__dirname, "fixtures", "download-and-die.ts"), history, downloads, id],
    { cwd: path.join(__dirname, ".."), stdio: "ignore" },
  );
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const left = fs.readdirSync(downloads);
  const part = left.find((n) => n.endsWith(PART_SUFFIX));
  assert.ok(part, `the child really died mid-copy (a work file is still there); folder held ${JSON.stringify(left)}`);
  const partBytes = fs.statSync(path.join(downloads, part)).size;
  assert.ok(
    partBytes > 0 && partBytes < KILL_TEST_BYTES,
    `the death landed IN the copy, not around it: ${partBytes} of ${KILL_TEST_BYTES} bytes`,
  );
  assert.equal(
    fs.existsSync(canonical),
    false,
    "THE invariant: no file bearing the name the user expects, because it is not the file the user expects",
  );
  assert.deepEqual(
    left.filter((n) => !n.endsWith(PART_SUFFIX)),
    [],
    "nothing but the work file survives the kill",
  );

  // The other half of what made this MAJEUR: the corpse must not push the next
  // download onto " (1)", nor stay in the folder forever.
  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });
  const res = await mgr.downloadAudio(id);
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, canonical, "the retry takes the canonical name: no corpse was squatting it");
  assert.equal(fs.statSync(canonical).size, KILL_TEST_BYTES, "and it is the WHOLE recording");
  assert.deepEqual(fs.readdirSync(downloads), ["2026-07-27 reunion.wav"], "the orphan work file was swept");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 MAJEUR 1: an orphan work file is swept, and never costs the next download its canonical name", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-orphan-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "reunion", { audio: true });
  const id = listHistory(history)[0].id;
  fs.mkdirSync(downloads, { recursive: true });
  // Exactly what the test above leaves behind, without paying for a spawn.
  const orphan = path.join(downloads, "2026-07-27 reunion.wav" + PART_SUFFIX);
  fs.writeFileSync(orphan, "half a recording from a run that never came back");
  // A file of the user's that merely LOOKS like debris to a careless sweep:
  // ".part" is what Firefox calls its own downloads in progress, in this very
  // folder. Flow deletes only its own suffix.
  const foreign = path.join(downloads, "someone-elses-download.part");
  fs.writeFileSync(foreign, "Firefox is still downloading this");

  const mgr = new DownloadManager({ historyRoot: () => history, downloadsDir: () => downloads });
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 reunion.wav"), "the plain name, not \" (1)\"");
  assert.equal(fs.existsSync(orphan), false, "the orphan work file is gone");
  assert.equal(fs.readFileSync(foreign, "utf8"), "Firefox is still downloading this", "another program's .part is untouched");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 MAJEUR 2: a copy whose size does not match the source is a failure, never a \"Saved to\"", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-short-"));
  const { history, downloads } = makeHistory(work);
  fileRecording(history, "2026-07-27", "reunion", { audio: true });
  const wav = path.join(history, "2026-07-27", "reunion", "reunion.wav");
  fs.writeFileSync(wav, Buffer.alloc(64 * 1024, 3));
  const id = listHistory(history)[0].id;

  // The source is MEASURED before the destination folder is even asked for, so
  // sabotaging it at downloadsDir() time (the same seam the tests above use)
  // makes the copy come out shorter than the file Flow measured - the exact
  // shape of a truncated download, with none of a real one's timing.
  const mgr = managerSabotagingSource(history, downloads, () => fs.writeFileSync(wav, "short"));
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, false, "a copy that does not match the source is never reported as saved");
  assert.match(res.error ?? "", /incomplete/i, "and the user is told why");
  assert.deepEqual(fs.readdirSync(downloads), [], "the incomplete file is removed - name free, nothing to mistake for a recording");
  assert.equal(mgr.lastDownloadedPath(), null, "and nothing is remembered as downloaded");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 MINEUR 7: a failure hands the user a sentence and the LOG the raw Node error", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-human-"));
  const { history } = makeHistory(work);
  fileRecording(history, "2026-07-27", "client-kickoff", { audio: false });
  const id = listHistory(history)[0].id;
  const blocked = path.join(work, "downloads-is-a-file");
  fs.writeFileSync(blocked, "not a directory");
  const logged: string[] = [];
  const mgr = new DownloadManager({
    historyRoot: () => history,
    downloadsDir: () => blocked,
    log: (m) => logged.push(m),
  });

  const res = await mgr.downloadDoc(id);

  assert.equal(res.ok, false);
  // DownloadResult.error is rendered verbatim by the Notes page.
  assert.doesNotMatch(res.error ?? "", /Error:|EEXIST|ENOTDIR|ENOENT|EPERM/, "no raw Node error reaches the page");
  assert.match(res.error ?? "", /Downloads folder/, "the page gets a sentence a human wrote");
  assert.ok(
    logged.some((l) => /EEXIST|ENOTDIR|ENOENT|EPERM/.test(l)),
    `the technical detail is in the log, where a bug report finds it; got ${JSON.stringify(logged)}`,
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
