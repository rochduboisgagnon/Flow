import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { numberedFilename } from "../shared/downloadName";
import type { DownloadResult } from "../shared/ipcContracts";

// U5c (Roch's decision): downloading a capture from the archive behaves like a
// browser download - straight into the OS Downloads folder, no "Save as"
// dialog, no path ever supplied by the renderer (only an opaque history id).
// This is deliberately main-process-only IPC, not an HTTP route: the HTTP API
// serves a remote PWA on another device, which has no business writing files
// into THIS machine's Downloads folder.
//
// DownloadResult itself lives in shared/ipcContracts.ts (compiled into the
// renderer/preload build too, same reason as every other IPC result shape).
//
// ---------------------------------------------------------------------------
// U5 REVIEW, MAJEUR 1 + 2: THE CANONICAL NAME IS ONLY EVER A WHOLE FILE
// ---------------------------------------------------------------------------
// The first version streamed straight into the FINAL name and reported ok:true
// without comparing anything. Its cleanup covered stream errors only - never
// the death of the process, which is the failure this app actually meets: the
// updater relaunches Flow whenever it feels like it (a download is not part of
// engineBusy()), and before-quit knows nothing about a copy in flight. What
// survived a kill was a file bearing the EXACT expected name, playable for its
// first minutes and then cut off. Worse, that corpse squatted the canonical
// name, so the retry landed on "... (1)" - and once retention removed the
// original from the archive, the only copy left of that meeting was the
// amputated one. That is the app lying about the user's own data.
//
// So: the bytes go into a WORK FILE, the size is verified against the source,
// and only then does the file take its canonical name - by link/rename, which
// the filesystem performs as one indivisible step. The invariant becomes
// structural rather than a matter of cleanup discipline: at every instant, a
// file bearing the canonical name is a file that was copied whole and checked.
// Killing the process mid-copy can only ever leave a work file behind, which
// the next download sweeps away.

/** Les octets a ecrire, quelle que soit leur provenance.
 *
 * B3e : ce module recevait un CHEMIN et copiait un fichier. La source est
 * maintenant une ligne du compte pour le document, et un objet de Storage pour
 * l'audio - donc « d'ou viennent les octets » devient une question a laquelle
 * l'appelant repond. Tout le reste de ce fichier - le fichier de travail, la
 * verification de taille, le nom canonique pris atomiquement - est INCHANGE, et
 * c'est voulu : ces protections repondent a la mort du processus en cours de
 * copie, un risque que le changement de source ne diminue en rien. */
export type ByteSource =
  | { kind: "text"; text: string }
  | { kind: "stream"; body: Readable };

export interface DownloadDeps {
  /** Le document d'une reunion, tel qu'il sera ecrit, et le nom qu'il portera.
   * Rend null quand l'identifiant ne designe rien - un identifiant forge, ou une
   * reunion supprimee entre l'affichage de la liste et le clic. */
  readDoc(id: string): Promise<{ stem: string; text: string } | null>;
  /** L'audio d'une reunion, EN FLUX. Jamais un tampon : un .wav d'une heure pese
   * 115 Mo, et le charger en memoire pour le recopier aussitot serait payer deux
   * fois ce que le disque va couter de toute facon. */
  openAudio(id: string): Promise<{ stem: string; bytes: number; body: Readable } | null>;
  /** app.getPath("downloads") - injected so tests never touch the real
   * Downloads folder, and so this module stays Electron-free itself. */
  downloadsDir(): string;
  log?(msg: string): void;
}

/** The suffix a copy in progress wears, and the ONLY thing the orphan sweep
 * will ever delete. Deliberately NOT the conventional ".part": Firefox names
 * its own in-progress downloads "<name>.part" in this very folder, and a sweep
 * that matched those would eat a download Flow has nothing to do with. A
 * suffix nobody else writes is what makes "clean up after ourselves" safe. */
export const PART_SUFFIX = ".flow-part";

/** What the user is told when nothing more specific is known. MAJEUR/MINEUR 7:
 * DownloadResult.error is rendered verbatim by the page, so a raw Node error
 * ("Error: EPERM: operation not permitted, open 'C:\\Users\\...'") was both
 * unreadable and a leak of internals. The technical text goes to the log,
 * which is what a bug report carries. */
const SAVE_FAILED = "Flow could not save that file to your Downloads folder.";

/** An error that carries something the USER can read, alongside the technical
 * detail for the log. Anything else that escapes is reported as SAVE_FAILED. */
