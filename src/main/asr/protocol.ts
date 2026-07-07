// Pure pieces of the whisper-server dialogue: multipart body construction and
// response parsing. No Electron, no sockets - unit-tested directly.

export interface InferenceResponse {
  text: string;
}

export interface ServerArgOptions {
  /** Beam search width (whisper-server --beam-size). >0 turns on beam search;
   * plan v4 chantier 11: a big, cheap accuracy lever after the model size. */
  beamSize?: number;
}

export function buildServerArgs(
  modelPath: string,
  port: number,
  threads: number,
  opts: ServerArgOptions = {},
): string[] {
  const args = [
    "--model",
    modelPath,
    "--host",
    "127.0.0.1", // loopback only: the ASR must never be reachable from the network
    "--port",
    String(port),
    "--threads",
    String(threads),
  ];
  if (opts.beamSize && opts.beamSize > 0) args.push("--beam-size", String(opts.beamSize));
  return args;
}

// Whisper always encodes a full 30 s window: without a hint, a 2 s utterance
// pays the same ~1.8 s encoder bill as a 30 s one (measured on this exact
// binary). audio_ctx shrinks the encoder context to what the audio actually
// needs - measured 1858 ms -> 254 ms on a short utterance with an IDENTICAL
// transcript. 50 ctx units per second (1500 = 30 s), a safety margin against
// the repetition artifacts seen with too-tight contexts, and a floor for very
// short clips. This single knob is what puts dictation far under the one-
// second target on CPU (plan 2, speed as requirement #1).
const CTX_PER_SECOND = 50;
const CTX_MARGIN = 128;
const CTX_MIN = 256;
const CTX_FULL = 1500;

export function computeAudioCtx(durationSec: number): number {
  return Math.min(CTX_FULL, Math.max(CTX_MIN, Math.ceil(durationSec * CTX_PER_SECOND) + CTX_MARGIN));
}

/** Duration of a canonical 16 kHz mono 16-bit WAV, from its byte length. */
export function wavDurationSec(wavBytes: number): number {
  return Math.max(0, wavBytes - 44) / 32_000;
}

// whisper-server expects multipart/form-data: the WAV under "file", plus
// simple fields. Same shape OpenWhispr proved against this exact server.
// verbose_json (OpenAI-compatible) gets us per-segment no-speech scoring on
// top of the text: the second anti-hallucination gate (plan 5.9).
export function buildInferenceBody(
  boundary: string,
  wav: Uint8Array,
  language: string,
  audioCtx?: number,
  prompt?: string,
): Buffer {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="utterance.wav"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`;
  const ctxField = audioCtx
    ? `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio_ctx"\r\n\r\n${audioCtx}\r\n`
    : "";
  // Plan v4 chantier 11: whisper-server reads a per-request `prompt` (initial
  // prompt), verified honored on the pinned build. The multipart body is UTF-8,
  // so accented French seeds ride cleanly here (a CLI --prompt would be mangled
  // by the Windows argv codepage). Empty prompt = field omitted.
  const promptField = prompt
    ? `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`
    : "";
  const fields =
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n${language}\r\n` +
    ctxField +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n` +
    promptField +
    `--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(head), Buffer.from(wav), Buffer.from(fields)]);
}

// Above this probability the model itself says "this segment is not speech":
// OpenAI's reference pipeline treats >0.6 as silence; we keep a little margin.
const NO_SPEECH_MAX = 0.66;

interface VerboseSegment {
  text?: string;
  no_speech_prob?: number;
}

export function parseInferenceResponse(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("whisper-server answered with non-JSON");
  }
  const r = parsed as InferenceResponse & { segments?: unknown };
  // With segments (verbose_json), drop the ones the model scores as
  // non-speech; a build that ignores verbose_json and returns plain json
  // still works through the text fallback below.
  if (Array.isArray(r.segments)) {
    const kept = (r.segments as VerboseSegment[])
      .filter(
        (s) =>
          typeof s === "object" &&
          s !== null &&
          typeof s.text === "string" &&
          (typeof s.no_speech_prob !== "number" || s.no_speech_prob <= NO_SPEECH_MAX),
      )
      .map((s) => (s.text as string).trim())
      .filter((t) => t.length > 0);
    return kept.join(" ").replace(/\s+/g, " ").trim();
  }
  if (typeof r.text !== "string") {
    throw new Error("whisper-server answered without a text field");
  }
  // The model pads utterances with spaces/newlines; trim once here so every
  // consumer downstream (insertion, clipboard) gets the clean text.
  return r.text.trim();
}

export function pickThreads(cpuCount: number): number {
  // Leave headroom for the app + the system; whisper saturates poorly past 8.
  return Math.max(1, Math.min(8, cpuCount - 2));
}
