// Dictation overlay: a small always-on-top pill shown while the PTT key is
// held. It ALSO owns the microphone capture (getUserMedia lives in a renderer),
// accumulating 16 kHz Float32 chunks in local variables only. On stop, the WAV
// goes to the main process and every local reference is dropped: the "nothing
// is ever stored" rule starts here.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { floatTo16BitPcm, encodeWav, durationMs, SAMPLE_RATE } from "../shared/wav";

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

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // Chromium resamples the device rate to the context rate: asking the
        // context for 16 kHz gives us ASR-ready PCM with zero conversion step.
        const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        await ctx.audioWorklet.addModule(
          URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })),
        );
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
        setPhase("error");
        api.sendCaptureError(String(err));
      }
    }

    function teardown(): Float32Array[] {
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

    function stop() {
      const chunks = teardown();
      const pcm = floatTo16BitPcm(chunks);
      chunks.length = 0; // release every audio reference immediately
      const wav = encodeWav(pcm);
      api.sendCaptureDone(wav.buffer as ArrayBuffer, durationMs(pcm.length));
    }

    function cancel() {
      teardown(); // chunks go out of scope unconsumed: nothing leaves this window
    }

    api.onCaptureCommand((cmd) => {
      if (cmd === "start") void start();
      else if (cmd === "stop") stop();
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
