// Dictation overlay: a small always-on-top pill shown while the PTT key is
// held. It ALSO owns the microphone capture (getUserMedia lives in a renderer),
// accumulating 16 kHz Float32 chunks in local variables only. On stop, the WAV
// goes to the main process and every local reference is dropped: the "nothing
// is ever stored" rule starts here.
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

type Phase = "idle" | "listening" | "error";

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

function Overlay() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
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
          // RMS of the latest frame drives the level meter (the §5.7 ribbon
          // will consume the same signal later).
          let sum = 0;
          for (let i = 0; i < ev.data.length; i++) sum += ev.data[i] * ev.data[i];
          setLevel(Math.min(1, Math.sqrt(sum / ev.data.length) * 6));
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
      if (!s) return [];
      const chunks = s.chunks;
      s.stream.getTracks().forEach((t) => t.stop());
      void s.ctx.close();
      setPhase("idle");
      setLevel(0);
      return chunks;
    }

    let lastCfg: CaptureStartPayload | undefined;

    function stop() {
      if (lastCfg?.sounds) playCue("stop");
      const chunks = teardown();
      const pcm = floatTo16BitPcm(chunks);
      chunks.length = 0; // release every audio reference immediately
      const wav = encodeWav(pcm);
      api.sendCaptureDone(wav.buffer as ArrayBuffer, durationMs(pcm.length));
    }

    function cancel() {
      teardown(); // chunks go out of scope unconsumed: nothing leaves this window
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
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 40,
        padding: "0 16px",
        borderRadius: 20,
        background: "rgba(11, 13, 16, 0.92)",
        border: "1px solid rgba(52, 227, 160, 0.35)",
        color: "#e9edf2",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontSize: 12.5,
        width: "fit-content",
        margin: "4px auto",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: phase === "error" ? "#e11d2a" : "#34e3a0",
          boxShadow: phase === "listening" ? "0 0 8px #34e3a0" : "none",
        }}
      />
      <span>{phase === "error" ? "Microphone unavailable" : "Listening..."}</span>
      <span
        aria-hidden
        style={{
          width: 72,
          height: 6,
          borderRadius: 3,
          background: "rgba(255,255,255,0.12)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${Math.round(level * 100)}%`,
            height: "100%",
            background: "#34e3a0",
            transition: "width 60ms linear",
          }}
        />
      </span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
