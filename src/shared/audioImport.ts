// V4 D1/D2: the pure half of "import an audio file" - what is accepted, how a
// file is decoded (in one pass or in slices), how the finished document reads,
// and how a stream of PCM is cut into transcribable segments. No Electron, no
// filesystem, no engine: everything here is unit-tested directly, and the two
// modules that DO touch the machine (main/audioDecode.ts for the hidden decode
// window, main/audioImport.ts for the pipeline) only act on what this file
// decides.
//
// The invariant that dominates the whole feature (plan §5.1.1): AN IMPORT IS A
// READ. Nothing in this file, and nothing downstream of it, ever names an
// operation that could modify the source file - there is no rename, no move, no
// delete and no write path anywhere in the import, including on the error and
// cancellation paths. What Flow keeps, it copies into its own folder, and the
// document says which file it came from and when (importedHeader below), because
// the source path is NOT stable: a USB key gets unplugged, a Downloads folder
// gets emptied.

import {
  SAMPLE_RATE,
  SEGMENT_MIN_MS,
  SEGMENT_TARGET_MS,
  endsInPause,
  findCutPoint,
  hms,
  ENGINE_LINE,
} from "./longform";

// ---- what Flow accepts ----

/** The containers Electron's own media stack decodes (the whole point of D1: no
 * ffmpeg, no third-party binary - Chromium already ships the codecs). Video is
 * deliberately absent: importing a video would mean extracting its audio track,
 * which plan §5.1.5 puts outside this wave. */
export const SUPPORTED_AUDIO_EXTENSIONS = [
  ".m4a",
  ".mp3",
  ".wav",
  ".wave",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".aac",
  ".weba",
] as const;

/** Lowercase extension of a file NAME (never a path: this module never sees one). */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

export function isSupportedAudioFile(fileName: string): boolean {
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(fileExtension(fileName));
}

/** Control characters and over-long names never reach the document: the file
 * name is the one piece of user-controlled text the import writes into markdown,
 * and a name carrying a newline would silently forge header lines. */
export function safeSourceName(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = fileName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (clean.length > 120 ? clean.slice(0, 117) + "..." : clean) || "audio file";
}

/** A refusal a human can act on (plan §5.1.3): the file NAME and its extension,
 * never the exception decodeAudioData threw - that one says "EncodingError" and
 * nothing else, which tells the user nothing about their own file. */
export function unreadableFileMessage(fileName: string, detail = ""): string {
  const ext = fileExtension(fileName);
  const kind = ext ? ` (${ext.slice(1).toUpperCase()})` : "";
  return (
    `"${safeSourceName(fileName)}"${kind} could not be read: this format is not one Flow can decode on this machine.` +
    (detail ? ` (${detail})` : "")
  );
}

// ---- the memory budget (plan §5.1.3, the main failure mode) ----
//
// decodeAudioData decodes the WHOLE file into Float32, and a renderer that runs
// out of memory doing it dies WITHOUT an exception - the window simply goes
// away. So the size of that buffer is computed BEFORE the decode, from the
// duration, and the decode either happens in one pass or in slices.
//
// One decision buys most of the headroom: decodeAudioData resamples to the
// sample rate of the context it is called on, so decoding on an
// OfflineAudioContext built at 16 000 Hz produces a 16 kHz AudioBuffer directly.
// Two hours of 44.1 kHz stereo is ~2.5 GB decoded at its native rate; the same
// two hours decoded at 16 kHz is ~460 MB. (Verified, not assumed: the bench
// below reports sampleRate 16000 for a 8 kHz source, i.e. Chromium really does
// resample on the way out.)
//
// MEASURED on 2026-07-29, not guessed, by scripts/measure-decode-budget.cjs
// (Electron 43, Windows 11, 64 GB, RTX 4080): one hidden renderer, source bytes
// shipped over IPC in 8 MB slices, decode on an OfflineAudioContext at 16 kHz,
// then the Int16 mono walk production streams back. Peak RSS is the renderer
// process's own working set, sampled every 200 ms through app.getAppMetrics().
//
//   STEREO source           MONO source
//   audio  decoded  peak    audio  decoded  peak
//   10 min   73 MB  183 MB
//   30 min  220 MB  444 MB
//    1 h    439 MB  911 MB
//    2 h    879 MB 1818 MB
//    4 h   1758 MB 3550 MB    4 h   879 MB 1921 MB
//    6 h      FAILS          5 h      FAILS
//    8 h      FAILS          6 h      FAILS
//
// Two facts came out of it, and the second is the one that matters:
//
//  1. The renderer's peak runs at ~2x the decoded buffer (the source bytes are
//     still held while Blink builds it), linearly, with no cliff.
//  2. The wall is PER CHANNEL, not per file. An AudioBuffer is one Float32Array
//     per channel, and the failure lands between 879 MB and 1152 MB in a single
//     channel - i.e. right around a 1 GB allocation - whatever the channel count:
//     4 h stereo (879 MB/channel) decodes, 6 h stereo (1318 MB/channel) does not,
//     and mono fails at the same per-channel size (5 h = 1152 MB). So the ceiling
//     is ~4.7 h of audio at 16 kHz, mono or stereo alike.
//
// It also fails HONESTLY at that wall: decodeAudioData rejects with "Unable to
// decode audio data" rather than taking the renderer down with it. That is on a
// machine with 64 GB to spare, though - on a laptop the same allocation is far
// more likely to end as an OOM kill, which is why main/audioDecode.ts still
// treats a dead decode window as a normal outcome rather than as an impossible one.
//
// The budget: 1 GB of DECODED audio, total. Half the measured per-channel wall in
// the mono case, a ~2 GB renderer peak (comfortable under Chromium's ~4 GB
// per-renderer ceiling on a machine with far less RAM than this one), and it
// takes a 2-hour stereo meeting - the case this feature exists for - in a single
// pass. Past it: slices for a WAV, a clean refusal for anything else.
export const MAX_ONE_SHOT_DECODE_BYTES = 1024 * 1024 * 1024;

