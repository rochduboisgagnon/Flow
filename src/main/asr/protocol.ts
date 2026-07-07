// Pure pieces of the whisper-server dialogue: multipart body construction and
// response parsing. No Electron, no sockets - unit-tested directly.

export interface InferenceResponse {
  text: string;
}

export function buildServerArgs(modelPath: string, port: number, threads: number): string[] {
  return [
    "--model",
    modelPath,
    "--host",
    "127.0.0.1", // loopback only: the ASR must never be reachable from the network
    "--port",
    String(port),
    "--threads",
    String(threads),
  ];
}

// whisper-server expects multipart/form-data: the WAV under "file", plus
// simple fields. Same shape OpenWhispr proved against this exact server.
// verbose_json (OpenAI-compatible) gets us per-segment no-speech scoring on
// top of the text: the second anti-hallucination gate (plan 5.9).
export function buildInferenceBody(
  boundary: string,
  wav: Uint8Array,
  language: string,
): Buffer {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="utterance.wav"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`;
  const fields =
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n${language}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n` +
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
