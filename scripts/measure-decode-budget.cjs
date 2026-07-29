// V4 D1: what does a one-shot decodeAudioData actually COST on this machine?
//
// The plan (§5.1.3) names memory as the main failure mode of the import: a
// two-hour stereo recording is ~2.5 GB once decoded to Float32, and the failure
// shows up as a renderer that dies without a message. The threshold that decides
// "one shot" from "in slices" therefore has to be MEASURED, not guessed - this
// script is that measurement, kept in the repo so the number in
// src/shared/audioImport.ts can be re-derived on another machine.
//
// What it reproduces, deliberately identical to the production path
// (src/renderer/decode.tsx):
//   - the source bytes arrive over IPC in 8 MB chunks (one huge mojo message is
//     not a thing we ship), reassembled into one Uint8Array;
//   - duration is probed with an <audio> element BEFORE any decode;
//   - the decode happens on an OfflineAudioContext whose sampleRate is already
//     16 000, so decodeAudioData resamples ON THE WAY OUT and the AudioBuffer is
//     16 kHz - the single biggest saving available without a demuxer;
//   - the buffer is then walked in ~5 s slices into Int16 mono, which is what
//     production streams back to the engine.
//
// The source files are 8 kHz, 8-bit, stereo PCM WAVs: a deliberately CHEAP
// container (16 KB/s on disk) that still decodes to the full 16 kHz Float32
// footprint, so hours of audio can be measured without writing gigabytes first.
// What is being measured is the decoded buffer, not the container.
//
// Run: npm run bench:decode        (durations in minutes: FLOW_DECODE_BENCH_MIN)

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MINUTES = (process.env.FLOW_DECODE_BENCH_MIN || "10,30,60,120,240").split(",").map(Number);
const SRC_RATE = 8000;
// Channel count of the SOURCE: decodeAudioData preserves it, so this is what
// decides whether the decoded buffer is one big Float32Array or two smaller
// ones - which turns out to be the question (see the table in
// src/shared/audioImport.ts).
const SRC_CH = Number(process.env.FLOW_DECODE_BENCH_CH || 2);
const XFER = 8 * 1024 * 1024; // IPC slice, same as production
const WORK = process.env.FLOW_DECODE_BENCH_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "flow-decode-bench-"));

// Never touch the real ~/.flow, and never take the single-instance lock: a
// packaged Flow may well be running while this bench does.
app.setPath("userData", path.join(WORK, "userData"));

function writeSourceWav(file, seconds) {
  const bytesPerSec = SRC_RATE * SRC_CH; // 8-bit
  const dataBytes = bytesPerSec * seconds;
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + dataBytes, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(SRC_CH, 22);
  head.writeUInt32LE(SRC_RATE, 24);
  head.writeUInt32LE(bytesPerSec, 28);
  head.writeUInt16LE(SRC_CH, 32);
  head.writeUInt16LE(8, 34);
  head.write("data", 36);
  head.writeUInt32LE(dataBytes, 40);
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, head);
  const block = Buffer.alloc(1 << 20);
  for (let i = 0; i < block.length; i++) block[i] = 128 + Math.round(60 * Math.sin(i / 12));
  let left = dataBytes;
  while (left > 0) {
    const n = Math.min(left, block.length);
    fs.writeSync(fd, block, 0, n);
    left -= n;
  }
  fs.closeSync(fd);
  return dataBytes + 44;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>decode bench</title></head><body>
