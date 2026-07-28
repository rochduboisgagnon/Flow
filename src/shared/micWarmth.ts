// Microphone pre-warm and pre-roll policy (plan V2, B2). Pure and DOM-free on
// purpose: the renderer owns the audio graph, but every RULE about it - how
// long the microphone may stay open, how much audio the pre-roll may hold, and
// what the user's setting means - is decided here, where it can be unit-tested
// without Electron, a window or a microphone.
//
// WHY THIS EXISTS AT ALL. Measured on the dictation hot path (B1): the first
// getUserMedia of a session costs hundreds of milliseconds, and EVERY press
// pays a fresh AudioContext plus an AudioWorklet module compile on top of it.
// Audio spoken during that window is not late - it never existed. That is the
// "missing first words" class of bug, and no amount of tuning downstream can
// recover a syllable the microphone was not open for.
//
// THE TRADE, STATED PLAINLY. The only way to have audio from BEFORE a keypress
// is to have been recording before the keypress. So this feature does the one
// thing a privacy-first product must never do casually: it holds the
// microphone open when the user is not dictating. Four hard rules bound it,
// and every one of them is enforced in code rather than promised in a doc:
//
//   1. BOUNDED IN TIME. The microphone is released `holdMs` after a dictation
//      ends (and after the startup warm-up), by a timer armed at the same
//      instant the capture ends. "always" is the ONE mode where it is not, and
//      it is opt-in, never a default.
//   2. BOUNDED IN SIZE. The pre-roll is a ring capped at PRE_ROLL_MS worth of
//      samples BY CONSTRUCTION (see PcmRing.push): it cannot grow past its
//      capacity even if nothing ever reads it.
//   3. NEVER WRITTEN DOWN. The ring lives in renderer memory only. Nothing in
//      this file, and nothing that uses it, touches the disk, the network or
//      the main process with those samples. The zero-retention rule (plan
//      §5.4) is not weakened: an unused ring is erased, not filed.
//   4. ERASABLE AND ERASED. The ring is cleared when the capture that consumed
//      it ends, when the microphone is released, and when the user turns the
//      setting off - three different moments, all explicit.
//
// AND THE HONEST COST: Windows' microphone indicator lights up for those
// seconds. That is not a bug to hide, it is the price, and the Settings text
// says so in the user's own words.

import type { CaptureWarmPayload } from "./ipcContracts";

/** How much audio the pre-roll may hold, in milliseconds. The plan's number
 * (§3.4, B2), and deliberately small: it has to cover the gap between "the key
 * went down" and "the microphone graph is delivering frames", not to record
 * the room. Half a second is long enough to save a clipped first syllable and
 * short enough that it can never turn a deliberate press into a recording of
 * the sentence the user said to somebody else beforehand. */
export const PRE_ROLL_MS = 500;

/** How long the microphone stays open once nothing needs it. Chosen against
 * the actual cadence of dictation - speak, think for a couple of seconds,
 * speak again - so that a burst of consecutive utterances pays the acquisition
 * cost once instead of once per press, while a user who walks away has the
 * indicator go out within seconds rather than staying lit all day. */
export const WARM_HOLD_MS = 5_000;

/** The user's choice, in Settings > Dictation. Three levels because there are
 * genuinely three answers to "how much microphone-open time will you trade for
 * never losing a first word", and pretending there are two would push someone
 * into the wrong one. */
export type MicPrewarm =
  /** Never open the microphone outside a press. Lowest exposure; the first
   * word of a dictation can be clipped, and the timings in Diagnostics will
   * say by how much. */
  | "off"
  /** Default. Open it for a few seconds at startup and after each dictation,
   * with a half-second rolling pre-roll prepended to the next press. */
  | "after"
  /** Keep it open for as long as Flow runs. Zero acquisition cost on every
   * press, forever - and the indicator stays lit, forever. Opt-in only. */
  | "always";

export function isMicPrewarm(v: unknown): v is MicPrewarm {
  return v === "off" || v === "after" || v === "always";
}

/**
 * The ONE translation from "what the user chose" to "what the renderer does".
 * `null` means the feature is off: no warm microphone, and a pre-roll ring of
 * zero capacity, so there is nothing held in memory to leak, clear or forget.
 *
 * `holdMs: null` (the "always" mode) means "never arm the release timer" - a
 * distinct value rather than a huge number, so no arithmetic anywhere can
 * accidentally turn "forever" into "in 24 days".
 */
export function warmPolicy(mode: MicPrewarm, micDeviceId: string): CaptureWarmPayload | null {
  if (mode === "off") return null;
  return {
    micDeviceId,
    preRollMs: PRE_ROLL_MS,
    holdMs: mode === "always" ? null : WARM_HOLD_MS,
  };
}

/** Ring capacity in SAMPLES for a wanted pre-roll duration. Floor, never
 * round: rounding up would let the ring hold marginally more audio than the
 * duration the user was told about, and this is exactly the number that must
 * never be generous. */
export function preRollSamples(ms: number, sampleRate: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor((ms / 1000) * sampleRate);
}

/**
 * A bounded ring of PCM frames: the pre-roll buffer itself.
 *
 * Capped by TOTAL SAMPLES, not by frame count, because the frame size is the
 * audio thread's business (128 samples per render quantum today, and not a
 * contract): a frame-count cap would silently become a different duration if
 * Chromium ever changed it. Over-capacity audio is trimmed out of the OLDEST
 * frame with slice(), not subarray(), so the underlying buffer is genuinely
 * released rather than kept alive behind a view - "never exceeds its size"
 * has to be true of memory, not just of an accounting field.
 *
 * A capacity of 0 makes every push a no-op. That is what the "off" setting
 * compiles down to: not a ring that is emptied often, a ring that never holds
 * a sample in the first place.
 */
export class PcmRing {
  private frames: Float32Array[] = [];
  private total = 0;

  constructor(private readonly capacity: number) {}

  push(frame: Float32Array): void {
    if (this.capacity <= 0 || frame.length === 0) return;
    this.frames.push(frame);
    this.total += frame.length;
    while (this.total > this.capacity) {
      const excess = this.total - this.capacity;
      const oldest = this.frames[0];
      if (excess >= oldest.length) {
        this.frames.shift();
        this.total -= oldest.length;
      } else {
        this.frames[0] = oldest.slice(excess);
        this.total -= excess;
      }
    }
  }

  /** Hand the buffered audio over AND empty the ring in one step. Two things
   * at once on purpose: the pre-roll may be consumed exactly once, and leaving
   * a copy behind after handing it to a capture would be retention with extra
   * steps. */
  drain(): Float32Array[] {
    const out = this.frames;
    this.frames = [];
    this.total = 0;
    return out;
  }

  clear(): void {
    this.frames = [];
    this.total = 0;
  }

  /** Samples currently held. Never exceeds `capacity`, by construction. */
  get size(): number {
    return this.total;
  }
}