class DownloadFailure extends Error {
  readonly userMessage: string;
  constructor(userMessage: string, detail: string) {
    super(detail);
    this.name = "DownloadFailure";
    this.userMessage = userMessage;
  }
}

/** Copies `src` into a brand-new file at `dest`, EXCLUSIVELY ("wx": fails with
 * EEXIST rather than truncating an existing file) and by STREAM. Never a
 * readFileSync/writeFileSync of the whole file: the main process carries the
 * keyboard hook, and a synchronous read of a multi-hundred-MB .wav would
 * freeze dictation for as long as the copy takes. The 'wx' flag also closes
 * the check-then-write race a plain existsSync()-then-write() would leave
 * open - the exclusivity is enforced by the filesystem itself, not by this
 * function's own bookkeeping. Rejects (never throws synchronously) on ANY
 * failure, including EEXIST (the caller's retry loop reads that code); a file
 * left behind by a failure, partial OR empty, is removed.
 *
 * `dest` is a WORK file (PART_SUFFIX), never the canonical name - see the
 * module note. That is also what makes the cleanup below safe by construction
 * (review, MINEUR 3): the path removed is not merely "the path we aimed at",
 * it is a path this call created itself, under a suffix no other program
 * writes, so no pre-existing file of the user's can ever be at the end of it.
 *
 * U5 review, constat 1 (the 0-byte corpse): the destination is opened FIRST,
 * ALONE, and the source is not touched until that open has answered. Opening
 * both at once left the cleanup keyed on "has the WriteStream emitted 'open'
 * yet", and a ReadStream on a missing or AV-locked source loses that race
 * routinely - so the rejection path ran while the exclusive create, already
 * dispatched and no longer cancellable, went on to leave a 0-byte file.
 *
 * The guard is deliberately NOT "did a stream open" but "did WE create this
 * file". An unconditional rm would be the worse bug: on the EEXIST path the
 * file at `dest` was created by someone else, and this function must never
 * touch it. `created` can only be set by our own exclusive create succeeding. */
function streamCopyExclusive(src: ByteSource, dest: string, log?: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const write = fs.createWriteStream(dest, { flags: "wx" });
    let read: Readable | null = null;
    let created = false;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      read?.destroy();
      write.destroy();
      if (!created) {
        reject(err); // 'wx' refused up front (EEXIST or similar): nothing of ours exists
        return;
      }
      fs.rm(dest, { force: true }, (rmErr) => {
        // Swallowing this was hiding the ONE failure the user has to clean up
        // by hand: the copy failed AND the debris survived.
        if (rmErr) log?.(`[download] could not remove ${dest} after a failed copy: ${rmErr}`);
        reject(err);
      });
    };

    write.once("error", fail);
    write.once("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    write.once("open", () => {
      created = true; // the file at `dest` exists because of THIS call, and only because of it
      if (src.kind === "text") {
        // Un document tient en memoire par construction - le tampon le borne a
        // 8 Mo - donc une seule ecriture suffit, et `end` declenche le "close"
        // que la promesse attend, exactement comme la fin d'un tuyau.
        write.end(src.text, "utf8");
        return;
      }
      read = src.body;
      read.once("error", fail);
      read.pipe(write);
    });
  });
}

// Generous but bounded: a real Downloads folder never legitimately holds
// anywhere near this many copies of the same recording; a runaway loop must
// still terminate rather than spin forever if something keeps colliding.
const MAX_NAME_ATTEMPTS = 1000;

// Codes a filesystem answers when it has no hard links at all (exFAT stick,
// some SMB shares, a few cloud-sync placeholders). They are the ONLY reason to
// fall back to rename() below - any other code is a real failure.
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "EINVAL"]);

/** Existence as a boolean, without throwing. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Removes a file THIS process created under PART_SUFFIX. Failure is logged,
 * never thrown: a work file we could not delete is debris, not a reason to
 * lose the outcome the caller is reporting. */
async function removeWorkFile(p: string, log?: (msg: string) => void): Promise<void> {
  try {
    await fs.promises.rm(p, { force: true });
  } catch (err) {
    log?.(`[download] could not remove the work file ${p}: ${err}`);
  }
}

/** Deletes work files a previous copy never finished - the ones a crash, a
 * forced quit or an updater relaunch mid-transfer leaves behind (MAJEUR 1: the
 * process death nothing else covers). Only PART_SUFFIX names are ever touched,
 * and never one this process is writing right now (`inFlight`), which is what
 * keeps the sweep from deleting a live copy of ours. Flow is single-instance,
 * so there is no second Flow whose work file could be mistaken for an orphan.
 * Never throws: a folder we cannot read is a reason to skip the sweep, not to
 * fail the download the user asked for. */
