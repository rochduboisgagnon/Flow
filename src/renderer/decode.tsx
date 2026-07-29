// V4 D1: the hidden DECODE window. It turns the bytes of an imported audio file
// into 16 kHz mono Int16 PCM and streams it back to the engine, using nothing
// but what Electron already ships - Chromium's own codecs (m4a/AAC, mp3, ogg,
// flac, wav) through decodeAudioData. No ffmpeg, no binary of any kind.
//
// Three deliberate choices, all of them about the failure mode named in plan
// §5.1.3 (memory):
//
//  1. The decode runs on an OfflineAudioContext built at 16 000 Hz.
//     decodeAudioData resamples to the sample rate of the context it is called
//     on, so the AudioBuffer that comes back is ALREADY 16 kHz - the resampling
//     the plan asks for happens inside the decode instead of doubling the peak
//     with a second full-length buffer. Two hours of 44.1 kHz stereo weighs
//     ~2.5 GB decoded at its native rate and ~880 MB decoded this way.
//  2. The duration is probed with an <audio> element FIRST, on the same bytes,
//     which costs a metadata parse and no decode at all. Main decides what to do
//     with that number (shared/audioImport.ts's planDecode) before this window
//     ever allocates anything.
//  3. The mono fold happens HERE, in place, into small Int16 slices that leave
//     immediately. Rendering the fold through a second OfflineAudioContext would
//     be more idiomatic and would hold a second copy of the whole recording; an
//     average of the channels is exact and costs one slice at a time.
//
// This window is otherwise inert: no UI, no timers, nothing retained between
// jobs. Everything is keyed on a token so a cancelled job's late message can
// never be mistaken for the next one's.
import type {
  DecodeBytesPayload,
  DecodeFlowPayload,
  DecodeTokenPayload,
} from "../shared/ipcContracts";
import { SAMPLE_RATE } from "../shared/wav";

const api = window.agrflow;

/** ~5 s of 16 kHz mono per message (160 KB): small enough that the engine never
 * waits on a big copy, large enough that a two-hour file is ~1400 messages. */
const SLICE_FRAMES = SAMPLE_RATE * 5;

let token = 0; // the job this window is currently working for
let parts: Uint8Array[] = [];
let byteCount = 0;
let paused = false;
let resumeWaiters: Array<() => void> = [];

function reset(): void {
  parts = [];
  byteCount = 0;
  paused = false;
  const waiters = resumeWaiters;
  resumeWaiters = [];
  for (const w of waiters) w(); // never leave a loop awaiting a resume that will not come
}

/** One contiguous copy of the file: decodeAudioData wants a single ArrayBuffer,
 * and Blob->arrayBuffer would make the same copy one layer down. */
function assemble(): Uint8Array {
  const all = new Uint8Array(byteCount);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  parts = []; // the slices die here: only ONE copy of the file is ever held
  return all;
}

function waitIfPaused(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise((resolve) => resumeWaiters.push(resolve));
}

/** Duration WITHOUT decoding: the metadata parse an <audio> element does when it
 * loads a blob. Answers 0 rather than throwing when the container carries no
 * usable duration (a streamed ogg, a truncated file) - "unknown" is a state main
 * knows how to handle, an exception here is not. */
function probeDurationMs(bytes: Uint8Array): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const el = new Audio();
    let settled = false;
    const finish = (ms: number) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      resolve(ms);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => finish(0); // a format the element refuses may still decode; let the decode say so
    // A metadata parse that never settles must not strand the import.
    setTimeout(() => finish(0), 15_000);
    el.src = url;
  });
}

async function probe(t: number): Promise<void> {
  if (t !== token) return;
  const bytes = assemble();
  // Keep the assembled copy: the decode that follows works on these same bytes,
  // and re-sending a two-hour file over IPC to probe it would be absurd.
  parts = [bytes];
  byteCount = bytes.length;
  const durationMs = await probeDurationMs(bytes);
  if (t !== token) return;
  api.sendDecodeMeta({ token: t, durationMs });
}

async function decode(t: number): Promise<void> {
  if (t !== token) return;
  const bytes = assemble();
  let buf: AudioBuffer;
  try {
    // Rate 16 000: the decode resamples on the way out (see the module note).
    // Length 1 / one channel: this context is never rendered, it only decodes.
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    buf = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
  } catch (err) {
    if (t !== token) return;
    const detail = String(err instanceof Error ? err.message : err);
    // Chromium says "Unable to decode audio data" both for a format it cannot
    // read and for a buffer it cannot allocate (measured: that is exactly what a
    // 6-hour file answers). Main cannot tell them apart from here either, so the
    // distinction is made where the FACTS are - it knows the projected size it
    // approved - and this only reports what it saw.
    api.sendDecodeError({ token: t, reason: "format", detail });
    reset();
    return;
  }
  if (t !== token) {
    reset();
    return;
  }
  try {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    const frames = buf.length;
    for (let start = 0; start < frames; start += SLICE_FRAMES) {
      await waitIfPaused(); // the engine is writing to disk: do not run ahead of it
      if (t !== token) return; // cancelled mid-stream: stop, say nothing more
      const n = Math.min(SLICE_FRAMES, frames - start);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < channels.length; c++) s += channels[c][start + i];
        s /= channels.length;
        // Clamp, same rule as shared/wav.ts: wrapping would turn a hot passage
        // into loud garbage instead of a flat ceiling.
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      api.sendDecodePcm({ token: t, pcm: out.buffer as ArrayBuffer });
    }
    api.sendDecodeDone({ token: t, frames, channels: buf.numberOfChannels });
  } catch (err) {
    if (t === token) api.sendDecodeError({ token: t, reason: "internal", detail: String(err) });
  } finally {
    reset();
  }
}

api.onDecodeCommand((cmd, payload) => {
  if (cmd === "bytes") {
    const p = payload as DecodeBytesPayload;
    // A new token means a new job: the previous one's bytes are dead weight.
    if (p.token !== token) {
      token = p.token;
      reset();
    }
    parts.push(p.bytes);
    byteCount += p.bytes.length;
    return;
  }
  if (cmd === "flow") {
    const p = payload as DecodeFlowPayload;
    if (p.token !== token) return;
    paused = p.paused;
    if (!paused) {
      const waiters = resumeWaiters;
      resumeWaiters = [];
      for (const w of waiters) w();
    }
    return;
  }
  const p = payload as DecodeTokenPayload;
  if (cmd === "probe") void probe(p.token);
  else if (cmd === "run") void decode(p.token);
  else if (cmd === "cancel") {
    // Bumping the token is what stops every loop in flight: they all check it.
    if (p.token === token) token = -1;
    reset();
  }
});
