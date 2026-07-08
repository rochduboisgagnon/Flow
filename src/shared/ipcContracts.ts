// IPC channel names shared by main and the overlay renderer. One place, typed,
// so a renamed channel cannot silently desynchronize the two sides.

// main -> overlay
export const CAPTURE_START = "capture:start";
export const CAPTURE_STOP = "capture:stop"; // finish and hand the WAV back
export const CAPTURE_CANCEL = "capture:cancel"; // discard everything

// overlay -> main
export const CAPTURE_DONE = "capture:done";
export const CAPTURE_ERROR = "capture:error";

// C2 native loopback capture (Windows-only): a hidden capture window mixes the PC's
// own sound (loopback) with the microphone into one 16 kHz mono stream and streams
// Int16 PCM slices to the engine, which feeds the long recorder directly (no PWA,
// no network hop). main -> capture window:
export const NATIVE_START = "native:start";
export const NATIVE_STOP = "native:stop";
// capture window -> main:
export const NATIVE_CHUNK = "native:chunk"; // one Int16 mono 16 kHz PCM slice (~1 s)
export const NATIVE_ERROR = "native:error";
export const NATIVE_READY = "native:ready"; // the capture graph is live
export const NATIVE_DONE = "native:done"; // the tail has been flushed; the recorder may finalize

export interface NativeStartPayload {
  micDeviceId: string; // "" = system default microphone
  captureSystem: boolean; // also mix in the PC's own sound (loopback)
}

export interface CaptureStartPayload {
  // Per-capture config so the overlay never holds stale settings.
  sounds: boolean; // audible start/stop cues
  micDeviceId: string; // "" = system default microphone
}

export interface CaptureDonePayload {
  // 16 kHz mono 16-bit WAV, alive only for this one utterance (never stored).
  wav: ArrayBuffer;
  durationMs: number;
}


// Model download/swap progress, surfaced through the local API (the Manager
// polls GET /settings; AGR Flow has no settings window of its own since v2).
export interface ModelStatePayload {
  status: "idle" | "downloading" | "ready" | "error";
  pct?: number;
  message?: string;
}

export interface ModelChoice {
  file: string;
  label: string;
  size: string;
}
