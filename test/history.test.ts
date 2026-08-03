import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LongRecorder, historyRoot, historyRootFor, listHistory, deleteHistoryEntry, resolveHistoryEntry, readHistoryDoc, type LongDeps } from "../src/main/longform";
import { fakeCaptureStore } from "./fixtures/capture-store";
import { dataDir, sanitizeSettings } from "../src/main/settings";
import { resolveDataDir, runMigration, DATA_DIR_NEW } from "../src/main/migrate";

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

/** Un enregistreur branche sur un magasin en memoire. Les tests de ce fichier
 * portent sur l'archive LOCALE - celle qu'une version precedente de Flow a
 * remplie - donc ils lui donnent une vraie racine sur disque et un magasin de
 * compte qui ne sert qu'a satisfaire le contrat. */
function make(over: Partial<LongDeps> = {}): LongRecorder {
  return new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    store: fakeCaptureStore(),
    stagingRootOverride: path.join(os.tmpdir(), "flow-hist-legacy-staging"),
    schedule: () => () => {},
    ...over,
  });
}

// ---------------------------------------------------------------------------
// B3a : LA CASE « GARDER L'AUDIO » DECIDE ENCORE QUELQUE CHOSE.
//
// Les quatre tests que ces deux-la remplacent verifiaient le trajet
// staging/ -> history/ : un trajet qui n'existe plus, parce que le document ne
// touche plus le disque. La PROMESSE, elle, survit sans changer d'un mot - le
// .wav est ecrit pendant toute la capture, quoi que dise la case (c'est la seule
// chose qui peut encore sauver une reunion dont la transcription tombe), et
// c'est a la FIN que la case tranche.
// ---------------------------------------------------------------------------

test("U4-2: keepAudio decoche - le .wav en transit est supprime des que le document est sur", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hist-audio-off-"));
  const pending = path.join(work, "pending");
  const rec = make({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 5 }),
    pendingAudioDir: pending,
    historyRootOverride: path.join(work, "history"),
  });

  const started = rec.start({ title: "No Audio Please", keepAudio: false });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  // Le .wav est ouvert MEME avec la case decochee : pendant la capture, c'est le
  // dernier recours si la transcription tombe, et un plantage ne donne pas de
  // seconde chance de commencer a l'ecrire.
  const wav = path.join(pending, started.recordingId! + ".wav");
  assert.equal(fs.existsSync(wav), true, "l'audio est ecrit pendant la capture, quoi que dise la case");

  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false);

  assert.equal(fs.existsSync(wav), false, "et il disparait a la fin : la case decrit ce que Flow GARDE");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-2: keepAudio cochee - le .wav survit a la fin, pour partir vers Storage", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-hist-audio-on-"));
  const pending = path.join(work, "pending");
  const rec = make({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 5 }),
    pendingAudioDir: pending,
    historyRootOverride: path.join(work, "history"),
  });
  const started = rec.start({ title: "Keep It", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false);

  const wav = path.join(pending, started.recordingId! + ".wav");
  assert.equal(fs.existsSync(wav), true, "la case cochee garde l'audio");
  // Et son entete de taille a ete corrigee : un fichier deplace avant la
  // fermeture du flux parait vide a tous les lecteurs.
  const head = fs.readFileSync(wav);
  assert.equal(head.subarray(0, 4).toString(), "RIFF");
  assert.equal(head.readUInt32LE(4), 36 + head.readUInt32LE(40), "RIFF et data se repondent");
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

  const rec = make({ historyRootOverride: history });
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
  const rec = make({ historyRootOverride: work });
  rec.purgeHistory();
  assert.equal(fs.existsSync(path.join(oldDir, "real-user-file.md")), true, "no marker = not our folder = untouched");
  fs.rmSync(work, { recursive: true, force: true });
});

