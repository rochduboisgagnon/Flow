import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./settings";
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
  pushRecent,
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
  // v6 c7: optional now. Empty/absent = record into an app-owned STAGING folder;
  // the destination is chosen at the END (save()). A non-empty dir keeps the old
  // "record straight into that folder" behaviour (still used by any caller that
  // wants it).
  dir?: string;
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
  log?: (msg: string) => void;
  /** Tests only: keep the recent-list file away from the real ~/.agr-flow. */
  recentPathOverride?: string;
  /** Tests only: keep the app-owned staging folder away from the real ~/.agr-flow. */
  stagingRootOverride?: string;
  /** Tests only: keep the retention history away from the real ~/.agr-flow. This is
   * a TEST seam, not a user setting - U2a fixed the history folder at
   * dataDir()/history, so production code never sets this. */
  historyRootOverride?: string;
}

const MAX_QUEUE = 240; // ~100 min of backlog before we refuse to grow (safety)

// U4a piege 1: how long state()'s `recent` field may lag behind recent.json.
// Exported so the cache behavior itself is testable (test/longform.test.ts)
// without a magic number duplicated on both sides. Short enough that nothing
// waits meaningfully on it, long enough to turn a 1 Hz poll's worth of reads
// into a small fraction of one.
export const RECENT_STATE_CACHE_MS = 3_000;

export function recentPath(): string {
  return path.join(dataDir(), "recent.json");
}

// v6 c7: app-owned staging root. A recording with no chosen destination lands
// in a per-session subfolder here; save() moves it out into the user's folder.
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

export function loadRecent(file = recentPath()): RecentEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

/** C10: recent.json can still point at an entry the retention purge already
 * removed (a staged recording nobody saved within the window). Filter those
 * out only when SERVING the list to a caller - recent.json on disk is left
 * untouched, and save()'s own bookkeeping keeps reading the raw list via
 * loadRecent() so it can give an accurate "already gone" error instead. */
function existingRecent(list: RecentEntry[]): RecentEntry[] {
  return list.filter((e) => e.docPath && fs.existsSync(e.docPath));
}

/** Playable length of a 16 kHz mono 16-bit .wav, from its size alone. Used for
 * a RECOVERED recording, whose duration nobody was around to measure: reading
 * it off the audio is honest, and beats showing "0:00" for a two-hour meeting.
 * 0 when there is no audio to measure. */
function wavDurationMs(audioPath: string): number {
  if (!audioPath) return 0;
  try {
    const bytes = Math.max(0, fs.statSync(audioPath).size - 44); // minus the header
    return Math.round((bytes / (SAMPLE_RATE * 2)) * 1000);
  } catch {
    return 0;
  }
}

function saveRecent(list: RecentEntry[], file = recentPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* the recent list is a convenience, never a blocker */
  }
}

export class LongRecorder {
  private deps: LongDeps;
  private active = false;
  private finalizing = false;
  private splicing = false; // notes splice in flight: save() waits it out (one writer)
  // U4: rescueOnQuit() ran. The process is on its way out and the recording is
  // already filed, so a finalize() still awaiting the ASR or Ollama must not
  // file or re-index it a second time if it somehow gets CPU again.
  private quitting = false;
  private startedAt = 0;
  private startedIso = "";
  private title = "";
  private dir = "";
  private staged = false; // v6 c7: the doc is still in the app-owned staging folder
  private transcriptPath = ""; // the ONE document (summary spliced in at finalize)
  private audioPath = "";
  private keepAudio = false;
  private native = false; // C2: engine-captured -> engine writes the .wav
  private audioStream: fs.WriteStream | null = null; // C2 native .wav (device mode: Pilot writes it)
  private audioBytes = 0; // C2 PCM bytes written to the native .wav (for the header patch)
  private audioFailed = false; // C2: a .wav I/O error occurred; stop writing but keep transcribing
  private headerStr = "";
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
  // U4a piege 1: state() is now polled at up to 1 Hz by BOTH GET /long/state
  // and the UI_LONG_STATE IPC channel (main/uiBridge.ts), and `recent` is a
  // synchronous read (existingRecent(loadRecent()): a JSON read plus an
  // fs.existsSync per entry) - the same load pattern main/index.ts's own
  // recentForUi() cache exists to keep off the keyboard hook's hot path for
  // UiStatePayload's 1 Hz push. Caching it HERE, once, protects every current
  // and future caller of state() alike, rather than asking each one to
  // remember to skip or cache the field itself.
  private recentStateCache: { at: number; value: RecentEntry[] } = { at: 0, value: [] };

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

