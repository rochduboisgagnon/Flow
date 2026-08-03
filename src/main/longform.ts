import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./settings";
import { CaptureDoc } from "../shared/captureDoc";
import { looksAbandoned, type OpenRecording, type RecordingRow } from "../shared/recordings";
import { audioObjectName } from "../shared/tus";
import { encodeWav } from "../shared/wav";
import { analyzeSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import type { LlmProvider } from "./llm/provider";
// U8: the ONE line format a kept live suggestion takes in the document. It lives
// in the feature's own pure module (with the gate and the prompt) rather than in
// shared/longform.ts, and is imported here exactly the way markLine is.
import {
  SAMPLE_RATE,
  SEGMENT_TARGET_MS,
  SEGMENT_MIN_MS,
  endsInPause,
  findCutPoint,
  transcriptHeader,
  transcriptLine,
  markLine,
  gapLine,
  interruptedNote,
  ENGINE_LINE,
  recordingBaseName,
  summaryPrompt,
  chunkTranscript,
  spliceNotes,
  composeNotesBlock,
  renderMyNotes,
  transcriptStamps,
  verifyCitations,
  MAX_HISTORY_ITEMS,
  type RecentEntry,
  type LongStateSnapshot,
  type LongStartResult,
  type LongStopResult,
  type LongTranscriptResult,
  type HistoryItem,
  type HistoryDocPayload,
} from "../shared/longform";

// U5a: HistoryItem/HistoryDocPayload now live in shared/longform.ts (same
// reason RecentEntry & co. do - see that file's module note); re-exported here
// so api.ts's existing `import type { HistoryItem } from "./longform"` keeps
// working unchanged.
export type { HistoryItem, HistoryDocPayload };

// C2: a 44-byte canonical WAV header (16 kHz mono 16-bit). Written with a
// placeholder size at native-capture start, then patched with the real sizes when
// the stream closes (streaming lets a multi-hour recording never sit in RAM).
function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

// The long-form recorder (plan §6 + plan v2 chantier C): continuous capture
// streamed from the DEVICE running AGR Pilot's PWA (phone or PC browser),
// arriving through the local API (/long/chunk) - never the host mic. Pause-
// aware segmentation, one warm-whisper pass
// per closed segment, INCREMENTAL transcript writes into the folder the USER
// chose (crash-safe: everything transcribed so far is already on disk), marks,
// and an optional Ollama summary at stop. Memory stays bounded: a segment's
// PCM dies right after its transcription (ring-buffer discipline).
//
// This mode is the ONLY writer of content in AGR Flow; dictation remains
// zero-retention. X last recordings are indexed in ~/.agr-flow/recent.json.

export interface LongStartOpts {
  // B3a : `dir` a disparu. Une reunion nait dans le compte, sous son
  // identifiant, et « ou est-ce que je la range » est une question de la fin -
  // ce que la colonne `staged` disait deja. Enregistrer « directement dans ce
  // dossier » n'avait de sens que quand le dossier etait le magasin.
  title?: string;
  keepAudio?: boolean; // v3 chantier 4: keep the listenable .wav (default off)
  native?: boolean; // C2: the engine captures the audio itself, so IT writes the .wav
}

// LongStateSnapshot lives in ../shared/longform now (U4a: shared/ipcContracts.ts
// reuses it for UI_LONG_STATE without pulling src/main into the renderer build).

export interface LongDeps {
  /** F1: transcribe ONE segment of this recording.
   *
   * Was `getSidecar(): WhisperSidecar | null` until F1 gave batch work its own
   * model. Two things changed and both are deliberate:
   *
   *  - The recorder no longer knows what a WhisperSidecar is. It asks for a
   *    segment to be transcribed and gets text back, which is the whole of what
   *    it ever wanted; WHICH engine serves it is a decision that now has a
   *    policy (shared/asrRole.ts) and a holder (main/asr/batchEngine.ts).
   *  - `allowEmptyDemote: false` moved INSIDE the implementation. It used to be
   *    passed here with a comment explaining that a meeting legitimately contains
   *    music and applause, so an empty decode must not demote a healthy GPU. The
   *    import pipeline passed it with the same comment for the same reason. One
   *    fact, one place. */
  transcribeSegment(wav: Uint8Array): Promise<{ text: string; ms: number }>;
  /** P1: who writes the summary. Absent means nobody does, and the document
   * ships as the transcript alone - which is already the behaviour on a machine
   * with no local model, so nothing new had to be taught to the callers.
   *
   * This module used to import Ollama by name and resolve the model itself.
   * Both moved behind the provider: "which model" is a question only the local
   * provider has, and asking it here is what made a second implementation mean
   * editing this file. */
  llm?: LlmProvider;
  /** settings.historyPurgeSuspended, read LAZILY (this module never imports
   * settings state - only dataDir()): true means the fixed history folder holds
   * an archive Flow was not managing, so the retention purge must not run at
   * all. Absent = not suspended, which is the normal case. */
  historyPurgeSuspended?(): boolean;
  /** D7: the live-notes slot (main/liveNotes.ts). Injected rather than imported
   * for the same reason as everything else in this interface - so the recorder's
   * tests never touch the real ~/.flow - and OPTIONAL so a caller that has no
   * notes panel (a test, a future headless mode) gets a recorder that behaves
   * exactly as it did before D7.
   *
   * The recorder is the only thing that reads or clears this: notes reach the
   * document through the one writer of the document, never through a second one
   * (the "double ecrivain" this vague's review is told to hunt for). */
  liveNotes?: {
    open(startedIso: string): void;
    read(startedIso: string): Array<{ atMs: number; text: string }>;
    clear(startedIso: string): void;
  };
  /** B3a : ou la reunion est ecrite. La copie de travail en memoire devant, le
   * compte derriere ; le recorder ne sait ni l'un ni l'autre. */
  store: CaptureStore;
  /** Ou le .wav en transit est ecrit. INJECTE, et non resolu ici : c'est ce qui
   * permet a ce module de ne plus appeler `dataDir()` du tout. Absent = pas
   * d'audio du tout, ce qui est le cas des tests qui ne testent que le document. */
  pendingAudioDir?: string;
  log?: (msg: string) => void;
  /** Couture de test : l'horloge des tranches. Rend de quoi l'arreter. */
  schedule?(fn: () => void, ms: number): () => void;
  /** Couture de test : l'horloge. */
  now?(): number;
  /** Couture de test : l'identifiant de la ligne. */
  newId?(): string;
  /** B3c : l'identifiant du compte, pour composer le chemin de l'objet audio.
   * Absent = pas de televersement (les tests qui ne testent que le document). */
  accountId?(): Promise<string>;
  /** B3c : confie l'audio d'une reunion terminee a la file de televersement.
   * Rend la main tout de suite - 115 Mo n'ont pas a retenir une finalisation. */
  uploadAudio?(recordingId: string): void;
  /** Tests only: keep the app-owned staging folder away from the real ~/.flow. */
  stagingRootOverride?: string;
  /** Tests only: keep the retention history away from the real ~/.agr-flow. This is
   * a TEST seam, not a user setting - U2a fixed the history folder at
   * dataDir()/history, so production code never sets this. */
  historyRootOverride?: string;
}

const MAX_QUEUE = 240; // ~100 min of backlog before we refuse to grow (safety)

// B3a : RECENT_STATE_CACHE_MS et recentPath() sont partis avec recent.json. Le
// cache existait parce que `state()` lisait un fichier JSON et faisait un
// `existsSync` par entree, jusqu'a deux fois par seconde, sur le fil qui porte
// le crochet clavier. Un champ en memoire n'a rien a mettre en cache : le
// defaut a disparu avec sa cause, pas avec un correctif.

// v6 c7 : la racine `staging/`, LEGACY depuis B3a. Plus rien n'y ecrit ; elle
// n'est plus lue que par le balayage des dossiers laisses par une version
// precedente de Flow (rescueOrphanedStaging).
export function stagingRoot(): string {
  return path.join(dataDir(), "staging");
}

// C10: a recording nobody explicitly filed at Stop still gets a home instead
// of sitting invisible in staging forever - it lands here, bucketed by date,
// and is purged after RETENTION_DAYS. U2a: FIXED under dataDir()/history, no
// longer configurable (settings.historyDir is gone - two truths about where
// recordings live was exactly the confusion a fixed folder ends).
export function historyRoot(): string {
  return historyRootFor(dataDir());
}

/** The history folder for a GIVEN data folder. Same rule as historyRoot(),
 * without the process-wide dataDir() cache: it is what lets a test assert the
 * fixed-folder rule against a sandboxed machine (the real dataDir() resolves
 * against the real home and caches its answer for the whole process). */
export function historyRootFor(dir: string): string {
  return path.join(dir, "history");
}

/** Copy a file INTO destDir without ever clobbering an existing user file: a
 * name collision gets a "-1", "-2"... suffix. COPY (not rename), so the source
 * stays put until BOTH files are safely in place - save() deletes the sources
 * only after committing (two-phase). copyFileSync works across volumes, so no
 * EXDEV special-casing is needed. */
function copyFileInto(destDir: string, src: string): string {
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dest = path.join(destDir, base);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(destDir, stem + "-" + i + ext);
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    // A failed copy can leave a truncated file (e.g. ENOSPC mid-write): remove it
    // so the user's folder is never littered with partial debris, then rethrow so
    // save()'s two-phase rollback runs.
    try {
      fs.rmSync(dest);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
  return dest;
}

/** Move `src` INTO destDir, with copyFileInto's exact no-clobber discipline
 * ("-1", "-2"... on a name collision). Tries an atomic rename FIRST: staging
 * and history both live under dataDir(), so the rename virtually always
 * applies, it costs the same whatever the file weighs (a multi-hour .wav runs
 * to hundreds of megabytes, and the SYNCHRONOUS quit rescue cannot afford to
 * copy that byte by byte while the user waits for the app to close), and it
 * never leaves a half-written destination behind. Falls back to the two-phase
 * copy-then-delete when rename cannot apply (EXDEV across volumes, a locked
 * file). Throws only when BOTH failed - and then nothing was destroyed. */
function moveFileInto(destDir: string, src: string): string {
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dest = path.join(destDir, base);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(destDir, stem + "-" + i + ext);
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch {
    /* cross-volume or locked: fall through to the copy that always works */
  }
  const copied = copyFileInto(destDir, src);
  try {
    fs.rmSync(src);
  } catch {
    // The copy is in place, so nothing is lost; a source we could not remove
    // only costs app-owned disk, and the next startup rescan will see it.
  }
  return copied;
}

/** Remove `dir` and any now-empty ancestor directories, up to but never
 * including `root`. Generalizes the old single-level staging cleanup (v6 c7)
 * to also cover history's two-level layout (C10: <root>/<date>/<title>/,
 * cleaning both the emptied recording folder AND the emptied date folder).
 * NEVER touches anything outside `root` (a user's own folder, or root itself,
 * is left exactly as it is). */
function cleanEmptyHoldingDirs(root: string, dir: string): void {
  let cur = dir;
  for (;;) {
    try {
      const rel = path.relative(root, cur);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // outside (or IS) root: stop
      if (fs.readdirSync(cur).length > 0) return; // not empty: nothing more to clean
      fs.rmdirSync(cur);
    } catch {
      return; // best effort: a leftover folder costs a little disk, never data
    }
    cur = path.dirname(cur);
  }
}

/** Create a fresh subfolder under `parent`: a name clash (same title within
 * the same minute, or a stray leftover) gets a "-1", "-2"... suffix rather
 * than reusing someone else's folder. Same collision discipline as
 * copyFileInto, one level up. */
function uniqueDir(parent: string, name: string): string {
  let dir = path.join(parent, name);
  for (let i = 1; fs.existsSync(dir); i++) dir = path.join(parent, name + "-" + i);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Local YYYY-MM-DD for a Date, matching the stamp style used elsewhere
 * (recordingBaseName): the folder name purgeHistory later parses back. */
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// ---- C10: retention purge ----

const RETENTION_DAYS = 90;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/; // must match ymd() exactly

// U2a: historyRoot() is now FIXED (dataDir()/history) - historyDir the setting
// is gone. Every guardrail below (marker gate, dangerous-root check, item cap)
// was written back when the folder was user-configurable; they still hold, so
// they stay, unchanged in behavior.
//
// U2c: they are NOT sufficient, which is why purgeHistory() gained a suspension
// switch above them. On a machine that had moved its recordings elsewhere, the
// fixed folder was frozen the day the user switched - and it carries the marker
// from when it WAS the default, so the marker gate happily authorizes deleting
// an untouched years-old archive on the first boot after the update. Only
// knowing that Flow was not the one filing into it can stop that.

/** True when `p` resolves to a filesystem/volume root (e.g. "C:\", "/"), the
 * user's own profile root, or an IMMEDIATE child of the profile (Documents,
 * Desktop, OneDrive-redirected folders...) - the purge must refuse to operate
 * there even if the history root was ever misdirected at one (non-negotiable
 * guardrail: a bad root must never turn into deleting real folders). Review
 * C10 F1: the profile-child rule still allows the default ~/.agr-flow/history
 * (parent is .agr-flow) and any dedicated folder on another drive. */
function isDangerousPurgeRoot(p: string): boolean {
  const resolved = path.resolve(p);
  if (path.dirname(resolved) === resolved) return true; // a volume/filesystem root
  const home = path.resolve(os.homedir());
  if (resolved === home) return true; // the user's profile root
  if (path.dirname(resolved) === home) return true; // Documents, Desktop, OneDrive... never purge grounds
  return false;
}

/** Security scan F1 (MEDIUM, 3/3, 2026-08-02): `/long/save` took the caller's
 * destination folder raw - `statSync` said "is it a directory", nothing said
 * "should we be writing there". That is a write-anywhere-this-user-can-write
 * primitive, and worse, a UNC destination turns a local save into an outbound
 * copy plus an SMB/NTLM authentication to a host the caller names.
 *
 * WHAT THIS REFUSES, and why each one rather than a blanket allowlist:
 *
 *  - Anything not absolute. A relative path resolves against Flow's cwd, which
 *    is a coincidence, never an intention.
 *  - UNC and device paths (`\\host\share`, `\\?\`, `\\.\`). This is the one that
 *    matters: it is the difference between "a file lands in an odd folder" and
 *    "the recording leaves the machine and takes a credential handshake with
 *    it". No legitimate Save flow has ever passed one.
 *  - A junction or symlink that lands on either of the above once resolved -
 *    checked on the REAL path, because otherwise the check is decoration.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: confine the destination to the user's
 * profile. Saving a recording to D:\Recordings is a thing a person does, and
 * this function must not decide it is suspicious. With F2 landed the caller is
 * authenticated - Flow itself or a sibling app - so "writes to an unusual local
 * folder" is a choice, while "writes to a remote host" is an exfiltration.
 * Drawing the line there is the honest place to draw it, and saying so beats
 * implying this returns the destination to a sandbox. */
export function refuseUnsafeDestination(dir: string): string | null {
  const looksRemote = (p: string): boolean => {
    const s = p.replace(/\//g, "\\");
    return s.startsWith("\\\\"); // UNC \\host\share, and the \\?\ and \\.\ prefixes
  };
  if (looksRemote(dir)) {
    return "refused: recordings are saved to a local folder, never to a network path";
  }
  if (!path.isAbsolute(dir)) {
    return "refused: the destination folder must be an absolute path";
  }
  try {
    // Follows junctions and symlinks. A folder that does not exist yet fails
    // here and is reported by the caller's own statSync a moment later, so an
    // unreadable path is never silently treated as safe.
    if (looksRemote(fs.realpathSync(dir))) {
      return "refused: that folder resolves to a network path";
    }
  } catch {
    /* not resolvable: statSync in the caller reports it as "not found" */
  }
  return null;
}

/** Review C10 F1 (marker gate): the purge only ever operates on a folder AGR
 * Flow itself established as a history root. fileIntoHistory drops this marker
 * when it creates the root; purgeHistoryDirs bails when it is absent. A
 * history root pointed at ANY pre-existing folder (the vault, an export dir)
 * therefore can never be purged, no matter what dated subfolders it holds. */
const HISTORY_MARKER = ".agr-flow-history";
function ensureHistoryRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const m = path.join(root, HISTORY_MARKER);
  if (!fs.existsSync(m))
    fs.writeFileSync(m, "AGR Flow history root. The retention purge only operates on folders carrying this marker.\n");
}

/** Delete date-named (YYYY-MM-DD) subfolders of `root` older than
 * RETENTION_DAYS. Guardrails, all non-negotiable (design review):
 *  - only an entry whose NAME matches DATE_DIR_RE is ever considered; age is
 *    judged by that name, never by mtime, and no other entry is touched.
 *  - lstat before acting: a symlink/junction entry is never followed into -
 *    only the link itself may be removed (unlink, never a recursive rm), so
 *    its target is never touched no matter what it points at.
 *  - refuses outright if `root` resolves to a volume root or the user's
 *    profile root.
 * Best-effort and silent beyond one summary log line: a purge failure must
 * NEVER block a recording from starting. */
function purgeHistoryDirs(root: string, log?: (msg: string) => void): void {
  try {
    if (isDangerousPurgeRoot(root)) {
      log?.(`[long] history purge refused: root looks unsafe (${root})`);
      return;
    }
    // Review C10 F1: no marker = not a folder this app established -> never purge.
    // Covers both "no history yet" and "root points at someone's real folder".
    if (!fs.existsSync(path.join(root, HISTORY_MARKER))) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // no history folder yet: nothing to purge
    }
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const entry of entries) {
      if (!DATE_DIR_RE.test(entry.name)) continue; // name must match exactly; never touch anything else
      const full = path.join(root, entry.name);
      const folderDate = new Date(entry.name + "T00:00:00");
      if (Number.isNaN(folderDate.getTime()) || folderDate.getTime() >= cutoff) continue; // within retention
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full); // lstat: decide WITHOUT ever following a symlink/junction
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // The stale link entry is app-owned bookkeeping and may be removed,
        // but its target is never touched: unlink the link, never rm -r it.
        try {
          fs.unlinkSync(full);
          removed++;
        } catch {
          /* best effort */
        }
        continue;
      }
      if (!st.isDirectory()) continue; // a stray file named like a date: leave it alone
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        /* best effort: a locked file just waits for the next purge */
      }
    }
    if (removed > 0) log?.(`[long] history purge: removed ${removed} folder(s) older than ${RETENTION_DAYS} days`);
  } catch (err) {
    log?.(`[long] history purge failed: ${err}`);
  }
}