test("C10 F1: purgeHistory refuses an immediate child of the user profile (Documents-like)", () => {
  const logs: string[] = [];
  const rec = make({
    historyRootOverride: path.join(os.homedir(), "Documents"),
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.ok(logs.some((m) => /refused/i.test(m)), "a profile child (Documents, Desktop, OneDrive) must be refused");
});

test("C10: purgeHistory refuses to operate on the user's profile root", () => {
  const logs: string[] = [];
  const rec = make({
    historyRootOverride: os.homedir(),
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.ok(logs.some((m) => /refused/i.test(m)), "the profile root must be refused, never scanned");
});

test("C10: purgeHistory refuses to operate on a filesystem/volume root", () => {
  const logs: string[] = [];
  const root = path.parse(process.cwd()).root; // e.g. "C:\\" on Windows, "/" elsewhere
  const rec = make({
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
  const rec = make({
    historyRootOverride: history,
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();
  assert.equal(logs.length, 0, "nothing to purge, nothing to log");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U2a: historyRoot() is fixed under dataDir(), no longer configurable", () => {
  // A5: the folder name is resolved (~/.flow, or ~/.agr-flow until the machine
  // is migrated), so assert the RELATION to dataDir() rather than a literal name.
  const root = historyRoot();
  assert.equal(root, path.join(dataDir(), "history"), "always lives under Flow's data folder");
  // U2c: the previous line here compared historyRoot() to itself, which is true
  // whatever the implementation does. These bite instead.
  assert.equal(path.basename(root), "history");
  assert.equal(path.dirname(root), dataDir(), "exactly one level under the data folder");
  assert.ok(path.isAbsolute(root), "an absolute path, never relative to the cwd");
  assert.equal(historyRoot.length, 0, "takes no argument: nothing can point it elsewhere");
  // The seam used everywhere else agrees with the real thing.
  assert.equal(historyRootFor(dataDir()), root);
});

test("U2c: a settings.json still carrying historyDir yields the FIXED history root, and the old folder is captured", async () => {
  // The chain the two waves left untested end to end: a raw settings.json from
  // a machine that had chosen D:\Reunions must (a) still resolve the history
  // root to the fixed folder, (b) have its choice CAPTURED by the migration,
  // and (c) lose the field on the way through sanitizeSettings.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-u2c-chain-"));
  const home = path.join(root, "home");
  const local = path.join(root, "local");
  const dataDirNew = path.join(home, DATA_DIR_NEW);
  fs.mkdirSync(dataDirNew, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  const chosen = path.join(root, "Reunions");
  fs.mkdirSync(chosen, { recursive: true });
  const raw = { language: "fr", historyDir: chosen };
  fs.writeFileSync(path.join(dataDirNew, "settings.json"), JSON.stringify(raw));

  const out = await runMigration({
    home,
    localAppData: local,
    selfVersion: "1.0.0",
    selfPid: process.pid,
    isAlive: () => false,
    requestQuit: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    graceMs: 0,
  });

  assert.equal(out.dataDir, dataDirNew);
  assert.equal(out.legacyHistoryDir, chosen, "the choice is captured, exactly once, by the migration");
  const fixed = historyRootFor(out.dataDir);
  assert.equal(fixed, path.join(dataDirNew, "history"), "the history root ignores the setting entirely");
  assert.notEqual(path.resolve(fixed), path.resolve(chosen), "and is NOT where the user's recordings are");
  assert.equal(historyRootFor(resolveDataDir(home)), fixed, "same answer the app itself would compute for this machine");
  // (c) the setting really is gone once it goes through the sanitizer.
  const s = sanitizeSettings(raw);
  assert.equal("historyDir" in s, false, "the retired field is dropped");
  assert.equal(s.legacyHistoryDir, "", "and does NOT leak into the new field by itself: index.ts writes it");

  fs.rmSync(root, { recursive: true, force: true });
});

test("U2c: a suspended purge deletes NOTHING, however old the folders are", () => {
  // The blocking finding: on a machine that had moved its recordings elsewhere,
  // the fixed folder is a frozen archive carrying the marker from when it WAS
  // the default. Every other guardrail waves the deletion through - only the
  // suspension flag stands between an untouched 200-day-old archive and rmSync.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-purge-suspended-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker written back when this folder was the default\n");
  const dayMs = 24 * 60 * 60 * 1000;
  const oldDir = path.join(history, ymd(new Date(Date.now() - 200 * dayMs)));
  fs.mkdirSync(oldDir);
  const precious = path.join(oldDir, "board-meeting.md");
  fs.writeFileSync(precious, "a meeting that cannot be re-recorded");

  const logs: string[] = [];
  const rec = make({
    historyRootOverride: history,
    historyPurgeSuspended: () => true,
    log: (m) => logs.push(m),
  });
  rec.purgeHistory();

  assert.equal(fs.existsSync(precious), true, "a suspended purge must not delete a single file");
  assert.equal(fs.existsSync(oldDir), true, "nor the dated folder itself");
  assert.ok(logs.some((m) => /SUSPENDED/.test(m)), "and it says so, out loud, in the log");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U2c: with the flag off, the purge still does its job (no regression)", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-purge-notsuspended-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  const dayMs = 24 * 60 * 60 * 1000;
  const oldDir = path.join(history, ymd(new Date(Date.now() - 200 * dayMs)));
  const keepDir = path.join(history, ymd(new Date(Date.now() - 10 * dayMs)));
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, "note.md"), "old");
  fs.mkdirSync(keepDir);
  fs.writeFileSync(path.join(keepDir, "note.md"), "recent");

  const rec = make({
    historyRootOverride: history,
    historyPurgeSuspended: () => false, // explicitly NOT suspended
  });
  rec.purgeHistory();

  assert.equal(fs.existsSync(oldDir), false, "the normal retention still removes what is past 90 days");
  assert.equal(fs.existsSync(keepDir), true, "and still keeps what is inside the window");
  fs.rmSync(work, { recursive: true, force: true });
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

test("Archive: a recording folder with no transcript never resolves (the rule listHistory used to enforce for it)", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-resolve-nodoc-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  // Audio but no .md: not a recording anything may surface.
  const orphan = path.join(history, "2026-05-02", "audio-only");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "audio-only.wav"), Buffer.from("RIFF0000WAVE"));

  const id = Buffer.from("2026-05-02/audio-only", "utf8").toString("base64url");
  assert.equal(resolveHistoryEntry(id, history), null, "no transcript = the entry does not exist");

  fs.rmSync(work, { recursive: true, force: true });
});

// ---- U5 review, constat 2: resolving an id must not walk the whole archive ----
//
// resolveHistoryEntry used to end with listHistory(root).find(...), a full
// SYNCHRONOUS enumeration of the archive on the main process - once per
// download AND once per Range request, i.e. once per seek in the audio player.
// The proof below is a COUNT, not a claim: every synchronous filesystem entry
// point longform.ts uses is wrapped for the duration of one call and the calls
// are tallied. An implementation that enumerates grows with the archive; one
// that goes straight to the folder cannot.

const COUNTED_FS_CALLS = ["readdirSync", "lstatSync", "statSync", "existsSync", "readFileSync", "openSync"] as const;

function countFsCalls<T>(fn: () => T): { result: T; calls: number } {
  const target = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const saved = new Map<string, (...args: unknown[]) => unknown>();
  let calls = 0;
  for (const name of COUNTED_FS_CALLS) {
    const orig = target[name];
    saved.set(name, orig);
    target[name] = (...args: unknown[]) => {
      calls++;
      return orig(...args);
    };
  }
  try {
    const result = fn();
    return { result, calls };
  } finally {
    for (const [name, orig] of saved) target[name] = orig;
  }
}

/** Seed a MARKED history root with `days` date folders of `perDay` recordings,
 * returning every entry's id (built the way listHistory builds it). */
function seedArchive(root: string, days: number, perDay: number, tag: string): string[] {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".agr-flow-history"), "marker\n");
  const ids: string[] = [];
  const base = Date.UTC(2026, 0, 1);
  for (let d = 0; d < days; d++) {
    const date = new Date(base + d * 86_400_000).toISOString().slice(0, 10);
    for (let r = 0; r < perDay; r++) {
      const title = `${tag}-${d}-${r}`;
      const dir = path.join(root, date, title);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${title}.md`), "# " + title);
      ids.push(Buffer.from(`${date}/${title}`, "utf8").toString("base64url"));
    }
  }
  return ids;
}

test("U5 constat 2: resolving an id costs the same handful of filesystem calls whatever the archive holds", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-resolve-cost-"));
  const small = path.join(work, "small");
  const large = path.join(work, "large");
  const smallIds = seedArchive(small, 2, 2, "s"); // 4 recordings
  const largeIds = seedArchive(large, 40, 5, "l"); // 200 recordings: 50x the archive

  // Control, so a constant result below actually means something: the full
  // ENUMERATION does scale with the archive, and the counter sees it.
  const smallList = countFsCalls(() => listHistory(small));
  const largeList = countFsCalls(() => listHistory(large));
  assert.equal(smallList.result.length, 4);
  assert.equal(largeList.result.length, 200);
  assert.ok(
    largeList.calls > smallList.calls * 10,
    `a full listing scales with the archive (${smallList.calls} -> ${largeList.calls} calls)`,
  );

  const smallResolve = countFsCalls(() => resolveHistoryEntry(smallIds[0], small));
  const firstOfLarge = countFsCalls(() => resolveHistoryEntry(largeIds[0], large));
  const lastOfLarge = countFsCalls(() => resolveHistoryEntry(largeIds[largeIds.length - 1], large));
  assert.ok(smallResolve.result, "the small archive's id resolves");
  assert.ok(firstOfLarge.result, "the large archive's first id resolves");
  assert.ok(lastOfLarge.result, "the large archive's last id resolves too");

  assert.equal(firstOfLarge.calls, smallResolve.calls, "a 50x bigger archive costs exactly the same");
  assert.equal(lastOfLarge.calls, smallResolve.calls, "and where the entry sits in it is irrelevant");
  assert.ok(
    smallResolve.calls < smallList.calls,
    `a resolution is cheaper than listing even the TINY archive (${smallResolve.calls} vs ${smallList.calls})`,
  );
  assert.ok(smallResolve.calls <= 8, `a resolution stays a handful of calls (was ${smallResolve.calls})`);

  // The Range-request case that motivated this: the audio player emits one
  // Range request per seek, and each one resolves the id again. Ten seeks must
  // cost ten cheap lookups, not ten walks of the whole archive.
  const tenSeeks = countFsCalls(() => {
    for (let i = 0; i < 10; i++) resolveHistoryEntry(largeIds[3], large);
  });
  assert.equal(tenSeeks.calls, 10 * smallResolve.calls, "ten Range requests = ten constant-cost lookups");

  fs.rmSync(work, { recursive: true, force: true });
});

// ---- U5a: readHistoryDoc - the ONE implementation behind both the HTTP
// /long/history/doc route and the UI_HISTORY_DOC IPC channel ----

test("U5a: readHistoryDoc resolves a real id to its title/date/text", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-readdoc-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  const recDir = path.join(history, "2026-07-27", "client-kickoff");
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, "client-kickoff.md"), "# Client Kickoff\n\nHello there.");

  const id = listHistory(history)[0].id;
  const doc = readHistoryDoc(id, history);
  assert.ok(doc, "a real id resolves");
  assert.equal(doc!.date, "2026-07-27");
  assert.equal(doc!.title, "client-kickoff");
  assert.equal(doc!.text, "# Client Kickoff\n\nHello there.");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5a: readHistoryDoc refuses an unknown/forged id cleanly (null, not a throw)", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-readdoc-bad-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");

  assert.equal(readHistoryDoc("not-a-real-id", history), null);
  assert.equal(readHistoryDoc("", history), null);
  const staleId = Buffer.from("2026-01-01/never-existed", "utf8").toString("base64url");
  assert.equal(readHistoryDoc(staleId, history), null);

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5a: readHistoryDoc caps an oversized document rather than reading it whole into memory-bound text", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-readdoc-cap-"));
  const history = path.join(work, "history");
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, ".agr-flow-history"), "marker\n");
  const recDir = path.join(history, "2026-07-27", "huge-meeting");
  fs.mkdirSync(recDir, { recursive: true });
  const big = "x".repeat(6 * 1024 * 1024); // 6 MB > the 5 MB cap
  fs.writeFileSync(path.join(recDir, "huge-meeting.md"), big);

  const id = listHistory(history)[0].id;
  const doc = readHistoryDoc(id, history);
  assert.ok(doc);
  assert.equal(doc!.text.length, 5 * 1024 * 1024, "capped at ~5 MB");

  fs.rmSync(work, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 2026-07-30: deleting a capture. Flow's first invariant is that it never
// deletes a recording it was not managing, and a delete-by-id is precisely
// where that could go wrong - so these tests are about what it REFUSES.
// ---------------------------------------------------------------------------

function seedCapture(root: string, date: string, title: string): string {
  // listHistory only reads a root that carries the marker file - the guard that
  // stops it walking a folder Flow does not own.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".agr-flow-history"), "", "utf8");
  const dir = path.join(root, date, title);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, title + ".md"), "# " + title + "\n\n[00:00:01] hello\n", "utf8");
  fs.writeFileSync(path.join(dir, "audio.wav"), "not really audio", "utf8");
  return dir;
}

test("deleting a capture removes its folder and nothing beside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-del-"));
  const gone = seedCapture(root, "2026-07-30", "Weekly sync");
  const kept = seedCapture(root, "2026-07-30", "Client call");
  const id = listHistory(root).find((i) => i.title === "Weekly sync")!.id;

  const r = deleteHistoryEntry(id, root);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(gone), false, "the capture is gone, audio included");
  assert.equal(fs.existsSync(kept), true, "and its neighbour is untouched");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a forged id is REFUSED, and refusing says so instead of failing silently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-del-"));
  seedCapture(root, "2026-07-30", "Weekly sync");
  for (const bad of ["", "not-base64", Buffer.from("../../etc", "utf8").toString("base64url")]) {
    const r = deleteHistoryEntry(bad, root);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.ok(r.error && r.error.length > 0, "and a user-readable reason, never a silent no-op");
  }
  assert.equal(listHistory(root).length, 1, "nothing was removed by any of them");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an id that resolves OUTSIDE the recordings folder is refused by the second guard", () => {
  // The roundtrip check in resolveHistoryEntry already stops this today. The
  // containment check exists for the day it does not: the failure mode here is
  // deleting a folder that belongs to someone else, so one guard is not enough.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-del-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-other-"));
  fs.writeFileSync(path.join(outside, "precious.txt"), "someone else's file", "utf8");
  const id = Buffer.from("../../" + path.basename(outside) + "/x", "utf8").toString("base64url");

  const r = deleteHistoryEntry(id, root);
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(outside, "precious.txt")), true, "untouched");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("deleting one that is already gone reports it rather than pretending it worked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-del-"));
  seedCapture(root, "2026-07-30", "Weekly sync");
  const id = listHistory(root)[0].id;
  assert.equal(deleteHistoryEntry(id, root).ok, true);
  const second = deleteHistoryEntry(id, root);
  assert.equal(second.ok, false, "a user clicking twice must not be told the second one worked");
  fs.rmSync(root, { recursive: true, force: true });
});
