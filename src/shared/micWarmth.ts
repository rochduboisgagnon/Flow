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
//      samples BY CONSTRUCTION (see PcmRing.trim): it cannot grow past its
//      capacity even if nothing ever reads it, and lowering the bound - which
//      is what turning the setting off does - erases the excess on the spot
//      rather than at some later release (PcmRing.setCapacity).
//   3. NEVER WRITTEN DOWN. The ring lives in renderer memory only. Nothing in
//      this file, and nothing that uses it, touches the disk, the network or
//      the main process with those samples. The zero-retention rule (plan
//      §5.4) is not weakened: an unused ring is erased, not filed.
//   4. ERASABLE AND ERASED. The ring is cleared when the capture that consumed
//      it ends, when the microphone is released, and when the user turns the
//      setting off - three different moments, all explicit.
//   5. ALIVE, OR RELEASED. A warm graph is only warm while it is still a
//      working microphone. It is re-verified before every adoption and every
//      policy push (mayAdoptWarmGraph below), and a graph that fails is
//      released rather than dictated through. This is a correctness rule, not
//      a privacy one, and it is here because rules 1-4 were written when a
//      graph could not outlive the keypress that built it.
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

// ---- Is a warm graph still a MICROPHONE, or just an object that used to be one? ----
//
// B2 as first written kept one premise from the code it replaced: a capture
// graph was created and destroyed inside a single keypress, so "the graph
// exists" and "the microphone works" were the same fact, and checking the
// second was checking the first twice. B2 broke that premise - a graph now
// outlives the press that built it, by seconds in "after" mode and by the whole
// session in "always" - without rewriting the guard that depended on it.
//
// Everything below exists to answer the question that premise used to answer
// for free. It is deliberately pure and DOM-free, like the rest of this file:
// the renderer reads the numbers off a MediaStreamTrack and an AudioContext,
// and the RULE about what those numbers mean is decided - and tested - here.

/** How long a graph may go without delivering a single audio frame before Flow
 * stops believing it is live.
 *
 * At 16 kHz an AudioWorklet hands over a render quantum roughly every 8 ms, so
 * this is about fifty missed frames: far beyond any scheduling hiccup, far
 * below anything a human would experience as a pause.
 *
 * This is the check the other three cannot make. `readyState`, `muted` and
 * `AudioContext.state` are what the platform is willing to SAY; frames are what
 * it actually DOES. The failure this whole guard exists for - a graph that
 * survived its device and reports perfect health while rendering nothing, which
 * is what a headset unplug, a resume from sleep or a Windows audio-service
 * restart can leave behind - is precisely the case where what the platform says
 * and what it does have come apart. */
export const MAX_FRAME_GAP_MS = 400;

/** Our own copy of MediaStreamTrack.readyState, so this module needs no DOM. */
export type TrackReadyState = "live" | "ended";

/** Our own copy of AudioContextState ("interrupted" is in the spec and reaches
 * us on some platforms; it is not "running", which is all we need to know). */
export type AudioGraphState = "running" | "suspended" | "closed" | "interrupted";

/** Everything the renderer can observe about a warm graph, in one shape. */
export interface WarmGraphVitals {
  /** Flow's own sticky record that this graph died - `track.onended` fired, the
   * context closed, or it was torn down. A graph never comes back. */
  ended: boolean;
  trackReadyState: TrackReadyState;
  /** MediaStreamTrack.muted: the source stopped delivering samples (another app
   * took the device exclusively, the audio service restarted). The track is
   * still "live" and the graph still renders - it renders SILENCE, which is the
   * bug this class of check exists to catch, not a state to dictate through. */
  trackMuted: boolean;
  contextState: AudioGraphState;
  /** ms since this graph last delivered a frame - or since it opened, when it
   * has not delivered one yet. */
  msSinceLastFrame: number;
}

/**
 * May a dictation be handed to this warm graph?
 *
 * Every "no" here costs one cold acquisition (~100-300 ms) and nothing else,
 * because the cold path re-asks the OS for a microphone and therefore
 * SELF-HEALS. Every wrong "yes" costs the user an entire utterance that plays
 * the cue, animates the ribbon, says "listening" and records silence - and in
 * "always" mode it costs them that utterance again on every press until Flow is
 * restarted, because nothing in that mode ever rebuilds the graph. The two
 * errors are not remotely symmetric, so this is strict.
 */
export function warmGraphIsUsable(v: WarmGraphVitals): boolean {
  if (v.ended) return false;
  if (v.trackReadyState !== "live") return false;
  if (v.trackMuted) return false;
  if (v.contextState !== "running") return false;
  return Number.isFinite(v.msSinceLastFrame) && v.msSinceLastFrame <= MAX_FRAME_GAP_MS;
}

/** Just enough of a MediaDeviceInfo to answer "which microphone is this",
 * declared here rather than imported from the DOM so the rule stays testable in
 * a bare node process. */
export interface DeviceLike {
  kind: string;
  deviceId: string;
  groupId: string;
}

/** A microphone's REAL identity, as a track reports it - never a setting. */
export interface DeviceIdentity {
  deviceId: string;
  groupId: string;
}

/** "Flow could not find out." Distinct from any real device, and it never
 * matches anything - callers must decide what to do with ignorance rather than
 * having it silently read as agreement. */
export const UNKNOWN_DEVICE: DeviceIdentity = { deviceId: "", groupId: "" };

export function deviceIsKnown(d: DeviceIdentity): boolean {
  return d.deviceId !== "" || d.groupId !== "";
}

