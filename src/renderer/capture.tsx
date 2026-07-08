// C2: the hidden NATIVE capture window (Windows-only). It mixes the PC's own sound
// (loopback, supplied picker-free by main's setDisplayMediaRequestHandler) with the
// microphone into one 16 kHz mono stream and streams Int16 PCM slices to the engine
// over IPC. The engine feeds those straight to the long recorder (no PWA, no network
// hop). Zero retention: nothing is written here; audio lives only in the graph.
import { floatTo16BitPcm, SAMPLE_RATE } from "../shared/wav";
import type { NativeStartPayload } from "../shared/ipcContracts";

// Mirrors overlay.tsx's capture worklet (kept inline so no extra bundler asset path).
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

const api = window.agrflow;
const SLICE_SAMPLES = SAMPLE_RATE; // ~1 s slices to the engine (matches the PWA cadence)

let session: { ctx: AudioContext; streams: MediaStream[] } | null = null;
let gen = 0; // cancellation token: a stop() that races an awaiting start() must win
let pending: Float32Array[] = [];
let pendingLen = 0;

/** Emit whole ~1 s slices; on `force` (stop) flush the tail too. */
function flush(force: boolean): void {
  while (pendingLen >= SLICE_SAMPLES || (force && pendingLen > 0)) {
    const take = Math.min(pendingLen, SLICE_SAMPLES);
    const out = new Float32Array(take);
    let filled = 0;
    while (filled < take && pending.length) {
      const head = pending[0];
      const need = take - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        pending.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        pending[0] = head.subarray(need);
        filled += need;
      }
    }
    pendingLen -= take;
    const pcm = floatTo16BitPcm([out]);
    api.sendNativeChunk(pcm.buffer as ArrayBuffer);
  }
}

async function start(cfg: NativeStartPayload): Promise<void> {
  const my = ++gen;
  const streams: MediaStream[] = [];
  let ctx: AudioContext | null = null;
  const bail = () => {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    void ctx?.close();
  };
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(cfg.micDeviceId ? { deviceId: { ideal: cfg.micDeviceId } } : {}),
        channelCount: 1,
        echoCancellation: true, // anti-echo: the mic can pick up the speakers on loopback
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streams.push(mic);
    if (my !== gen) return bail();
    // Chromium resamples device rates to the context rate: a 16 kHz context gives
    // ASR-ready PCM with no manual resample step (same trick as the dictation overlay).
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl); // don't leak one blob URL per session
    }
    if (my !== gen) return bail();
    const mixBus = new GainNode(ctx, { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
    ctx.createMediaStreamSource(mic).connect(mixBus);
    if (cfg.captureSystem) {
      // main's setDisplayMediaRequestHandler supplies the loopback source, so NO
      // picker appears. getDisplayMedia still requires a video track in the request;
      // we drop it and keep only the system audio.
      const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (my !== gen) {
        sys.getTracks().forEach((t) => t.stop());
        return bail();
      }
      sys.getVideoTracks().forEach((t) => t.stop());
      streams.push(sys);
      const sysAudio = sys.getAudioTracks();
      if (sysAudio.length) ctx.createMediaStreamSource(new MediaStream(sysAudio)).connect(mixBus);
    }
    const node = new AudioWorkletNode(ctx, "agrflow-capture");
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      pending.push(ev.data);
      pendingLen += ev.data.length;
      flush(false);
    };
    mixBus.connect(node);
    // No connection to ctx.destination: capture only, never playback.
    session = { ctx, streams };
    api.sendNativeReady();
  } catch (err) {
    bail();
    api.sendNativeError(String(err));
  }
}

function stop(): void {
  gen++; // invalidate any start() still awaiting a device
  const s = session;
  session = null;
  if (s) {
    s.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    void s.ctx.close();
  }
  flush(true); // send the tail, then drop every audio reference
  pending = [];
  pendingLen = 0;
  api.sendNativeDone(); // AFTER the tail: main may now finalize (nothing else is coming)
}

api.onNativeCommand((cmd, cfg) => {
  if (cmd === "start" && cfg) void start(cfg);
  else if (cmd === "stop") stop();
});
