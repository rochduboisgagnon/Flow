import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { DownloadManager, PART_SUFFIX, type DownloadDeps } from "../src/main/downloads";

// U5c : le telechargement d'une capture, facon navigateur - droit dans le
// dossier Telechargements, sans boite de dialogue.
//
// B3e a change la SOURCE (une ligne du compte et un objet de Storage, au lieu de
// deux fichiers dans un dossier date) et rien d'autre. Ce que ces tests
// defendent porte sur la DESTINATION - le fichier de travail, la verification de
// taille, le nom canonique pris atomiquement, le balayage des restes - et
// survit donc mot pour mot au changement de support. C'est le harnais qui a
// bouge, pas les promesses.
//
// Aucun test ne touche le vrai dossier Telechargements.

/** Une capture, telle que le compte la detient. */
interface FakeRecording {
  title: string;
  startedIso: string;
  doc: string;
  audio: Buffer | null;
}

/** Le magasin des captures d'un test, plus le dossier Telechargements temporaire.
 * `deps()` rend exactement ce que DownloadManager attend. */
function makeAccount(work: string) {
  const downloads = path.join(work, "downloads");
  const rows = new Map<string, FakeRecording>();
  const stem = (r: FakeRecording) => `${r.startedIso.slice(0, 10)} ${r.title}`;
  return {
    downloads,
    rows,
    /** Ajoute une capture et rend son identifiant. */
    add(id: string, title: string, opts: { audio?: boolean; date?: string } = {}): string {
      rows.set(id, {
        title,
        startedIso: (opts.date ?? "2026-07-27") + "T13:00:00.000Z",
        doc: `# ${title}\n\nHello.`,
        audio: opts.audio ? Buffer.from("RIFF0000WAVE") : null,
      });
      return id;
    },
    deps(over: Partial<DownloadDeps> = {}): DownloadDeps {
      return {
        readDoc: (id: string) => {
          const r = rows.get(id);
          return Promise.resolve(r ? { stem: stem(r), text: r.doc } : null);
        },
        openAudio: (id: string) => {
          const r = rows.get(id);
          if (!r?.audio) return Promise.resolve(null);
          return Promise.resolve({ stem: stem(r), bytes: r.audio.length, body: Readable.from(r.audio) });
        },
        downloadsDir: () => downloads,
        ...over,
      };
    },
  };
}



test("downloadDoc: an unknown/forged id is refused cleanly, never throws", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-unknown-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const mgr = new DownloadManager(acct.deps());

  const res = await mgr.downloadDoc("not-a-real-id");
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.equal(fs.existsSync(downloads), false, "nothing was written for an id that does not resolve");

  fs.rmSync(work, { recursive: true, force: true });
});

test("downloadAudio: refuses cleanly when the recording exists but has no audio", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-noaudio-"));
  const acct = makeAccount(work);

  const id = acct.add("rec-1", "client-kickoff", { audio: false, date: "2026-07-27" });
  const mgr = new DownloadManager(acct.deps());

  const res = await mgr.downloadAudio(id);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /audio/i);

  fs.rmSync(work, { recursive: true, force: true });
});

test("downloadDoc writes \"YYYY-MM-DD Title.md\" straight into the downloads dir, by streaming (not readFileSync)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-doc-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "client-kickoff", { audio: true, date: "2026-07-27" });
  const mgr = new DownloadManager(acct.deps());

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
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "client-kickoff", { audio: true, date: "2026-07-27" });
  const mgr = new DownloadManager(acct.deps());

  const res = await mgr.downloadAudio(id);
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 client-kickoff.wav"));
  assert.equal(fs.existsSync(res.path!), true);

  fs.rmSync(work, { recursive: true, force: true });
});

test("three downloads of the SAME recording in a row never overwrite - browser-style (1), (2) numbering", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-triple-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "weekly-sync", { audio: false, date: "2026-07-27" });
  const mgr = new DownloadManager(acct.deps());

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
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "weekly-sync", { audio: false, date: "2026-07-27" });
  fs.mkdirSync(downloads, { recursive: true });
  // A file the USER put there, unrelated to Flow, that happens to share the name.
  const clash = path.join(downloads, "2026-07-27 weekly-sync.md");
  fs.writeFileSync(clash, "not Flow's content - must survive untouched");

  const mgr = new DownloadManager(acct.deps());
  const res = await mgr.downloadDoc(id);

  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 weekly-sync (1).md"));
  assert.equal(fs.readFileSync(clash, "utf8"), "not Flow's content - must survive untouched", "the pre-existing file was never touched");

  fs.rmSync(work, { recursive: true, force: true });
});