<script>
const { ipcRenderer } = require("electron");
let parts = [], total = 0;
ipcRenderer.on("bytes", (_e, buf) => { parts.push(new Uint8Array(buf)); total += buf.byteLength; });
ipcRenderer.on("go", async () => {
  const t0 = performance.now();
  try {
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    parts = [];
    // 1. duration BEFORE the decode, the cheap way.
    const blob = new Blob([all], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const probed = await new Promise((res, rej) => {
      const el = new Audio();
      el.preload = "metadata";
      el.onloadedmetadata = () => res(el.duration);
      el.onerror = () => rej(new Error("metadata"));
      el.src = url;
    });
    URL.revokeObjectURL(url);
    const tProbe = performance.now();
    // 2. the decode, straight to 16 kHz (the context's rate is the output rate).
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const buf = await ctx.decodeAudioData(all.buffer);
    const tDecode = performance.now();
    // 3. Int16 mono, in ~5 s slices, exactly like production streams it.
    const ch = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    const SLICE = 16000 * 5;
    let bytes = 0;
    for (let start = 0; start < buf.length; start += SLICE) {
      const n = Math.min(SLICE, buf.length - start);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < ch.length; c++) s += ch[c][start + i];
        s /= ch.length;
        if (s > 1) s = 1; else if (s < -1) s = -1;
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      bytes += out.byteLength;
    }
    ipcRenderer.send("done", {
      ok: true, probed, frames: buf.length, channels: buf.numberOfChannels, rate: buf.sampleRate,
      pcmBytes: bytes, probeMs: tProbe - t0, decodeMs: tDecode - tProbe, totalMs: performance.now() - t0,
    });
  } catch (err) {
    ipcRenderer.send("done", { ok: false, error: String(err && err.message ? err.message : err), totalMs: performance.now() - t0 });
  }
});
</script></body></html>`;

function mb(bytes) {
  return (bytes / 1048576).toFixed(0);
}

async function run() {
  const pageFile = path.join(WORK, "bench.html");
  fs.writeFileSync(pageFile, PAGE);
  const rows = [];
  for (const minutes of MINUTES) {
    const seconds = Math.round(minutes * 60);
    const src = path.join(WORK, `src-${minutes}min.wav`);
    const srcBytes = writeSourceWav(src, seconds);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });
    await win.loadFile(pageFile);
    const pid = win.webContents.getOSProcessId();
    let peakKb = 0;
    const sampler = setInterval(() => {
      for (const m of app.getAppMetrics()) {
        if (m.pid === pid && m.memory && m.memory.workingSetSize > peakKb) peakKb = m.memory.workingSetSize;
      }
    }, 200);
    const bytes = fs.readFileSync(src);
    for (let o = 0; o < bytes.length; o += XFER) {
      const slice = bytes.subarray(o, Math.min(bytes.length, o + XFER));
      win.webContents.send("bytes", slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
    }
    const result = await new Promise((resolve) => {
      ipcMain.once("done", (_e, r) => resolve(r));
      win.webContents.send("go");
      setTimeout(() => resolve({ ok: false, error: "timed out after 10 min" }), 600_000);
    });
    clearInterval(sampler);
    // One more sample after the fact: the peak often lands between two ticks.
    for (const m of app.getAppMetrics()) if (m.pid === pid && m.memory && m.memory.workingSetSize > peakKb) peakKb = m.memory.workingSetSize;
    const decodedBytes = result.ok ? result.frames * result.channels * 4 : 16000 * seconds * 2 * 4;
    rows.push({
      minutes,
      srcMB: mb(srcBytes),
      decodedMB: mb(decodedBytes),
      peakMB: (peakKb / 1024).toFixed(0),
      ok: result.ok,
      rate: result.rate,
      channels: result.channels,
      decodeMs: result.decodeMs ? Math.round(result.decodeMs) : "",
      totalMs: result.totalMs ? Math.round(result.totalMs) : "",
      error: result.error || "",
    });
    console.log(JSON.stringify(rows[rows.length - 1]));
    win.destroy();
    fs.rmSync(src, { force: true });
    // Let the renderer process actually go away before the next round.
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("\n minutes | source | decoded@16k | renderer peak RSS | decode | ok");
  for (const r of rows) {
    console.log(
      ` ${String(r.minutes).padStart(7)} | ${String(r.srcMB + " MB").padStart(6)} | ${String(r.decodedMB + " MB").padStart(11)} | ` +
        `${String(r.peakMB + " MB").padStart(17)} | ${String(r.decodeMs + " ms").padStart(8)} | ${r.ok ? "yes" : "NO: " + r.error}`,
    );
  }
  app.exit(0);
}

// Each round destroys its window before the next one; without this the default
// "last window closed" behaviour quits the bench after the first measurement.
app.on("window-all-closed", () => {});

app.whenReady().then(run);
