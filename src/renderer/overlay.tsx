// Dictation overlay: a small always-on-top pill shown while the PTT key is
// held. It ALSO owns the microphone capture (getUserMedia lives in a renderer),
// accumulating 16 kHz Float32 chunks in local variables only. On stop, the WAV
// goes to the main process and every local reference is dropped: the "nothing
// is ever stored" rule starts here.
//
// Visual (plan v3 chantier 3): the validated prototype ribbon - thin DARK
// strands (rgba(40,40,40)), length 0.80, crest slightly left - on a FROSTED
// GLASS pill (translucent white, see-through, Roch), bigger/more imposing than
// v2. Amplitude follows the mic; during transcription it flattens to a wire.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { floatTo16BitPcm, encodeWav, durationMs, SAMPLE_RATE } from "../shared/wav";
import type { CaptureStartPayload, CaptureWarmPayload } from "../shared/ipcContracts";
import {
  PcmRing,
  preRollSamples,
  mayAdoptWarmGraph,
  resolveWantedDevice,
  type DeviceIdentity,
  type WarmGraphVitals,
} from "../shared/micWarmth";

// The worklet forwards raw input frames to the page. Inlined via Blob so no
// extra bundler entry or asset path is needed.
const WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("agrflow-capture", CaptureProcessor);
`;

// House-made start/stop cues (opt-in via the `sounds` setting; the v5 removal is
// reinstated 2026-07-23 at Roch's request, but as an ORIGINAL synthesized blip -
// no third-party audio). A soft sine "blip" with a fast attack and quick decay,
// ~180 ms: HIGHER for start (A5 gliding down), LOWER for stop (D5 -> A4), echoing
// the Wispr convention (high = go, low = done) without shipping its files. Web
// Audio only, no asset. A cue must NEVER break capture, so it is all best-effort.
let cueCtx: AudioContext | null = null;
function playCue(kind: "start" | "stop"): void {
  try {
    if (!cueCtx) cueCtx = new AudioContext();
    const ctx = cueCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    const [f0, f1] = kind === "start" ? [880, 784] : [587, 440]; // A5->G5 / D5->A4
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + 0.16);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.11, t + 0.012); // soft fast attack (tunable)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18); // quick decay
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    /* audio output unavailable (rare): dictation just continues silently */
  }
}

type Phase = "idle" | "listening" | "transcribing" | "error";

// ---- B2/B1: the two §3.3 budgets only this process can answer ----
//
// B1 could time everything up to "the order left the main process" and then hit
// a wall: "first animation frame painted" and "microphone actually capturing"
// both happen in HERE, and this renderer's performance.now() has a different
// origin from main's. Comparing the two would not be imprecise, it would be
// wrong.
//
// So this measures DURATIONS from one instant it owns - the arrival of
// CAPTURE_START - and sends two plain numbers. Main adds them to the instant it
// recorded for that same message (hotpath.markOverlayTimings). Nothing here
// ever reads main's clock, and nothing in main ever reads this one.
//
// Module scope because the two halves of the measurement live in two different
// components: the paint is observed inside the ribbon's animation loop, the
// first sample inside the capture graph's frame handler. One press, one object,
// one message when both are known.
interface CaptureTiming {
  startedAt: number; // performance.now() when CAPTURE_START arrived
  paintMs: number | null;
  sampleMs: number | null;
  sent: boolean;
}
let timing: CaptureTiming | null = null;

function reportTiming(): void {
  if (!timing || timing.sent || timing.paintMs === null || timing.sampleMs === null) return;
  timing.sent = true;
  try {
    window.agrflow.sendCaptureTiming({ firstPaintMs: timing.paintMs, firstSampleMs: timing.sampleMs });
  } catch {
    /* diagnostics must never be able to break a dictation: a lost measurement
       is a blank cell in a panel, and that is the whole cost of this catch */
  }
}

/**
 * B2: the live microphone graph. ONE object with two modes, which is the point
 * of the whole task: `sink === null` means warm-but-idle (frames go to the
 * bounded pre-roll ring and nowhere else), `sink !== null` means a dictation is
 * capturing into it. A press between two dictations therefore does not build
 * anything - it flips this field and drains the ring.
 *
 * The graph is created and destroyed as ONE unit, deliberately: a context
 * outlives the audio device it was bound to, and a context whose device
 * disappeared can stop pulling render quanta - which shows up as a capture that
 * succeeds and contains nothing. This project has already paid for that class
 * of bug once (U4).
 *
 * B2 REVISED. The sentence that used to close this note - "the microphone's
 * lifetime and the graph's lifetime are the same lifetime" - was TRUE while a
 * graph was born and died inside one keypress, and B2 made it false without
 * touching the guard that leaned on it. A graph now outlives its press, so the
 * two lifetimes can diverge, and the only honest response is to stop assuming
 * and start CHECKING: the four fields below (`ended`, the track, the context's
 * state, `lastFrameAt`) exist so that "this graph is a working microphone" is
 * something Flow verifies before every adoption instead of something it
 * inherits from the fact that the object still exists.
 */
interface MicGraph {
  ctx: AudioContext;
  stream: MediaStream;
  /** The ONE audio track, held so both its liveness (`readyState`, `muted`,
   * `onended`) and its IDENTITY can be read from the device itself. */
  track: MediaStreamTrack;
  /** Held, not just connected. Our worklet node is never wired to
   * ctx.destination (this window captures, it never plays), so the spec's
   * "playing reference" that normally keeps a source node alive does not apply
   * to it. That was survivable while a graph lasted one keypress; a graph that
   * now lives for seconds - or, in "always" mode, for the session - must not
   * depend on the garbage collector's opinion of an unreferenced node. */
  src: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  /** The SETTING this graph was opened for ("" = "the system default"). Answers
   * "did the user pick a different microphone" and nothing else - see `device`
   * for the question it CANNOT answer. */
  wantedDeviceId: string;
  /** The REAL device the track bound to, snapshotted from the track at open
   * time. `wantedDeviceId` stays "" while Windows swaps the device behind the
   * word "default"; this does not. */
  device: DeviceIdentity;
  /** Pre-roll. Capped at the CURRENT policy's preRollMs of audio (PcmRing, and
   * resized by applyWarm when the policy changes under a live graph), memory
   * only, drained into a capture or erased - never written anywhere. */
  ring: PcmRing;
  /** Non-null while a dictation is capturing into it. */
  sink: Float32Array[] | null;
  /** Sticky: the track ended, the context closed, or this graph was released.
   * A dead graph is never resurrected, only replaced. */
  ended: boolean;
  /** performance.now() of the last frame this graph delivered, seeded with the
   * instant it opened. A graph that has stopped rendering is dead in the only
   * way the user would ever notice. */
  lastFrameAt: number;
}

/** What the adoption rule (shared/micWarmth.ts) needs to see, read off the live
 * objects at the moment of the question - never cached, because every one of
 * these can change without anything telling us. */
function vitalsOf(g: MicGraph): WarmGraphVitals {
  return {
    ended: g.ended,
    trackReadyState: g.track.readyState,
    trackMuted: g.track.muted,
    contextState: g.ctx.state,
    msSinceLastFrame: performance.now() - g.lastFrameAt,
  };
}

// Microphone enumeration for the Manager's settings view (device labels only
// exist after one granted getUserMedia; grab a stream for a moment, list,
// release). Called by main via executeJavaScript: keep it on the main world.
(window as unknown as Record<string, unknown>).__agrflowListMics = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    stream.getTracks().forEach((t) => t.stop());
    return devices
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d) => ({ id: d.deviceId, label: d.label || "Microphone" }));
  } catch {
    return [];
  }
};

// ---- Listening ribbon (ported from prototype-animation-ecoute.html) ----

interface Strand {
  amp: number;
  freq: number;
  phase: number;
  speed: number;
  bob: number;
  alpha: number;
  sign: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeStrands(n: number): Strand[] {
  const r = rng(20260702); // deterministic: same ribbon every session
  const arr: Strand[] = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      amp: 0.20 + 0.80 * Math.pow(r(), 1.5), // R2: fewer, fuller filaments
      freq: 0.85 + r() * 1.7,
      phase: r() * Math.PI * 2,
      speed: 0.55 + r() * 0.9,
      bob: r() * 2 - 1,
      alpha: 0.55 + 0.45 * r(),
      sign: r() < 0.5 ? -1 : 1,
    });
  }
  return arr;
}

const RIBBON = {
  lengthScale: 0.86, // R2: emerald filament span
  strandCount: 6, // R2: six fuller filaments (was 30 thin ones)
  skew: 0.86, // crest slightly left of center
  baseSpeed: 0.55,
};
// Solid AGR-site amber ribbon (Roch 2026-07-22: "un orange, pas un orange fluo"). The site accent is
// --brand #b9762a with --brand-2 #9c6222 as its deep tone; the ramp stays INSIDE that amber family
// (no bright peak like the old #db8434) and compositing is NORMAL, not additive - see the draw loop.
// Flow's OWN signature; the Pilot composer ribbon follows the chosen theme separately.
const RIBBON_STOPS = ["#9c6222", "#b9762a", "#c07f30", "#b9762a", "#9c6222"];

function Ribbon({
  levelRef,
  phase,
}: {
  levelRef: React.MutableRefObject<number>;
  phase: Phase;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;
    const strands = makeStrands(RIBBON.strandCount);
    let raf = 0;
    let activation = 0; // 0..1, eased
    let level = 0; // smoothed mic level
    let prevPhase = ""; // to snap activation up on the rising edge into "listening"

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const maxAmp = H * 0.34; // R2: proportional to height (parity with AGR Pilot)
    const spanW = W * RIBBON.lengthScale;
    const x0 = (W - spanW) / 2;
    const grad = ctx.createLinearGradient(x0, 0, x0 + spanW, 0);
    RIBBON_STOPS.forEach((s, i) => grad.addColorStop(i / (RIBBON_STOPS.length - 1), s));

    const draw = (now: number) => {
      const t = now / 1000;
      const p = phaseRef.current;
      // Snap to a visible amplitude the instant listening begins, so even a very short press
      // shows the ribbon at once instead of ramping up from flat (~0.5 s) - which, on a brief
      // show, meant the user saw nothing appear.
      if (p === "listening" && prevPhase !== "listening") {
        activation = Math.max(activation, 0.62);
        // B1/B2: THIS is "press -> first animation frame" (§3.3, budget 50 ms).
        // Taken on the rising edge into listening, inside the rAF callback that
        // is about to draw the first visibly-active ribbon - the standard proxy
        // for a painted frame, and honest about being one: the compositor still
        // has to put it on screen after this line returns.
        if (timing && timing.paintMs === null) {
          timing.paintMs = now - timing.startedAt;
          reportTiming();
        }
      }
      prevPhase = p;
      // Listening: amplitude follows the mic (a breathing floor keeps it visible
      // between words). Transcribing: a calmer breathing wire. Idle: still present.
      level += (levelRef.current - level) * 0.25;
      const target =
        p === "listening"
          ? 0.45 + 0.55 * Math.min(1, level * 1.7)
          : p === "transcribing"
            ? 0.3
            : 0.28;
      activation += (target - activation) * 0.08;

      ctx.clearRect(0, 0, W, H);
      const midY = H / 2;
      const steps = 90;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = grad;
      // Normal (source-over) compositing: overlapping strands stay a solid amber instead of
      // summing toward yellow-white. The old additive "lighter" blend was exactly the neon
      // bloom Roch asked to drop ("un orange, pas un orange fluo", 2026-07-22).
      for (const s of strands) {
        const trace = () => {
          ctx.beginPath();
          for (let k = 0; k <= steps; k++) {
            const tt = k / steps;
            const x = x0 + tt * spanW;
            const env = Math.pow(Math.sin(Math.PI * Math.pow(tt, RIBBON.skew)), 1.12);
            const wave = Math.sin(tt * s.freq * Math.PI * 2 + s.phase + t * s.speed * 1.2);
            const bob = Math.sin(t * 0.45 + s.phase) * 0.32 * s.bob;
            const y = midY + env * (maxAmp * activation) * (s.amp * s.sign * wave * 0.9 + bob);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        };
        trace();
        ctx.globalAlpha = 0.1;
        ctx.lineWidth = 3.4;
        ctx.stroke(); // wide low-alpha halo
        trace();
        ctx.globalAlpha = Math.min(1, (0.42 + 0.42 * activation) * s.alpha);
        ctx.lineWidth = 1.3;
        ctx.stroke(); // bright core
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return (
    <canvas
      ref={canvasRef}
      // 2026-07-23: the ribbon now lives INSIDE a pill (see Overlay), so it carries no
      // drop-shadow of its own - the pill is its backdrop and reads on any desktop. maxAmp =
      // H*0.34 and the span follow the canvas, so the ribbon just scales. Keep OVERLAY_W/H in
      // main/overlay.ts in step: the window must hold the pill (canvas + padding) plus its shadow.
      style={{ width: 92, height: 18, display: "block" }}
      aria-hidden
    />
  );
}

function Overlay() {
  const [phase, setPhase] = useState<Phase>("idle");
  const levelRef = useRef(0); // written per audio frame, read by the ribbon rAF
  const soundsOn = useRef(false); // this capture's opt-in cue flag (start plays now, stop later)

  useEffect(() => {
    const api = window.agrflow;
    // Cancellation token for every async microphone acquisition (a capture's,
    // and B2's pre-warm). getUserMedia can take hundreds of ms; a 300 ms press
    // can legitimately release BEFORE the mic is ready. Without this, that
    // stop() found no session yet and the capture finished establishing itself
    // afterwards: a hidden, hot microphone accumulating audio that nothing
    // would ever stop - the exact opposite of this product. Every path that
    // ends a graph's life bumps the generation; openMic() re-checks it after
    // every await.
    let gen = 0;
    // B2: the live graph, warm or capturing (see MicGraph). Null = the
    // microphone is closed and Windows' indicator is off.
    let mic: MicGraph | null = null;
    // B2: the pre-warm policy main last pushed. Null means "no warm
    // microphone", and it is enforced rather than merely obeyed: applying it
    // closes the device on the spot and erases the pre-roll, and any ring built
    // while it holds has zero capacity - so there is no buffered audio to hold,
    // clear or forget. It is also the channel an OUTSIDE order arrives on (the
    // lock screen, sleep, the tray's pause), which is why nothing about it may
    // ever be deferred to a timer.
    let policy: CaptureWarmPayload | null = null;
    let releaseTimer: number | undefined;
    // What the CURRENT policy's micDeviceId resolves to on this machine right
    // now, or null while Flow does not know (device ids are blank until one
    // getUserMedia has been granted, and enumerateDevices can throw). Refreshed
    // off the hot path only: after each open, and on every devicechange - which
    // is the event that reports the one change no track-level signal ever
    // will, Windows swapping its default input.
    let resolvedDevice: DeviceIdentity | null = null;

    async function refreshResolvedDevice(): Promise<void> {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        resolvedDevice = resolveWantedDevice(devices, policy?.micDeviceId ?? mic?.wantedDeviceId ?? "");
      } catch {
        // Not knowing is a state, and it is handled where it matters: the
        // adoption rule skips the device comparison rather than guessing, which
        // degrades to the setting-only behaviour and never to a false match.
        resolvedDevice = null;
      }
    }

    /** B2 revised: the ONE rule that decides whether a warm graph is still a
     * working microphone, asked from the two places that need it - the press
     * that would adopt it, and the policy push that would keep it open. Two
     * answers to that question is exactly how the first version got a dead
     * graph adopted for the rest of a session. */
    function graphStillFits(g: MicGraph, wantedDeviceId: string): boolean {
      return mayAdoptWarmGraph({
        graphWantedDeviceId: g.wantedDeviceId,
        graphDevice: g.device,
        wantedDeviceId,
        resolved: resolvedDevice,
        vitals: vitalsOf(g),
      });
    }

    /** B2: open the microphone and build the graph. `forCapture` decides which
     * mode it is born in - a press builds it already capturing, a pre-warm
     * builds it idle with only the ring behind it. */
    async function openMic(deviceId: string, forCapture: boolean): Promise<void> {
      const my = gen; // the caller bumped it; anything that bumps it again wins
      let stream: MediaStream | null = null;
      let ctx: AudioContext | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // "ideal": a picked-then-unplugged microphone silently falls back
            // to the system default instead of failing the capture.
            ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (my !== gen) {
          stream.getTracks().forEach((t) => t.stop());
          return; // stop/cancel/release raced us: nothing was captured, nothing is kept
        }
        // Chromium resamples the device rate to the context rate: asking the
        // context for 16 kHz gives us ASR-ready PCM with zero conversion step.
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (ctx.state === "suspended") {
          // A context that starts suspended pulls no render quanta: the graph
          // would look perfect and capture silence. The overlay window sets
          // autoplayPolicy "no-user-gesture-required" precisely so this does not
          // happen - but "should not" is not "cannot", so ask anyway, and let
          // the adoption gate refuse whatever stayed asleep.
          void ctx.resume().catch(() => {
            /* refused: the graph fails its vitals and the cold path takes over */
          });
        }
        const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        try {
          await ctx.audioWorklet.addModule(workletUrl);
        } finally {
          URL.revokeObjectURL(workletUrl); // one blob URL leaked per dictation otherwise
        }
        if (my !== gen) {
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          return;
        }
        const track = stream.getAudioTracks()[0];
        // A stream with no audio track is not a microphone, however healthy it
        // looks. Failing here routes it through the catch below, which stops
        // everything and reports - instead of installing a graph that would
        // pass every later check and record nothing.
        if (!track) throw new Error("the microphone stream carried no audio track");
        const bound = track.getSettings();
        const g: MicGraph = {
          ctx,
          stream,
          track,
          src: ctx.createMediaStreamSource(stream),
          node: new AudioWorkletNode(ctx, "agrflow-capture"),
          wantedDeviceId: deviceId,
          device: { deviceId: bound.deviceId ?? "", groupId: bound.groupId ?? "" },
          ring: new PcmRing(preRollSamples(policy?.preRollMs ?? 0, SAMPLE_RATE)),
          sink: forCapture ? [] : null,
          ended: false,
          lastFrameAt: performance.now(),
        };
        // Hear the death rather than discover it. A device can go away under a
        // graph that is otherwise perfectly healthy - headset unplugged, audio
        // service restarted, another app taking it exclusively - and before B2
        // that was unreachable, because a graph could not outlive the keypress
        // that built it. Now it can, so the end of the device has to arrive as
        // an event, not as a surprise at the next press.
        track.onended = () => {
          g.ended = true;
          if (mic !== g || g.sink !== null) return; // a live capture is ended by its own path
          releaseMic();
          applyWarm(policy); // reopen on whatever the setting names now, or stay closed
        };
        ctx.onstatechange = () => {
          // A context that stopped running renders no quanta: the capture would
          // succeed and be empty. Suspended is recoverable, closed is not.
          if (g.ctx.state === "closed") g.ended = true;
          else if (g.ctx.state === "suspended") {
            void g.ctx.resume().catch(() => {
              g.ended = true;
            });
          }
        };
        g.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          const frame = ev.data;
          // Proof of life, stamped before anything decides what to do with the
          // audio: frames are what the graph DOES, where readyState and
          // AudioContext.state are only what it says.
          g.lastFrameAt = performance.now();
          if (!g.sink) {
            // Warm but idle. The ONLY thing that happens to this audio is a
            // bounded ring in memory: it is not levelled, not analysed, not
            // encoded, not sent anywhere, and it is erased the moment the graph
            // is released or a capture drains it.
            g.ring.push(frame);
            return;
          }
          g.sink.push(frame);
          // B1/B2: "press -> microphone actually capturing" (§3.3, budget
          // 80 ms) for a COLD start - the first frame that reaches this
          // capture. A warm start answers 0 in start() below, because the
          // pre-roll already holds the audio from before the keypress.
          if (timing && timing.sampleMs === null) {
            timing.sampleMs = performance.now() - timing.startedAt;
            reportTiming();
          }
          // RMS of the latest frame drives the ribbon's amplitude (5.7).
          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          levelRef.current = Math.min(1, Math.sqrt(sum / frame.length) * 6);
        };
        // No connection to ctx.destination: capture only, never playback.
        g.src.connect(g.node);
        mic = g;
        // Device ids are blank until a getUserMedia has been granted, which
        // just happened: this is the cheapest moment to learn what "" resolves
        // to on this machine. Fire-and-forget - nothing on the press path waits
        // for it, and an unknown resolution is a handled state.
        void refreshResolvedDevice();
        if (forCapture) setPhase("listening");
      } catch (err) {
        // A later step can throw AFTER the stream is live: never leak a hot mic.
        stream?.getTracks().forEach((t) => t.stop());
        void ctx?.close();
        // A PRE-WARM that cannot open the microphone is not an error the user
        // needs to be told about: nothing was asked for and nothing is lost.
        // The next real press reports it, exactly as it did before B2.
        if (!forCapture) return;
        setPhase("error");
        api.sendCaptureError(String(err));
      }
    }

    /** B2: close the microphone NOW. The one place Windows' indicator goes out,
     * and the one place the pre-roll is erased for good. */
    function releaseMic(): void {
      gen++; // a getUserMedia still in flight must not install itself afterwards
      window.clearTimeout(releaseTimer);
      releaseTimer = undefined;
      const g = mic;
      mic = null;
      if (!g) return;
      g.sink = null;
      g.ended = true; // whatever still holds a reference must not adopt this
      g.ring.clear(); // the pre-roll never outlives the microphone that filled it
      g.node.port.onmessage = null;
      // Both listeners fire DURING the teardown two lines down (stop() ends the
      // track, close() closes the context). Left attached, a graph that is
      // already gone would ask for a replacement it no longer has any business
      // asking for.
      g.track.onended = null;
      g.ctx.onstatechange = null;
      g.stream.getTracks().forEach((t) => t.stop());
      void g.ctx.close();
    }

    /** B2: hand the microphone back to the pre-warm policy after a dictation -
     * or close it, when there is no policy. */
    function armRelease(): void {
      window.clearTimeout(releaseTimer);
      releaseTimer = undefined;
      if (!policy) {
        releaseMic(); // pre-warm off: the mic is only ever open while holding
        return;
      }
      if (policy.holdMs === null) return; // "always": kept for as long as Flow runs
      releaseTimer = window.setTimeout(() => {
        releaseTimer = undefined;
        releaseMic();
      }, policy.holdMs);
    }

    /** B2: main pushed a new pre-warm policy (or, with null, told us to cool
     * down). Never touches a microphone a dictation is currently using: the
     * setting takes effect at the end of that press, through endCapture's
     * re-apply. */
    function applyWarm(next: CaptureWarmPayload | null): void {
      policy = next;
      if (mic && mic.sink !== null) return; // a capture owns it; decided at its end
      if (!next) {
        // A null policy is an ORDER, not a preference: release NOW. Main sends
        // it when the user turns pre-warm off, and it is the channel any other
        // "stop listening" has to use - the lock screen, sleep, the tray's
        // "pause dictation". Nothing here is deferred to a timer: releaseMic
        // clears the pending one, closes the device and erases the pre-roll on
        // this very tick, so Windows' microphone indicator goes out as part of
        // the gesture rather than some seconds after it.
        releaseMic();
        return;
      }
      // The pre-roll's capacity follows the CURRENT policy, not the one that
      // happened to be in force when the graph was built. Turning pre-warm on
      // during a press used to leave the microphone open - for the whole
      // session, in "always" - behind a ring built at zero capacity: warm, lit,
      // and holding nothing. Resizing also SHRINKS on the spot, which is what a
      // privacy bound has to do; rebuilding the graph would achieve the same
      // but by dropping the very microphone this feature exists to keep, and
      // through a call to the OS that can fail.
      if (mic) mic.ring.setCapacity(preRollSamples(next.preRollMs, SAMPLE_RATE));
      // The SAME rule the press uses (graphStillFits): a graph nobody could
      // dictate through - wrong device, ended track, stopped context, no frames
      // - is not a warm microphone, it is a device handle held for nothing.
      if (mic && !graphStillFits(mic, next.micDeviceId)) releaseMic();
      if (!mic) {
        gen++;
        void openMic(next.micDeviceId, false);
      }
      armRelease();
    }

    function start(cfg?: CaptureStartPayload) {
      gen++; // any acquisition still in flight belongs to a previous press
      // Play the "go" cue on the KEYPRESS, before the getUserMedia latency, so it is
      // instant. Remember the flag for the matching stop cue on release.
      soundsOn.current = !!cfg?.sounds;
      if (soundsOn.current) playCue("start");
      timing = { startedAt: performance.now(), paintMs: null, sampleMs: null, sent: false };
      const wanted = cfg?.micDeviceId ?? "";
      window.clearTimeout(releaseTimer);
      releaseTimer = undefined;
      // B2, THE POINT OF THE TASK: a microphone kept warm by the previous
      // dictation (or by the startup warm-up) is adopted SYNCHRONOUSLY - no
      // acquisition, no AudioContext, no worklet compile between the key and
      // the first recorded sample. And its ring already holds the half-second
      // BEFORE the key went down, which is what makes the first word
      // unloseable rather than merely fast.
      //
      // graphStillFits is the whole revision: warmth is no longer inferred from
      // the object existing, it is PROVEN on the spot - a track that is still
      // live and unmuted, a context that is still running, frames that are
      // still arriving, and the device the setting names RIGHT NOW rather than
      // the string it was opened with. Everything it rejects falls through to
      // the cold path below, which self-heals by re-asking the OS.
      if (mic && mic.sink === null && graphStillFits(mic, wanted)) {
        const seed = mic.ring.drain();
        mic.sink = seed;
        if (seed.length > 0) {
          timing.sampleMs = 0; // audio covering the keypress was already in hand
          reportTiming();
        }
        setPhase("listening");
        return;
      }
      // Warm for a microphone the user no longer wants, or one Flow can no
      // longer vouch for (or, defensively, a graph left capturing): drop it
      // rather than dictate through it.
      if (mic) releaseMic();
      gen++;
      void openMic(wanted, true);
    }

    /** End the capture and hand back what it recorded. With pre-warm on the
     * graph SURVIVES - still open, ring refilling - for the policy's hold
     * window; with it off, everything is closed exactly as it was before B2. */
    function endCapture(): Float32Array[] {
      gen++; // invalidate any acquisition still awaiting its microphone
      levelRef.current = 0;
      timing = null; // this press's measurements are over, sent or not
      const g = mic;
      const chunks = g?.sink ?? [];
      if (g) {
        g.sink = null;
        g.ring.clear(); // what seeded this capture is consumed, never kept twice
      }
      // Re-APPLY the policy rather than merely arm its timer. It settles two
      // cases a bare armRelease() would get wrong: a press that released before
      // its microphone ever opened (no graph to hold, but the next press should
      // still find a warm one), and a policy that changed DURING the press -
      // including a change of microphone, which applyWarm defers precisely
      // because it must never take a device away from a live dictation.
      applyWarm(policy);
      return chunks;
    }

    function stop() {
      if (soundsOn.current) playCue("stop");
      const chunks = endCapture();
      setPhase("transcribing"); // the overlay stays up until main says flowDone
      const pcm = floatTo16BitPcm(chunks);
      chunks.length = 0; // release every audio reference immediately
      const wav = encodeWav(pcm);
      api.sendCaptureDone(wav.buffer as ArrayBuffer, durationMs(pcm.length));
    }

    function cancel() {
      endCapture(); // chunks go out of scope unconsumed: nothing leaves this window
      setPhase("idle");
    }

    api.onCaptureCommand((cmd, cfg) => {
      if (cmd === "start") {
        start(cfg);
      } else if (cmd === "stop") stop();
      else if (cmd === "cancel") cancel();
    });
    api.onCaptureWarm(applyWarm);

    // The one event that reports what NO track-level signal ever will: Windows
    // switched its default input. An open track does not migrate - it goes on
    // feeding the microphone it was bound to, in perfect health - so a graph
    // opened for the default ("" in the setting) silently becomes a graph on
    // the old device, and every later press would keep dictating into it.
    // Re-resolve, then hand the decision to the same rule as everywhere else.
    const onDeviceChange = () => {
      void refreshResolvedDevice().then(() => {
        if (mic && mic.sink !== null) return; // a live dictation is never disturbed
        applyWarm(policy);
      });
    };
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
      releaseMic(); // this window going away must never leave a microphone open
    };
  }, []);

  return (
    // 2026-07-23 (Roch): the ribbon sits in a horizontal PILL - a stadium with fully circular
    // ends, Wispr-style - but in the AGR charte: a near-black translucent pill with the amber
    // ribbon inside (colour unchanged). The wrapper only centers it; the error state keeps its
    // own matching chip (errors are rare).
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontSize: 10.7, // C1 (v15): text +20% (R8 had shrunk it value-by-value)
      }}
    >
      {phase === "error" ? (
        <span
          style={{
            color: "#f4f1ec", // warm off-white (charte)
            background: "rgba(20,18,15,0.86)", // near-black, faintly warm (charte noir)
            border: "1px solid #b9762a", // the single amber accent (--brand)
            borderRadius: 999, // stadium ends, matched to the ribbon pill
            padding: "5px 13px",
            fontWeight: 500,
            boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
          }}
        >
          Microphone unavailable
        </span>
      ) : (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "5px 16px", // slim vertical breathing room (Roch: ~30% shorter pill)
            background: "rgba(20,18,15,0.82)", // charte near-black, faintly warm
            borderRadius: 999, // stadium: fully circular ends (the Wispr shape)
            boxShadow: "0 2px 10px rgba(0,0,0,0.45)", // lifts off a light desktop
          }}
        >
          <Ribbon levelRef={levelRef} phase={phase} />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