test("a write failure (destination cannot be created) yields {ok:false, error}, never an exception", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-fail-"));
  const acct = makeAccount(work);
  const id = acct.add("rec-1", "client-kickoff", { audio: false, date: "2026-07-27" });
  // A regular FILE where the downloads directory should be: mkdirSync(recursive)
  // cannot create a directory on top of it, and every attempted write fails.
  const blockedDownloads = path.join(work, "downloads-is-a-file");
  fs.writeFileSync(blockedDownloads, "not a directory");
  const mgr = new DownloadManager(acct.deps({ downloadsDir: () => blockedDownloads }));

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

/**
 * B3e : une SOURCE QUI TOMBE, exprimee sur un flux plutot que sur un fichier.
 *
 * Les trois tests ci-dessous prouvaient la meme chose avec un fichier local
 * qu'ils supprimaient ou remplacaient par un dossier entre la resolution et la
 * copie. La source est maintenant un flux venu de Storage, donc « la source
 * tombe » s'exprime autrement - et mieux, parce que les deux formes qui compte
 * vraiment deviennent explicites :
 *
 *  - `kind: "error"` : le flux emet une erreur en cours de route. C'est la
 *    coupure reseau au milieu d'un telechargement de 115 Mo.
 *  - `kind: "short"` : le flux annonce N octets et n'en livre que la moitie.
 *    C'est le cas vicieux - aucune erreur n'est levee, tout a l'air d'avoir
 *    marche, et seule la verification de taille l'attrape.
 */
function brokenAudio(acct: ReturnType<typeof makeAccount>, id: string, kind: "error" | "short"): DownloadDeps {
  return acct.deps({
    openAudio: () => {
      const bytes = 12;
      const body = new Readable({
        read() {
          this.push(Buffer.from("RIFF00"));
          if (kind === "error") this.destroy(new Error("le stockage a coupe"));
          else this.push(null); // fin prematuree : six octets sur douze annonces
        },
      });
      return Promise.resolve({ stem: "2026-07-27 reunion", bytes, body });
    },
  });
}

test("U5 constat 1: a source that VANISHED leaves no 0-byte corpse, and the canonical name stays free", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-vanished-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "reunion", { audio: true, date: "2026-07-27" });
  const canonical = path.join(downloads, "2026-07-27 reunion.wav");

  const broken = new DownloadManager(brokenAudio(acct, id, "error"));
  const res = await broken.downloadAudio(id);

  assert.equal(res.ok, false, "a source that fell over cannot be downloaded");
  assert.deepEqual(fs.readdirSync(downloads), [], "no file at all is left in the destination folder");
  assert.equal(fs.existsSync(canonical), false, "and specifically not a truncated file under the canonical name");
  assert.equal(broken.lastDownloadedPath(), null, "a failed download is never remembered as the last one");

  // The regression that made this MAJOR: the corpse squatted the canonical
  // name, so the first SUCCESSFUL download landed on "... (1)" instead.
  const mgr = new DownloadManager(acct.deps());
  const retry = await mgr.downloadAudio(id);
  assert.equal(retry.ok, true, retry.error ?? "expected ok");
  assert.equal(retry.path, canonical, "the retry gets the canonical name, not \" (1)\"");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 constat 1: a source that cannot be READ (locked/unreadable) leaves no debris either", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-locked-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "reunion", { audio: true, date: "2026-07-27" });

  // LE CAS VICIEUX : le flux annonce douze octets et en livre six, SANS lever
  // d'erreur. Rien ne signale l'incident ; seule la verification de taille voit
  // que la copie est incomplete, et c'est exactement pour ca qu'elle existe.
  const mgr = new DownloadManager(brokenAudio(acct, id, "short"));
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, false, "une copie incomplete n'est jamais annoncee comme reussie");
  assert.ok(res.error, "and says so");
  assert.deepEqual(fs.readdirSync(downloads), [], "no file at all is left in the destination folder");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 constat 1 (the trap): a failing copy removes ITS OWN debris and never the user's pre-existing file", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-trap-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "reunion", { audio: true, date: "2026-07-27" });
  fs.mkdirSync(downloads, { recursive: true });
  // The user's own file already holds the canonical name: the copy will get
  // EEXIST on it and move to " (1)" - and THAT is the one it created and may
  // clean up. An unconditional rm(dest) would have destroyed the file below.
  const mine = path.join(downloads, "2026-07-27 reunion.wav");
  fs.writeFileSync(mine, "the user's own file - must survive untouched");

  const mgr = new DownloadManager(brokenAudio(acct, id, "error"));
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
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const canonical = path.join(downloads, "2026-07-27 reunion.wav");
  fs.mkdirSync(downloads, { recursive: true });

  // A real child process, hard-killed while the copy runs: no exit hook, no
  // finally, no cleanup of ours gets to run. Simulating this with a stream
  // error would have tested the one path that already worked.
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(__dirname, "fixtures", "download-and-die.ts"), downloads, String(KILL_TEST_BYTES)],
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
  // download onto " (1)", nor stay in the folder forever. La reprise passe par une
  // source de la MEME taille que celle que l'enfant televersait, pour que le nom
  // canonique soit celui que le cadavre squattait.
  const id = acct.add("rec-1", "reunion", { audio: true, date: "2026-07-27" });
  const mgr = new DownloadManager(
    acct.deps({
      openAudio: () =>
        Promise.resolve({
          stem: "2026-07-27 reunion",
          bytes: KILL_TEST_BYTES,
          body: Readable.from(Buffer.alloc(KILL_TEST_BYTES, 7)),
        }),
    }),
  );
  const res = await mgr.downloadAudio(id);
  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, canonical, "the retry takes the canonical name: no corpse was squatting it");
  assert.equal(fs.statSync(canonical).size, KILL_TEST_BYTES, "and it is the WHOLE recording");
  assert.deepEqual(fs.readdirSync(downloads), ["2026-07-27 reunion.wav"], "the orphan work file was swept");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 MAJEUR 1: an orphan work file is swept, and never costs the next download its canonical name", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-orphan-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "reunion", { audio: true, date: "2026-07-27" });
  fs.mkdirSync(downloads, { recursive: true });
  // Exactly what the test above leaves behind, without paying for a spawn.
  const orphan = path.join(downloads, "2026-07-27 reunion.wav" + PART_SUFFIX);
  fs.writeFileSync(orphan, "half a recording from a run that never came back");
  // A file of the user's that merely LOOKS like debris to a careless sweep:
  // ".part" is what Firefox calls its own downloads in progress, in this very
  // folder. Flow deletes only its own suffix.
  const foreign = path.join(downloads, "someone-elses-download.part");
  fs.writeFileSync(foreign, "Firefox is still downloading this");

  const mgr = new DownloadManager(acct.deps());
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, true, res.error ?? "expected ok");
  assert.equal(res.path, path.join(downloads, "2026-07-27 reunion.wav"), "the plain name, not \" (1)\"");
  assert.equal(fs.existsSync(orphan), false, "the orphan work file is gone");
  assert.equal(fs.readFileSync(foreign, "utf8"), "Firefox is still downloading this", "another program's .part is untouched");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 MAJEUR 2: a copy whose size does not match the source is a failure, never a \"Saved to\"", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-short-"));
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  const id = acct.add("rec-1", "reunion", { audio: true, date: "2026-07-27" });

  // La source ANNONCE sa taille avant que le dossier de destination soit meme
  // demande. Un flux qui en livre moins que ce qu'il annonce a donc exactement la
  // forme d'un telechargement tronque, sans rien de son timing - et c'est la
  // seule chose que la verification de taille existe pour attraper.
  const mgr = new DownloadManager(brokenAudio(acct, id, "short"));
  const res = await mgr.downloadAudio(id);

  assert.equal(res.ok, false, "a copy that does not match the source is never reported as saved");
  assert.ok(res.error, "and the user is told why");
  assert.deepEqual(fs.readdirSync(downloads), [], "the incomplete file is removed - name free, nothing to mistake for a recording");
  assert.equal(mgr.lastDownloadedPath(), null, "and nothing is remembered as downloaded");

  fs.rmSync(work, { recursive: true, force: true });
});

