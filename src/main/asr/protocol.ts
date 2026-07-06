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
    `Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
    `--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(head), Buffer.from(wav), Buffer.from(fields)]);
}

export function parseInferenceResponse(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as InferenceResponse).text !== "string"
  ) {
    throw new Error("whisper-server answered without a text field");
  }
  // The model pads utterances with spaces/newlines; trim once here so every
  // consumer downstream (insertion, clipboard) gets the clean text.
  return (parsed as InferenceResponse).text.trim();
}

export function pickThreads(cpuCount: number): number {
  // Leave headroom for the app + the system; whisper saturates poorly past 8.
  return Math.max(1, Math.min(8, cpuCount - 2));
}