// ---- filing a finished recording into the archive (C10 + U4) ----

/** The date folder a recording is filed under. Normally the day it was
 * recorded, EXCEPT when that day already sits outside the retention window:
 * a recording recovered from a machine that stayed off for four months would
 * then land straight in a bucket the very next purge deletes - Flow would have
 * "rescued" a meeting into the bin. Such a recording is filed under TODAY
 * instead, so the user gets the full window to notice it; the document's own
 * header still states the real recording date, so nothing is misrepresented.
 *
 * The comparison mirrors purgeHistoryDirs' arithmetic exactly: the purge judges
 * a folder by the MIDNIGHT its name decodes to, never by the instant inside it. */
function historyDateFolder(startedMs: number, now = Date.now()): string {
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  if (Number.isFinite(startedMs) && startedMs > 0) {
    const name = ymd(new Date(startedMs));
    const midnight = new Date(name + "T00:00:00").getTime();
    if (!Number.isNaN(midnight) && midnight >= cutoff) return name;
  }
  return ymd(new Date(now));
}

export interface FiledRecording {
  dir: string;
  docPath: string;
  audioPath: string; // "" when no audio was kept
}

/** File a finished recording into `<historyRoot>/<date>/<name>/`. ONE
 * implementation behind the FOUR ways a recording reaches the archive -
 * finalize()'s normal staged landing, the synchronous quit rescue, the startup
 * rescan of orphaned staging folders, and (V4 D2) an audio file import - so a
 * guardrail cannot hold on one path and quietly not on another.
 *
 * Order of operations, and why it is that order:
 *  - the DOCUMENT moves first and alone. If that fails, nothing was touched:
 *    the caller still has a complete recording exactly where it was, and the
 *    next startup rescan will try again.
 *  - the audio follows only when the user asked to keep it. A failure there is
 *    logged and swallowed: a transcript in the archive beats a rollback that
 *    would put the meeting back into a folder nothing lists.
 *  - the .wav is removed ONLY when keepAudio is false, and only once the
 *    document is safely filed. That is the sole deletion this function can
 *    ever perform, it concerns the audio alone, and it happens because the
 *    user explicitly unchecked "Keep the audio file". The recording itself
 *    (the document) is never deleted by Flow, on any path.
 * Returns null when nothing was filed. Never throws. */