test("U5 MINEUR 7: a failure hands the user a sentence and the LOG the raw Node error", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-dl-human-"));
  const acct = makeAccount(work);
  const id = acct.add("rec-1", "client-kickoff", { audio: false, date: "2026-07-27" });
  const blocked = path.join(work, "downloads-is-a-file");
  fs.writeFileSync(blocked, "not a directory");
  const logged: string[] = [];
  const mgr = new DownloadManager(acct.deps({
    downloadsDir: () => blocked,
    log: (m) => logged.push(m),
  }));

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
  const acct = makeAccount(work);
  const downloads = acct.downloads;
  acct.add("rec-1", "client-kickoff", { audio: true, date: "2026-07-27" });
  const mgr = new DownloadManager(acct.deps());

  // Un chemin de fichier passe COMME identifiant ne doit resoudre a rien. La
  // garde a change de nature avec B3e et elle est plus forte : un identifiant est
  // une cle de ligne, et une requete portant le jeton de quelqu'un ne peut rendre
  // que SES lignes - un chemin n'en est jamais une.
  const res = await mgr.downloadDoc("C:\\Users\\Roch\\secret.md");
  assert.equal(res.ok, false, "a raw path is not a valid id and must be refused");
  assert.equal(fs.existsSync(downloads), false, "et rien n'est ecrit pour un identifiant qui ne resout pas");

  fs.rmSync(work, { recursive: true, force: true });
});
