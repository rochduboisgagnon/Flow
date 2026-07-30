import fs from "node:fs";
import path from "node:path";
import {
  PcmSegmenter,
  buildWavHeader,
  importTitle,
  importedHeader,
  importProgress,
  isSupportedAudioFile,
  partialImportNote,
  planDecode,
  readWavInfo,
  safeSourceName,
  sanitizeImportRequest,
  unreadableFileMessage,
  type ImportItem,
  type ImportQueueSnapshot,
  type ImportStartResult,
  type WavInfo,
} from "../shared/audioImport";
import { SAMPLE_RATE, encodeWav } from "../shared/wav";
import { analyzeSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import {
  chunkTranscript,
  hms,
  recordingBaseName,
  spliceNotes,
  summaryPrompt,
  transcriptLine,
} from "../shared/longform";
import type { DecodeCall, DecodeResult, DecodeVerdict } from "./audioDecode";
import { fileRecordingIntoHistory, historyEntryId, noteInterruption } from "./longform";

// V4 D2: the import pipeline - "this audio file becomes a document in the
// archive". It owns the QUEUE, the SEGMENTATION, the transcription loop and the
// filing; it owns no window and no engine (both are injected), so the whole
// thing is unit-testable against fakes, which is how the invariants below are
// actually proved rather than merely asserted in a comment.
//
// THE FOUR RULES THIS FILE EXISTS TO KEEP (plan §5.1.1 and §5.1.4):
//
//  1. AN IMPORT IS A READ. The source file is opened read-only and nothing
//     else: there is no rename, no unlink, no rm, no write and no truncate
//     anywhere in this file that can reach it, on ANY path - success, refusal,
//     decode failure, cancellation, quit. What Flow keeps, it writes into its
//     own folders (staging, then the archive). test/audio-import.test.ts holds a
//     read-only fixture and re-checks its bytes, its mtime and its whole parent
//     directory after every one of those paths.
//  2. THE DICTATION ALWAYS WINS. whisper is one shared bottleneck. This pipeline
//     asks, before every single segment, whether the user's own voice currently
//     owns the engine (a dictation in flight, or a live long recording) and
//     stands aside for as long as it does. Note the direction: the import waits
//     on the DICTATION, never the reverse - the dictation path acquires nothing
//     from here, so there is no lock it could ever queue behind. The one
//     residual overlap is a segment already inside the model when the key goes
//     down (a ~7 s segment, i.e. under two seconds of GPU on this machine); the
//     press is never BLOCKED by it, it merely shares the device briefly.
//  3. THE DOCUMENT NEVER LIES. An import that produced nothing leaves nothing:
//     the staging folder is removed whole. An import that produced real work and
//     then stopped - cancelled, broken decode, app closed - is filed WITH a note
//     under its header saying it is partial and how far it got, and no notes are
//     generated for it (a summary of half a meeting presented as the meeting's
//     notes is exactly the small lie this app does not tell).
//  4. THE SOURCE PATH IS NOT A REFERENCE. It never reaches the document, never
//     reaches the window and never reaches the archive; the document records the
//     file NAME and the import instant (importedHeader), because a USB key gets
//     unplugged and a Downloads folder gets emptied.
//
// And one thing this file deliberately does NOT do: touch main/stats.ts. Imported
// audio is other people's voices, not the user's dictation, and folding it into
// the counters would corrupt both the words-per-minute reading and the streak
// (plan §5.1.2). There is no import of the stats store here, and a test asserts
// that this source never gains one.

/** How much of a file's head is read to look for a RIFF/WAVE header. Generous:
 * a WAV written by a phone or a DAW can carry LIST/iXML chunks of a few KB
 * before its `data` chunk, and a `data` chunk we fail to find only costs us the
 * sliced path (readWavInfo answers null, the ordinary one-pass decode runs). */
const HEAD_BYTES = 64 * 1024;

/** How often the pipeline re-asks whether the user has released the engine.
 * Short enough that an import resumes imperceptibly after a dictation, long
 * enough that waiting costs nothing measurable on the process that carries the
 * keyboard hook. */
const ENGINE_POLL_MS = 150;

/** Rows the queue keeps at all. Finished rows are bookkeeping for the page, so
 * the oldest of them are dropped past this - never a pending or running one,
 * and never anything on disk. */
const MAX_QUEUE_ROWS = 40;

/** A segment with less voiced audio than this is not sent to the model: the same
 * floor LongRecorder.pump uses, so an imported silence produces the same
 * (absent) transcript line a recorded one does. */
const MIN_VOICED_MS = 250;

export interface ImportDeps {
  /** The hidden decode window's one operation (main/audioDecode.ts). Injected
   * rather than constructed here: it needs Electron, this file must not. */
  decode(call: DecodeCall): Promise<DecodeResult>;
  /** One segment of 16 kHz mono PCM (already WAV-wrapped) in, text out - the
   * SAME warm sidecar dictation uses. The caller wires it with
   * `allowEmptyDemote: false`, exactly as the long recorder does: an imported
   * recording legitimately contains music, applause and ambience, and demoting
   * a healthy GPU because a segment came back empty would be a silent speed
   * regression for the whole app. */
  transcribe(wav: Uint8Array): Promise<{ text: string }>;
  /** Who owns the speech engine RIGHT NOW, if anyone: a dictation in flight, or
   * a live long recording. Null means the import may proceed. This is rule 2. */
  userEngineClaim(): "dictation" | "recording" | null;
  /** `<dataDir>/history` - the fixed archive root (U2a). */
  historyRoot(): string;
  /** `<dataDir>/staging` - the app-owned folder a document is built in before it
   * is filed. Deliberately the SAME staging root the long recorder uses: the
   * boot rescan (LongRecorder.rescueOrphanedStaging) then covers an import the
   * app died in the middle of, for free and through one implementation, which is
   * the whole of what plan §5.1.4 promises about a restart. */
  stagingRoot(): string;
  /** settings.summaryModel, read lazily. "" falls back to the first installed
   * Ollama model, exactly like LongRecorder.finalize. */
  summaryModel?(): string;
  ollamaModels?(): Promise<string[] | null>;
  summarize?(model: string, prompt: string): Promise<string | null>;
  log?(msg: string): void;
  /** Tests only: a clock they control. */
  now?(): number;
  /** Tests only: the decoded-audio budget planDecode judges against. Production
   * never sets it (the measured MAX_ONE_SHOT_DECODE_BYTES stands); a test lowers
   * it so the sliced path can be exercised on a file of a few megabytes instead
   * of the five-hour recording it would otherwise take. */
  decodeBudgetBytes?(): number;
}

/** One queued import. `pub` is the ONLY part that ever crosses IPC - notably,
 * `path` does not (rule 4). */
interface Job {
  pub: ImportItem;
  /** Opened read-only, and nothing else, ever. */
  path: string;
  keepAudio: boolean;
  notes: boolean;
  cancelled: boolean;
  /** Set when the pipeline itself has to stop (a staging folder that cannot be
   * created, a decode we refused): carried out through isCancelled() so the
   * decode window unwinds the same way a user cancellation unwinds. */
  abort: string;
  startedMs: number;
  dir: string; // staging folder, "" until the first PCM arrives
  docPath: string;
  audioPath: string;
  audioBytes: number;
  decodedMs: number;
  transcribedMs: number;
  segments: number; // segments handed to the engine, for the log
  /** Transcript LINES actually written. This - not the segment count - is what
   * "real work exists" means everywhere below: a file of pure silence closes
   * segments like any other and would otherwise be filed as an empty document. */
  lines: number;
  /** Segments the engine failed on, each already an honest gap in the document.
   * Kept apart from `lines` so "no speech in this file" and "the engine broke"
   * cannot come out as the same sentence. */
  gaps: number;
  /** True once the probe said "unknown length": the header line is then patched
   * from the audio actually decoded, at the end (see finishDocument). */
  lengthUnknown: boolean;
}

export class ImportQueue {
  private jobs: Job[] = [];
  private pumping = false;
  private seq = 0;
  /** rescueOnQuit() ran: the process is going away and whatever it filed is
   * filed. A run() still in flight must not file it a second time (same guard,
   * and the same reason, as LongRecorder.quitting). */
  private quitting = false;

  constructor(private readonly deps: ImportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Queue what the request names. Everything about "is this file acceptable" is
   * decided HERE, up front, so a user who dropped ten files learns immediately
   * which ones Flow will not read instead of discovering it one failure at a
   * time. The path is checked, never trusted: an existing regular file with a
   * supported audio extension, or a refusal with a sentence to show. */
  start(raw: unknown): ImportStartResult {
    const req = sanitizeImportRequest(raw);
    const accepted: string[] = [];
    const rejected: Array<{ fileName: string; reason: string }> = [];
    if (req.paths.length === 0) {
      return { ok: false, accepted, rejected, error: "no audio file to import" };
    }
    for (const p of req.paths) {
      const fileName = path.basename(p);
      const shown = safeSourceName(fileName);
      // The order of these three refusals is the order of what the user can act
      // on: "it is not there" and "that is a folder" are more useful than a
      // lecture about the extension of something that was never a file.
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        rejected.push({ fileName: shown, reason: `"${shown}" is not there any more.` });
        continue;
      }
      if (!st.isFile()) {
        rejected.push({ fileName: shown, reason: `"${shown}" is not a file.` });
        continue;
      }
      if (!isSupportedAudioFile(fileName)) {
        rejected.push({ fileName: shown, reason: unreadableFileMessage(fileName) });
        continue;
      }
      if (st.size < 44) {
        // Smaller than the smallest possible WAV header: there is no audio in
        // there, and saying so beats a decode that fails with "EncodingError".
        rejected.push({ fileName: shown, reason: `"${shown}" holds no audio (it is ${st.size} bytes).` });
        continue;
      }
      const resolved = path.resolve(p);
      if (this.jobs.some((j) => path.resolve(j.path) === resolved && isPending(j.pub.phase))) {
        rejected.push({ fileName: shown, reason: `"${shown}" is already in the queue.` });
        continue;
      }
      if (this.jobs.filter((j) => isPending(j.pub.phase)).length >= MAX_QUEUE_ROWS) {
        rejected.push({ fileName: shown, reason: "The import queue is full. Wait for it to drain." });
        continue;
      }
      const id = `imp-${this.now().toString(36)}-${(++this.seq).toString(36)}`;
      this.jobs.push({
        pub: {
          id,
          fileName: shown,
          phase: "queued",
          progress: 0,
          durationMs: 0,
          processedMs: 0,
          queuedIso: new Date(this.now()).toISOString(),
        },
        path: p,
        keepAudio: req.keepAudio,
        notes: req.notes,
        cancelled: false,
        abort: "",
        startedMs: 0,
        dir: "",
        docPath: "",
        audioPath: "",
        audioBytes: 0,
        decodedMs: 0,
        transcribedMs: 0,
        segments: 0,
        lines: 0,
        gaps: 0,
        lengthUnknown: false,
      });
      accepted.push(id);
    }
    this.trimRows();
    if (accepted.length > 0) void this.pump();
    return { ok: accepted.length > 0, accepted, rejected };
  }

  /** Cancel a pending/running import, or dismiss a finished row.
   *
   * Three behaviours, one channel, because from the page's side they are one
   * gesture ("I am done with this row") and because each of them has to do
   * something visible:
   *  - QUEUED: the row disappears. Nothing was read, nothing was written, there
   *    is nothing to report.
   *  - RUNNING: the decode stops at the next slice and the run() unwinds through
   *    its cancellation path, which decides between "a partial document that
   *    says so" and "nothing at all". The row STAYS, so the user learns which
   *    of the two happened.
   *  - FINISHED: the row disappears. Bookkeeping only: the document that was
   *    filed is untouched, and so is the source file.
   */
  cancel(id: string): { ok: boolean } {
    const job = this.jobs.find((j) => j.pub.id === id);
    if (!job) return { ok: false };
    if (job.pub.phase === "queued") {
      this.jobs = this.jobs.filter((j) => j !== job);
      return { ok: true };
    }
    if (isPending(job.pub.phase)) {
      job.cancelled = true;
      this.deps.log?.(`[import] cancelling "${job.pub.fileName}"`);
      return { ok: true };
    }
    this.jobs = this.jobs.filter((j) => j !== job);
    return { ok: true };
  }

  /** One coherent snapshot, queue order (the running one first, then what
   * waits). `progress` is derived here, from audio actually decoded and actually
   * transcribed - never a number that advances on its own (plan §5.1.4). */
  snapshot(): ImportQueueSnapshot {
    const items = this.jobs.map((j) => ({
      ...j.pub,
      progress: importProgress(j.pub.phase, j.pub.processedMs, j.pub.durationMs),
    }));
    const active = this.jobs.find((j) => j.pub.phase !== "queued" && isPending(j.pub.phase));
    return {
      items,
      activeId: active?.pub.id ?? "",
      busy: this.jobs.some((j) => isPending(j.pub.phase)),
    };
  }

  /** True while anything is queued or running - what the engine reports so an
   * update or a shutdown does not land in the middle of an import. */
  get isBusy(): boolean {
    return this.jobs.some((j) => isPending(j.pub.phase));
  }

  /** The synchronous half of "the app is closing", called from before-quit where
   * Electron awaits nothing (the same discipline, for the same reason, as
   * LongRecorder.rescueOnQuit). Whatever the running import already transcribed
   * is filed WITH its partial note; an import that had produced nothing leaves
   * nothing behind. Never throws: an exception here must not keep the app from
   * dying. Returns whether it filed something. */
  rescueOnQuit(): boolean {
    this.quitting = true;
    let rescued = false;
    for (const job of this.jobs) {
      if (!isPending(job.pub.phase) || job.pub.phase === "queued") continue;
      job.cancelled = true;
      try {
        if (job.lines > 0 && job.docPath) {
          this.finishPartial(job, "interrupted");
          rescued = true;
        } else {
          this.discard(job);
          job.pub.phase = "cancelled";
          job.pub.error = "Flow closed before this import had transcribed anything.";
        }
      } catch (err) {
        this.deps.log?.(`[import] quit rescue failed: ${err}`);
      }
    }
    return rescued;
  }

  // ---- the pump: ONE import at a time, whatever the queue holds ----

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.pub.phase === "queued");
        if (!job) return;
        try {
          await this.run(job);
        } catch (err) {
          // A bug in the pipeline must not wedge the queue, and must not leave a
          // row claiming to be running forever.
          this.deps.log?.(`[import] unexpected failure on "${job.pub.fileName}": ${err}`);
          this.fail(job, `Flow could not finish importing "${job.pub.fileName}".`);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: Job): Promise<void> {
    if (job.cancelled) {
      this.jobs = this.jobs.filter((j) => j !== job);
      return;
    }
    job.pub.phase = "reading";
    job.startedMs = this.now();

    // Rule 2, at the coarsest grain: an import does not even begin while a
    // meeting is being recorded or a dictation is in flight.
    await this.waitForEngine(job);
    if (job.cancelled) {
      // Nothing has been created yet: cancelling here leaves literally nothing.
      // `processedMs` is still 0, which is what snapshot() derives the frozen
      // progress from - the row never has to be told what to display.
      job.pub.phase = "cancelled";
      return;
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(job.path); // READ. The only thing this pipeline ever does to it.
    } catch {
      return this.fail(job, `"${job.pub.fileName}" is not there any more. Nothing was read from it.`);
    }
    if (!st.isFile()) return this.fail(job, `"${job.pub.fileName}" is not a file.`);

    const wav = readWavHead(job.path, st.size);
    const plan = planDecode({
      fileName: job.pub.fileName,
      durationMs: wav?.durationMs ?? 0,
      channels: wav?.channels ?? 0,
      wav,
      budgetBytes: this.deps.decodeBudgetBytes?.(),
    });
    if (plan.mode === "refuse") {
      // Refused BEFORE anything was decoded or written: the sentence says how
      // long the file is and what the limit is, and the file was only read.
      return this.fail(job, plan.message);
    }
    if (plan.durationMs > 0) job.pub.durationMs = plan.durationMs;

    const seg = new PcmSegmenter();
    let result: DecodeResult;
    if (plan.mode === "slices" && wav) {
      result = await this.decodeSlices(job, seg, wav, plan.slices);
    } else {
      result = await this.deps.decode({
        source: { path: job.path },
        // The duration BEFORE the full decode (plan §5.1.3): this is the one
        // thing standing between a six-hour file and a dead renderer.
        probe: true,
        accept: (durationMs) => this.acceptDuration(job, durationMs, wav),
        onPcm: (pcm) => this.onPcm(job, seg, pcm),
        isCancelled: () => job.cancelled || job.abort !== "",
      });
    }

    // The tail: whatever the segmenter still holds, however short. Only when the
    // decode actually finished - a cancelled import must not transcribe one more
    // segment after the user asked it to stop.
    if (result.ok && !job.cancelled && job.abort === "") {
      const tail = seg.flush();
      if (tail) await this.transcribeSegment(job, tail);
    }

    if (this.quitting) return; // the quit rescue owns this document now
    if (job.abort !== "") return this.fail(job, job.abort);
    if (job.cancelled) return this.cancelled(job);
    if (!result.ok) {
      if (result.reason === "cancelled") return this.cancelled(job);
      return this.fail(
        job,
        result.reason === "memory"
          ? // Not our own refusal - that one comes back through job.abort above,
            // with planDecode's sentence. This is the decode window having
            // actually died on the allocation, which on a laptop is how a file
            // inside the budget can still fail.
            `Flow ran out of memory decoding "${job.pub.fileName}". Nothing was written, and the file itself was not touched.`
          : unreadableFileMessage(job.pub.fileName, result.detail),
      );
    }
    if (job.lines === 0) {
      // A file that decoded fine and produced no transcript at all. Nothing is
      // filed: an empty document in the archive is worse than an honest refusal.
      // The two causes get two different sentences, because "there is no speech
      // in your file" and "the speech engine failed on every segment" are not the
      // same news and would send the user looking in different places.
      this.discard(job);
      job.pub.phase = "failed";
      job.pub.error =
        job.gaps > 0
          ? `Flow could not transcribe "${job.pub.fileName}": the speech engine failed on every segment. Nothing was written, and the file itself was not touched.`
          : `Flow found no speech in "${job.pub.fileName}". Nothing was written, and the file itself was not touched.`;
      return;
    }
    // The MEASURED length, for a container whose metadata carried none. Only
    // legitimate here, on the path where the whole file was decoded: the audio
    // that came out IS the length of the file.
    if (job.lengthUnknown) job.pub.durationMs = job.decodedMs;
    else if (job.pub.durationMs <= 0) job.pub.durationMs = result.durationMs || job.decodedMs;
    this.finishDocument(job, "whole");

    if (job.notes) {
      job.pub.phase = "notes";
      await this.addNotes(job);
    }
    if (this.quitting) return;
    job.pub.phase = "filing";
    this.file(job);
    job.pub.phase = "done";
    job.pub.processedMs = job.pub.durationMs;
  }

  /** A WAV too long to decode in one pass, cut at frame boundaries and decoded
   * slice by slice - each slice a fresh 44-byte header plus a byte range, which
   * is a decodable file in its own right (shared/audioImport.ts). ONE segmenter
   * across all of them, so the transcript's segmentation and its timestamps do
   * not restart at every slice boundary. */
  private async decodeSlices(
    job: Job,
    seg: PcmSegmenter,
    wav: WavInfo,
    slices: Array<{ startFrame: number; frames: number }>,
  ): Promise<DecodeResult> {
    const bytesPerFrame = Math.max(1, Math.round((wav.channels * wav.bitsPerSample) / 8));
    let frames = 0;
    let last: DecodeResult = { ok: true, frames: 0, durationMs: 0, channels: wav.channels };
    for (const slice of slices) {
      if (job.cancelled || job.abort !== "") return { ok: false, reason: "cancelled", detail: "cancelled" };
      const dataBytes = slice.frames * bytesPerFrame;
      const start = wav.dataOffset + slice.startFrame * bytesPerFrame;
      const r = await this.deps.decode({
        source: {
          path: job.path,
          start,
          end: start + dataBytes - 1, // inclusive, fs.createReadStream semantics
          prefix: buildWavHeader(wav, dataBytes),
        },
        onPcm: (pcm) => this.onPcm(job, seg, pcm),
        isCancelled: () => job.cancelled || job.abort !== "",
      });
      if (!r.ok) return r;
      frames += r.frames;
      last = { ok: true, frames, durationMs: wav.durationMs, channels: wav.channels };
    }
    return last;
  }

  /** The verdict on a probed duration (the one-pass path). Refusing here costs
   * the user nothing: the bytes are dropped, no buffer is allocated, and the
   * sentence they get names the length and the limit. */
  private acceptDuration(job: Job, durationMs: number, wav: WavInfo | null): DecodeVerdict {
    const plan = planDecode({
      fileName: job.pub.fileName,
      durationMs,
      channels: wav?.channels ?? 0,
      wav,
      budgetBytes: this.deps.decodeBudgetBytes?.(),
    });
    if (plan.mode === "refuse") {
      // The sentence travels on the JOB, not in the decode result: it is a
      // verdict this pipeline reached (it knows the length and the budget), and
      // run() must put it in front of the user word for word rather than wrap it
      // in a second sentence that repeats the file name.
      job.abort = plan.message;
      return { ok: false, reason: "memory", detail: plan.message };
    }
    if (durationMs > 0) job.pub.durationMs = durationMs;
    else job.lengthUnknown = true;
    return { ok: true };
  }

  /** One ~5 s slice of 16 kHz mono PCM from the decode window. Returning a
   * promise is what applies BACKPRESSURE: the renderer is paused while this
   * transcribes, so a two-hour file never piles its whole decoded self up in
   * this process's memory, and the queue can stop between two segments to let a
   * dictation through. */
  private async onPcm(job: Job, seg: PcmSegmenter, pcm: Int16Array): Promise<void> {
    if (job.cancelled || job.abort !== "") return;
    if (!this.ensureDocument(job)) return;
    job.decodedMs += Math.round((pcm.length / SAMPLE_RATE) * 1000);
    if (job.pub.phase === "reading") job.pub.processedMs = job.decodedMs;
    this.writeAudio(job, pcm);
    for (const s of seg.push(pcm)) {
      if (job.cancelled || job.abort !== "") return;
      await this.transcribeSegment(job, s);
    }
  }

  /** One segment: wait for the engine, transcribe, append the timestamped line.
   * A failed segment is an honest gap in the document and the import goes on -
   * the same rule LongRecorder.pump applies to a live capture. */
  private async transcribeSegment(job: Job, s: { pcm: Int16Array; offsetMs: number }): Promise<void> {
    await this.waitForEngine(job);
    if (job.cancelled || job.abort !== "") return;
    try {
      const speech = analyzeSpeech(s.pcm);
      if (speech.voicedMs >= MIN_VOICED_MS) {
        const { text } = await this.deps.transcribe(encodeWav(s.pcm));
        const clean = gateTranscript(text);
        if (clean) {
          fs.appendFileSync(job.docPath, transcriptLine(s.offsetMs, clean));
          job.lines++;
        }
      }
    } catch (err) {
      this.deps.log?.(`[import] segment at ${Math.round(s.offsetMs / 1000)}s failed: ${err}`);
      job.gaps++;
      try {
        fs.appendFileSync(
          job.docPath,
          `> [segment at ${Math.round(s.offsetMs / 1000)}s could not be transcribed]\n\n`,
        );
      } catch {
        /* the log line above already recorded it */
      }
    }
    job.segments++;
    job.transcribedMs = s.offsetMs + Math.round((s.pcm.length / SAMPLE_RATE) * 1000);
    job.pub.phase = "transcribing";
    job.pub.processedMs = job.transcribedMs;
  }

  /** Rule 2. Stands aside for as long as the user's own voice has the engine,
   * and SAYS SO in the snapshot while it does. Cancellation breaks the wait: a
   * user who gives up during a two-hour meeting must not have to wait for it to
   * end before the row disappears. */
  private async waitForEngine(job: Job): Promise<void> {
    for (;;) {
      const claim = this.deps.userEngineClaim();
      if (!claim || job.cancelled || job.abort !== "") {
        if (job.pub.waitingFor) delete job.pub.waitingFor;
        return;
      }
      if (job.pub.waitingFor !== claim) {
        job.pub.waitingFor = claim;
        this.deps.log?.(`[import] standing aside: the ${claim} has the speech engine`);
      }
      await sleep(ENGINE_POLL_MS);
    }
  }

  // ---- the document on disk ----

  /** Create the staging folder and write the document's header, lazily, on the
   * first PCM slice. Lazily on purpose: a file that turns out to be undecodable,
   * or refused for its length, must leave NOTHING behind - not even an empty
   * folder - and by the time PCM arrives both of those verdicts are in. */
  private ensureDocument(job: Job): boolean {
    if (job.docPath) return true;
    const title = importTitle(job.pub.fileName);
    try {
      // Same folder shape and same name shape as a staged recording
      // ("<epoch ms>-<random>"), which is what lets the boot rescan read an
      // import the app died inside of without any bookkeeping of its own.
      const dir = path.join(
        this.deps.stagingRoot(),
        String(this.now()) + "-" + Math.random().toString(36).slice(2, 8),
      );
      fs.mkdirSync(dir, { recursive: true });
      const base = recordingBaseName(title, new Date(job.startedMs || this.now()));
      const docPath = path.join(dir, base + ".md");
      fs.writeFileSync(
        docPath,
        importedHeader(title, {
          fileName: job.pub.fileName,
          importedIso: new Date(job.startedMs || this.now()).toISOString(),
          durationMs: job.pub.durationMs,
        }),
      );
      job.dir = dir;
      job.docPath = docPath;
      // The decoded 16 kHz mono .wav is written ONLY when the user asked to keep
      // it - unlike a live capture, which always writes one because the audio is
      // the only thing that can still save a meeting whose transcription falls
      // over. An import has no such risk: the user's own file is exactly where
      // it was (an import never touches it), so a second copy would be weight,
      // not a safety net.
      if (job.keepAudio) {
        job.audioPath = path.join(dir, base + ".wav");
        fs.writeFileSync(job.audioPath, encodeWav(new Int16Array(0))); // the 44-byte header alone
        job.audioBytes = 0;
      }
      return true;
    } catch (err) {
      job.abort = `Flow could not prepare a document for "${job.pub.fileName}" (${String(err)}).`;
      this.deps.log?.(`[import] ${job.abort}`);
      return false;
    }
  }

  /** Append PCM to the kept .wav. Best effort in the strict sense: the
   * transcript is the deliverable, and a disk that refuses the audio must not
   * cost the user the document.
   *
   * Synchronous, on the process that carries the keyboard hook, and that is a
   * bounded choice rather than an oversight: one append is ~160 KB, it only
   * happens when the user asked to keep the audio, and it runs INSIDE the
   * backpressure window (the decode renderer is paused until this returns), so it
   * can never queue up behind itself the way a stream's buffer could. */
  private writeAudio(job: Job, pcm: Int16Array): void {
    if (!job.audioPath) return;
    try {
      fs.appendFileSync(job.audioPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      job.audioBytes += pcm.byteLength;
    } catch (err) {
      this.deps.log?.(`[import] the kept .wav could not be written, dropping it: ${err}`);
      job.audioPath = "";
    }
  }

  /** The notes, from the SAME local summarizer a live capture uses (Ollama
   * today; the embedded model of D6 later, through this same dep). No local
   * model available means the document is the timestamped transcript alone -
   * never an error, never an empty "## Notes" section. */
  private async addNotes(job: Job): Promise<void> {
    if (!this.deps.summarize) return;
    let model = "";
    try {
      model = (this.deps.summaryModel?.() || "") || (await this.deps.ollamaModels?.())?.[0] || "";
    } catch {
      model = "";
    }
    if (!model) {
      this.deps.log?.("[import] no local model available: transcript only, no notes");
      return;
    }
    try {
      const doc = fs.readFileSync(job.docPath, "utf8");
      const header = this.headerOf(job);
      const body = doc.startsWith(header) ? doc.slice(header.length) : doc;
      const parts = chunkTranscript(body);
      let notes = "";
      if (parts.length === 1) {
        notes = (await this.deps.summarize(model, summaryPrompt(parts[0], []))) ?? "";
      } else {
        const partials: string[] = [];
        for (const p of parts) {
          const x = await this.deps.summarize(model, summaryPrompt(p, []));
          if (x) partials.push(x);
        }
        notes =
          (await this.deps.summarize(model, summaryPrompt(partials.join("\n\n---\n\n"), []))) ??
          partials.join("\n\n---\n\n");
      }
      if (!notes.trim()) {
        this.deps.log?.("[import] the notes came back empty: transcript stands alone");
        return;
      }
      // spliceNotes is the function the live notes splice uses, so an imported
      // document ends up shaped exactly like a capture whose notes were
      // generated - which is the whole point of D2 ("the same document").
      // Atomic swap, same discipline as every other rewrite of a document.
      const tmp = job.docPath + ".tmp";
      fs.writeFileSync(tmp, spliceNotes(doc, header, notes));
      fs.renameSync(tmp, job.docPath);
    } catch (err) {
      // A failed summary is a document without notes, never a failed import.
      this.deps.log?.(`[import] notes failed, keeping the transcript: ${err}`);
    }
  }

  private headerOf(job: Job): string {
    return importedHeader(importTitle(job.pub.fileName), {
      fileName: job.pub.fileName,
      importedIso: new Date(job.startedMs || this.now()).toISOString(),
      durationMs: job.pub.durationMs,
    });
  }

  /** Patch the header's "- source length:" line for a container that carried no
   * duration at all (a streamed ogg, a truncated file): the number is only known
   * once the audio has been decoded, and a header left claiming 00:00:00 for a
   * 40-minute memo is precisely the kind of small untruth the campaign's
   * invariant forbids. A PARTIAL import of such a file never learns the total at
   * all, so it says "unknown" rather than reporting the part as the whole. Best
   * effort, atomic, and a no-op in the normal case (a container that stated its
   * own duration got it right in the header from the start). */
  private finishDocument(job: Job, extent: "whole" | "partial"): void {
    if (!job.lengthUnknown) return;
    const value = extent === "whole" && job.pub.durationMs > 0 ? hms(job.pub.durationMs) : "unknown";
    try {
      const doc = fs.readFileSync(job.docPath, "utf8");
      const fixed = doc.replace(/^- source length: .*$/m, `- source length: ${value}`);
      if (fixed === doc) return;
      const tmp = job.docPath + ".tmp";
      fs.writeFileSync(tmp, fixed);
      fs.renameSync(tmp, job.docPath);
    } catch (err) {
      this.deps.log?.(`[import] could not state the measured length in the header: ${err}`);
    }
  }

  /** File the finished document into the archive, through the SAME function the
   * recorder's three paths use (main/longform.ts's fileRecordingIntoHistory), so
   * every guardrail it carries - the marker, the no-clobber suffixing, the
   * date-bucket retention rule - applies to an import identically. */
  /** Close the kept .wav by writing its real sizes into the header it was opened
   * with a placeholder for. Until this runs the file declares zero bytes of
   * audio, so every player reads it as empty - the same size-patch the long
   * recorder performs when a native capture ends, for the same reason. This is
   * the ONE place this module opens a file for writing, and the file is Flow's
   * own copy: the source is not in scope here and never could be. */
  private sealAudio(job: Job): void {
    if (!job.audioPath) return;
    try {
      const fd = fs.openSync(job.audioPath, "r+");
      try {
        const patch = Buffer.alloc(4);
        patch.writeUInt32LE(36 + job.audioBytes, 0);
        fs.writeSync(fd, patch, 0, 4, 4); // RIFF chunk size
        patch.writeUInt32LE(job.audioBytes, 0);
        fs.writeSync(fd, patch, 0, 4, 40); // data chunk size
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.deps.log?.(`[import] could not finish the kept .wav's header: ${err}`);
    }
  }

  private file(job: Job): void {
    this.sealAudio(job);
    const staged = job.dir;
    const filed = fileRecordingIntoHistory({
      historyRoot: this.deps.historyRoot(),
      docPath: job.docPath,
      audioPath: job.audioPath,
      keepAudio: job.keepAudio,
      startedMs: job.startedMs || this.now(),
      log: this.deps.log,
    });
    if (!filed) {
      // The document is still in staging, complete: the boot rescan will file it.
      this.deps.log?.(`[import] "${job.pub.fileName}" stayed in staging; the next start files it`);
      return;
    }
    job.dir = filed.dir;
    job.docPath = filed.docPath;
    job.audioPath = filed.audioPath;
    job.pub.historyId = historyEntryId(filed.dir);
    this.dropEmptyStagingDir(staged);
    this.deps.log?.(`[import] filed "${job.pub.fileName}" -> ${filed.docPath}`);
  }

  /** A cancellation. Rule 3 decides between the two outcomes, and there are only
   * two: a document that says how far it got, or nothing at all. */
  private cancelled(job: Job): void {
    if (job.lines > 0 && job.docPath) {
      this.finishPartial(job, "cancelled");
      return;
    }
    this.discard(job);
    job.pub.phase = "cancelled";
    job.pub.processedMs = 0;
  }

  /** A refusal or a failure. Same two outcomes as a cancellation - work that
   * exists is kept and labelled, work that does not exist leaves nothing - plus
   * the sentence to put in front of the user. */
  private fail(job: Job, message: string): void {
    if (job.lines > 0 && job.docPath) {
      this.finishPartial(job, "failed");
      job.pub.error = message;
      this.deps.log?.(`[import] ${message}`);
      return;
    }
    this.discard(job);
    job.pub.phase = "failed";
    job.pub.error = message;
    this.deps.log?.(`[import] ${message}`);
  }

  /** Keep the work, and make the document SAY it is partial before anything
   * files it: the note goes right under the header, no notes are generated (a
   * summary of half the audio presented as the meeting's notes would be the lie
   * this rule exists to prevent), and the row carries `partial` so the page can
   * say it too. */
  private finishPartial(job: Job, kind: "cancelled" | "interrupted" | "failed"): void {
    noteInterruption(
      job.docPath,
      partialImportNote(kind, job.transcribedMs, job.pub.durationMs),
      this.deps.log,
    );
    this.finishDocument(job, "partial");
    this.file(job);
    job.pub.partial = true;
    job.pub.phase = kind === "failed" ? "failed" : "cancelled";
    job.pub.processedMs = job.transcribedMs;
    if (job.pub.waitingFor) delete job.pub.waitingFor;
  }

  /** Remove what THIS pipeline created, and nothing else: a folder it made
   * itself, this session, under the app-owned staging root, whose name it chose.
   * The containment check is not ceremony - it is what makes "an import that
   * produced nothing leaves nothing" a deletion that can never reach a file the
   * user owns. The SOURCE is never a candidate here; it is not even in scope. */
  private discard(job: Job): void {
    const dir = job.dir;
    job.dir = "";
    job.docPath = "";
    job.audioPath = "";
    if (!dir || !this.underStaging(dir)) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.deps.log?.(`[import] could not clean up ${dir}: ${err}`);
    }
  }

  /** The now-empty session folder the document was just moved out of. rmdir,
   * never rm -r: anything still in there keeps the folder alive, and a folder
   * outside the app-owned staging root is never a candidate at all. Left behind,
   * an empty folder would make the boot rescan log "a staging folder without a
   * transcript" at every start, forever. */
  private dropEmptyStagingDir(dir: string): void {
    if (!dir || !this.underStaging(dir)) return;
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty, or already gone: a leftover folder costs app-owned disk only */
    }
  }

  private underStaging(p: string): boolean {
    const rel = path.relative(this.deps.stagingRoot(), p);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /** Keep the row list bounded. Only FINISHED rows are ever dropped, oldest
   * first, and dropping one touches nothing on disk. */
  private trimRows(): void {
    if (this.jobs.length <= MAX_QUEUE_ROWS) return;
    const finished = this.jobs.filter((j) => !isPending(j.pub.phase));
    const drop = new Set(finished.slice(0, this.jobs.length - MAX_QUEUE_ROWS));
    if (drop.size > 0) this.jobs = this.jobs.filter((j) => !drop.has(j));
  }
}

function isPending(phase: ImportItem["phase"]): boolean {
  return phase !== "done" && phase !== "failed" && phase !== "cancelled";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read the head of a file to look for a RIFF/WAVE header - the ONE fs call in
 * this module that opens the user's file, and it opens it with "r". Answers null
 * for anything that is not a WAV Flow can cut, which is always a safe answer:
 * the caller then takes the ordinary one-pass decode. */
export function readWavHead(p: string, fileBytes: number): WavInfo | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r"); // READ-ONLY. Never "r+", never a flag that can create.
    const want = Math.min(HEAD_BYTES, Math.max(0, fileBytes));
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, 0);
    return readWavInfo(new Uint8Array(buf.buffer, buf.byteOffset, n), fileBytes);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do about a descriptor that will not close */
      }
    }
  }
}
