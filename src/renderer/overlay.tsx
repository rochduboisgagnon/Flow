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
import { PcmRing, preRollSamples } from "../shared/micWarmth";

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
 * The graph is created and destroyed as ONE unit, deliberately: keeping the
 * AudioContext alive across releases would save another 10-100 ms per press,
 * but a context outlives the audio device it was bound to, and a context whose
 * output device disappeared can stop pulling render quanta - which would show
 * up as a capture that succeeds and contains nothing. This project has already
 * paid for that class of bug once (U4). The microphone's lifetime and the
 * graph's lifetime are the same lifetime.
 */
interface MicGraph {
  ctx: AudioContext;
  stream: MediaStream;
  /** Held, not just connected. Our worklet node is never wired to
   * ctx.destination (this window captures, it never plays), so the spec's
   * "playing reference" that normally keeps a source node alive does not apply
   * to it. That was survivable while a graph lasted one keypress; a graph that
   * now lives for seconds - or, in "always" mode, for the session - must not
   * depend on the garbage collector's opinion of an unreferenced node. */
  src: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  /** The device this graph was opened for; a different choice releases it. */
  micDeviceId: string;
  /** Pre-roll. Capped at preRollMs of audio BY CONSTRUCTION (PcmRing), memory
   * only, drained into a capture or erased - never written anywhere. */
  ring: PcmRing;
  /** Non-null while a dictation is capturing into it. */
  sink: Float32Array[] | null;
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
    // B2: the pre-warm policy main last pushed. Null = the user turned it off,
    // which is enforced rather than merely obeyed: the ring is built with zero
    // capacity, so there is no buffered audio to hold, clear or forget.
    let policy: CaptureWarmPayload | null = null;
    let releaseTimer: number | undefined;

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
        const g: MicGraph = {
          ctx,
          stream,
          src: ctx.createMediaStreamSource(stream),
          node: new AudioWorkletNode(ctx, "agrflow-capture"),
          micDeviceId: deviceId,
          ring: new PcmRing(preRollSamples(policy?.preRollMs ?? 0, SAMPLE_RATE)),
          sink: forCapture ? [] : null,
        };
        g.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          const frame = ev.data;
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
      g.ring.clear(); // the pre-roll never outlives the microphone that filled it
      g.node.port.onmessage = null;
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
     * setting takes effect at the end of that press, through armRelease. */
    function applyWarm(next: CaptureWarmPayload | null): void {
      policy = next;
      if (mic && mic.sink !== null) return; // a capture owns it; decided at its end
      if (!next) {
        releaseMic();
        return;
      }
      if (mic && mic.micDeviceId !== next.micDeviceId) releaseMic();
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
      // getUserMedia, no AudioContext, no worklet compile between the key and
      // the first recorded sample. And its ring already holds the half-second
      // BEFORE the key went down, which is what makes the first word
      // unloseable rather than merely fast.
      if (mic && mic.sink === null && mic.micDeviceId === wanted) {
        const seed = mic.ring.drain();
        mic.sink = seed;
        if (seed.length > 0) {
          timing.sampleMs = 0; // audio covering the keypress was already in hand
          reportTiming();
        }
        setPhase("listening");
        return;
      }
      // Warm for a microphone the user no longer wants (or, defensively, a
      // graph left capturing): drop it rather than dictate through it.
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