export function fileRecordingIntoHistory(opts: {
  historyRoot: string;
  docPath: string;
  audioPath: string;
  keepAudio: boolean;
  startedMs: number;
  log?: (msg: string) => void;
}): FiledRecording | null {
  const { historyRoot: root, docPath, audioPath, keepAudio, startedMs, log } = opts;
  let destDir: string;
  try {
    ensureHistoryRoot(root); // review C10 F1: the marker makes the root purgeable
    const dateDir = path.join(root, historyDateFolder(startedMs));
    fs.mkdirSync(dateDir, { recursive: true });
    destDir = uniqueDir(dateDir, path.basename(docPath, ".md"));
  } catch (err) {
    log?.(`[long] cannot prepare the history folder: ${err}`);
    return null;
  }
  let newDoc: string;
  try {
    newDoc = moveFileInto(destDir, docPath);
  } catch (err) {
    try {
      fs.rmdirSync(destDir); // empty by construction: leave no debris behind
    } catch {
      /* best effort */
    }
    log?.(`[long] could not file the recording into history: ${err}`);
    return null;
  }
  let newAudio = "";
  if (audioPath && fs.existsSync(audioPath)) {
    if (keepAudio) {
      try {
        newAudio = moveFileInto(destDir, audioPath);
      } catch (err) {
        log?.(`[long] the transcript was filed but its .wav could not follow (left where it was): ${err}`);
      }
    } else {
      try {
        fs.rmSync(audioPath);
        log?.("[long] audio dropped: the recording asked not to keep the .wav");
      } catch (err) {
        log?.(`[long] could not drop the .wav the recording asked not to keep: ${err}`);
      }
    }
  }
  return { dir: destDir, docPath: newDoc, audioPath: newAudio };
}

/** Everything needed to file an ORPHANED staging folder, read back from what
 * the folder already carries - no bookkeeping sidecar to keep in sync, and
 * nothing a session that died mid-write could have failed to write: start()
 * writes the document's header (title + start instant) before the first chunk
 * ever arrives, and names the staging folder "<epoch ms>-<random>". */
