// Did the microphone keep producing audio for the whole press? (plan V2, B9)
//
// THE CASE THIS EXISTS FOR, and why it is invisible today. Unplug a USB headset
// in the middle of a sentence and NOTHING in Flow raises an error. The renderer
// already holds a live MediaStream; when the device disappears its track simply
// ends, the AudioWorklet stops being handed frames, and the capture goes on
// "succeeding" with no more audio in it. On release, main receives a perfectly
// well-formed WAV that happens to stop where the headset did. The user gets
// half a sentence, or the energy VAD drops the clip entirely and they get
// nothing at all - and every surface of the app says the dictation worked.
// Exactly the class of failure B6 was written to end, one layer lower.
//
// The same signature covers three other real causes, which is why the counter
// is named for the SYMPTOM and not for one cause: the Windows audio service
// restarting, another application seizing the device in exclusive mode, and a
// Bluetooth headset switching profile mid-utterance.
//
// WHY A HEURISTIC, stated plainly rather than dressed up. Main cannot observe
// the renderer's MediaStreamTrack, so it cannot be TOLD the device died; all it
// has is two numbers it already owns - how long the key was held, and how much
// audio came back. A clip much shorter than its own press is the only evidence
// available from here. That makes this a detector with a deliberate bias: it
// must never cry wolf, so it is tuned to miss small losses rather than to
// invent big ones.
//
// The two thresholds are set from that bias, not from taste:
//   - a press must be long enough that its startup cost is a small share of it.
//     getUserMedia is genuinely slow on the first press of a session (hundreds
//     of milliseconds; it is menace §3.2.3 of the plan and the whole reason B2
//     exists), and every capture therefore starts LATE by construction. On a
//     600 ms tap that latency alone can be half the clip.
//   - the missing time must be far past any honest startup cost. 1.5 s is
//     several times the worst first-call getUserMedia this project has seen,
//     so what it flags is a device that stopped, never a device that was slow
//     to start.
//
// ZERO RETENTION (plan §5.4), same discipline as hotpath.ts and
// silentFailures.ts: two durations in milliseconds and a boolean. Nothing here
// can carry a word of what was dictated.
//
// ADVERSE REVIEW V2, CONSTAT 4: a warm capture is not just "the audio recorded
// during the hold" - shared/micWarmth.ts's pre-roll ring can PREPEND up to
// PRE_ROLL_MS of audio captured BEFORE the key ever went down (that is the
// whole point of the pre-roll: saving the first syllable a cold getUserMedia
// would otherwise clip). So `capturedMs` for a warm press is, at most,
// `heldMs + PRE_ROLL_MS`, and the original `heldMs - capturedMs` arithmetic
// below - written before B2's pre-roll existed - silently credits that
// cushion as if it proved the microphone kept working for the whole hold. A
// real drop that a healthy mic's own pre-roll happens to paper over up to
// PRE_ROLL_MS of would then read as "less missing than it is", weakening the
// exact detector this module exists for.
//
// The fix: `judgeCaptureShortfall` takes an explicit `preRollMs` credit and
// removes it from `capturedMs` before comparing to `heldMs` - i.e. it judges
// only the audio that can be PROVEN to have been produced during the hold.
// Callers that do not know their pre-roll (or predate this change) omit the
// argument and get the old arithmetic back exactly, unchanged.
//
// The credit passed in is deliberately the ring's WORST-CASE capacity
// (PRE_ROLL_MS), not an attempt to measure the exact amount actually buffered
// for one specific press - main cannot see the renderer's ring fill level,
// and guessing low would let a real drop hide under the guess. Crediting the
// worst case can only ever make `missingMs` LARGER (never smaller) than the
// pre-roll-blind reading, so it can only make the detector MORE willing to
// flag a genuine drop - never less, and never a reason to cry wolf on a
// healthy capture: a healthy capture's `capturedMs` is always >= `heldMs` (it
// is real hold audio PLUS a non-negative pre-roll contribution of AT MOST
// PRE_ROLL_MS), so crediting the full PRE_ROLL_MS on a healthy capture can
// drive `missingMs` no higher than PRE_ROLL_MS itself - see the "safety
// margin" test in capture-continuity.test.ts, which pins this down with real
// numbers instead of leaving it as an argument in a comment.