/** What an AudioBuffer decoded at 16 kHz weighs: Float32 per channel. Channels
 * are NOT mixed down by decodeAudioData - the mono fold happens after, on our
 * side - so a stereo source really does cost twice a mono one. */
export function decodedBytes(durationMs: number, channels: number): number {
  const frames = Math.max(0, Math.round((durationMs / 1000) * SAMPLE_RATE));
  return frames * Math.max(1, channels) * 4;
}

/** Nothing in a compressed container tells us the channel count before the
 * decode, so the projection assumes stereo. Being wrong here means slicing a
 * mono file that would have fitted - which costs nothing but a few extra decode
 * calls, while being wrong the other way costs the user their import. */
export const ASSUMED_CHANNELS = 2;

/** How much audio one slice carries when the file is decoded in slices. Ten
 * minutes of 16 kHz stereo is ~77 MB decoded: an order of magnitude under the
 * budget, so the sliced path stays flat in memory no matter how long the
 * recording is. */
export const DECODE_SLICE_MS = 10 * 60_000;

// ---- reading a WAV header without decoding anything ----
//
// Why WAV gets its own path: it is the one container Flow can CUT itself. A PCM
// WAV is a header plus a flat array of frames, so slice N is "a fresh 44-byte
// header plus these bytes" - exact, lossless, and safe at any offset. Nothing
// equivalent exists for m4a/mp3/ogg/flac without a demuxer, i.e. without the
// ffmpeg this whole design avoids. It is also the format that most needs it: a
// two-hour 44.1 kHz stereo WAV is 1.27 GB on disk, where the same meeting as
// m4a is ~115 MB.

export interface WavInfo {
  audioFormat: number; // 1 = PCM, 3 = IEEE float, anything else = compressed
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  dataOffset: number; // byte offset of the first sample IN THE FILE
  dataBytes: number; // usable bytes of audio (clamped to the real file size)
  frames: number;
  durationMs: number;
  /** True when the audio is linear (PCM/float) AND frame-addressable, i.e. when
   * cutting at a frame boundary yields another valid WAV. Compressed WAV payloads
   * (ADPCM & friends) are never sliced: their blocks carry decoder state. */
  sliceable: boolean;
}

/** Parse the RIFF chunks at the head of a file. `head` is the first few KB - a
 * data chunk that does not appear there means "not a WAV Flow can cut", which is
 * a safe answer, never a wrong one: the caller falls back to the ordinary
 * one-pass decode. Returns null for anything that is not a RIFF/WAVE at all. */