function readStagedSession(
  dir: string,
  folderName: string,
): { docPath: string; audioPath: string; title: string; startedMs: number; startedIso: string } | null {
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let docPath = "";
  let audioPath = "";
  for (const f of files) {
    if (!f.isFile()) continue;
    // ".md" excludes a ".md.tmp" left by an interrupted atomic swap: a torn
    // temporary file is never mistaken for the document.
    if (!docPath && f.name.toLowerCase().endsWith(".md")) docPath = path.join(dir, f.name);
    else if (!audioPath && f.name.toLowerCase().endsWith(".wav")) audioPath = path.join(dir, f.name);
  }
  if (!docPath) return null;
  let title = path.basename(docPath, ".md");
  let startedMs = NaN;
  // D7: the start instant EXACTLY as the header spells it, not re-derived from
  // startedMs. It is the key the live-notes slot is filed under, and a
  // round-trip through Date.parse and toISOString would not reproduce it byte
  // for byte for every ISO form - a mismatch there would silently drop the
  // user's notes instead of merging them.
  let startedIso = "";
  try {
    const head = fs.readFileSync(docPath, "utf8").slice(0, 512);
    const t = head.match(/^# (.+)$/m);
    if (t) title = t[1].trim() || title;
    const r = head.match(/^- recorded: (.+)$/m);
    if (r) {
      startedIso = r[1].trim();
      const ms = Date.parse(startedIso);
      if (!Number.isNaN(ms)) startedMs = ms;
    }
  } catch {
    /* the header is a convenience; the folder name below is the floor */
  }
  if (Number.isNaN(startedMs)) {
    const stamp = Number(folderName.split("-")[0]);
    if (Number.isFinite(stamp) && stamp > 0) startedMs = stamp;
  }
  if (Number.isNaN(startedMs)) {
    try {
      startedMs = fs.statSync(docPath).mtimeMs;
    } catch {
      startedMs = Date.now();
    }
  }
  return { docPath, audioPath, title, startedMs, startedIso };
}

/** Insert the interruption note at the TOP of the document, right under the
 * header, rather than appending it at the end: whoever opens a three-hour
 * transcript has to learn that it is incomplete without scrolling to the
 * bottom. Best effort and never destructive - a document that cannot be
 * rewritten gets the note appended instead, and if THAT fails too the recording
 * is still filed (a missing note is a disappointment; a lost meeting is the bug
 * being fixed here).
 *
 * V4 D2 reuses it for the partial-import note, which needs the identical
 * treatment for the identical reason: whoever opens the document has to learn
 * that it covers only part of the audio without scrolling to the bottom. The
 * name says "interruption" because that is what it was written for; what it
 * DOES is "put this note right under the header, atomically, best effort". */
/** D7: write a "## Notes" block into a document, SYNCHRONOUSLY and atomically.
 *
 * Used by the two interrupted paths - the quit rescue (which runs inside
 * before-quit, where Electron awaits nothing) and the boot rescan of an orphaned
 * staging folder - so a meeting that ended in a crash still carries the notes the
 * user typed during it. finalize() does its own splice instead, because it also
 * has generated notes to fold in and a summary to await.
 *
 * ORDER MATTERS, and it is the opposite of what looks right. noteInterruption()
 * puts its warning immediately under the header, so it must run BEFORE this: a
 * splice moves whatever it finds at the top of the body down into the transcript
 * region, so a warning inserted afterwards would end up above the notes block
 * and the body would no longer START with "## Notes" - which is exactly the
 * anchor shared/redact.ts uses to find the derived notes and drop them on a
 * passage removal (see MY_NOTES_HEADING's note in shared/longform.ts). Splicing
 * last therefore keeps the redaction complete, at the cost of the interruption
 * warning sitting just above the transcript instead of just below the header -
 * which is where the existing regenerate path has always put it anyway.
 *
 * Best effort in the strict sense: a document that cannot be rewritten keeps its
 * transcript and loses the block. Returns whether the notes reached the file, so
 * the caller only clears the slot when they actually did. */
export function spliceMyNotesSync(
  docPath: string,
  header: string,
  notes: ReadonlyArray<{ atMs: number; text: string }>,
  log?: (msg: string) => void,
): boolean {
  const block = renderMyNotes(notes);
  if (!block) return false;
  try {
    const doc = fs.readFileSync(docPath, "utf8");
    const tmp = docPath + ".tmp";
    fs.writeFileSync(tmp, spliceNotes(doc, header, block));
    fs.renameSync(tmp, docPath);
    return true;
  } catch (err) {
    log?.(`[long] could not write the notes you typed into ${docPath} (the transcript is intact): ${err}`);
    return false;
  }
}

export function noteInterruption(docPath: string, note: string, log?: (msg: string) => void): void {
  try {
    const doc = fs.readFileSync(docPath, "utf8");
    const at = doc.indexOf(ENGINE_LINE);
    if (at < 0) {
      fs.appendFileSync(docPath, note);
      return;
    }
    const cut = at + ENGINE_LINE.length;
    // Atomic swap, same discipline as the summary and notes splices.
    const tmp = docPath + ".tmp";
    fs.writeFileSync(tmp, doc.slice(0, cut) + note + doc.slice(cut));
    fs.renameSync(tmp, docPath);
  } catch (err) {
    log?.(`[long] could not place the interruption note at the top: ${err}`);
    try {
      fs.appendFileSync(docPath, note);
    } catch {
      /* filing the recording matters more than annotating it */
    }
  }
}

// ---- Archive 2026-07-14: history browsing (list + resolve) ----
//
// The PWA never sends a filesystem path. Every history entry is addressed by
// an OPAQUE id (base64url of "<date>/<titleFolder>", both single path
// segments). On every request the engine re-enumerates the real history dirs
// and only ever serves a directory that (a) decodes to two clean segments,
// (b) resolves, via path.resolve, INSIDE historyRoot, and (c) still shows up
// in a fresh listHistory() scan. A forged/stale id is a 404, never a read
// outside historyRoot (security review: this is the whole point of the id
// scheme, not an incidental detail).

// The cap itself now lives in shared/longform.ts: the Notes page has to be able
// to tell the user when the listing was truncated, and a second copy of the
// number here is a second source of truth the page could drift from (U5 review,
// MAJEUR 4). The walk below is still the ONE place that enforces it.

/** True when `p` is a REAL directory: lstat says directory, and says it is not
 * a symlink/junction. lstat and never stat, so the decision is made about the
 * entry itself and can never follow a link out of the history root. The ONE
 * expression of that rule, shared by listHistory's walk and by
 * resolveHistoryEntry's direct lookup - the two must not be able to drift. */
function isRealDirectory(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Enumerate `<root>/<YYYY-MM-DD>/<title>/` recordings, newest first. Marker-gated
 * like the purge (never lists a folder AGR Flow did not itself establish as a
 * history root). Never follows a symlinked date or title folder - lstat decides,
 * matching purgeHistoryDirs' discipline. `log` is optional (tests/pure callers
 * don't need one); when given, a truncated listing logs once instead of failing
 * silently. */
export function listHistory(root: string = historyRoot(), log?: (msg: string) => void): HistoryItem[] {
  const items: HistoryItem[] = [];
  try {
    if (!fs.existsSync(path.join(root, HISTORY_MARKER))) return [];
    let dateEntries: fs.Dirent[];
    try {
      dateEntries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    // Newest date first, so the cap below keeps the most recent recordings
    // rather than an arbitrary directory-listing order.
    const dateNames = dateEntries
      .filter((e) => DATE_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    let truncated = false;
    for (const dateName of dateNames) {
      if (items.length >= MAX_HISTORY_ITEMS) {
        truncated = true;
        break;
      }
      const dateDir = path.join(root, dateName);
      if (!isRealDirectory(dateDir)) continue; // never follow a linked date dir
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(dateDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const dayItems: HistoryItem[] = [];
      for (const sub of subEntries) {
        const folderDir = path.join(dateDir, sub.name);
        if (!isRealDirectory(folderDir)) continue; // never follow a linked title dir
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(folderDir, { withFileTypes: true });
        } catch {
          continue;
        }
        let docFile = "";
        let audioFile = "";
        for (const f of files) {
          if (!f.isFile()) continue;
          if (!docFile && f.name.toLowerCase().endsWith(".md")) docFile = f.name;
          else if (!audioFile && f.name.toLowerCase().endsWith(".wav")) audioFile = f.name;
        }
        if (!docFile) continue; // no transcript: nothing worth surfacing
        let docStat: fs.Stats;
        try {
          docStat = fs.statSync(path.join(folderDir, docFile));
        } catch {
          continue;
        }
        let audioBytes = 0;
        let hasAudio = false;
        if (audioFile) {
          try {
            audioBytes = fs.statSync(path.join(folderDir, audioFile)).size;
            hasAudio = true;
          } catch {
            hasAudio = false;
          }
        }
        dayItems.push({
          id: historyEntryId(folderDir),
          date: dateName,
          title: sub.name,
          hasAudio,
          audioBytes,
          docBytes: docStat.size,
          savedMs: docStat.mtimeMs,
        });
      }
      dayItems.sort((a, b) => b.savedMs - a.savedMs);
      for (const item of dayItems) {
        if (items.length >= MAX_HISTORY_ITEMS) {
          truncated = true;
          break;
        }
        items.push(item);
      }
    }
    if (truncated) log?.(`[long] history listing truncated at ${MAX_HISTORY_ITEMS} entries`);
  } catch (err) {
    log?.(`[long] history listing failed: ${err}`);
  }
  return items;
}

/** True when `s` is anything other than a single clean path segment: empty,
 * contains a separator of either flavor, an embedded "..", or a drive/UNC
 * prefix. Applied to BOTH decoded segments of a history id - the whole point
 * of the id scheme is that neither segment can smuggle a path out of
 * historyRoot. */
function isUnsafePathSegment(s: string): boolean {
  if (!s) return true;
  if (s.includes("\\") || s.includes("/")) return true;
  if (s.includes("..")) return true;
  if (/^[a-zA-Z]:/.test(s)) return true; // drive prefix, e.g. "C:"
  return false;
}

/** Decode an opaque history id and resolve it to the on-disk recording folder.
 * Returns null on any failure - a forged id, a stale id whose folder was
 * purged, a symlink, or a path that would resolve outside historyRoot - never
 * partial information.
 *
 * U5 review, constat 2: this used to finish with `listHistory(root).find(...)`,
 * i.e. a full SYNCHRONOUS walk of the entire archive (a readdir of the root,
 * then per date folder an lstat + readdir, then per recording an lstat + readdir
 * + one or two stats) on the main process, the one carrying the keyboard hook.
 * That walk ran on every download AND on every Range request - and the audio
 * player emits one Range request per seek, so scrubbing a track re-enumerated
 * years of recordings per drag.
 *
 * The id already encodes everything needed to go straight to the folder: it is
 * the base64url of "<date>/<title>", two single path segments. So the lookup is
 * now direct, and each guarantee the walk used to provide incidentally is
 * asserted explicitly and locally, at O(1) filesystem calls whatever the
 * archive holds:
 *  - marker gate: the same `.agr-flow-history` check listHistory does, so a
 *    root Flow did not itself establish still serves nothing.
 *  - the DATE folder is checked on its own (isRealDirectory, shared with
 *    listHistory): a symlinked/junctioned date folder is never walked into,
 *    which the old code only got by virtue of the enumeration skipping it.
 *  - the recording folder itself: same lstat, unchanged.
 *  - the entry must actually carry a transcript, or it does not exist as far as
 *    this function is concerned - unchanged, and the same rule listHistory uses
 *    to decide an entry is worth surfacing.
 * The containment check (never a path outside historyRoot) was always local and
 * is untouched. */
export function resolveHistoryEntry(
  id: string,
  root: string = historyRoot(),
): { dir: string; doc: string | null; audio: string | null } | null {
  if (!id) return null;
  let rel: string;
  try {
    const buf = Buffer.from(id, "base64url");
    // base64url decoding never throws on garbage input (invalid characters are
    // just dropped), so a roundtrip check is the actual "did this decode
    // cleanly" gate: a forged/truncated id will not re-encode to itself.
    if (buf.toString("base64url") !== id) return null;
    rel = buf.toString("utf8");
  } catch {
    return null;
  }
  const slash = rel.indexOf("/");
  if (slash <= 0 || slash === rel.length - 1) return null;
  const date = rel.slice(0, slash);
  const folder = rel.slice(slash + 1);
  if (isUnsafePathSegment(date) || isUnsafePathSegment(folder)) return null;
  if (!DATE_DIR_RE.test(date)) return null;
  const resolvedRoot = path.resolve(root);
  const dir = path.join(resolvedRoot, date, folder);
  const resolvedDir = path.resolve(dir);
  // Containment check (non-negotiable): the resolved dir must sit strictly
  // inside historyRoot, never AT it (that would mean an empty folder name).
  if (!resolvedDir.startsWith(resolvedRoot + path.sep)) return null;
  // Marker gate, byte-for-byte listHistory's own check: a folder AGR Flow did
  // not establish as a history root is never served, whatever it contains.
  if (!fs.existsSync(path.join(root, HISTORY_MARKER))) return null;
  // The date folder, then the recording folder. Both must be real directories,
  // neither may be a symlink/junction: resolving "through" a linked date folder
  // would be a read outside historyRoot in everything but the string.
  if (!isRealDirectory(path.join(resolvedRoot, date))) return null;
  if (!isRealDirectory(resolvedDir)) return null;
  let doc: string | null = null;
  let audio: string | null = null;
  try {
    const files = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!doc && f.name.toLowerCase().endsWith(".md")) doc = path.join(resolvedDir, f.name);
      else if (!audio && f.name.toLowerCase().endsWith(".wav")) audio = path.join(resolvedDir, f.name);
    }
  } catch {
    return null;
  }
  if (!doc) return null;
  return { dir: resolvedDir, doc, audio };
}

/** The opaque id of a filed recording, derived from its own folder: base64url
 * of "<date>/<title>", the exact string resolveHistoryEntry decodes. The ONE
 * encoder, because there are now two callers - listHistory's walk, and the V4
 * D2 import pipeline, which files a document and then has to hand the window a
 * way to open the note it just produced. Two encoders would be two chances to
 * disagree with the single decoder. */
/**
 * Delete one capture: its folder, and nothing else.
 *
 * 2026-07-30. The whole of this function's caution is in what it does NOT do.
 * Flow's first invariant is that it never deletes a recording it was not
 * managing, and a delete-by-id is exactly where that could go wrong, so the
 * path is not trusted from the caller at any point:
 *
 *  - the id is resolved through resolveHistoryEntry, whose base64url roundtrip
 *    check already refuses a forged or truncated id;
 *  - and the resolved directory is then re-verified to sit UNDER the history
 *    root, because a resolver that ever grew a traversal bug would otherwise
 *    hand this function a path anywhere on the disk.
 *
 * The second check is redundant today. It is here because "redundant" and
 * "unnecessary" are different words when the failure mode is deleting someone
 * else's folder.
 */
export function deleteHistoryEntry(
  id: string,
  root: string = historyRoot(),
  log?: (msg: string) => void,
): { ok: boolean; error?: string } {
  const found = resolveHistoryEntry(id, root);
  if (!found) return { ok: false, error: "that capture no longer exists" };
  const dir = path.resolve(found.dir);
  const base = path.resolve(root);
  const inside = dir.startsWith(base + path.sep) && dir !== base;
  if (!inside) {
    log?.(`[history] refused to delete ${dir}: outside the recordings folder`);
    return { ok: false, error: "that capture is not in Flow's recordings folder" };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log?.(`[history] deleted ${path.basename(path.dirname(dir))}/${path.basename(dir)}`);
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    log?.(`[history] could not delete ${dir}: ${msg}`);
    // Said out loud: a user who clicked delete and saw nothing happen would
    // believe the recording was gone when it is still on their disk.
    return { ok: false, error: `could not delete it: ${msg}` };
  }
}

export function historyEntryId(dir: string): string {
  const { date, title } = historyEntryLabel(dir);
  return Buffer.from(`${date}/${title}`, "utf8").toString("base64url");
}

/** date/title derived from a RESOLVED entry's own folder (root/date/folder,
 * resolveHistoryEntry's own layout) - the one place that decode happens, used
 * everywhere a resolved entry needs to be named for a human (the doc payload
 * below, U5c's downloaded filenames): never re-derived from the id itself. */
export function historyEntryLabel(dir: string): { date: string; title: string } {
  return { date: path.basename(path.dirname(dir)), title: path.basename(dir) };
}

// ~5 MB: a transcript this long is already pathological. Shared by
// readHistoryDoc (HTTP + IPC) so the two surfaces can never disagree on the cap.
const MAX_HISTORY_DOC_BYTES = 5 * 1024 * 1024;

/** Read a history entry's transcript for display: resolves the id, reads the
 * document (capped), and derives title/date from the resolved folder - the
 * ONE implementation behind both the HTTP /long/history/doc route and the
 * UI_HISTORY_DOC IPC channel (U5a), so a forged/stale id is refused
 * identically on both surfaces. Returns null when the id does not resolve to
 * a real entry with a document, or the file could not be read. */
export function readHistoryDoc(id: string, root: string = historyRoot()): HistoryDocPayload | null {
  const entry = resolveHistoryEntry(id, root);
  if (!entry || !entry.doc) return null;
  let text: string;
  try {
    const buf = fs.readFileSync(entry.doc);
    text = (buf.length > MAX_HISTORY_DOC_BYTES ? buf.subarray(0, MAX_HISTORY_DOC_BYTES) : buf).toString("utf8");
  } catch {
    return null;
  }
  const { date, title } = historyEntryLabel(entry.dir);
  return { title, date, text };
}

// B3a : `loadRecent`, `existingRecent`, `saveRecent` et `wavDurationMs` sont
// partis avec recent.json. Les quatre decrivaient la meme chose - « quelle est
// la derniere capture, et son fichier existe-t-il encore » - une question qui
// n'a plus de sens quand la derniere capture est une ligne du compte et non un
// chemin sur un disque. `state()` la tient maintenant en memoire (lastFinished),
// ce qui retire au passage le cache que le sondage a 1 Hz avait rendu necessaire.

// ---------------------------------------------------------------------------
// B3a : LE MAGASIN D'UNE CAPTURE.
//
// Le recorder ne connait ni Supabase, ni la copie de travail, ni la file : il
// pousse une ligne complete et rend la main. C'est la meme frontiere que
// LiveNotesBacking, pour la meme raison - les tests du recorder ne doivent
// toucher ni reseau ni compte.
//
// `write` est SYNCHRONE et ne rend rien. Une methode qui rendrait une promesse
// serait une methode qu'un appelant pourrait attendre, et le seul appelant qui
// compte ici tourne pendant une reunion.
// ---------------------------------------------------------------------------
export interface CaptureStore {
  /** La memoire d'abord, le reseau derriere. Ne bloque jamais, ne lance jamais. */
  write(row: RecordingRow): void;
  /** Ce qui n'est pas encore monte. Pour le DIRE, jamais pour l'attendre. */
  pending(): number;
  /** Relire une reunion deja terminee. Jamais appelee pendant une capture : elle
   * sert a exporter ou a annoter un enregistrement dont le tampon a ete lache. */
  read(id: string): Promise<RecordingRow | null>;
  /** Les lignes restees ouvertes du compte. Pour le sauvetage au demarrage. */
  listOpen(): Promise<OpenRecording[]>;
  /** Les notes tapees pendant une seance, lues depuis le compte.
   *
   * Le recorder les lit AILLEURS pendant une reunion (deps.liveNotes, servi
   * depuis la memoire, parce que la page les relit dix fois par minute). Celle-ci
   * ne sert qu'au sauvetage : les notes d'une seance morte ne sont dans la
   * memoire de personne, seulement dans le compte. */
  readLiveNotes(startedIso: string): Promise<Array<{ atMs: number; text: string }>>;
  /** Uniquement apres que les notes sont surement dans le document. */
  clearLiveNotes(startedIso: string): void;
}

/**
 * Toutes les DOC_FLUSH_MS, la tranche part si le document a bouge.
 *
 * CE QUE CE CHIFFRE ACHETE, ET CE QU'IL COUTE. C'est la fenetre de perte d'un
 * plantage brutal : au pire vingt secondes de transcript, jamais la reunion.
 * Le prix est le nombre d'envois - une heure produit ~180 mises a jour d'une
 * ligne qui grandit jusqu'a 124 Ko (mesure : shared/captureDoc.ts).
 *
 * Pourquoi pas plus court : chaque tranche renvoie le document ENTIER, donc
 * diviser l'intervalle par deux double le trafic pour gagner dix secondes sur
 * un scenario - le plantage en cours de reunion - qui doit rester rare.
 * Pourquoi pas plus long : au-dela d'une minute, la fenetre de perte cesse
 * d'etre negligeable pour quelqu'un qui vient d'entendre la phrase importante.
 */
export const DOC_FLUSH_MS = 20_000;

export class LongRecorder {
  private deps: LongDeps;
  private active = false;
  private finalizing = false;
  private splicing = false; // annotation en vol : save() l'attend (un seul ecrivain)
  // U4: rescueOnQuit() ran. The process is on its way out and the recording is
  // already closed, so a finalize() still awaiting the ASR or Ollama must not
  // write it a second time if it somehow gets CPU again.
  private quitting = false;
  private startedAt = 0;
  private startedIso = "";
  private endedIso = "";
  private title = "";
  private recordingId = "";
  private staged = true; // la destination se choisit a la fin, jamais au depart
  /** B3a : LE document. Il n'y a plus de fichier .md pendant la capture. */
  private doc: CaptureDoc | null = null;
  /** La version deja envoyee. Compare a `doc.version()`, c'est ce qui evite de
   * televerser 124 Ko toutes les vingt secondes quand personne ne parle. */
  private flushedRev = 0;
  private stopFlush: (() => void) | null = null;
  private keepAudio = false;
  private native = false; // C2: engine-captured -> engine writes the .wav
  /** Le .wav EN TRANSIT sur le disque de la machine.
   *
   * Oui, c'est un fichier, dans une refonte qui en retire cinq. Il reste, et le
   * choix est mesure : un .wav d'une heure pese 115 Mo. Le garder en memoire
   * pour attendre la fin de la reunion couterait 115 Mo de RAM, et le
   * televerser au fil de l'eau interdirait de reprendre apres une coupure -
   * reprendre suppose une source durable a relire.
   *
   * Ce n'est donc pas un MAGASIN : rien ne le lit pour afficher quoi que ce
   * soit, il ne survit pas a un televersement reussi, et il porte un nom
   * derive de l'identifiant de la ligne pour qu'un redemarrage retrouve
   * exactement le fichier de la ligne inachevee. */
  private audioLocalPath = "";
  /** Le chemin de l'objet dans Storage. Vide jusqu'a ce que B3c le remplisse. */
  private audioObjectPath = "";
  private audioStream: fs.WriteStream | null = null;
  private audioBytes = 0; // octets PCM ecrits dans le .wav local (pour l'entete)
  private audioUploaded = 0; // octets confirmes dans Storage (B3c)
  private audioUploadUrl = "";
  private audioUploadExpires = "";
  private audioFailed = false; // une erreur d'I/O audio : arreter d'ecrire, continuer a transcrire
  private marks: number[] = [];
  private lastError = "";
  // U4 (review, major): how long the capture actually ran, frozen the moment it
  // ends. state() used to report 0 as soon as `active` went false, so the
  // biggest number on the Record page fell to 00:00:00 the instant Stop was
  // pressed - for the whole of a finalization that can take minutes, and after
  // it. The duration a recording reached is a FACT about it; it does not
  // disappear because the transcription is still running.
  private elapsedMs = 0;
  // Current (open) segment + its start offset in samples since recording start.
  private cur: Int16Array[] = [];
  private curLen = 0;
  private consumed = 0; // samples already CLOSED into segments
  private queue: Array<{ pcm: Int16Array; offsetMs: number }> = [];
  private segments = 0;
  private pumping = false;
  /** La derniere capture terminee, en memoire.
   *
   * U4a piege 1 a disparu avec son support : `recent` etait une lecture de
   * recent.json plus un `existsSync` par entree, faite jusqu'a une fois par
   * seconde par deux appelants, et il fallait un cache pour la tenir hors du
   * chemin du crochet clavier. Un champ en memoire n'a rien a mettre en cache. */
  private lastFinished: RecentEntry | null = null;

  constructor(deps: LongDeps) {
    this.deps = deps;
  }

  get isBusy(): boolean {
    return this.active || this.finalizing;
  }

  private stagingBase(): string {
    return this.deps.stagingRootOverride ?? stagingRoot();
  }

  private historyBase(): string {
    return this.deps.historyRootOverride ?? historyRoot();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Best-effort retention purge of the LEGACY archive (C10 §5). B3 moved the
   * documents into the account, so this folder can only hold recordings made by
   * a Flow older than this build - and the retention promise they were made
   * under still applies to them. Never throws, so a failure here can never stop
   * a recording from starting.
   *
   * U2c (blocking review finding): SUSPENDED outright when the settings flag
   * says so. On a machine that used to file its recordings elsewhere, the fixed
   * folder is a frozen archive Flow never managed - and it carries the marker
   * from the days it was the default, so every other guardrail below would wave
   * the deletion through. Flow never deletes recordings it was not managing. */
  purgeHistory(): void {
    if (this.deps.historyPurgeSuspended?.()) {
      this.deps.log?.(
        `[long] history purge SUSPENDED: ${this.historyBase()} holds recordings Flow was not managing. ` +
          `Nothing is deleted until "Resume automatic cleanup" in Settings > Storage.`,
      );
      return;
    }
    purgeHistoryDirs(this.historyBase(), this.deps.log);
  }

  /**
   * Le balayage des dossiers `staging/` laisses par une version PRECEDENTE.
   *
   * B3 lui a retire sa raison d'etre principale sans le rendre inutile. Une
   * reunion coupee par un plantage ne laisse plus de dossier : elle laisse une
   * ligne OUVERTE dans le compte, et c'est `rescueAbandoned()` qui la ferme.
   * Mais une machine qui met Flow a jour au milieu de rien peut tres bien porter
   * un dossier orphelin ecrit par la version d'avant, et le perdre en changeant
   * de support serait exactement la quatrieme lecon des vagues closes - un
   * correctif qui part avec son support.
   *
   * Il ne touche donc plus recent.json (le fichier n'a plus de lecteur) : il
   * classe l'orphelin dans l'archive locale, ou les pages savent encore le lire,
   * et le dit dans le journal. Never throws and never deletes. */
  rescueOrphanedStaging(): number {
    const staging = this.stagingBase();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(staging, { withFileTypes: true });
    } catch {
      return 0; // pas de dossier staging du tout : le cas normal
    }
    let rescued = 0;
    for (const entry of entries) {
      const dir = path.join(staging, entry.name);
      try {
        // lstat decides, like everywhere else in this file: a symlink/junction
        // dropped into staging is never followed out of the app-owned root.
        const st = fs.lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        const session = readStagedSession(dir, entry.name);
        if (!session) {
          this.deps.log?.(`[long] staging folder without a transcript, left untouched: ${dir}`);
          continue;
        }
        noteInterruption(session.docPath, interruptedNote("recovered", -1), this.deps.log);
        const filed = fileRecordingIntoHistory({
          historyRoot: this.historyBase(),
          docPath: session.docPath,
          audioPath: session.audioPath,
          // Nobody can tell what the user had asked for in a session that died
          // without a trace, so Flow keeps what it cannot attribute: the rule
          // that matters is never destroying a recording, not enforcing a
          // checkbox whose value no longer exists anywhere.
          keepAudio: true,
          startedMs: session.startedMs,
          log: this.deps.log,
        });
        if (!filed) continue;
        rescued++;
        cleanEmptyHoldingDirs(staging, dir);
        this.deps.log?.(`[long] recovered an interrupted recording from an older Flow -> ${filed.docPath}`);
      } catch (err) {
        this.deps.log?.(`[long] could not recover ${dir}: ${err}`);
      }
    }
    return rescued;
  }

  /**
   * B3b : LE SAUVETAGE, cote compte.
   *
   * Le remplacant de `rescueOrphanedStaging`, et il tient la meme promesse par
   * un chemin plus court : une ligne ouverte que plus personne n'alimente EST
   * une reunion interrompue. Pas de dossier a inventorier, pas d'entete a
   * reparser pour retrouver un instant de depart - la ligne le porte.
   *
   * TROIS CHOSES QU'IL FAIT ET QUE L'ANCIEN NE POUVAIT PAS FAIRE :
   *
   *  - il voit la reunion coupee sur l'AUTRE ordinateur. C'est un cas que la
   *    refonte cree, et rien d'autre ne le couvre.
   *  - il distingue « morte » de « en cours ailleurs », par le pouls. Sans ca,
   *    se connecter sur le portable pendant que le fixe enregistre marquerait la
   *    reunion en cours comme interrompue.
   *  - il recolle les notes tapees pendant la seance, lues depuis `live_notes`
   *    sous leur `started_iso`. L'ancien les lisait dans une fente locale, donc
   *    il ne les retrouvait que sur la machine qui avait plante.
   *
   * Ne lance jamais. Rend le nombre de reunions fermees. */
  async rescueAbandoned(): Promise<number> {
    const store = this.deps.store;
    const open = await store.listOpen();
    if (open.length === 0) return 0;
    const nowMs = this.now();
    let closed = 0;
    for (const r of open) {
      // La ligne de CETTE session en cours n'est pas orpheline, quoi que dise
      // son pouls : c'est nous qui l'alimentons.
      if (r.id === this.recordingId && this.isBusy) continue;
      if (!looksAbandoned(r.heartbeatIso, nowMs)) {
        this.deps.log?.(`[long] "${r.title}" est en cours d'enregistrement ailleurs : laissee telle quelle`);
        continue;
      }
      const header = transcriptHeader(r.title, r.startedIso);
      const doc = new CaptureDoc(header);
      // Le document tel qu'il a atterri, entete comprise. On le remet dans un
      // tampon plutot que de manipuler la chaine a la main, pour que l'ordre
      // « avertissement puis splice » soit tenu par le meme code que la fin
      // normale d'une reunion.
      doc.append(r.doc.startsWith(header) ? r.doc.slice(header.length) : r.doc);
      doc.prependToBody(interruptedNote("recovered", -1));
      const mine = await store.readLiveNotes(r.startedIso);
      const block = renderMyNotes(mine);
      if (block) doc.spliceNotesBlock(block);
      // La ligne ENTIERE est reecrite, avec son audio tel qu'il etait : une
      // reunion coupee apres la fin de son televersement ne doit pas perdre son
      // audio en se faisant fermer. Seuls le document et l'instant de fin
      // changent - voir le commentaire d'OpenRecording.
      store.write({
        ...r,
        doc: doc.text(),
        // Le dernier instant dont on sache qu'elle vivait, et non maintenant :
        // une reunion coupee hier ne s'est pas terminee au lancement d'aujourd'hui.
        endedIso: r.heartbeatIso,
      });
      // Les notes ne sont effacees de `live_notes` qu'APRES l'ecriture du
      // document, et la file est FIFO : la suppression ne peut pas depasser le
      // document. C'est la seule chose qui rend cet effacement sur.
      if (block) store.clearLiveNotes(r.startedIso);
      closed++;
      this.deps.log?.(
        `[long] reunion interrompue retrouvee : "${r.title}" (${mine.length} note(s) recuperee(s))`,
      );
    }
    return closed;
  }

  /** U4 blocking finding: `before-quit` is SYNCHRONOUS and Electron awaits
   * nothing a handler starts.
   *
   * B3 rend cette contrainte inoffensive plutot que de ruser avec elle. Il n'y a
   * plus rien a finir : le document est en memoire, l'avertissement s'y insere
   * en trois affectations, la ligne part dans la file et le processus meurt.
   * Rien n'est attendu, rien ne peut retenir la fermeture.
   *
   * ET SI LA FILE NE SE VIDE PAS ? C'est le cas normal, pas le cas d'erreur : le
   * processus meurt en general avant. La ligne reste alors OUVERTE dans le
   * compte avec un pouls vieux de quelques secondes, et `rescueAbandoned()` la
   * ferme au prochain lancement - sur cette machine ou sur l'autre. C'est
   * pourquoi ce chemin peut se permettre de ne rien attendre : il n'est pas la
   * derniere chance, il est le raccourci.
   *
   * Rend si quelque chose a ete sauve. */
  rescueOnQuit(): boolean {
    if (!this.active && !this.finalizing) return false;
    // Count what is about to be lost BEFORE tearing the state down, so the note
    // in the document can be specific: the queued segments plus the open one.
    const pending = this.queue.length + (this.curLen > 0 ? 1 : 0);
    if (this.active) this.elapsedMs = Math.max(0, this.now() - this.startedAt); // freeze before active drops
    this.active = false;
    this.quitting = true; // a finalize() still in flight must not write this twice
    this.cancelFlush();
    try {
      // Le .wav d'abord : son entete de taille est un espace reserve jusqu'a la
      // fermeture du flux, donc un fichier deplace avant ca parait vide a tous
      // les lecteurs. Il reste sur le disque, ou le prochain lancement le
      // retrouvera par le nom de la ligne.
      this.flushNativeAudioSync();
      const doc = this.doc;
      if (doc) {
        doc.prependToBody(interruptedNote("quit", pending));
        // D7: les notes tapees partent MAINTENANT, sur le chemin de la sortie, et
        // avant que la ligne soit ecrite. Pas de resume et pas de modele ici - le
        // processus meurt et n'attend rien - donc le bloc porte les notes de
        // l'humain seules, ce qui est le contenu honnete d'un enregistrement
        // interrompu. Voir CaptureDoc.prependToBody sur l'ordre des deux.
        const mine = this.deps.liveNotes?.read(this.startedIso) ?? [];
        const block = renderMyNotes(mine);
        if (block) {
          doc.spliceNotesBlock(block);
          // Effacer la fente ici est sur POUR UNE SEULE RAISON : la file est
          // FIFO et le document part avant. Si le processus meurt entre les
          // deux, le document est monte avec les notes dedans et les lignes
          // `live_notes` survivent, ce qui est rattrapable. L'inverse ne le
          // serait pas.
          this.deps.liveNotes?.clear(this.startedIso);
        }
      }
      this.endedIso = new Date(this.now()).toISOString();
      this.publish();
      this.rememberFinished();
      this.deps.log?.(`[long] rescued on quit -> ${this.recordingId}`);
      return true;
    } catch (err) {
      this.deps.log?.(`[long] quit rescue failed: ${err}`);
      return false;
    } finally {
      this.finalizing = false;
    }
  }

  start(opts: LongStartOpts): LongStartResult {
    if (this.active || this.finalizing) return { ok: false, error: "a recording is already in progress" };
    this.purgeHistory(); // l'archive LEGACY : au plus tot, jamais bloquant
    const now = new Date(this.now());
    this.title = (opts.title || "").trim() || "Recording";
    this.keepAudio = !!opts.keepAudio;
    this.recordingId = this.deps.newId?.() ?? randomUUID();
    // B3a : plus de dossier de destination au depart. Une reunion nait dans le
    // compte, sous son identifiant, et la question « ou est-ce que je la
    // range » se pose a la fin - ce que la colonne `staged` disait deja.
    this.staged = true;
    this.startedAt = this.now();
    this.startedIso = now.toISOString();
    this.endedIso = "";
    this.elapsedMs = 0; // a new recording: the previous one's length is no longer the answer
    this.marks = [];
    this.cur = [];
    this.curLen = 0;
    this.consumed = 0;
    this.queue = [];
    this.segments = 0;
    this.lastError = "";
    this.quitting = false;
    this.flushedRev = 0;
    this.audioUploaded = 0;
    this.audioObjectPath = "";
    this.audioUploadUrl = "";
    this.audioUploadExpires = "";
    this.doc = new CaptureDoc(transcriptHeader(this.title, this.startedIso));
    // Le .wav local est ouvert MEME quand la case « garder l'audio » est
    // decochee, et c'est le meme raisonnement qu'avant : pendant la capture,
    // l'audio est la seule chose qui peut encore sauver une reunion dont la
    // transcription tombe, et un plantage ne donne pas de seconde chance de
    // commencer a l'ecrire. U4 constat 2 : c'est a la FIN que la case decide,
    // en televersant ou en supprimant.
    this.audioLocalPath = this.openLocalAudio();
    this.native = !!opts.native;
    this.active = true;
    // D7: bind the live-notes slot to THIS recording, after the buffer exists (a
    // start that failed above must not claim the slot). Never destructive.
    this.deps.liveNotes?.open(this.startedIso);
    // La ligne existe des le premier instant, et c'est ce qui rend une reunion
    // coupee trente secondes plus tard VISIBLE comme interrompue plutot que
    // disparue.
    this.publish();
    this.armFlush();
    this.deps.log?.(`[long] recording started -> ${this.recordingId}`);
    return { ok: true, recordingId: this.recordingId };
  }

  /** Ouvre le .wav en transit et rend son chemin, ou "" si rien ne l'ecrira.
   * Toute erreur est absorbee : une capture sans audio vaut mieux que pas de
   * capture. */
  private openLocalAudio(): string {
    this.audioStream = null;
    this.audioBytes = 0;
    this.audioFailed = false;
    const dir = this.deps.pendingAudioDir;
    if (!dir) return "";
    const p = path.join(dir, this.recordingId + ".wav");
    try {
      fs.mkdirSync(dir, { recursive: true });
      // L'entete est ecrite SYNCHRONIQUEMENT, puis le flux ouvre en ajout.
      //
      // Ce n'est pas un detail de style. `createWriteStream` n'ouvre le fichier
      // que de facon differee, et son premier `write` est asynchrone : le
      // fichier peut ne pas exister pendant les premieres millisecondes de la
      // capture. Or l'argument entier qui justifie d'ouvrir ce .wav meme quand
      // la case est decochee est qu'« un plantage ne donne pas de seconde
      // chance de commencer a l'ecrire ». Un fichier qui n'existe pas encore ne
      // tient pas cette promesse.
      fs.writeFileSync(p, wavHeader(0));
      const s = fs.createWriteStream(p, { flags: "a" });
      // Sans ce gestionnaire, un echec d'ecriture asynchrone (disque plein,
      // volume retire, verrou antivirus) est un evenement 'error' non capture
      // qui ferait PLANTER le moteur. On l'absorbe : plus d'audio, mais le
      // transcript continue.
      s.on("error", (err) => {
        this.audioFailed = true;
        this.deps.log?.(`[long] .wav stream error: ${err}`);
      });
      s.write(wavHeader(0));
      this.audioStream = s;
      return p;
    } catch (err) {
      this.deps.log?.(`[long] cannot open the .wav in transit: ${err}`);
      return "";
    }
  }

  // -------------------------------------------------------------------------
  // LES TRANCHES
  // -------------------------------------------------------------------------

  /** Arme l'horloge des tranches. Une seule a la fois. */
  private armFlush(): void {
    this.cancelFlush();
    const tick = () => this.flushSlice();
    if (this.deps.schedule) {
      this.stopFlush = this.deps.schedule(tick, DOC_FLUSH_MS);
      return;
    }
    const t = setInterval(tick, DOC_FLUSH_MS);
    // unref : une horloge qui empeche le processus de mourir serait exactement
    // la troisieme des sept regressions du plan, par la porte de derriere.
    t.unref?.();
    this.stopFlush = () => clearInterval(t);
  }

  private cancelFlush(): void {
    this.stopFlush?.();
    this.stopFlush = null;
  }

  /** Envoie la tranche si le document a bouge. Public pour que les tests n'aient
   * pas a avancer une horloge pour verifier ce que la tranche contient. */
  flushSlice(): void {
    const doc = this.doc;
    if (!doc) return;
    if (doc.version() === this.flushedRev) return; // rien de neuf : pas d'envoi
    this.publish();
  }

  /** Ecrit la ligne, en entier, telle qu'elle est maintenant. */
  private publish(): void {
    const doc = this.doc;
    if (!doc || !this.recordingId) return;
    this.flushedRev = doc.version();
    try {
      this.deps.store.write(this.row(doc.text()));
    } catch (err) {
      // Le magasin promet de ne pas lancer ; s'il lance quand meme, ca ne doit
      // pas arreter une reunion en cours.
      this.deps.log?.(`[long] la tranche n'a pas pu etre mise en file : ${err}`);
    }
  }

  private row(doc: string): RecordingRow {
    return {
      id: this.recordingId,
      title: this.title,
      startedIso: this.startedIso,
      // Vivante pendant la capture, puis la longueur atteinte. L'autre
      // ordinateur peut ainsi voir une reunion avancer.
      durationMs: this.active ? Math.max(0, this.now() - this.startedAt) : this.elapsedMs,
      doc,
      audioPath: this.audioObjectPath,
      audioBytes: this.audioBytes,
      audioUploaded: this.audioUploaded,
      // La ligne du recorder ne connait aucune URL de televersement : c'est la
      // file qui la fabrique et la persiste. Ecrire "" ici l'effacerait a chaque
      // tranche de document, donc le recorder rend ce qu'il a lu au depart.
      audioUploadUrl: this.audioUploadUrl,
      audioUploadExpires: this.audioUploadExpires,
      staged: this.staged,
      endedIso: this.endedIso,
    };
  }

  private rememberFinished(): void {
    this.lastFinished = {
      id: this.recordingId,
      title: this.title,
      startedIso: this.startedIso,
      durationMs: this.elapsedMs,
      staged: this.staged,
    };
  }

  /** C2 native mode: append the engine-captured PCM to the .wav in transit.
   * Called alongside onChunk. */
  writeNativeAudio(pcm: Int16Array): void {
    const s = this.audioStream;
    if (!s || this.audioFailed) return;
    try {
      s.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      this.audioBytes += pcm.byteLength;
    } catch (err) {
      this.audioFailed = true;
      this.deps.log?.(`[long] .wav write failed: ${err}`);
    }
  }

  /** Patch a .wav's RIFF/data sizes to `bytes` in place. Best effort. */
  private patchWavSizes(p: string, bytes: number): void {
    if (!p) return;
    try {
      const fd = fs.openSync(p, "r+");
      const patch = Buffer.alloc(4);
      patch.writeUInt32LE(36 + bytes, 0);
      fs.writeSync(fd, patch, 0, 4, 4); // RIFF chunk size
      patch.writeUInt32LE(bytes, 0);
      fs.writeSync(fd, patch, 0, 4, 40); // data chunk size
      fs.closeSync(fd);
    } catch (err) {
      this.deps.log?.(`[long] .wav header patch failed: ${err}`);
    }
  }

  /** Close the .wav and patch its sizes. Awaited by finalize so the upload never
   * reads a half-written file. NEVER hangs: an errored/wedged stream still
   * resolves (via its 'error' event or a safety timer). */
  private closeLocalAudio(): Promise<void> {
    const stream = this.audioStream;
    this.audioStream = null;
    if (!stream) return Promise.resolve();
    const bytes = this.audioBytes;
    const p = this.audioLocalPath;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.patchWavSizes(p, bytes);
        resolve();
      };
      const timer = setTimeout(finish, 3000); // never await a wedged stream forever
      stream.on("error", () => {
        clearTimeout(timer);
        finish();
      });
      stream.end(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  /** C2: best-effort SYNCHRONOUS close for an abrupt engine quit, so a .wav left
   * open still gets a valid size header instead of looking empty (data size 0). */
  flushNativeAudioSync(): void {
    const stream = this.audioStream;
    if (!stream) return;
    this.audioStream = null;
    try {
      stream.destroy();
    } catch {
      /* best effort */
    }
    this.patchWavSizes(this.audioLocalPath, this.audioBytes);
  }

  /** One streamed PCM slice (~5 s, Int16 16 kHz) from the recording device. */
  onChunk(pcm: Int16Array): void {
    if (!this.active) return;
    this.cur.push(pcm);
    this.curLen += pcm.length;
    const curMs = (this.curLen / SAMPLE_RATE) * 1000;
    if (curMs < SEGMENT_MIN_MS) return;
    const joined = this.joinCurrent();
    if (endsInPause(joined)) {
      this.closeSegment(joined, joined.length);
    } else if (curMs >= SEGMENT_TARGET_MS) {
      // R5 (review fix): search for the quietest cut ONLY in the tail past the
      // minimum length, so the front segment stays >= SEGMENT_MIN_MS. Without this,
      // a cut window wider than the buffer could slice off a sub-250ms fragment (that
      // pump drops) and split a word mid-utterance.
      this.closeSegment(joined, findCutPoint(joined, SEGMENT_TARGET_MS - SEGMENT_MIN_MS));
    }
  }

  mark(): { ok: boolean } {
    if (!this.active) return { ok: false };
    const off = this.now() - this.startedAt;
    this.marks.push(off);
    this.doc?.append(markLine(off));
    return { ok: true };
  }

  /** A capture gap on the CLIENT device (screen locked, network loss): note it
   * honestly in the transcript. The audio and the offsets stay on the AUDIO
   * timeline (what was actually captured), so transcript timestamps keep
   * matching the playable file. */
  gap(seconds: number): { ok: boolean } {
    if (!this.active) return { ok: false };
    this.doc?.append(gapLine(this.now() - this.startedAt, seconds));
    return { ok: true };
  }

  /** Stops the capture; transcription of the backlog + the summary continue in
   * the background (state shows finalizing until done). */
  stop(): LongStopResult {
    if (!this.active) return { ok: false, recordingId: "" };
    // Freeze the length the capture reached BEFORE `active` drops: from here on
    // it is what state() reports, all through finalizing and after (U4 review).
    this.elapsedMs = Math.max(0, this.now() - this.startedAt);
    this.active = false;
    this.finalizing = true;
    const joined = this.joinCurrent();
    if (joined.length > 0) this.closeSegment(joined, joined.length);
    const id = this.recordingId;
    void this.finalize();
    return { ok: true, recordingId: id };
  }

  /**
   * L'EXPORT vers un dossier de l'utilisateur, l'ancien « Save to... ».
   *
   * Ce que ce verbe fait a change de nature avec B3. Il ne DEPLACE plus rien :
   * la reunion est dans le compte, elle y reste, et cette methode en ecrit une
   * COPIE la ou quelqu'un la demande. `staged` passe a faux pour dire « celle-la,
   * je l'ai rangee », ce qui est exactement ce que la colonne annonce.
   *
   * Consequence heureuse : il n'y a plus de commit en deux phases, plus de
   * rollback, plus de suppression de source. Un export rate ne peut plus laisser
   * une reunion orpheline, parce qu'il n'y a plus d'original a perdre.
   */
  async save(destDir: string): Promise<{ ok: boolean; error?: string; docPath?: string; audioPath?: string }> {
    if (this.active) return { ok: false, error: "a recording is still in progress" };
    const dir = (destDir || "").trim();
    if (!dir) return { ok: false, error: "no destination folder" };
    const refusal = refuseUnsafeDestination(dir);
    if (refusal) return { ok: false, error: refusal };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return { ok: false, error: "destination folder not found: " + dir };
    }
    if (!stat.isDirectory()) return { ok: false, error: "destination is not a folder" };
    // Normalement deja fait : l'interface n'offre « Save » qu'une fois la
    // finalisation passee. On l'attend quand meme, pour ne jamais exporter un
    // document a moitie ecrit. Meme attente pour une annotation en vol : un seul
    // ecrivain a la fois.
    const deadline = this.now() + 10 * 60_000;
    while ((this.finalizing || this.splicing) && this.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (this.finalizing || this.splicing) return { ok: false, error: "still finalizing; try again in a moment" };
    const last = this.lastFinished;
    if (!last) return { ok: false, error: "no finished recording to save" };
    const row = await this.rowFor(last.id);
    if (!row) return { ok: false, error: "the recording could not be read back from your account" };
    // F1, revue adverse : on revérifie la destination ICI, juste avant d'ecrire.
    // L'attente ci-dessus peut durer dix minutes, et c'est l'appelant qui decide
    // quand elle s'ouvre : passer un vrai dossier local, laisser la verification
    // passer, puis remplacer ce dossier par une jonction vers \\host\share. Sans
    // ce second regard, la garde serait la decoration que son propre commentaire
    // refuse d'etre.
    const lateRefusal = refuseUnsafeDestination(dir);
    if (lateRefusal) return { ok: false, error: lateRefusal };
    const base = recordingBaseName(row.title, new Date(Date.parse(row.startedIso) || this.now()));
    let subDir = "";
    let docPath = "";
    let audioPath = "";
    try {
      // Chaque capture a son sous-dossier, comme avant, pour que le .md et son
      // audio voyagent ensemble plutot que de s'empiler en vrac.
      subDir = uniqueDir(dir, base);
      docPath = path.join(subDir, base + ".md");
      fs.writeFileSync(docPath, row.doc);
      // Le .wav en transit est encore la quand le televersement n'est pas fini,
      // et l'exporter alors est le bon comportement : l'utilisateur demande une
      // copie, pas une preuve que Storage l'a recue.
      if (this.audioLocalPath && this.lastFinished?.id === row.id && fs.existsSync(this.audioLocalPath)) {
        audioPath = path.join(subDir, base + ".wav");
        fs.copyFileSync(this.audioLocalPath, audioPath);
      }
    } catch (err) {
      // Rien a annuler cote compte : la reunion n'a jamais quitte le compte.
      // On nettoie seulement ce qu'on vient de creer chez l'utilisateur.
      for (const p of [audioPath, docPath]) {
        if (!p) continue;
        try {
          fs.rmSync(p);
        } catch {
          /* laisser une copie partielle plutot que de toucher un fichier de l'utilisateur */
        }
      }
      try {
        if (subDir) fs.rmdirSync(subDir);
      } catch {
        /* non vide ou deja parti */
      }
      return { ok: false, error: "could not save the recording: " + String(err) };
    }
    this.staged = false;
    this.lastFinished = { ...last, staged: false };
    // La ligne du compte apprend qu'elle a ete rangee. Elle est terminee, donc
    // ceci n'est pas une tranche : c'est une derniere mise a jour.
    this.deps.store.write({ ...row, staged: false });
    this.deps.log?.(`[long] exported -> ${docPath}`);
    return { ok: true, docPath, audioPath };
  }

  /** La ligne d'une reunion : le tampon s'il la porte encore, le compte sinon. */
  private async rowFor(id: string): Promise<RecordingRow | null> {
    if (id && id === this.recordingId && this.doc) return this.row(this.doc.text());
    return this.deps.store.read(id);
  }

  /** Meeting-notes splice (2026-07-21): the Pilot server generates the notes
   * (Claude one-shot, on ITS side) and hands the finished text here; the ENGINE
   * stays the one writer of the document, so a splice can never tear against an
   * export reading it (save waits on `splicing` like it waits on `finalizing`).
   * The 100%-local invariant holds: no network call happens here, we only write
   * bytes we were handed.
   *
   * B3 : la cible est un IDENTIFIANT et non un chemin. Le « et si save() avait
   * deplace la capture entre-temps » n'existe plus - rien ne se deplace, donc il
   * n'y a plus de `movedTo` a renvoyer. */
  async notesSplice(recordingId: string, notes: string): Promise<{ ok: boolean; error?: string }> {
    const id = (recordingId || "").trim();
    const text = (notes || "").trim();
    if (!id) return { ok: false, error: "missing recording id" };
    if (!text) return { ok: false, error: "empty notes" };
    if (this.active || this.finalizing) return { ok: false, error: "a recording is still in progress" };
    this.splicing = true;
    try {
      const row = await this.rowFor(id);
      if (!row) return { ok: false, error: "no recording to annotate" };
      const doc = new CaptureDoc(transcriptHeader(row.title, row.startedIso));
      const header = doc.headerText();
      doc.append(row.doc.startsWith(header) ? row.doc.slice(header.length) : row.doc);
      doc.spliceNotesBlock(text);
      // Si c'est encore la capture en memoire, le tampon devient la verite ; la
      // ligne suit. Sinon on ecrit seulement la ligne.
      if (id === this.recordingId && this.doc) this.doc.spliceNotesBlock(text);
      this.deps.store.write({ ...row, doc: doc.text() });
      this.deps.log?.(`[long] notes spliced -> ${id}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      this.splicing = false;
    }
  }

  /** Live transcript tail for the Record page (v3 chantier 5): the document
   * content from byte `since` onward, plus the new byte offset to poll from.
   * Une lecture de memoire, la ou c'etait une lecture de fichier a 1 Hz. */
  transcriptSince(since: number): LongTranscriptResult {
    return this.doc?.since(since) ?? { text: "", nextSince: since | 0 };
  }

  state(): LongStateSnapshot {
    return {
      active: this.active,
      finalizing: this.finalizing,
      startedIso: this.startedIso,
      recordingId: this.recordingId,
      // Live while capturing, then the length it reached - through finalizing
      // and after it, until the next start() opens a new recording.
      durationMs: this.active ? this.now() - this.startedAt : this.elapsedMs,
      segments: this.segments,
      pending: this.queue.length,
      // Ce qui n'est pas encore monte dans le compte. Pour le DIRE : la page
      // Record montre « hors ligne, N changements en attente » plutot que de
      // laisser croire que tout est arrive.
      unsent: this.deps.store.pending(),
      marks: this.marks.length,
      title: this.title,
      lastError: this.lastError,
      recent: this.lastFinished ? [this.lastFinished] : [],
    };
  }

  /** Capture died under us (mic error): keep what we have, stop cleanly. */
  abort(reason: string): void {
    if (!this.active) return;
    this.lastError = reason;
    this.deps.log?.(`[long] capture error: ${reason}`);
    this.stop();
  }

  private joinCurrent(): Int16Array {
    if (this.cur.length === 1 && this.curLen === this.cur[0].length) return this.cur[0];
    const out = new Int16Array(this.curLen);
    let o = 0;
    for (const c of this.cur) {
      out.set(c, o);
      o += c.length;
    }
    this.cur = out.length ? [out] : [];
    return out;
  }

  private closeSegment(joined: Int16Array, cut: number): void {
    const seg = joined.slice(0, cut);
    const rest = joined.subarray(cut);
    this.cur = rest.length ? [rest.slice(0)] : [];
    this.curLen = rest.length;
    const offsetMs = Math.round((this.consumed / SAMPLE_RATE) * 1000);
    this.consumed += seg.length;
    if (this.queue.length >= MAX_QUEUE) {
      // The ASR cannot keep up at all (should not happen: whisper runs many
      // times faster than realtime here). Refusing keeps memory bounded; the
      // gap is written into the transcript rather than silently eaten (same
      // honest-gap discipline as a per-segment transcription failure).
      this.lastError = "transcription backlog full; a segment was dropped";
      this.deps.log?.("[long] " + this.lastError);
      this.doc?.append(`> [segment at ${Math.round(offsetMs / 1000)}s dropped: transcription backlog full]\n\n`);
      return;
    }
    this.queue.push({ pcm: seg, offsetMs });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        try {
          const speech = analyzeSpeech(item.pcm);
          if (speech.voicedMs >= 250) {
            // F1: which engine serves this is the batch engine's decision, not
            // the recorder's - and with the default settings it is the same warm
            // dictation engine this line used to reach for directly. The
            // "an empty decode must not demote a healthy GPU" rule moved with the
            // call (see LongDeps.transcribeSegment).
            const { text } = await this.deps.transcribeSegment(encodeWav(item.pcm));
            const clean = gateTranscript(text);
            if (clean) this.doc?.append(transcriptLine(item.offsetMs, clean));
          }
          this.segments++;
        } catch (err) {
          // One failed segment must not kill the recording: note it in the
          // transcript (honest gap) and move on.
          this.lastError = String(err);
          this.doc?.append(`> [segment at ${Math.round(item.offsetMs / 1000)}s could not be transcribed]\n\n`);
        }
        this.queue.shift(); // the segment's PCM dies here (bounded memory)
      }
    } finally {
      this.pumping = false;
    }
  }

  private async finalize(): Promise<void> {
    try {
      // C2: close + size-patch the .wav BEFORE the recording is uploadable, so
      // B3c never reads a half-written audio file.
      await this.closeLocalAudio();
      // Drain the backlog (pump may already be running; wait it out).
      while ((this.queue.length > 0 || this.pumping) && !this.quitting) {
        await this.pump();
        await new Promise((r) => setTimeout(r, 200));
      }
      // U4: the quit rescue already closed and published this recording,
      // synchronously, on the way out. Whatever this async tail was still doing,
      // it must not write it a second time with a duration that has since moved.
      if (this.quitting) {
        this.deps.log?.("[long] finalize abandoned: the quit rescue already closed this recording");
        return;
      }
      const doc = this.doc;
      if (!doc) return;
      // v3 chantier 4: always attempt a summary and splice it into the SAME
      // document at the top (no template chooser anymore). If no local LLM is
      // available, the document is the transcript alone.
      //
      // D7 adds a second author to that block: it appears whenever EITHER author
      // has something to say. A recording the user annotated on a machine with no
      // local model still gets its notes - the campaign's own default case.
      const mine = this.deps.liveNotes?.read(this.startedIso) ?? [];
      const mineBlock = renderMyNotes(mine);
      let generated = "";
      // P1: ask the provider whether anything can write a summary at all, before
      // reading the document.
      const llm = this.deps.llm;
      const canSummarize = llm ? (await llm.available()).found : false;
      let body = "";
      if (canSummarize || mineBlock) {
        const text = doc.text();
        const header = doc.headerText();
        body = text.startsWith(header) ? text.slice(header.length) : text;
      }
      if (canSummarize && llm) {
        const parts = chunkTranscript(body);
        if (parts.length === 1) {
          generated = (await llm.long(summaryPrompt(parts[0], this.marks, mineBlock))) ?? "";
        } else {
          // Map-reduce: summarize each chunk, then the joined summaries. The
          // user's notes go to the REDUCE step only, not to every chunk: a note
          // about minute 90 is noise while summarizing minute 3, and repeating
          // the whole outline in every one of a dozen prompts spends the context
          // budget on the part of the work that needs it least.
          const partials: string[] = [];
          for (const p of parts) {
            const x = await llm.long(summaryPrompt(p, []));
            if (x) partials.push(x);
          }
          generated =
            (await llm.long(summaryPrompt(partials.join("\n\n---\n\n"), this.marks, mineBlock))) ??
            partials.join("\n\n---\n\n");
        }
        if (generated) {
          // D8: the model was ASKED for provenance; here is where we find out
          // whether it told the truth. Every "[hh:mm:ss]" it wrote is checked
          // against the timestamps that really begin a line of THIS transcript,
          // and anything else is deleted. Nothing is ever repaired or
          // approximated: see verifyCitations' note on why an invented citation
          // is worse than none.
          const checked = verifyCitations(generated, transcriptStamps(body));
          if (checked.dropped > 0) {
            this.deps.log?.(
              `[long] notes provenance: kept ${checked.kept} citation(s), dropped ${checked.dropped} the model made up (provider ${llm.id})`,
            );
          }
          generated = checked.text;
        } else {
          this.deps.log?.("[long] summary empty: transcript stands alone");
        }
      } else {
        this.deps.log?.("[long] no local model available: transcript only, no summary");
      }
      const block = composeNotesBlock(mineBlock, generated);
      if (block) {
        // Through spliceNotes, the SAME function the regenerate path uses, so
        // there is one shape of document rather than two that can drift. Plus
        // besoin de tmp+rename : le tampon n'est jamais lu a moitie ecrit, parce
        // qu'il n'y a plus de fichier a lire.
        doc.spliceNotesBlock(block);
      }
      // La reunion est terminee. C'est ce champ, et lui seul, qui la sort de
      // l'ensemble « lignes ouvertes » que le sauvetage inspecte.
      this.endedIso = new Date(this.now()).toISOString();
      this.elapsedMs = Math.round((this.consumed / SAMPLE_RATE) * 1000);
      await this.settleAudio();
      this.publish();
      // SEULEMENT MAINTENANT, une fois le document ecrit dans la file avec les
      // notes dedans. Une fente videe avant une ecriture ratee aurait jete les
      // notes de quelqu'un ; et l'ordre FIFO de la file garantit que la
      // suppression cote compte ne depasse pas le document.
      if (block && mineBlock) this.deps.liveNotes?.clear(this.startedIso);
      this.rememberFinished();
      this.deps.log?.(
        `[long] done: ${this.recordingId}` +
          (mine.length > 0 ? ` (${mine.length} note(s) you typed` : " (") +
          (generated ? (mine.length > 0 ? " + generated notes)" : "generated notes)") : mine.length > 0 ? ")" : "transcript only)"),
      );
    } catch (err) {
      this.lastError = String(err);
      this.deps.log?.(`[long] finalize failed: ${err}`);
    } finally {
      this.finalizing = false;
      this.cancelFlush();
    }
  }

  /**
   * Ce que devient le .wav en transit, une fois la reunion terminee.
   *
   * DEUX CHEMINS, et la case a cocher decide lequel :
   *
   *  - decochee : le fichier est supprime des que le document est sur. C'est ce
   *    que la case ANNONCE, et c'est ici qu'elle devient vraie - pendant la
   *    capture le .wav est ecrit quoi qu'elle dise, parce qu'il est le dernier
   *    recours si la transcription tombe.
   *  - cochee : la ligne apprend le chemin de l'objet et sa taille, et la file de
   *    televersement prend le relais. RIEN N'EST ATTENDU ICI : 115 Mo derriere
   *    une reunion qui vient de finir bloqueraient la finalisation, donc l'etat
   *    du transfert vit dans la ligne et la page le lit.
   *
   * Le chemin de l'objet est compose ICI et non par la file, pour que la ligne
   * porte « il y a un audio pour cette reunion » des la fin de la capture. C'est
   * ce qui permet a un lancement suivant de savoir qu'il reste du travail meme si
   * la premiere tranche n'est jamais partie.
   */
  private async settleAudio(): Promise<void> {
    const p = this.audioLocalPath;
    if (!p) return;
    if (!this.keepAudio) {
      try {
        await fsp.rm(p, { force: true });
        this.deps.log?.("[long] audio dropped: the recording asked not to keep the .wav");
        this.audioLocalPath = "";
      } catch (err) {
        this.deps.log?.(`[long] could not drop the .wav the recording asked not to keep: ${err}`);
      }
      return;
    }
    const uid = (await this.deps.accountId?.()) ?? "";
    if (!uid) {
      // Sans compte connu, le chemin ne peut pas etre compose - et un chemin sans
      // le bon prefixe serait refuse par le RLS apres une heure de reunion. Le
      // fichier reste : le balayage du prochain lancement le reprendra.
      this.deps.log?.("[long] l'audio attend : le compte n'est pas connu pour l'instant");
      return;
    }
    try {
      this.audioBytes = (await fsp.stat(p)).size;
    } catch {
      /* la taille mesuree pendant la capture reste la meilleure estimation */
    }
    this.audioObjectPath = audioObjectName(uid, this.recordingId);
    this.audioUploaded = 0;
    this.deps.uploadAudio?.(this.recordingId);
  }
}