/**
 * Do two identities name the same physical microphone?
 *
 * groupId FIRST, and that is the point rather than a detail: Chromium exposes
 * the system default input TWICE - once as a synthetic "default" entry and once
 * as the real device - and which of the two a track reports in getSettings() is
 * not something a privacy guard should be betting on. Both carry the same
 * groupId, and the groupId is exactly what changes when Windows switches its
 * default input.
 */
export function sameDevice(a: DeviceIdentity, b: DeviceIdentity): boolean {
  if (a.groupId !== "" && b.groupId !== "") return a.groupId === b.groupId;
  return a.deviceId !== "" && a.deviceId === b.deviceId;
}

/**
 * Which REAL microphone the `micDeviceId` setting names RIGHT NOW.
 *
 * The setting's default value is "", meaning "whatever Windows calls the
 * default" - a value that stays "" while the device behind it changes. So
 * comparing settings answers "did the user pick a different microphone", never
 * "is this still the same microphone", and B2 shipped the second question
 * answered by the first: unplug a headset, and the old graph passed the guard
 * and kept being dictated into.
 */
export function resolveWantedDevice(devices: readonly DeviceLike[], wanted: string): DeviceIdentity {
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const isReal = (d: DeviceLike) =>
    d.deviceId !== "" && d.deviceId !== "default" && d.deviceId !== "communications";
  if (wanted !== "") {
    const picked = inputs.find((d) => d.deviceId === wanted);
    if (picked) return { deviceId: picked.deviceId, groupId: picked.groupId };
    // The picked device is gone. getUserMedia's `ideal` constraint falls back
    // to the system default, so the default is what a graph opened right now
    // would ACTUALLY be on - fall through and resolve that instead of claiming
    // a device that no longer exists.
  }
  const virtual =
    inputs.find((d) => d.deviceId === "default") ?? inputs.find((d) => d.deviceId === "communications");
  if (virtual) {
    const behind = inputs.find((d) => isReal(d) && d.groupId !== "" && d.groupId === virtual.groupId);
    return behind
      ? { deviceId: behind.deviceId, groupId: behind.groupId }
      : { deviceId: virtual.deviceId, groupId: virtual.groupId };
  }
  const first = inputs.find(isReal);
  return first ? { deviceId: first.deviceId, groupId: first.groupId } : UNKNOWN_DEVICE;
}

/** Everything the adoption decision reads, gathered by the renderer. */
export interface WarmAdoption {
  /** The `micDeviceId` SETTING the warm graph was opened for. */
  graphWantedDeviceId: string;
  /** What the graph's track actually bound to, read from the track itself. */
  graphDevice: DeviceIdentity;
  /** The `micDeviceId` setting this press asks for. */
  wantedDeviceId: string;
  /** What that setting resolves to right now, or null when Flow could not
   * enumerate devices (the call threw, or no getUserMedia has been granted yet
   * and the ids are therefore blank). */
  resolved: DeviceIdentity | null;
  vitals: WarmGraphVitals;
}

/**
 * THE rule: may this press be handed the warm graph instead of opening a
 * microphone of its own? One function, two call sites (the press, and the
 * policy push that decides whether to keep a warm graph at all), because "is
 * this graph still good" must not have two answers.
 *
 * The device comparison is skipped when either side is unknown, and only then.
 * That is a deliberate degradation to B2's original setting-only behaviour on a
 * platform that tells us nothing - never a shortcut taken when the platform
 * did answer.
 */
export function mayAdoptWarmGraph(a: WarmAdoption): boolean {
  // Did the USER change their mind? Still a real question, and settings answer
  // it exactly - it is the only one they answer.
  if (a.graphWantedDeviceId !== a.wantedDeviceId) return false;
  if (!warmGraphIsUsable(a.vitals)) return false;
  if (
    a.resolved !== null &&
    deviceIsKnown(a.resolved) &&
    deviceIsKnown(a.graphDevice) &&
    !sameDevice(a.graphDevice, a.resolved)
  ) {
    return false;
  }
  return true;
}

function normalizeCapacity(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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
  private cap: number;

  constructor(capacity: number) {
    this.cap = normalizeCapacity(capacity);
  }

  /** Samples this ring may hold. Read-only from the outside: the ONLY way to
   * change it is setCapacity, which enforces the new bound immediately. */
  get capacity(): number {
    return this.cap;
  }

  /**
   * Adopt the capacity the CURRENT policy asks for, enforcing it on the spot.
   *
   * WHY THIS EXISTS. The capacity used to be fixed at construction, so a policy
   * that changed while a graph was alive was simply never applied. Turning
   * pre-warm on during a press left the microphone open - for the entire
   * session, in "always" mode - behind a ring built at zero capacity: lit,
   * warm, and holding nothing it could ever prepend to a dictation. The
   * opposite direction is worse: turning the pre-roll DOWN has to erase what is
   * already held above the new bound, and "at the next release" is not an
   * acceptable answer for a privacy bound.
   *
   * Rebuilding the audio graph on a policy change would fix the same bug, and
   * was rejected: it drops the very microphone this feature exists to keep
   * open, and it does so through a call to the OS that can fail - trading a
   * bookkeeping bug for a latency regression and a new failure mode. A resize
   * cannot fail, and it shrinks synchronously.
   */
  setCapacity(capacity: number): void {
    this.cap = normalizeCapacity(capacity);
    this.trim();
  }

  push(frame: Float32Array): void {
    if (this.cap <= 0 || frame.length === 0) return;
    this.frames.push(frame);
    this.total += frame.length;
    this.trim();
  }

  /** Drop the OLDEST audio until the ring is back inside its bound. Shared by
   * push and setCapacity so "never exceeds its capacity" has exactly one
   * implementation to be right. */
  private trim(): void {
    if (this.cap <= 0) {
      this.clear();
      return;
    }
    while (this.total > this.cap) {
      const excess = this.total - this.cap;
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