import { PRE_ROLL_MS, type MicPrewarm } from "./micWarmth";

/** Below this, a press is too short for the arithmetic to mean anything: the
 * capture's own startup latency is too large a share of it. */
export const SHORTFALL_MIN_HELD_MS = 2_000;

/** How much audio has to be missing before this is a device that stopped rather
 * than a device that was slow to start. */
export const SHORTFALL_MIN_MISSING_MS = 1_500;

export interface CaptureShortfall {
  /** How long the shortcut was held, main-process clock. */
  heldMs: number;
  /** How much audio actually came back in the WAV, UNADJUSTED - the raw
   * figure worth stating in a log line, pre-roll and all. */
  capturedMs: number;
  /** heldMs - (capturedMs credited for pre-roll), floored at 0: how much of
   * the HOLD is unaccounted for once any pre-roll cushion has been removed
   * from the credit. See the module note on why the credit is a worst case,
   * never a per-press measurement. */
  missingMs: number;
  /** The verdict: the microphone stopped producing audio during the press. */
  dropped: boolean;
}

/** Pure, total, and defensive about its inputs: both numbers come from clocks
 * and a decoder, and a NaN or a negative must produce "nothing to report"
 * rather than a false accusation.
 *
 * `preRollMs` (constat 4): how much of `capturedMs` may legitimately be audio
 * from BEFORE the hold began - the worst-case credit for the mic-prewarm mode
 * in effect, computed by `preRollCreditMs` below. Defaults to 0 (the original
 * behaviour) for a caller that does not know it. */
export function judgeCaptureShortfall(heldMs: number, capturedMs: number, preRollMs = 0): CaptureShortfall {
  const held = Number.isFinite(heldMs) && heldMs > 0 ? heldMs : 0;
  const captured = Number.isFinite(capturedMs) && capturedMs > 0 ? capturedMs : 0;
  const preRoll = Number.isFinite(preRollMs) && preRollMs > 0 ? preRollMs : 0;
  // The credit can only reduce how much of `captured` counts as hold audio,
  // never go negative itself.
  const capturedDuringHold = Math.max(0, captured - preRoll);
  // A clip LONGER than its press (net of any pre-roll credit) is not a
  // contradiction worth flagging: the release travels to the renderer, which
  // flushes whatever the worklet already handed it. Clamp instead of
  // reporting a negative gap.
  const missingMs = Math.max(0, held - capturedDuringHold);
  const dropped = held >= SHORTFALL_MIN_HELD_MS && missingMs >= SHORTFALL_MIN_MISSING_MS;
  return { heldMs: held, capturedMs: captured, missingMs, dropped };
}

/** The worst-case pre-roll credit for a mic-prewarm mode (constat 4/5): the
 * ring holds up to PRE_ROLL_MS of audio recorded before the key went down
 * whenever prewarm is not "off" (see shared/micWarmth.ts), and none at all
 * when it is. Kept here, pure and tested, rather than computed ad hoc at each
 * call site - `judgeCaptureShortfall` and the 300 ms release-noise guard in
 * main/index.ts must never independently drift on what "the pre-roll" means. */
export function preRollCreditMs(mode: MicPrewarm): number {
  return mode === "off" ? 0 : PRE_ROLL_MS;
}

/** The line for flow.log. Says the numbers AND the likely cause, because a user
 * reading this has already lost a sentence and needs to know what to check -
 * not to be told an event occurred. */
export function shortfallLogLine(v: CaptureShortfall): string {
  return (
    `[audio] the microphone stopped producing audio during a dictation: the shortcut was held ` +
    `${Math.round(v.heldMs)} ms but only ${Math.round(v.capturedMs)} ms of sound came back ` +
    `(${Math.round(v.missingMs)} ms missing). Usual causes: a USB or Bluetooth headset disconnected ` +
    `mid-sentence, the Windows audio service restarted, or another application took the device in ` +
    `exclusive mode. The text that was inserted, if any, is only the part Flow actually heard.`
  );
}