export function readWavInfo(head: Uint8Array, fileBytes: number): WavInfo | null {
  if (head.length < 12) return null;
  const tag = (off: number, s: string) => Array.from(s).every((c, i) => head[off + i] === c.charCodeAt(0));
  if (!tag(0, "RIFF") || !tag(8, "WAVE")) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let off = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number } | null =
    null;
  while (off + 8 <= head.length) {
    const id = String.fromCharCode(head[off], head[off + 1], head[off + 2], head[off + 3]);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt " && off + 8 + 16 <= head.length) {
      fmt = {
        audioFormat: v.getUint16(off + 8, true),
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        blockAlign: v.getUint16(off + 20, true),
        bitsPerSample: v.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      if (!fmt || fmt.channels < 1 || fmt.sampleRate < 1 || fmt.bitsPerSample < 8) return null;
      const dataOffset = off + 8;
      // The declared size is a claim; the file's real length is the fact. A
      // truncated recording (the usual way a WAV ends up on a phone) must not
      // make us read past the end.
      const dataBytes = Math.max(0, Math.min(size, fileBytes - dataOffset));
      const bytesPerFrame = Math.max(1, Math.round((fmt.channels * fmt.bitsPerSample) / 8));
      const frames = Math.floor(dataBytes / bytesPerFrame);
      const sliceable =
        (fmt.audioFormat === 1 || fmt.audioFormat === 3) &&
        fmt.bitsPerSample % 8 === 0 &&
        (fmt.blockAlign === 0 || fmt.blockAlign === bytesPerFrame);
      return {
        ...fmt,
        dataOffset,
        dataBytes: frames * bytesPerFrame,
        frames,
        durationMs: Math.round((frames / fmt.sampleRate) * 1000),
        sliceable,
      };
    }
    off += 8 + size + (size % 2); // RIFF chunks are word-aligned
  }
  return null;
}

/** A canonical 44-byte header for a slice of an existing WAV: same format, same
 * rate, same channels, only the sizes change. This is what makes a byte range of
 * a PCM file a decodable file in its own right. */
