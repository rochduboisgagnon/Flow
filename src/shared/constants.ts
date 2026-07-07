// Default push-to-talk shortcut: Ctrl + Win (both sides accepted), the combo
// chosen by design (plan 5.8). A modifiers-only combination - which is exactly
// why the hotkey path is a low-level monitor (keyspy) with our own matcher
// (src/shared/combo.ts) instead of any OS hotkey registration API.
export const DEFAULT_COMBO = ["CTRL", "WIN"];

// A press shorter than this is treated as an accidental tap and cancelled:
// no capture reaches the ASR, nothing is inserted.
export const MIN_HOLD_MS = 200;

// Two quick taps of the shortcut within this window toggle hands-free capture
// (plan 5.8): dictate without holding the keys; double-tap again to stop.
export const DOUBLE_TAP_MS = 400;
