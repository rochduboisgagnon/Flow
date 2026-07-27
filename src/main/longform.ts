import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WhisperSidecar } from "./asr/sidecar";
import { dataDir } from "./settings";
import { encodeWav } from "../shared/wav";
import { analyzeSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import { summarize } from "./llm/ollama";
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
  recordingBaseName,
  summaryPrompt,
  chunkTranscript,
  spliceNotes,
  pushRecent,
  type RecentEntry,
} from "../shared/longform";

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

export interface LongStateSnapshot {
  active: boolean;
  finalizing: boolean;
  startedIso: string;
  durationMs: number;
  segments: number; // transcribed so far
  pending: number; // queued behind the ASR
  marks: number;
  title: string;
  dir: string;
  docPath: string;
  audioPath: string;
  lastError: string;
  recent: RecentEntry[];
}

export interface LongDeps {
  getSidecar(): WhisperSidecar | null;
  /** settings.summaryModel: the Ollama model used for meeting summaries.
   * "" (or absent) falls back to the first installed model. */
  summaryModel?(): string;
  /** Installed Ollama models, used to auto-pick a summary model when the user
   * did not configure one. Injectable so tests don't hit a real Ollama. */
  ollamaModels?: () => Promise<string[] | null>;
  /** settings.historyPurgeSuspended, read LAZILY (this module never imports
   * settings state - only dataDir()): true means the fixed history folder holds
   * an archive Flow was not managing, so the retention purge must not run at
   * all. Absent = not suspended, which is the normal case. */
  historyPurgeSuspended?(): boolean;
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

export interface HistoryItem {
  id: string;
  date: string;
  title: string;
  hasAudio: boolean;
  audioBytes: number;
  docBytes: number;
  savedMs: number;
}

// A runaway history (years of unattended recordings piling up on the fixed
// folder) must never make the archive view stall the engine's single-threaded
// API. Bounded, like the ASR queue.
const MAX_HISTORY_ITEMS = 2000;

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
      let dateStat: fs.Stats;
      try {
        dateStat = fs.lstatSync(dateDir); // lstat: never follow a linked date dir
      } catch {
        continue;
      }
      if (dateStat.isSymbolicLink() || !dateStat.isDirectory()) continue;
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(dateDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const dayItems: HistoryItem[] = [];
      for (const sub of subEntries) {
        const folderDir = path.join(dateDir, sub.name);
        let folderStat: fs.Stats;
        try {
          folderStat = fs.lstatSync(folderDir); // lstat: never follow a linked title dir
        } catch {
          continue;
        }
        if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) continue;
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
          id: Buffer.from(`${dateName}/${sub.name}`, "utf8").toString("base64url"),
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

/** Decode an opaque history id and resolve it to the on-disk recording folder,
 * re-enumerating history (via listHistory) to confirm the id names a REAL,
 * currently-listed entry before returning anything. Returns null on any
 * failure - a forged id, a stale id whose folder was purged, a symlink, or a
 * path that would resolve outside historyRoot - never partial information. */
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
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(resolvedDir); // lstat: never follow a symlinked entry
  } catch {
    return null;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
  // Re-enumerate: the id must name an entry a fresh scan actually finds. This
  // is what turns "syntactically clean id" into "a real, currently-listed
  // history entry" - closes the gap between path-safety and existence.
  const found = listHistory(root).find((it) => it.id === id);
  if (!found) return null;
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
  // Current (open) segment + its start offset in samples since recording start.
  private cur: Int16Array[] = [];
  private curLen = 0;
  private consumed = 0; // samples already CLOSED into segments
  private queue: Array<{ pcm: Int16Array; offsetMs: number }> = [];
  private segments = 0;
  private pumping = false;

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
   * forever. Same two-phase discipline as save(): copy first, delete the
   * staging sources only once the copies are safely in place. Best effort:
   * any failure just leaves the recording in staging - nothing is lost,
   * nothing blocks the recording (it is already finished by the time this
   * runs, inside finalize()). */
  private fileIntoHistory(): void {
    const root = this.historyBase();
    let destDir: string;
    try {
      ensureHistoryRoot(root); // review C10 F1: the marker makes the root purgeable
      const dateDir = path.join(root, ymd(new Date(this.startedAt)));
      fs.mkdirSync(dateDir, { recursive: true });
      destDir = uniqueDir(dateDir, path.basename(this.transcriptPath, ".md"));
    } catch (err) {
      this.deps.log?.(`[long] cannot prepare the history folder: ${err}`);
      return;
    }
    const madeDest: string[] = [];
    let newDoc: string;
    let newAudio = "";
    try {
      newDoc = copyFileInto(destDir, this.transcriptPath);
      madeDest.push(newDoc);
      // C10: a staged recording keeps its .wav in history EVEN when the
      // keepAudio setting is off - start() hands out an audio path for every
      // staged recording precisely so this safety net has something to keep
      // (see start()). The .wav may still be legitimately absent (the writer
      // never got a chunk before Stop), which must not fail the filing.
      if (this.audioPath && fs.existsSync(this.audioPath)) {
        newAudio = copyFileInto(destDir, this.audioPath);
        madeDest.push(newAudio);
      }
    } catch (err) {
      for (const p of madeDest) {
        try {
          fs.rmSync(p);
        } catch {
          /* leave a partial copy rather than risk touching more */
        }
      }
      try {
        fs.rmdirSync(destDir);
      } catch {
        /* best effort */
      }
      this.deps.log?.(`[long] could not file the recording into history: ${err}`);
      return;
    }
    const oldDir = this.dir;
    const oldDoc = this.transcriptPath;
    const oldAudio = this.audioPath;
    this.dir = destDir;
    this.transcriptPath = newDoc;
    this.audioPath = newAudio;
    try {
      fs.rmSync(oldDoc);
    } catch {
      /* */
    }
    if (oldAudio) {
      try {
        fs.rmSync(oldAudio);
      } catch {
        /* */
      }
    }
    cleanEmptyHoldingDirs(this.stagingBase(), oldDir);
    this.deps.log?.(`[long] filed into history -> ${newDoc}`);
  }

  start(opts: LongStartOpts): { ok: boolean; error?: string; docPath?: string; audioPath?: string } {
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
    // C10: a STAGED recording (no destination chosen) gets an audio path
    // regardless of keepAudio - it is filed into History as a safety net at
    // finalize, and the user hasn't decided yet whether they want the audio;
    // by the time they'd open History the capture is long gone if we hadn't
    // kept it. A recording with an explicit destination keeps the existing
    // behaviour (keepAudio alone decides).
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
    this.marks = [];
    this.cur = [];
    this.curLen = 0;
    this.consumed = 0;
    this.queue = [];
    this.segments = 0;
    this.lastError = "";
    this.headerStr = transcriptHeader(this.title, this.startedIso);
    try {
      fs.writeFileSync(this.transcriptPath, this.headerStr);
    } catch (err) {
      return { ok: false, error: "cannot write in the folder: " + String(err) };
    }
    this.active = true;
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
  stop(): { ok: boolean; docPath: string } {
    if (!this.active) return { ok: false, docPath: "" };
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
    saveRecent(pushRecent(list.slice(1), updated), this.deps.recentPathOverride);
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
  transcriptSince(since: number): { text: string; nextSince: number } {
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
      durationMs: this.active ? Date.now() - this.startedAt : 0,
      segments: this.segments,
      pending: this.queue.length,
      marks: this.marks.length,
      title: this.title,
      dir: this.dir,
      docPath: this.transcriptPath,
      audioPath: this.audioPath,
      lastError: this.lastError,
      // C10: entries the retention purge already removed are hidden here
      // (recent.json on disk is untouched; save() still reads it raw).
      recent: existingRecent(loadRecent(this.deps.recentPathOverride)),
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
            const sc = this.deps.getSidecar();
            if (!sc) throw new Error("speech engine not ready");
            // Long-form auto-segments legitimately contain non-speech (music, applause);
            // an empty decode must NOT demote a healthy GPU (only a hard failure does).
            const { text } = await sc.transcribe(encodeWav(item.pcm), { allowEmptyDemote: false });
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
      while (this.queue.length > 0 || this.pumping) {
        await this.pump();
        await new Promise((r) => setTimeout(r, 200));
      }
      // v3 chantier 4: always attempt a summary and splice it into the SAME
      // document at the top (no template chooser anymore). If no local LLM is
      // available, the document is the transcript alone.
      let summary = "";
      const model =
        (this.deps.summaryModel?.() || "") ||
        (this.deps.ollamaModels ? (await this.deps.ollamaModels())?.[0] : undefined) ||
        "";
      if (model) {
        const doc = fs.readFileSync(this.transcriptPath, "utf8");
        const body = doc.startsWith(this.headerStr) ? doc.slice(this.headerStr.length) : doc;
        const parts = chunkTranscript(body);
        if (parts.length === 1) {
          summary = (await summarize(model, summaryPrompt(parts[0], this.marks))) ?? "";
        } else {
          // Map-reduce: summarize each chunk, then the joined summaries.
          const partials: string[] = [];
          for (const p of parts) {
            const x = await summarize(model, summaryPrompt(p, []));
            if (x) partials.push(x);
          }
          summary =
            (await summarize(model, summaryPrompt(partials.join("\n\n---\n\n"), this.marks))) ??
            partials.join("\n\n---\n\n");
        }
        if (summary) {
          // Atomic swap (tmp + rename): the summary splice REWRITES the whole document, so a live
          // transcriptSince poll racing this write must never observe a half-written file. Write the
          // final content aside, then rename over the path in one step (same discipline as saveRecent).
          const tmp = this.transcriptPath + ".tmp";
          fs.writeFileSync(
            tmp,
            this.headerStr + "## Summary\n\n" + summary.trim() + "\n\n## Transcript\n\n" + body.replace(/^\s+/, ""),
          );
          fs.renameSync(tmp, this.transcriptPath);
        } else {
          this.deps.log?.("[long] summary empty: transcript stands alone");
        }
      } else {
        this.deps.log?.("[long] no Ollama model available: transcript only, no summary");
      }
      // C10: a recording with no chosen destination is the history mechanism's
      // default landing spot, not a second write path (design invariant) - move
      // it out of staging into <historyRoot>/<date>/<title>/ NOW, so recent.json
      // below points at the history location straight away. staged stays true:
      // the user still hasn't filed it into a folder of their own choosing.
      if (this.staged) this.fileIntoHistory();
      saveRecent(
        pushRecent(loadRecent(this.deps.recentPathOverride), {
          title: this.title,
          startedIso: this.startedIso,
          dir: this.dir,
          docPath: this.transcriptPath,
          audioPath: this.audioPath,
          durationMs: Math.round((this.consumed / SAMPLE_RATE) * 1000),
          staged: this.staged, // v6 c7: needs a "Save to..." step until filed
        }),
        this.deps.recentPathOverride,
      );
      this.deps.log?.(`[long] done: ${this.transcriptPath}${summary ? " (with summary)" : ""}`);
    } catch (err) {
      this.lastError = String(err);
      this.deps.log?.(`[long] finalize failed: ${err}`);
    } finally {
      this.finalizing = false;
    }
  }
}