export function buildWavHeader(info: WavInfo, dataBytes: number): Uint8Array {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  const bytesPerFrame = Math.max(1, Math.round((info.channels * info.bitsPerSample) / 8));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, info.audioFormat, true);
  v.setUint16(22, info.channels, true);
  v.setUint32(24, info.sampleRate, true);
  v.setUint32(28, info.sampleRate * bytesPerFrame, true);
  v.setUint16(32, bytesPerFrame, true);
  v.setUint16(34, info.bitsPerSample, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

// ---- the decode plan ----

export interface DecodeSlice {
  startFrame: number; // in SOURCE frames
  frames: number;
}

export type DecodePlan =
  | { mode: "one-shot"; durationMs: number }
  | { mode: "slices"; durationMs: number; slices: DecodeSlice[] }
  | { mode: "refuse"; message: string };

/** The decision plan §5.1.3 asks for, taken BEFORE any decode happens.
 *
 * A file whose projected buffer fits the budget is decoded in one pass. One that
 * does not is sliced when it CAN be (a linear WAV), and refused - with a sentence
 * that says how long it is and what the limit is - when it cannot, because
 * attempting it is how a renderer dies without a message. Refusing is the honest
 * failure the plan asks for; the documented fallback (a minimal ffmpeg) stays a
 * later decision, taken on formats actually encountered. */
export function planDecode(input: {
  fileName: string;
  durationMs: number; // 0 when unknown (a compressed file whose metadata has not been probed yet)
  channels?: number; // 0/absent = unknown
  wav?: WavInfo | null;
  budgetBytes?: number;
}): DecodePlan {
  const budget = input.budgetBytes ?? MAX_ONE_SHOT_DECODE_BYTES;
  const wav = input.wav ?? null;
  const durationMs = input.durationMs > 0 ? input.durationMs : (wav?.durationMs ?? 0);
  const channels = input.channels && input.channels > 0 ? input.channels : (wav?.channels ?? ASSUMED_CHANNELS);
  // Unknown duration is not a licence to decode blind: the caller (the hidden
  // window) probes it with an <audio> element before decoding, and only calls
  // back here once it knows. A zero here therefore means "nothing to project
  // yet", which can only be one-shot.
  if (durationMs <= 0) return { mode: "one-shot", durationMs: 0 };
  if (decodedBytes(durationMs, channels) <= budget) return { mode: "one-shot", durationMs };
  if (wav && wav.sliceable && wav.frames > 0) {
    const framesPerSlice = Math.max(1, Math.round((DECODE_SLICE_MS / 1000) * wav.sampleRate));
    const slices: DecodeSlice[] = [];
    for (let start = 0; start < wav.frames; start += framesPerSlice) {
      slices.push({ startFrame: start, frames: Math.min(framesPerSlice, wav.frames - start) });
    }
    return { mode: "slices", durationMs, slices };
  }
  const hours = (durationMs / 3_600_000).toFixed(1);
  const limitHours = (budget / (SAMPLE_RATE * channels * 4) / 3600).toFixed(1);
  return {
    mode: "refuse",
    message:
      `"${safeSourceName(input.fileName)}" runs ${hours} h, which is more than Flow can decode in one pass on this ` +
      `machine (about ${limitHours} h for this format). Nothing was read from the file. Split it, or convert it to WAV, ` +
      `which Flow decodes in slices at any length.`,
  };
}

// ---- segmentation ----

/** Cuts a stream of 16 kHz mono PCM into transcribable segments, on exactly the
 * rules the long recorder uses live: a natural pause closes a segment
 * (endsInPause), and past SEGMENT_TARGET_MS a hard cut lands on the quietest
 * point of the tail (findCutPoint). Those two functions are imported, never
 * reimplemented - an import that segmented differently from a live capture would
 * produce a differently-shaped document from the same audio.
 *
 * Kept apart from LongRecorder.onChunk, which owns the same rules for a LIVE
 * stream, because the two have opposite obligations around them: the recorder
 * must never block its caller (audio is arriving in real time) and transcribes
 * on a background pump, while the import must be able to STOP between two
 * segments - to let a dictation through (plan §5.1.4), or to honour a
 * cancellation - and therefore needs the segments handed back to it rather than
 * queued behind its back. */
export class PcmSegmenter {
  private cur: Int16Array[] = [];
  private curLen = 0;
  private consumed = 0; // frames already closed into segments

  /** Feed one PCM chunk; get back whatever segments it completed (often none,
   * sometimes several when the chunk is long). */
  push(pcm: Int16Array): Array<{ pcm: Int16Array; offsetMs: number }> {
    const out: Array<{ pcm: Int16Array; offsetMs: number }> = [];
    if (pcm.length > 0) {
      this.cur.push(pcm);
      this.curLen += pcm.length;
    }
    for (;;) {
      const curMs = (this.curLen / SAMPLE_RATE) * 1000;
      if (curMs < SEGMENT_MIN_MS) return out;
      const joined = this.join();
      if (endsInPause(joined)) {
        out.push(this.close(joined, joined.length));
        continue;
      }
      if (curMs >= SEGMENT_TARGET_MS) {
        // Same guard as the recorder's: search the cut only in the tail past the
        // minimum length, so the closed segment can never fall under it.
        out.push(this.close(joined, findCutPoint(joined, SEGMENT_TARGET_MS - SEGMENT_MIN_MS)));
        continue;
      }
      return out;
    }
  }

  /** The tail, at end of file: whatever is left, however short. */
  flush(): { pcm: Int16Array; offsetMs: number } | null {
    if (this.curLen === 0) return null;
    const joined = this.join();
    return this.close(joined, joined.length);
  }

  private join(): Int16Array {
    if (this.cur.length === 1 && this.cur[0].length === this.curLen) return this.cur[0];
    const out = new Int16Array(this.curLen);
    let o = 0;
    for (const c of this.cur) {
      out.set(c, o);
      o += c.length;
    }
    this.cur = out.length ? [out] : [];
    return out;
  }

  private close(joined: Int16Array, cut: number): { pcm: Int16Array; offsetMs: number } {
    const seg = joined.slice(0, cut);
    const rest = joined.subarray(cut);
    this.cur = rest.length ? [rest.slice(0)] : [];
    this.curLen = rest.length;
    const offsetMs = Math.round((this.consumed / SAMPLE_RATE) * 1000);
    this.consumed += seg.length;
    return { pcm: seg, offsetMs };
  }
}

// ---- the document ----

export interface ImportSource {
  fileName: string; // basename only: the PATH is never written into the document
  importedIso: string;
  durationMs: number;
}

/** A readable title from a file name: "reunion-client_2026-07-12.m4a" reads as
 * "reunion client 2026 07 12". Never empty. */
export function importTitle(fileName: string): string {
  const ext = fileExtension(fileName);
  const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  const words = safeSourceName(stem)
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words || "Imported recording";
}

/** The header of an imported document. Two things are stated that a live capture
 * has no need of (plan §5.1.1, rule 3): WHICH file this came from and WHEN it was
 * imported - a user who finds this note six months from now must be able to tie it
 * back to its source without guessing, and the source PATH is not written because
 * it is not stable enough to be worth remembering.
 *
 * There is deliberately no "- recorded:" line: Flow does not know when the audio
 * was recorded, and a header that quietly reported the import instant as the
 * recording date would be exactly the kind of small lie the document must not
 * tell. ENGINE_LINE closes the header, as it does for a capture, because that
 * line - not the title - is what spliceNotes anchors on when the notes are
 * spliced in later. */
export function importedHeader(title: string, source: ImportSource): string {
  return (
    `# ${title}\n\n` +
    `- imported: ${source.importedIso}\n` +
    `- source file: ${safeSourceName(source.fileName)}\n` +
    `- source length: ${hms(source.durationMs)}\n` +
    ENGINE_LINE
  );
}

/** What a document says when it does NOT cover the whole file (plan §5.1.4: a
 * cancellation leaves either a complete document or nothing, and work kept has to
 * say how far it goes). Written right under the header, like the recorder's own
 * interruption note, so a reader learns it before scrolling. */
export function partialImportNote(kind: "cancelled" | "interrupted", coveredMs: number, totalMs: number): string {
  const how =
    kind === "cancelled"
      ? "You cancelled this import."
      : "Flow closed before this import finished.";
  const extent =
    totalMs > 0
      ? `Only the first ${hms(coveredMs)} of ${hms(totalMs)} was transcribed`
      : `Only the first ${hms(coveredMs)} was transcribed`;
  return `> [Partial import: ${how} ${extent}; the rest of the file was never read. The source file was not modified.]\n\n`;
}

// ---- the IPC request, validated ----

export interface ImportRequest {
  paths: string[];
  /** Keep the decoded 16 kHz mono .wav next to the document. Off by default: the
   * user's own file is still exactly where it was (an import never touches it),
   * so a second copy is redundant weight rather than a safety net. */
  keepAudio: boolean;
  /** Generate meeting notes on top of the timestamped transcript. */
  notes: boolean;
}

export const MAX_IMPORT_BATCH = 20;

/** Same discipline as shared/longStart.ts: the decision about what an IPC
 * request means is pure and tested here, so the handler in main/uiBridge.ts only
 * acts on the verdict. Paths ARE accepted from the renderer here - unavoidable,
 * a dropped file is a path - which is exactly why the main side treats them as
 * read-only from end to end and refuses anything that is not an existing regular
 * file with a supported extension. */
export function sanitizeImportRequest(raw: unknown): ImportRequest {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawPaths = Array.isArray(o.paths) ? o.paths : [];
  const paths: string[] = [];
  for (const p of rawPaths) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (!trimmed || paths.includes(trimmed)) continue;
    paths.push(trimmed);
    if (paths.length >= MAX_IMPORT_BATCH) break;
  }
  return {
    paths,
    keepAudio: o.keepAudio === true,
    notes: o.notes !== false, // notes are the point of an import; opt OUT, not in
  };
}

