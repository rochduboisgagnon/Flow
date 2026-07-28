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

/** Below this, a press is too short for the arithmetic to mean anything: the
 * capture's own startup latency is too large a share of it. */
export const SHORTFALL_MIN_HELD_MS = 2_000;

/** How much audio has to be missing before this is a device that stopped rather
 * than a device that was slow to start. */
export const SHORTFALL_MIN_MISSING_MS = 1_500;

export interface CaptureShortfall {
  /** How long the shortcut was held, main-process clock. */
  heldMs: number;
  /** How much audio actually came back in the WAV. */
  capturedMs: number;
  /** heldMs - capturedMs, floored at 0. */
  missingMs: number;
  /** The verdict: the microphone stopped producing audio during the press. */
  dropped: boolean;
}

/** Pure, total, and defensive about its inputs: both numbers come from clocks
 * and a decoder, and a NaN or a negative must produce "nothing to report"
 * rather than a false accusation. */
export function judgeCaptureShortfall(heldMs: number, capturedMs: number): CaptureShortfall {
  const held = Number.isFinite(heldMs) && heldMs > 0 ? heldMs : 0;
  const captured = Number.isFinite(capturedMs) && capturedMs > 0 ? capturedMs : 0;
  // A clip LONGER than its press is not a contradiction worth flagging: the
  // release travels to the renderer, which flushes whatever the worklet already
  // handed it. Clamp instead of reporting a negative gap.
  const missingMs = Math.max(0, held - captured);
  const dropped = held >= SHORTFALL_MIN_HELD_MS && missingMs >= SHORTFALL_MIN_MISSING_MS;
  return { heldMs: held, capturedMs: captured, missingMs, dropped };
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
