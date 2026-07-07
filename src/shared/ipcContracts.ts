// IPC channel names shared by main and the overlay renderer. One place, typed,
// so a renamed channel cannot silently desynchronize the two sides.

// main -> overlay
export const CAPTURE_START = "capture:start";
export const CAPTURE_STOP = "capture:stop"; // finish and hand the WAV back
export const CAPTURE_CANCEL = "capture:cancel"; // discard everything

// overlay -> main
export const CAPTURE_DONE = "capture:done";
export const CAPTURE_ERROR = "capture:error";

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

// settings window <-> main (invoke/handle)
export const SETTINGS_GET = "settings:get";
export const SETTINGS_SET = "settings:set";
// Records a new shortcut through the low-level hook itself: main resolves with
// the normalized combo, or null on cancel/timeout. While recording, keyspy
// swallows every key (nothing leaks to the OS - including the Win key, so the
// Start menu cannot steal the recorder's focus).
export const SHORTCUT_RECORD = "shortcut:record";

// settings window -> main: open the Windows microphone privacy panel
// (onboarding when access is denied, plan 5.9)
export const OPEN_MIC_SETTINGS = "onboarding:micSettings";

// main -> settings window: ASR model download/swap progress
export const MODEL_STATE = "model:state";

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
