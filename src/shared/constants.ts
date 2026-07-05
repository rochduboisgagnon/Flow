// Default push-to-talk key. RIGHT CTRL: a single physical key almost never used
// alone, clean DOWN/UP semantics through keyspy, and holdable with one finger
// while speaking. Configurable in the settings (commit 8).
export const DEFAULT_PTT_KEY = "RIGHT CTRL";

// A press shorter than this is treated as an accidental tap and cancelled:
// no capture reaches the ASR, nothing is inserted.
export const MIN_HOLD_MS = 200;
