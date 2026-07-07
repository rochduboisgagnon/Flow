import fs from "node:fs";
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
  pushRecent,
  type RecentEntry,
} from "../shared/longform";

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
  cleanupModel(): string; // settings.cleanupModel ("" = none configured)
  /** Installed Ollama models, used to auto-pick a summary model when the user
   * did not configure one. Injectable so tests don't hit a real Ollama. */
  ollamaModels?: () => Promise<string[] | null>;
  log?: (msg: string) => void;
  /** Tests only: keep the recent-list file away from the real ~/.agr-flow. */
  recentPathOverride?: string;
  /** Tests only: keep the app-owned staging folder away from the real ~/.agr-flow. */
  stagingRootOverride?: string;
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

/** Remove a now-empty staging subfolder. NEVER touches anything outside the
 * app-owned staging root (a user's own folder is left exactly as it is). */
function cleanStagingDir(root: string, dir: string): void {
  try {
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // not inside staging
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* best effort: leftover staging costs a little disk, never data */
  }
}

export function loadRecent(file = recentPath()): RecentEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as RecentEntry[]) : [];
  } catch {
    return [];
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
  private startedAt = 0;
  private startedIso = "";
  private title = "";
  private dir = "";
  private staged = false; // v6 c7: the doc is still in the app-owned staging folder
  private transcriptPath = ""; // the ONE document (summary spliced in at finalize)
  private audioPath = "";
  private keepAudio = false;
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

  start(opts: LongStartOpts): { ok: boolean; error?: string; docPath?: string; audioPath?: string } {
    if (this.active || this.finalizing) return { ok: false, error: "a recording is already in progress" };
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
    // The .wav is written by the Pilot server as chunks stream in, ONLY when the
    // user chose to keep the audio (v3 chantier 4). We own the path; an empty
    // path tells the server not to open a file.
    this.audioPath = this.keepAudio ? path.join(dir, base + ".wav") : "";
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
      this.closeSegment(joined, findCutPoint(joined));
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
    // Wait it out anyway so we never move a half-written document.
    const deadline = Date.now() + 10 * 60_000;
    while (this.finalizing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (this.finalizing) return { ok: false, error: "still finalizing; try again in a moment" };
    // recent.json is the source of truth for "the last capture" (survives an
    // engine restart between Stop and Save).
    const list = loadRecent(this.deps.recentPathOverride);
    const entry = list[0];
    if (!entry || !entry.docPath) return { ok: false, error: "no finished recording to save" };
    if (!fs.existsSync(entry.docPath)) return { ok: false, error: "the recording is no longer in staging (already saved?)" };
    // Two-phase commit so a mid-way failure never orphans the recording:
    // (1) COPY the document (and the .wav if it really exists) into the chosen
    //     folder; on ANY error, delete the copies made and leave staging
    //     untouched so a retry is clean. (2) point recent.json at the new
    //     location, THEN delete the staging sources. Either both files land in
    //     the folder and recent.json follows, or nothing in recent.json changed
    //     and the sources stay put. A large .wav that fails to copy (a near-full
    //     target volume, an antivirus lock) can never strand the transcript.
    const madeDest: string[] = [];
    let newDoc: string;
    let newAudio = "";
    try {
      newDoc = copyFileInto(dir, entry.docPath);
      madeDest.push(newDoc);
      // The .wav may be absent (transcript-only, or the Pilot server could not
      // create it and rolled back at /long/start): its absence must NOT fail the
      // save - the document is the deliverable.
      if (entry.audioPath && fs.existsSync(entry.audioPath)) {
        newAudio = copyFileInto(dir, entry.audioPath);
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
      return { ok: false, error: "could not save the recording: " + String(err) };
    }
    const stagedFrom = entry.dir;
    const updated: RecentEntry = { ...entry, dir, docPath: newDoc, audioPath: newAudio, staged: false };
    saveRecent(pushRecent(list.slice(1), updated), this.deps.recentPathOverride);
    // Keep the live snapshot consistent if it still points at the saved doc.
    if (this.transcriptPath === entry.docPath) {
      this.transcriptPath = newDoc;
      this.audioPath = newAudio;
      this.dir = dir;
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
    cleanStagingDir(this.stagingBase(), stagedFrom);
    this.deps.log?.(`[long] saved -> ${newDoc}`);
    return { ok: true, docPath: newDoc, audioPath: newAudio };
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
      recent: loadRecent(this.deps.recentPathOverride),
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
      // gap is visible in the transcript rather than silently eaten.
      this.lastError = "transcription backlog full; a segment was dropped";
      this.deps.log?.("[long] " + this.lastError);
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
            const { text } = await sc.transcribe(encodeWav(item.pcm));
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
      // Drain the backlog (pump may already be running; wait it out).
      while (this.queue.length > 0 || this.pumping) {
        await this.pump();
        await new Promise((r) => setTimeout(r, 200));
      }
      // v3 chantier 4: always attempt a summary and splice it into the SAME
      // document at the top (no template chooser anymore). If no local LLM is
      // available, the document is the transcript alone.
      let summary = "";
      const model = this.deps.cleanupModel() || (this.deps.ollamaModels ? (await this.deps.ollamaModels())?.[0] : undefined) || "";
      if (model) {
        const doc = fs.readFileSync(this.transcriptPath, "utf8");
        const body = doc.startsWith(this.headerStr) ? doc.slice(this.headerStr.length) : doc;
        const parts = chunkTranscript(body);
        if (parts.length === 1) {
          summary = (await summarize(model, summaryPrompt("meeting", parts[0], this.marks))) ?? "";
        } else {
          // Map-reduce: summarize each chunk, then the joined summaries.
          const partials: string[] = [];
          for (const p of parts) {
            const x = await summarize(model, summaryPrompt("meeting", p, []));
            if (x) partials.push(x);
          }
          summary =
            (await summarize(model, summaryPrompt("meeting", partials.join("\n\n---\n\n"), this.marks))) ??
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
