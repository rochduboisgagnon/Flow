// Default push-to-talk shortcut: Ctrl + Win (both sides accepted), the combo
// chosen by design (plan 5.8). A modifiers-only combination - which is exactly
// why the hotkey path is a low-level monitor (keyspy) with our own matcher
// (src/shared/combo.ts) instead of any OS hotkey registration API.
export const DEFAULT_COMBO = ["CTRL", "WIN"];

// A press shorter than this is treated as an accidental tap and cancelled:
// no capture reaches the ASR, nothing is inserted.
export const MIN_HOLD_MS = 200;

// How long a hold has to have lasted before a stray key STOPS the dictation
// (delivering what was said) instead of CANCELLING it (throwing it away).
//
// 2026-07-30, from a human report: "sometimes the transcript stops in the
// middle without me releasing the shortcut, so I don't get to finish."
//
// The cause was one line: ANY keydown outside the combo cancelled a capture in
// progress. The intent behind it is real - Ctrl+Win then Arrow is a virtual
// desktop switch, not dictation - but the rule ignored the one thing that tells
// the two apart. Somebody invoking a shortcut presses the third key almost
// immediately; somebody dictating has been speaking for seconds. A stray key at
// second nine is not the start of a shortcut.
//
// So the response is split by WHEN it arrives, and the asymmetry is on purpose:
// early, the capture is cancelled (a shortcut must not insert text); late, it is
// stopped and what was already said is delivered. Cancelling late is the only
// version that destroys work the user cannot get back, and that is the outcome
// worth eliminating - the same reasoning as the pre-roll and the partial import.
export const STRAY_KEY_STOPS_AFTER_MS = 1_500;

// Two quick taps of the shortcut within this window toggle hands-free capture
// (plan 5.8): dictate without holding the keys; double-tap again to stop.
export const DOUBLE_TAP_MS = 400;

// THE single source of truth for the titlebar's height. U1 feeds this (in DIP)
// to BrowserWindow's titleBarOverlay so Windows' native caption buttons are
// drawn at this height, while main.css reads the SAME number as --titlebar-h
// to size its own custom titlebar row. If the two ever diverge, the native
// buttons float above or below the custom row instead of sitting flush in it.
export const TITLEBAR_H = 40;
