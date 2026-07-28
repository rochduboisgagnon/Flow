import fs from "node:fs";
import path from "node:path";
import { resolveHistoryEntry, historyEntryLabel } from "./longform";
import { historyDownloadStem, numberedFilename } from "../shared/downloadName";
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

export interface DownloadDeps {
  historyRoot(): string;
  /** app.getPath("downloads") - injected so tests never touch the real
   * Downloads folder, and so this module stays Electron-free itself. */
  downloadsDir(): string;
  log?(msg: string): void;
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
 * U5 review, constat 1 (the 0-byte corpse): the destination is opened FIRST,
 * ALONE, and the source is not touched until that open has answered. Opening
 * both at once left the cleanup keyed on "has the WriteStream emitted 'open'
 * yet", and a ReadStream on a missing or AV-locked source loses that race
 * routinely - so the rejection path ran while the exclusive create, already
 * dispatched and no longer cancellable, went on to leave a 0-byte file. That
 * corpse both looked like a recording Flow had corrupted and squatted the
 * canonical name, pushing the next SUCCESSFUL download to "... (1)".
 *
 * The guard is deliberately NOT "did a stream open" but "did WE create this
 * file". An unconditional rm would be the worse bug: on the EEXIST path the
 * file at `dest` is the USER'S, one this function never created and must never
 * touch. `created` can only be set by our own exclusive create succeeding. */
function streamCopyExclusive(src: string, dest: string, log?: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const write = fs.createWriteStream(dest, { flags: "wx" });
    let read: fs.ReadStream | null = null;
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
      read = fs.createReadStream(src);
      read.once("error", fail);
      read.pipe(write);
    });
  });
}

// Generous but bounded: a real Downloads folder never legitimately holds
// anywhere near this many copies of the same recording; a runaway loop must
// still terminate rather than spin forever if something keeps colliding.
const MAX_NAME_ATTEMPTS = 1000;

/** Streams `src` into `dir` under a browser-style de-duplicated name built
 * from `stem`/`ext` (numberedFilename): the plain name first, then " (1)",
 * " (2)"... on a collision. Returns the path actually written. */
async function writeUniqueCopy(
  dir: string,
  stem: string,
  ext: string,
  src: string,
  log?: (msg: string) => void,
): Promise<string> {
  // U5 review, constat 3: async, like every other step of this copy path. The
  // Downloads folder is precisely the one the user is invited to relocate, so
  // it can be a network share or a disconnected OneDrive that takes seconds to
  // answer - and a blocking call here freezes the main process, keyboard hook
  // and dictation included, for exactly that long.
  await fs.promises.mkdir(dir, { recursive: true });
  for (let variant = 0; variant < MAX_NAME_ATTEMPTS; variant++) {
    const dest = path.join(dir, numberedFilename(stem, ext, variant));
    try {
      await streamCopyExclusive(src, dest, log);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // browser-style: try the next number
      throw err;
    }
  }
  throw new Error(`too many "${stem}" downloads already in ${dir}`);
}

export class DownloadManager {
  private deps: DownloadDeps;
  // U5c: the last file this session actually wrote, for UI_OPEN_PATH's
  // "downloaded-file" destination (shell.showItemInFolder). NEVER sourced
  // from the renderer - only ever set by a download that just succeeded here.
  private lastPath: string | null = null;

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
    // The renderer only ever hands over an id; resolution happens here, with
    // the exact same containment guarantees as the archive's read routes (a
    // forged/stale id is refused, never a read outside historyRoot).
    const entry = resolveHistoryEntry(id, this.deps.historyRoot());
    if (!entry) return { ok: false, error: "recording not found" };
    const src = kind === "doc" ? entry.doc : entry.audio;
    if (!src) {
      return { ok: false, error: kind === "doc" ? "no transcript for this recording" : "no audio for this recording" };
    }
    const { date, title } = historyEntryLabel(entry.dir);
    const stem = historyDownloadStem(date, title);
    const ext = kind === "doc" ? "md" : "wav";
    try {
      const dest = await writeUniqueCopy(this.deps.downloadsDir(), stem, ext, src, (msg) => this.deps.log?.(msg));
      this.lastPath = dest;
      this.deps.log?.(`[download] ${kind} -> ${dest}`);
      return { ok: true, path: dest };
    } catch (err) {
      this.deps.log?.(`[download] could not write ${kind} for ${id}: ${err}`);
      return { ok: false, error: String(err) };
    }
  }
}
