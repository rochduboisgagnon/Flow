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
import type { CaptureStartPayload } from "../shared/ipcContracts";

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

// Audible start/stop cues (plan 5.9): know it is listening without looking.
// v5 chantier 5: audible start/stop cues removed entirely (Roch: no noise at all).

type Phase = "idle" | "listening" | "transcribing" | "error";

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
// R2: the same emerald AGR gradient as AGR Pilot's ribbon (kept in sync).
const RIBBON_STOPS = ["#17e0a8", "#34e3a0", "#21c9d6", "#2ec7a0", "#7ef0c8"];

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
      ctx.globalCompositeOperation = "lighter"; // additive: filaments bloom where they cross
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
      style={{ width: 216, height: 40, display: "block" }}
      aria-hidden
    />
  );
}

function Overlay() {
  const [phase, setPhase] = useState<Phase>("idle");
  const levelRef = useRef(0); // written per audio frame, read by the ribbon rAF
  const sessionRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    chunks: Float32Array[];
  } | null>(null);

  useEffect(() => {
    const api = window.agrflow;
    // Cancellation token for the async start(). getUserMedia can take hundreds
    // of ms; a 300 ms press can legitimately release BEFORE the mic is ready.
    // Without this, that stop() found no session yet and the capture finished
    // establishing itself afterwards: a hidden, hot microphone accumulating
    // audio that nothing would ever stop - the exact opposite of this product.
    // teardown() bumps the generation; start() re-checks it after every await.
    let gen = 0;

    async function start(cfg?: CaptureStartPayload) {
      const my = ++gen;
      let stream: MediaStream | null = null;
      let ctx: AudioContext | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // "ideal": a picked-then-unplugged microphone silently falls back
            // to the system default instead of failing the capture.
            ...(cfg?.micDeviceId ? { deviceId: { ideal: cfg.micDeviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (my !== gen) {
          stream.getTracks().forEach((t) => t.stop());
          return; // stop/cancel raced us: nothing was captured, nothing is kept
        }
        // Chromium resamples the device rate to the context rate: asking the
        // context for 16 kHz gives us ASR-ready PCM with zero conversion step.
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        await ctx.audioWorklet.addModule(
          URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })),
        );
        if (my !== gen) {
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          return;
        }
        const src = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "agrflow-capture");
        const chunks: Float32Array[] = [];
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          chunks.push(ev.data);
          // RMS of the latest frame drives the ribbon's amplitude (5.7).
          let sum = 0;
          for (let i = 0; i < ev.data.length; i++) sum += ev.data[i] * ev.data[i];
          levelRef.current = Math.min(1, Math.sqrt(sum / ev.data.length) * 6);
        };
        src.connect(node);
        // No connection to ctx.destination: capture only, never playback.
        sessionRef.current = { ctx, stream, chunks };
        setPhase("listening");
      } catch (err) {
        // A later step can throw AFTER the stream is live: never leak a hot mic.
        stream?.getTracks().forEach((t) => t.stop());
        void ctx?.close();
        setPhase("error");
        api.sendCaptureError(String(err));
      }
    }

    function teardown(): Float32Array[] {
      gen++; // invalidate any start() still awaiting its microphone
      const s = sessionRef.current;
      sessionRef.current = null;
      levelRef.current = 0;
      if (!s) return [];
      const chunks = s.chunks;
      s.stream.getTracks().forEach((t) => t.stop());
      void s.ctx.close();
      return chunks;
    }

    let lastCfg: CaptureStartPayload | undefined;

    function stop() {
      const chunks = teardown();
      setPhase("transcribing"); // the overlay stays up until main says flowDone
      const pcm = floatTo16BitPcm(chunks);
      chunks.length = 0; // release every audio reference immediately
      const wav = encodeWav(pcm);
      api.sendCaptureDone(wav.buffer as ArrayBuffer, durationMs(pcm.length));
    }

    function cancel() {
      teardown(); // chunks go out of scope unconsumed: nothing leaves this window
      setPhase("idle");
    }

    api.onCaptureCommand((cmd, cfg) => {
      if (cmd === "start") {
        lastCfg = cfg;
        void start(cfg);
      } else if (cmd === "stop") stop();
      else if (cmd === "cancel") cancel();
    });

  }, []);

  return (
    <div
      style={{
        // Plan v3 chantier 3: frosted-glass pill. Translucency is the alpha of a
        // white gradient (backdrop-filter can't blur the desktop behind a
        // transparent Electron window); the inset top highlight + soft shadow
        // read as glass. Bigger + more imposing than v2 (Roch).
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 40,
        padding: "0 17px",
        borderRadius: 20,
        background: "linear-gradient(180deg, rgba(14,17,22,0.82), rgba(10,12,16,0.72))",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.06)",
        backdropFilter: "blur(16px) saturate(1.2)",
        WebkitBackdropFilter: "blur(16px) saturate(1.2)",
        color: "#e9ecf0",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontSize: 8.9, // R8: text -15%
        width: "fit-content",
        margin: "7px auto",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: phase === "error" ? "#ff6b6b" : "#34e3a0",
          boxShadow: phase === "listening" ? "0 0 8px rgba(52, 227, 160, 0.75)" : "none",
          flexShrink: 0,
        }}
      />
      {phase === "error" ? (
        <span>Microphone unavailable</span>
      ) : (
        <>
          <Ribbon levelRef={levelRef} phase={phase} />
          {phase === "transcribing" && (
            <span style={{ color: "#9aa0a8" }}>Transcribing...</span>
          )}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