  /** C10: a recording being saved may currently sit in EITHER the app-owned
   * staging folder (freshly stopped, not yet filed) or the history folder (the
   * retention safety net, already relocated once by fileIntoHistory). Picks
   * the matching root so the emptied session/date folder is cleaned up bounded
   * to wherever it actually lives - never wanders outside either app-owned root. */
  private holdingRootFor(dir: string): string {
    const hist = this.historyBase();
    const rel = path.relative(hist, dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return hist;
    return this.stagingBase();
  }

  /** Best-effort retention purge (C10 §5): call at engine startup and at the
   * top of every start() so history never grows unbounded. Never throws -
   * purgeHistoryDirs already swallows its own errors - so a failure here can
   * never stop a recording from starting.
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

  /** File a STAGED recording out of the app-owned staging folder into the
   * date-bucketed history (C10): a recording nobody explicitly saved still
   * gets a home for RETENTION_DAYS instead of sitting invisible in staging
   * forever. The move itself, and every guardrail around it, lives in
   * fileRecordingIntoHistory - shared with the quit rescue and the startup
   * rescan. Best effort: any failure just leaves the recording in staging,
   * where the next startup rescan finds it. */
  private fileIntoHistory(): void {
    const oldDir = this.dir;
    const filed = fileRecordingIntoHistory({
      historyRoot: this.historyBase(),
      docPath: this.transcriptPath,
      audioPath: this.audioPath,
      // U4 constat 2: "Keep the audio file" finally decides something. The .wav
      // is written throughout a STAGED capture whatever the box says (it is the
      // only thing that can still save a meeting whose transcription failed,
      // and in device mode the Pilot server needs a path to stream it to), but
      // it enters the 90-day archive only when the user asked to keep it.
      keepAudio: this.keepAudio,
      startedMs: this.startedAt,
      log: this.deps.log,
    });
    if (!filed) return;
    this.dir = filed.dir;
    this.transcriptPath = filed.docPath;
    this.audioPath = filed.audioPath;
    cleanEmptyHoldingDirs(this.stagingBase(), oldDir);
    this.deps.log?.(`[long] filed into history -> ${filed.docPath}`);
  }

  /** True when `p` sits inside the app-owned staging root. Tells "this
   * recording is still parked where only Flow can see it" apart from "it has
   * already been filed into history, or straight into the user's own folder". */
  private underStaging(p: string): boolean {
    const rel = path.relative(this.stagingBase(), p);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /** U4 blocking finding: `before-quit` is SYNCHRONOUS and Electron awaits
   * nothing a handler starts. Calling stop() from there only LAUNCHES
   * finalize(), which drains the ASR queue in 200 ms polls and then waits on an
   * Ollama round-trip - the process dies long before fileIntoHistory() and
   * saveRecent() ever run, and the meeting stays in <dataDir>/staging, a folder
   * nothing lists, nothing rescans and nothing purges. The recording exists on
   * disk and is invisible from every surface of the app.
   *
   * This is the synchronous half of the fix: no summary, no waiting on the
   * transcription, just "get the document into the archive, index it, and say
   * honestly what is missing from it". Best effort in the strict sense of
   * flushNativeAudioSync(): an exception here must never keep the app from
   * dying. Returns whether it actually rescued something. */
  rescueOnQuit(): boolean {
    if (!this.active && !this.finalizing) return false;
    // Count what is about to be lost BEFORE tearing the state down, so the note
    // in the document can be specific: the queued segments plus the open one.
    const pending = this.queue.length + (this.curLen > 0 ? 1 : 0);
    if (this.active) this.elapsedMs = Math.max(0, Date.now() - this.startedAt); // freeze before active drops
    this.active = false;
    this.quitting = true; // a finalize() still in flight must not file this twice
    try {
      // The .wav first: its size header is a placeholder until the stream
      // closes, so a file moved before this looks empty to every player.
      this.flushNativeAudioSync();
      noteInterruption(this.transcriptPath, interruptedNote("quit", pending), this.deps.log);
      // D7: the notes the user typed go in NOW, on the way out, and before the
      // document is relocated below. No summary and no model on this path - the
      // process is dying and awaits nothing - so the block holds the human's
      // notes alone, which is the honest content for an interrupted recording.
      // See spliceMyNotesSync on why it must follow noteInterruption.
      const mine = this.deps.liveNotes?.read(this.startedIso) ?? [];
      if (spliceMyNotesSync(this.transcriptPath, this.headerStr, mine, this.deps.log)) {
        this.deps.liveNotes?.clear(this.startedIso);
      }
      // Only a recording still parked in staging needs relocating; one recorded
      // straight into the user's own folder is already where they want it.
      if (this.staged && this.underStaging(this.transcriptPath)) this.fileIntoHistory();
      this.writeRecent(
        pushRecent(loadRecent(this.deps.recentPathOverride), {
          title: this.title,
          startedIso: this.startedIso,
          dir: this.dir,
          docPath: this.transcriptPath,
          audioPath: this.audioPath,
          // Wall clock, not `consumed`: the capture ran until this very moment,
          // while `consumed` only counts segments that were CLOSED in time.
          durationMs: this.elapsedMs,
          staged: this.staged,
        }),
      );
      this.deps.log?.(`[long] rescued on quit -> ${this.transcriptPath}`);
      return true;
    } catch (err) {
      this.deps.log?.(`[long] quit rescue failed: ${err}`);
      return false;
    } finally {
      this.finalizing = false;
    }
  }

  /** U4, the real net: everything rescueOnQuit() does assumes before-quit RUNS.
   * A power cut, a bugcheck, a taskkill or an OOM never gives the engine that
   * chance, and the recording stays in <dataDir>/staging exactly as the failed
   * session left it. At boot nothing can legitimately be recording yet (the
   * single-instance lock is held, and neither the local API nor the window is
   * up), so ANY folder still sitting in staging belongs to a session that is
   * over: file it into the archive, where every surface of the app can finally
   * see it, and say so in the log.
   *
   * Never throws and never deletes: a folder it cannot file stays exactly where
   * it is, so the next boot tries again. Returns how many were rescued. */
  rescueOrphanedStaging(): number {
    const staging = this.stagingBase();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(staging, { withFileTypes: true });
    } catch {
      return 0; // no staging folder at all: the normal case, nothing to say
    }
    let rescued = 0;
    let best: RecentEntry | null = null;
    let bestMs = -1;
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
        // D7, the last of the three merge paths: the app never got to run any
        // shutdown code, so nothing filed the notes typed during this recording.
        // The slot outlives the crash (it is a separate file under dataDir, not
        // in this folder - see main/liveNotes.ts), so they can still be merged
        // here. Matched on the start instant read out of the document's own
        // header: notes from a DIFFERENT session are never attached to this one,
        // they are left in the slot for open() to set aside by name.
        if (session.startedIso) {
          const mine = this.deps.liveNotes?.read(session.startedIso) ?? [];
          if (
            spliceMyNotesSync(
              session.docPath,
              transcriptHeader(session.title, session.startedIso),
              mine,
              this.deps.log,
            )
          ) {
            this.deps.liveNotes?.clear(session.startedIso);
            this.deps.log?.(`[long] recovered ${mine.length} note(s) you had typed during ${session.docPath}`);
          }
        }
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
        this.deps.log?.(`[long] recovered an interrupted recording -> ${filed.docPath}`);
        if (session.startedMs > bestMs) {
          bestMs = session.startedMs;
          best = {
            title: session.title,
            startedIso: new Date(session.startedMs).toISOString(),
            dir: filed.dir,
            docPath: filed.docPath,
            audioPath: filed.audioPath,
            durationMs: wavDurationMs(filed.audioPath),
            staged: true, // never filed by the user: it still deserves a "Save to..."
          };
        }
      } catch (err) {
        this.deps.log?.(`[long] could not recover ${dir}: ${err}`);
      }
    }
    if (best) {
      // RECENT_MAX is 1: recent.json holds "the last capture", and save() files
      // exactly that one. A recovered recording takes the slot only when it is
      // genuinely more recent than what is already there, so a boot rescue can
      // never demote a capture the user finished afterwards.
      const list = loadRecent(this.deps.recentPathOverride);
      const headMs = list[0] ? Date.parse(list[0].startedIso || "") : NaN;
      if (!list[0] || Number.isNaN(headMs) || bestMs >= headMs) {
        this.writeRecent(pushRecent(list, best));
      }
    }
    return rescued;
  }

  start(opts: LongStartOpts): LongStartResult {
    if (this.active || this.finalizing) return { ok: false, error: "a recording is already in progress" };
    this.purgeHistory(); // C10: retention purge on every start(), best effort, never blocking
    const now = new Date();
    this.title = (opts.title || "").trim() || "Recording";
    this.keepAudio = !!opts.keepAudio;
    // v6 c7: no destination chosen up front -> record into an app-owned staging
    // folder and let the user file it at Stop (save()). A caller that passes an
    // explicit dir keeps the record-straight-into-it behaviour.
    const explicit = (opts.dir || "").trim();
    this.staged = !explicit;
    let dir: string;
    if (this.staged) {
      dir = path.join(this.stagingBase(), String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8));
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, error: "cannot prepare the staging folder: " + String(err) };
      }
    } else {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(explicit);
      } catch {
        return { ok: false, error: "destination folder not found: " + explicit };
      }
      if (!stat.isDirectory()) return { ok: false, error: "destination is not a folder" };
      dir = explicit;
    }
    this.dir = dir;
    const base = recordingBaseName(this.title, now);
    this.transcriptPath = path.join(dir, base + ".md");
    // The .wav is written by the Pilot server as chunks stream in, when the
    // user chose to keep the audio (v3 chantier 4). We own the path; an empty
    // path tells the server not to open a file.
    // A STAGED recording gets a path regardless of keepAudio, because DURING
    // the capture the .wav is the only thing that can still save a meeting
    // whose transcription falls over, and a crash gives no second chance to
    // start writing it. U4 constat 2: that is where its life ends when the box
    // is unchecked - fileIntoHistory() drops it once the document is safely
    // filed, so the checkbox describes what Flow KEEPS, truthfully, instead of
    // being a decoration on a .wav retained for 90 days no matter what.
    // A recording with an explicit destination never writes one at all.
    this.audioPath = this.keepAudio || this.staged ? path.join(dir, base + ".wav") : "";
    // C2: in NATIVE mode the engine captures the audio, so the engine writes the .wav
    // (in device mode the Pilot server writes it as chunks stream in). Open a growing
    // WAV with a placeholder header; writeNativeAudio appends, close patches the sizes.
    this.native = !!opts.native;
    this.audioStream = null;
    this.audioBytes = 0;
    this.audioFailed = false;
    // C10: this.audioPath is now the single source of truth for "should the
    // wav be written" (it already folds in keepAudio OR staged above), so the
    // native-capture gate no longer re-checks keepAudio separately.
    if (this.native && this.audioPath) {
      try {
        const s = fs.createWriteStream(this.audioPath);
        // Without this handler an async write failure (disk full, volume removed, AV
        // lock) is an uncaught 'error' event that would CRASH the whole engine. Absorb
        // it: stop writing audio but let the transcript still finalize.
        s.on("error", (err) => {
          this.audioFailed = true;
          this.deps.log?.(`[long] native .wav stream error: ${err}`);
        });
        s.write(wavHeader(0));
        this.audioStream = s;
      } catch (err) {
        this.deps.log?.(`[long] cannot open the .wav for native capture: ${err}`);
        this.audioStream = null;
      }
    }
    this.startedAt = Date.now();
    this.startedIso = now.toISOString();
    this.elapsedMs = 0; // a new recording: the previous one's length is no longer the answer
    this.marks = [];
    this.cur = [];
    this.curLen = 0;
    this.consumed = 0;
    this.queue = [];
    this.segments = 0;
    this.lastError = "";
    this.quitting = false;
    this.headerStr = transcriptHeader(this.title, this.startedIso);
    try {
      fs.writeFileSync(this.transcriptPath, this.headerStr);
    } catch (err) {
      return { ok: false, error: "cannot write in the folder: " + String(err) };
    }
    this.active = true;
    // D7: bind the live-notes slot to THIS recording, after the document exists
    // (a start that failed above must not claim the slot). Never destructive - a
    // slot still holding an earlier session's unfiled notes is moved aside, not
    // overwritten (main/liveNotes.ts's open()).
    this.deps.liveNotes?.open(this.startedIso);
    this.deps.log?.(`[long] recording started -> ${this.transcriptPath}`);
    return { ok: true, docPath: this.transcriptPath, audioPath: this.audioPath };
  }

  /** C2 native mode: append the engine-captured PCM to the .wav (no-op in device
   * mode, where the Pilot server writes it). Called alongside onChunk. */
  writeNativeAudio(pcm: Int16Array): void {
    const s = this.audioStream;
    if (!s || this.audioFailed) return;
    try {
      s.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      this.audioBytes += pcm.byteLength;
    } catch (err) {
      this.audioFailed = true;
      this.deps.log?.(`[long] native .wav write failed: ${err}`);
    }
  }

  /** Patch a native .wav's RIFF/data sizes to `bytes` in place. Best effort. */
  private patchWavSizes(p: string, bytes: number): void {
    try {
      const fd = fs.openSync(p, "r+");
      const patch = Buffer.alloc(4);
      patch.writeUInt32LE(36 + bytes, 0);
      fs.writeSync(fd, patch, 0, 4, 4); // RIFF chunk size
      patch.writeUInt32LE(bytes, 0);
      fs.writeSync(fd, patch, 0, 4, 40); // data chunk size
      fs.closeSync(fd);
    } catch (err) {
      this.deps.log?.(`[long] native .wav header patch failed: ${err}`);
    }
  }

  /** Close the native .wav (if any) and patch its sizes. Awaited by finalize so
   * save() never moves a half-written file. NEVER hangs: an errored/wedged stream
   * still resolves (via its 'error' event or a safety timer) so finalize can't stick. */
  private closeNativeAudio(): Promise<void> {
    const stream = this.audioStream;
    this.audioStream = null;
    if (!stream) return Promise.resolve();
    const bytes = this.audioBytes;
    const p = this.audioPath;
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

  /** C2: best-effort SYNCHRONOUS close for an abrupt engine quit, so a native .wav
   * left open still gets a valid size header instead of looking empty (data size 0). */
  flushNativeAudioSync(): void {
    const stream = this.audioStream;
    if (!stream) return;
    this.audioStream = null;
    try {
      stream.destroy();
    } catch {
      /* best effort */
    }
    this.patchWavSizes(this.audioPath, this.audioBytes);
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
    const off = Date.now() - this.startedAt;
    this.marks.push(off);
    try {
      fs.appendFileSync(this.transcriptPath, markLine(off));
    } catch {
      /* the in-memory mark still reaches the summary */
    }
    return { ok: true };
  }

  /** A capture gap on the CLIENT device (screen locked, network loss): note it
   * honestly in the transcript. The audio and the offsets stay on the AUDIO
   * timeline (what was actually captured), so transcript timestamps keep
   * matching the playable file. */
  gap(seconds: number): { ok: boolean } {
    if (!this.active) return { ok: false };
    try {
      fs.appendFileSync(this.transcriptPath, gapLine(Date.now() - this.startedAt, seconds));
    } catch {
      /* the recording goes on */
    }
    return { ok: true };
  }

  /** Stops the capture; transcription of the backlog + the summary continue in
   * the background (state shows finalizing until done). */
  stop(): LongStopResult {
    if (!this.active) return { ok: false, docPath: "" };
    // Freeze the length the capture reached BEFORE `active` drops: from here on
    // it is what state() reports, all through finalizing and after (U4 review).
    this.elapsedMs = Math.max(0, Date.now() - this.startedAt);
    this.active = false;
    this.finalizing = true;
    const joined = this.joinCurrent();
    if (joined.length > 0) this.closeSegment(joined, joined.length);
    const t = this.transcriptPath;
    void this.finalize();
    return { ok: true, docPath: t };
  }

  /** v6 c7: file the finished recording into the folder the user picks at Stop.
   * Waits out finalize (so the summary splice is done), then MOVES the document
   * (and the .wav if kept) out of staging into destDir and repoints recent.json.
   * Deletes nothing the user owns; a name clash is suffixed, never overwritten. */
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
    // Normally already done: the UI only offers "Save" once state left finalizing.
    // Wait it out anyway so we never move a half-written document. Same wait for
    // a notes splice in flight (notesSplice): one writer at a time, never a torn
    // copy of a document being rewritten.
    const deadline = Date.now() + 10 * 60_000;
    while ((this.finalizing || this.splicing) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (this.finalizing || this.splicing) return { ok: false, error: "still finalizing; try again in a moment" };
    // recent.json is the source of truth for "the last capture" (survives an
    // engine restart between Stop and Save).
    const list = loadRecent(this.deps.recentPathOverride);
    const entry = list[0];
    if (!entry || !entry.docPath) return { ok: false, error: "no finished recording to save" };
    // C10: the entry can be missing because it was already saved, OR because
    // the retention purge removed it (a staged recording nobody saved within
    // the window) - either way, refuse cleanly rather than half-committing.
    if (!fs.existsSync(entry.docPath)) return { ok: false, error: "the recording is no longer available (already saved, or removed by the history purge)" };
    // F1, adverse review: check the destination AGAIN, here, immediately before
    // anything is created.
    //
    // The check at the top of this function is not enough on its own, and the
    // reason is the wait above it: finalize can hold this call for up to ten
    // minutes. That is not a microsecond race - it is a comfortable window, and
    // the caller is the one who decides when it opens, because the caller is who
    // called /long/stop. Pass a real local folder, let the check pass, then swap
    // that folder for a junction to \\host\share while save() waits. Without this
    // second look the guard would be exactly the decoration its own comment says
    // it refuses to be.
    //
    // The first check stays: it refuses an obviously bad destination before the
    // ten-minute wait rather than after it, which is the difference between a
    // clear error and a mysterious pause.
    const lateRefusal = refuseUnsafeDestination(dir);
    if (lateRefusal) return { ok: false, error: lateRefusal };
    // Two-phase commit so a mid-way failure never orphans the recording:
    // (1) COPY the document (and the .wav if it really exists) into the chosen
    //     folder; on ANY error, delete the copies made and leave staging
    //     untouched so a retry is clean. (2) point recent.json at the new
    //     location, THEN delete the staging sources. Either both files land in
    //     the folder and recent.json follows, or nothing in recent.json changed
    //     and the sources stay put. A large .wav that fails to copy (a near-full
    //     target volume, an antivirus lock) can never strand the transcript.
    const madeDest: string[] = [];
    let subDir = "";
    let newDoc: string;
    let newAudio = "";
    try {
      // Each capture gets its own subfolder <slug>-<YYYY-MM-DD-HHmm> (the doc's
      // base name) so the .md and its audio travel together instead of piling
      // up loose in the chosen folder. Same layout as history's per-recording
      // folders; uniqueDir keeps two same-titled captures apart.
      subDir = uniqueDir(dir, path.basename(entry.docPath, ".md"));
      newDoc = copyFileInto(subDir, entry.docPath);
      madeDest.push(newDoc);
      // The .wav may be absent (transcript-only, or the Pilot server could not
      // create it and rolled back at /long/start): its absence must NOT fail the
      // save - the document is the deliverable.
      if (entry.audioPath && fs.existsSync(entry.audioPath)) {
        newAudio = copyFileInto(subDir, entry.audioPath);
        madeDest.push(newAudio);
      }
    } catch (err) {
      for (const p of madeDest) {
        try {
          fs.rmSync(p);
        } catch {
          /* leave a partial copy rather than risk touching a user file */
        }
      }
      // Drop the subfolder too if it emptied out (rmdirSync refuses otherwise):
      // a failed save must not litter the user's folder.
      try {
        if (subDir) fs.rmdirSync(subDir);
      } catch {
        /* non-empty or already gone */
      }
      return { ok: false, error: "could not save the recording: " + String(err) };
    }
    const stagedFrom = entry.dir;
    const updated: RecentEntry = { ...entry, dir: subDir, docPath: newDoc, audioPath: newAudio, staged: false };
    // U4 (review, major): through writeRecent, so the state() cache cannot go on
    // advertising the staging path this call is about to delete.
    this.writeRecent(pushRecent(list.slice(1), updated));
    // Keep the live snapshot consistent if it still points at the saved doc.
    if (this.transcriptPath === entry.docPath) {
      this.transcriptPath = newDoc;
      this.audioPath = newAudio;
      this.dir = subDir;
      this.staged = false;
    }
    // recent.json now points at the destination copies; remove the staging
    // originals (best effort - a leftover only costs a little app-owned disk).
    try {
      fs.rmSync(entry.docPath);
    } catch {
      /* */
    }
    if (entry.audioPath) {
      try {
        fs.rmSync(entry.audioPath);
      } catch {
        /* */
      }
    }
    // C10: the recording may be leaving staging OR history - clean whichever
    // app-owned root it actually came from (bounded, never wanders outside it).
    cleanEmptyHoldingDirs(this.holdingRootFor(stagedFrom), stagedFrom);
    this.deps.log?.(`[long] saved -> ${newDoc}`);
    return { ok: true, docPath: newDoc, audioPath: newAudio };
  }

  /** Meeting-notes splice (2026-07-21): the Pilot server generates the notes
   * (Claude one-shot, on ITS side) and hands the finished text here; the ENGINE
   * stays the one writer of the document, so a splice can never tear against
   * save() moving the files (save waits on `splicing` like it waits on
   * `finalizing`). The 100%-local invariant holds: no network call happens
   * here, we only write bytes we were handed. The target is resolved from
   * recent.json, NOT trusted from the caller: if save() moved the capture
   * between notes generation and this call, the caller gets `movedTo` and
   * re-splices on the new path (the notes are already computed). */
  notesSplice(docPath: string, notes: string): { ok: boolean; error?: string; movedTo?: string } {
    const p = (docPath || "").trim();
    const text = (notes || "").trim();
    if (!p) return { ok: false, error: "missing docPath" };
    if (!text) return { ok: false, error: "empty notes" };
    if (this.active || this.finalizing) return { ok: false, error: "a recording is still in progress" };
    const entry = loadRecent(this.deps.recentPathOverride)[0];
    if (!entry || !entry.docPath || !fs.existsSync(entry.docPath)) {
      return { ok: false, error: "no recording to annotate (already purged?)" };
    }
    if (path.resolve(p) !== path.resolve(entry.docPath)) {
      return { ok: false, movedTo: entry.docPath, error: "the recording moved" };
    }
    this.splicing = true;
    try {
      const doc = fs.readFileSync(entry.docPath, "utf8");
      const header = transcriptHeader(entry.title, entry.startedIso);
      // Atomic swap, same discipline as the summary splice in finalize().
      const tmp = entry.docPath + ".tmp";
      fs.writeFileSync(tmp, spliceNotes(doc, header, text));
      fs.renameSync(tmp, entry.docPath);
      this.deps.log?.(`[long] notes spliced -> ${entry.docPath}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      this.splicing = false;
    }
  }

  /** Live transcript tail for the PWA page (v3 chantier 5): the document
   * content from byte `since` onward, plus the new byte offset to poll from. */
  transcriptSince(since: number): LongTranscriptResult {
    try {
      const buf = fs.readFileSync(this.transcriptPath);
      const from = Math.max(0, Math.min(since | 0, buf.length));
      return { text: buf.toString("utf8", from), nextSince: buf.length };
    } catch {
      return { text: "", nextSince: since | 0 };
    }
  }

  state(): LongStateSnapshot {
    return {
      active: this.active,
      finalizing: this.finalizing,
      startedIso: this.startedIso,
      // Live while capturing, then the length it reached - through finalizing
      // and after it, until the next start() opens a new recording. Callers
      // that need "is something running" read `active`/`finalizing`, which have
      // always been the honest answer to that question (GET /long/state carries
      // both, so the AGR Pilot client is unaffected by this field no longer
      // collapsing to 0).
      durationMs: this.active ? Date.now() - this.startedAt : this.elapsedMs,
      segments: this.segments,
      pending: this.queue.length,
      marks: this.marks.length,
      title: this.title,
      dir: this.dir,
      docPath: this.transcriptPath,
      audioPath: this.audioPath,
      lastError: this.lastError,
      recent: this.cachedRecent(),
    };
  }

  /** C10: entries the retention purge already removed are hidden here
   * (recent.json on disk is untouched; save() still reads it raw).
   *
   * U4a piege 1: cached for RECENT_STATE_CACHE_MS so a caller polling state()
   * at 1 Hz (GET /long/state, UI_LONG_STATE) does not re-read recent.json and
   * re-stat its entry's docPath on every single tick.
   *
   * U4 (review, major): the original note here claimed the cache could only
   * ever be "briefly behind, never wrong". That was false, and save() was the
   * proof: it MOVES the document and deletes the staging original, so for up to
   * three seconds afterwards state() went on advertising a path that no longer
   * exists - not late, wrong. Every write of recent.json made from inside this
   * class therefore drops the cache (writeRecent), which leaves the cache
   * absorbing only what it was built for: repeated reads between two writes. A
   * write by ANOTHER process is still picked up on the ordinary expiry, which
   * is the only staleness this class cannot see coming. */
  private cachedRecent(): RecentEntry[] {
    const now = Date.now();
    if (now - this.recentStateCache.at > RECENT_STATE_CACHE_MS) {
      this.recentStateCache = { at: now, value: existingRecent(loadRecent(this.deps.recentPathOverride)) };
    }
    return this.recentStateCache.value;
  }

  /** The ONE way this class writes recent.json: persist, then drop the state()
   * cache so the very next snapshot reflects what was just written. Every
   * writer goes through here - finalize(), save(), the quit rescue and the boot
   * rescan - because a cache invalidated on three paths out of four is a cache
   * that lies on the fourth. */
  private writeRecent(list: RecentEntry[]): void {
    saveRecent(list, this.deps.recentPathOverride);
    // `at: 0` is not a reachable timestamp, so the next cachedRecent() re-reads.
    this.recentStateCache = { at: 0, value: [] };
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
      try {
        fs.appendFileSync(this.transcriptPath, `> [segment at ${Math.round(offsetMs / 1000)}s dropped: transcription backlog full]\n\n`);
      } catch { /* disk hiccup: the log line above still recorded it */ }
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
            if (clean) fs.appendFileSync(this.transcriptPath, transcriptLine(item.offsetMs, clean));
          }
          this.segments++;
        } catch (err) {
          // One failed segment must not kill the recording: note it in the
          // transcript (honest gap) and move on.
          this.lastError = String(err);
          try {
            fs.appendFileSync(this.transcriptPath, `> [segment at ${Math.round(item.offsetMs / 1000)}s could not be transcribed]\n\n`);
          } catch { /* */ }
        }
        this.queue.shift(); // the segment's PCM dies here (bounded memory)
      }
    } finally {
      this.pumping = false;
    }
  }

  private async finalize(): Promise<void> {
    try {
      // C2: close + size-patch the native .wav BEFORE the recording is filable, so
      // save() never moves a half-written audio file (no-op in device mode).
      await this.closeNativeAudio();
      // Drain the backlog (pump may already be running; wait it out).
      while ((this.queue.length > 0 || this.pumping) && !this.quitting) {
        await this.pump();
        await new Promise((r) => setTimeout(r, 200));
      }
      // U4: the quit rescue already filed and indexed this recording,
      // synchronously, on the way out. Whatever this async tail was still
      // doing, it must not file it a second time or overwrite recent.json with
      // paths that have since moved.
      if (this.quitting) {
        this.deps.log?.("[long] finalize abandoned: the quit rescue already filed this recording");
        return;
      }
      // v3 chantier 4: always attempt a summary and splice it into the SAME
      // document at the top (no template chooser anymore). If no local LLM is
      // available, the document is the transcript alone.
      //
      // D7 adds a second author to that block, and it changes when the block is
      // written: it used to appear only if a model produced something, and now it
      // appears whenever EITHER author has something to say. A recording the user
      // annotated on a machine with no local model still gets its notes - which
      // is the case that matters most, since it is the campaign's own default.
      const mine = this.deps.liveNotes?.read(this.startedIso) ?? [];
      const mineBlock = renderMyNotes(mine);
      let generated = "";
      // P1: ask the provider whether anything can write a summary at all, before
      // reading the document. The gate is kept (rather than letting long() just
      // return null) because reading a whole transcript to then discover nobody
      // will summarise it is work done for nothing on every recording made on a
      // machine with no model - which is the campaign's own default case.
      const llm = this.deps.llm;
      const canSummarize = llm ? (await llm.available()).found : false;
      let doc = "";
      let body = "";
      if (canSummarize || mineBlock) {
        doc = fs.readFileSync(this.transcriptPath, "utf8");
        body = doc.startsWith(this.headerStr) ? doc.slice(this.headerStr.length) : doc;
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
        this.deps.log?.("[long] no Ollama model available: transcript only, no summary");
      }
      const block = composeNotesBlock(mineBlock, generated);
      if (block) {
        // Atomic swap (tmp + rename): the splice REWRITES the whole document, so a live
        // transcriptSince poll racing this write must never observe a half-written file. Write the
        // final content aside, then rename over the path in one step (same discipline as saveRecent).
        // Through spliceNotes, the SAME function the regenerate path uses, so
        // there is one shape of document rather than two that can drift.
        const tmp = this.transcriptPath + ".tmp";
        fs.writeFileSync(tmp, spliceNotes(doc, this.headerStr, block));
        fs.renameSync(tmp, this.transcriptPath);
        // Only NOW, once the notes are on disk inside the document. A slot
        // cleared before a failed write would have thrown the user's notes away
        // (main/liveNotes.ts's clear()).
        if (mineBlock) this.deps.liveNotes?.clear(this.startedIso);
      }
      // C10: a recording with no chosen destination is the history mechanism's
      // default landing spot, not a second write path (design invariant) - move
      // it out of staging into <historyRoot>/<date>/<title>/ NOW, so recent.json
      // below points at the history location straight away. staged stays true:
      // the user still hasn't filed it into a folder of their own choosing.
      if (this.staged) this.fileIntoHistory();
      this.writeRecent(
        pushRecent(loadRecent(this.deps.recentPathOverride), {
          title: this.title,
          startedIso: this.startedIso,
          dir: this.dir,
          docPath: this.transcriptPath,
          audioPath: this.audioPath,
          durationMs: Math.round((this.consumed / SAMPLE_RATE) * 1000),
          staged: this.staged, // v6 c7: needs a "Save to..." step until filed
        }),
      );
      this.deps.log?.(
        `[long] done: ${this.transcriptPath}` +
          (mine.length > 0 ? ` (${mine.length} note(s) you typed` : " (") +
          (generated ? (mine.length > 0 ? " + generated notes)" : "generated notes)") : mine.length > 0 ? ")" : "transcript only)"),
      );
    } catch (err) {
      this.lastError = String(err);
      this.deps.log?.(`[long] finalize failed: ${err}`);
    } finally {
      this.finalizing = false;
    }
  }
}