async function sweepOrphanWorkFiles(dir: string, inFlight: Set<string>, log?: (msg: string) => void): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(PART_SUFFIX)) continue;
    const p = path.join(dir, name);
    if (inFlight.has(p)) continue;
    try {
      await fs.promises.unlink(p);
      log?.(`[download] removed an unfinished copy left by a previous run: ${p}`);
    } catch (err) {
      log?.(`[download] could not remove the leftover work file ${p}: ${err}`);
    }
  }
}

/** Gives the finished, verified work file its canonical name, and returns the
 * name it actually took.
 *
 * link()+unlink() rather than rename(): rename REPLACES an existing
 * destination on both Windows and POSIX, and the canonical name has been
 * unreserved for the entire duration of the copy - minutes, on a 500 MB wav -
 * which is ample time for the user to have saved a file of that exact name
 * themselves. link() is the one move Node offers that fails (EEXIST) instead
 * of clobbering, so "never overwrite the user's file" survives even that
 * window. Both operations are atomic per the volume: at no instant does the
 * canonical name hold a partial file.
 *
 * Filesystems with no hard links answer one of NO_HARDLINK_CODES; those fall
 * back to the checked rename the review asked for, whose (microsecond) window
 * between the check and the move is the best available there. */
async function publishFinishedCopy(
  part: string,
  dir: string,
  stem: string,
  ext: string,
  from: number,
  log?: (msg: string) => void,
): Promise<string> {
  for (let variant = from; variant < MAX_NAME_ATTEMPTS; variant++) {
    const dest = path.join(dir, numberedFilename(stem, ext, variant));
    try {
      await fs.promises.link(part, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue; // taken while we were copying: browser-style, next number
      if (!code || !NO_HARDLINK_CODES.has(code)) throw err;
      if (await pathExists(dest)) continue;
      await fs.promises.rename(part, dest);
      return dest;
    }
    // The canonical name now points at the finished bytes; the work file is
    // just a second name for them. Losing this unlink costs an orphan the next
    // download sweeps away - never the download itself.
    await removeWorkFile(part, log);
    return dest;
  }
  throw new DownloadFailure(
    "Your Downloads folder already holds too many copies of this capture.",
    `too many "${stem}" downloads already in ${dir}`,
  );
}

/** Streams `src` into `dir` under a browser-style de-duplicated name built from
 * `stem`/`ext` (numberedFilename): the plain name first, then " (1)", " (2)"...
 * on a collision. Returns the path actually written.
 *
 * The canonical name is checked BEFORE the copy (skip to the next number if it
 * is taken) and taken atomically AFTER it - see publishFinishedCopy. In
 * between, the only thing on disk is a PART_SUFFIX work file.
 *
 * `expectedBytes` is what the source measured before any of this started
 * (MAJEUR 2): a copy is "done" only when the destination holds exactly that
 * many bytes. Anything else - a full disk that stopped short, a source rewritten
 * underneath us - is a failure, the work file goes, and the user is told. Flow
 * never says "Saved to ..." about a file it has not counted. */
async function copyIntoDownloads(
  dir: string,
  stem: string,
  ext: string,
  src: ByteSource,
  expectedBytes: number,
  inFlight: Set<string>,
  log?: (msg: string) => void,
): Promise<string> {
  // U5 review, constat 3 (first round): async, like every other step of this
  // copy path. The Downloads folder is precisely the one the user is invited to
  // relocate, so it can be a network share or a disconnected OneDrive that takes
  // seconds to answer - and a blocking call here freezes the main process,
  // keyboard hook and dictation included, for exactly that long.
  await fs.promises.mkdir(dir, { recursive: true });
  // Before picking a name, not after: an orphan holds the work name of its own
  // variant, so sweeping first lets this download reuse the canonical name a
  // killed one was aiming for.
  await sweepOrphanWorkFiles(dir, inFlight, log);

  for (let variant = 0; variant < MAX_NAME_ATTEMPTS; variant++) {
    const dest = path.join(dir, numberedFilename(stem, ext, variant));
    const part = dest + PART_SUFFIX;
    // Taken already (the user's own file, or an earlier download): move on
    // rather than copy 500 MB only to find at publish time it has nowhere to go.
    if (await pathExists(dest)) continue;
    if (inFlight.has(part)) continue;
    inFlight.add(part);
    try {
      try {
        await streamCopyExclusive(src, part, log);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // next number
        throw err;
      }
      let got: number;
      try {
        got = (await fs.promises.stat(part)).size;
      } catch (err) {
        await removeWorkFile(part, log);
        throw new DownloadFailure(SAVE_FAILED, `could not measure the copy at ${part}: ${err}`);
      }
      if (got !== expectedBytes) {
        await removeWorkFile(part, log);
        throw new DownloadFailure(
          "Flow could not save that file: the copy came out incomplete, so it was removed. Try again.",
          `size mismatch at ${part}: expected ${expectedBytes} bytes, wrote ${got}`,
        );
      }
      try {
        return await publishFinishedCopy(part, dir, stem, ext, variant, log);
      } catch (err) {
        // The bytes are verified but they could not take a name: leaving the
        // work file would be debris under a name nothing plays.
        await removeWorkFile(part, log);
        throw err;
      }
    } finally {
      inFlight.delete(part);
    }
  }
  throw new DownloadFailure(
    "Your Downloads folder already holds too many copies of this capture.",
    `too many "${stem}" downloads already in ${dir}`,
  );
}

export class DownloadManager {
  private deps: DownloadDeps;
  // U5c: the last file this session actually wrote, for UI_OPEN_PATH's
  // "downloaded-file" destination (shell.showItemInFolder). NEVER sourced
  // from the renderer - only ever set by a download that just succeeded here.
  private lastPath: string | null = null;
  // The work files being written RIGHT NOW, so the orphan sweep can tell a
  // live copy from the corpse of a dead one.
  private inFlight = new Set<string>();

  constructor(deps: DownloadDeps) {
    this.deps = deps;
  }

  lastDownloadedPath(): string | null {
    return this.lastPath;
  }

  downloadDoc(id: string): Promise<DownloadResult> {
    return this.download(id, "doc");
  }

  downloadAudio(id: string): Promise<DownloadResult> {
    return this.download(id, "audio");
  }

  private async download(id: string, kind: "doc" | "audio"): Promise<DownloadResult> {
    // La page ne remet qu'un identifiant, et la resolution se fait ici.
    //
    // B3e : le schema d'identifiants opaques a disparu avec le dossier qu'il
    // confinait, et il n'y a rien a regretter - le RLS est une garde plus forte
    // que le confinement de chemin qu'il remplace. Un identifiant forge ne rend
    // pas le document d'un autre compte : il ne rend RIEN, parce que la requete
    // porte le jeton de celui qui la fait.
    let src: ByteSource;
    let stem: string;
    let expectedBytes: number;
    try {
      if (kind === "doc") {
        const doc = await this.deps.readDoc(id);
        if (!doc) return { ok: false, error: "recording not found" };
        stem = doc.stem;
        src = { kind: "text", text: doc.text };
        // Mesure en OCTETS et non en caracteres : la verification de fin compare
        // a la taille du fichier ecrit, et un document accentue a plus d'octets
        // que de caracteres. C'est l'ecart qui ferait declarer « incomplet »
        // chaque telechargement d'un document francais.
        expectedBytes = Buffer.byteLength(doc.text, "utf8");
      } else {
        const audio = await this.deps.openAudio(id);
        if (!audio) return { ok: false, error: "no audio for this recording" };
        stem = audio.stem;
        src = { kind: "stream", body: audio.body };
        // Ce que le compte dit que l'objet pese, connu AVANT que la copie
        // commence : le nombre auquel la copie finie doit correspondre ne peut
        // pas venir d'une source qu'on est en train de lire.
        expectedBytes = audio.bytes;
      }
    } catch (err) {
      this.deps.log?.(`[download] could not read ${kind} for ${id}: ${err}`);
      return { ok: false, error: SAVE_FAILED };
    }
    const ext = kind === "doc" ? "md" : "wav";
    try {
      const dir = this.deps.downloadsDir();
      const dest = await copyIntoDownloads(dir, stem, ext, src, expectedBytes, this.inFlight, (msg) =>
        this.deps.log?.(msg),
      );
      this.lastPath = dest;
      this.deps.log?.(`[download] ${kind} -> ${dest} (${expectedBytes} bytes)`);
      return { ok: true, path: dest };
    } catch (err) {
      this.deps.log?.(`[download] could not write ${kind} for ${id}: ${err}`);
      return { ok: false, error: err instanceof DownloadFailure ? err.userMessage : SAVE_FAILED };
    }
  }
}
