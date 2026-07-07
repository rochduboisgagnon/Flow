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
// Synthesized on the fly (two-tone blips), so no audio assets to ship. A
// dedicated AudioContext at the device rate, NEVER the capture context (which
// is 16 kHz and has no output).
let cueCtx: AudioContext | null = null;
function playCue(kind: "start" | "stop") {
  try {
    cueCtx ??= new AudioContext();
    void cueCtx.resume();
    const t0 = cueCtx.currentTime;
    const osc = cueCtx.createOscillator();
    const gain = cueCtx.createGain();
    osc.type = "sine";
    if (kind === "start") {
      osc.frequency.setValueAtTime(620, t0);
      osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.07);
    } else {
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.exponentialRampToValueAtTime(540, t0 + 0.09);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain).connect(cueCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.14);
  } catch {
    /* a failed cue must never break the capture */
  }
}

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
      amp: 0.12 + 0.88 * Math.pow(r(), 1.6), // many small strands, a few big
      freq: 0.85 + r() * 1.7,
      phase: r() * Math.PI * 2,
      speed: 0.55 + r() * 0.9,
      bob: r() * 2 - 1,
      alpha: 0.16 + 0.26 * r(),
      sign: r() < 0.5 ? -1 : 1,
    });
  }
  return arr;
}

const RIBBON = {
  strokeWidth: 0.55, // thin strands (validated style)
  maxAmp: 13, // v3: more imposing (Roch), still slimmer than the raw prototype
  lengthScale: 0.8, // "20% shorter"
  strandCount: 30,
  skew: 0.86, // crest slightly left of center
  baseSpeed: 0.55,
};

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

    const draw = (now: number) => {
      const t = now / 1000;
      const p = phaseRef.current;
      // Listening: amplitude follows the mic (a floor keeps it alive between
      // words). Transcribing: collapse toward a breathing wire. Idle: flat.
      level += (levelRef.current - level) * 0.25;
      const target =
        p === "listening" ? 0.3 + 0.7 * Math.min(1, level * 1.6) : p === "transcribing" ? 0.12 : 0;
      activation += (target - activation) * 0.08;

      ctx.clearRect(0, 0, W, H);
      const midY = H / 2;
      const spanW = W * RIBBON.lengthScale;
      const x0 = (W - spanW) / 2;
      const steps = 90;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = RIBBON.strokeWidth;
      for (const s of strands) {
        ctx.beginPath();
        for (let k = 0; k <= steps; k++) {
          const tt = k / steps;
          const x = x0 + tt * spanW;
          const env = Math.pow(Math.sin(Math.PI * Math.pow(tt, RIBBON.skew)), 1.12);
          const wave = Math.sin(tt * s.freq * Math.PI * 2 + s.phase + t * s.speed * RIBBON.baseSpeed * 2.2);
          const bob = Math.sin(t * 0.45 + s.phase) * 0.32 * s.bob;
          const y = midY + env * (RIBBON.maxAmp * activation) * (s.amp * s.sign * wave * 0.9 + bob);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(40, 40, 40, ${s.alpha.toFixed(3)})`;
        ctx.stroke();
      }
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
      if (cfg?.sounds) playCue("start");
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
      if (lastCfg?.sounds) playCue("stop");
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
        gap: 12,
        height: 46,
        padding: "0 20px",
        borderRadius: 23,
        background: "linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.64))",
        border: "1px solid rgba(255,255,255,0.70)",
        boxShadow: "0 12px 32px rgba(17,24,39,0.24), inset 0 1px 0 rgba(255,255,255,0.95)",
        backdropFilter: "blur(16px) saturate(1.2)",
        WebkitBackdropFilter: "blur(16px) saturate(1.2)",
        color: "#1a1916",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontSize: 12.5,
        width: "fit-content",
        margin: "7px auto",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: phase === "error" ? "#c0392b" : "#1d6f5c",
          boxShadow: phase === "listening" ? "0 0 7px rgba(29, 111, 92, 0.7)" : "none",
          flexShrink: 0,
        }}
      />
      {phase === "error" ? (
        <span>Microphone unavailable</span>
      ) : (
        <>
          <Ribbon levelRef={levelRef} phase={phase} />
          {phase === "transcribing" && (
            <span style={{ color: "#6b6960" }}>Transcribing...</span>
          )}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