// ---- progress ----

export type ImportPhase =
  | "queued"
  | "reading" // decoding the file into 16 kHz mono PCM
  | "transcribing"
  | "notes"
  | "filing"
  | "done"
  | "failed"
  | "cancelled";

/** One import, as the queue reports it. `progress` is REAL - derived from audio
 * actually decoded and actually transcribed (plan §5.1.4: never an animation
 * that advances on its own). */
export interface ImportItem {
  id: string;
  fileName: string; // basename: the page never needs the path, and never gets it
  phase: ImportPhase;
  progress: number; // 0..1
  durationMs: number; // 0 until the file's length is known
  processedMs: number;
  queuedIso: string;
  /** Human-readable, shown as-is (never an exception's text). */
  error?: string;
  /** The archive entry the document landed in, once filed - what a page needs to
   * open the note it just produced. */
  historyId?: string;
  /** Cancelled or interrupted with work kept: the document says so itself. */
  partial?: boolean;
}

export interface ImportQueueSnapshot {
  items: ImportItem[]; // queue order: the running one first, then what is waiting
  activeId: string; // "" when nothing is running
  busy: boolean;
}

export interface ImportStartResult {
  ok: boolean;
  /** Ids the queue accepted, in the order they will run. */
  accepted: string[];
  /** Files refused up front, each with the sentence to show for it. */
  rejected: Array<{ fileName: string; reason: string }>;
  error?: string;
}

/** Decoding is the cheap half and transcription the long one, so a progress bar
 * that gave them equal weight would sprint then crawl. The split is fixed and
 * stated rather than tuned: the read is a fraction of the work, and pretending
 * otherwise is what makes a progress bar untrustworthy. */
export const DECODE_PROGRESS_SHARE = 0.15;

export function importProgress(phase: ImportPhase, processedMs: number, durationMs: number): number {
  if (phase === "done") return 1;
  if (phase === "queued") return 0;
  if (durationMs <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, processedMs / durationMs));
  if (phase === "reading") return ratio * DECODE_PROGRESS_SHARE;
  if (phase === "transcribing") return DECODE_PROGRESS_SHARE + ratio * (1 - DECODE_PROGRESS_SHARE - 0.05);
  if (phase === "notes" || phase === "filing") return 0.97;
  return ratio; // failed / cancelled: whatever was really covered, frozen
}
