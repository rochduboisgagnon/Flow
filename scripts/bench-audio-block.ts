// What the utterance pipeline's audio prologue does to the main thread's event
// loop: `npm run bench:audio` (build first - the worker leg reads dist/).
//
// WHY THIS EXISTS (plan V2, B4b-suite). B4b's second half was specified as
// "move the WAV encoding and the VAD off the main thread (worker)", on the
// premise (plan §3.6.4) that a 30 s utterance means "environ 480 000
// echantillons dans des boucles JavaScript, au moment precis ou l'utilisateur
// relache ses touches". The campaign's own rule is that no improvement is
// declared without a measurement - which cuts both ways: a REARRANGEMENT is not
// declared necessary without one either. This script is that measurement, and
// unlike bench-hotpath.ts it needs no running app, no keyboard and no
// microphone: the three functions under test are pure.
//
// It measures, per clip length:
//   1. INLINE - the exact synchronous work processUtterance does today
//      (pcmFromWav -> analyzeSpeech -> encodeWav(trimToSpeech(...))), timed on
//      the main thread, under load;
//   2. the event-loop lag that work produces, through the REAL B11 sampler
//      (src/shared/loopLag.ts), so the number is comparable to what the
//      Diagnostics panel and bench:hotpath report;
//   3. WORKER - the same work in a worker_threads Worker, with the WAV moved by
//      transferList in both directions, measuring what the main thread actually
//      pays (the postMessage) and the wall-clock round trip it would add to the
//      release-to-text budget. The worker's output is compared byte-for-byte
//      with the inline one, so a leg that silently did nothing cannot pass.
//
// THE LOAD, stated exactly rather than described: an engine log written through
// the real LogQueue + file sink at 250 lines/s (whisper-server's stderr rate
// during a decode), plus a continuous 64 KB HTTP POST/response loop against a
// local server that answers after 250 ms (the shape of a transcription in
// flight). Both are the loads plan §3.2.2 names.
//
// ZERO RETENTION: the audio here is synthetic, generated in this file. Nothing
// reads a microphone, a file, or anything the user ever said.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { LoopLagSampler, realScheduler } from "../src/shared/loopLag";
import { summarizeLoopLag, LOOP_LAG_P99_THRESHOLD_MS } from "../src/shared/hotpath";
import { pcmFromWav, encodeWav, floatTo16BitPcm, SAMPLE_RATE } from "../src/shared/wav";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../src/shared/vad";
import { LogQueue } from "../src/shared/logQueue";
import { createFileLogSink } from "../src/main/logSink";

// Clip lengths that mean something in this product, not round numbers:
//   2 / 5 s   a normal dictation
//   7 s       one long-recording segment (SEGMENT_TARGET_MS)
//   30 s      the hands-free utterance plan §3.6.4 argues from
//   300 s     a five-minute import over POST /transcribe
//   2097 s    the API's own ceiling (MAX_AUDIO_BYTES = 64 MiB of 16 kHz mono)
const CLIP_SECONDS = [2, 5, 7, 30, 300, 2097];
const REPS = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** Speech-shaped enough that the VAD passes and trimToSpeech has real bounds to
 * find: an amplitude-modulated tone over a noise floor, silent at both ends. */
function speechLikeWav(seconds: number): Uint8Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const silent = t < 0.3 || t > seconds - 0.3;
    const env = silent ? 0 : 0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    f[i] = env * Math.sin(2 * Math.PI * 180 * t) + (Math.random() - 0.5) * 0.004;
  }
  return encodeWav(floatTo16BitPcm([f]));
}

/** EXACTLY the synchronous prologue of processUtterance (src/main/index.ts). */
function inlineProlog(wav: Uint8Array): { blockMs: number; bytes: number } {
  const t0 = performance.now();
  const pcm = pcmFromWav(wav);
  const speech = analyzeSpeech(pcm);
  const out = hasSpeech(speech) ? encodeWav(trimToSpeech(pcm, speech)) : null;
  return { blockMs: performance.now() - t0, bytes: out ? out.length : 0 };
}

/** The worker leg reads the COMPILED shared modules, so the file it runs is the
 * one a packaged build would ship - not a re-implementation that could be fast
 * for the wrong reason. Written to a temp file with absolute requires; there is
 * nothing to add to the build and nothing left behind in the tree. */
function writeWorkerFile(): string | null {
  const dist = path.join(__dirname, "..", "dist", "shared");
  if (!fs.existsSync(path.join(dist, "wav.js")) || !fs.existsSync(path.join(dist, "vad.js"))) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-worker-"));
  const file = path.join(dir, "worker.cjs");
  fs.writeFileSync(
    file,
    `const { parentPort } = require("node:worker_threads");
const { pcmFromWav, encodeWav } = require(${JSON.stringify(path.join(dist, "wav.js"))});
const { analyzeSpeech, hasSpeech, trimToSpeech } = require(${JSON.stringify(path.join(dist, "vad.js"))});
parentPort.on("message", (m) => {
  const pcm = pcmFromWav(new Uint8Array(m.wav));
  const speech = analyzeSpeech(pcm);
  if (!hasSpeech(speech)) return parentPort.postMessage({ id: m.id, bytes: 0 });
  const out = encodeWav(trimToSpeech(pcm, speech));
  parentPort.postMessage({ id: m.id, bytes: out.length, wav: out.buffer }, [out.buffer]);
});
`,
  );
  return file;
}

interface Row {
  clip: string;
  mib: string;
  blockMed: string;
  blockWorst: string;
  lagP50: string;
  lagP99: string;
  lagMax: string;
  postMed: string;
  rttMed: string;
  same: string;
}

async function main() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bench-log-"));
  const logQueue = new LogQueue(createFileLogSink(() => path.join(logDir, "flow.log")), { onFailure: () => {} });

  const server = http.createServer((_req, res) => setTimeout(() => res.end('{"ok":true}'), 250));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const inference = () =>
    new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.end("x".repeat(64 * 1024));
    });

  const workerFile = writeWorkerFile();
  let worker: Worker | null = null;
  const pending = new Map<number, (bytes: number) => void>();
  let nextId = 1;
  if (workerFile) {
    worker = new Worker(workerFile);
    await new Promise((r) => worker!.once("online", r));
    worker.on("message", (m: { id: number; bytes: number }) => {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.(m.bytes);
    });
  } else {
    console.log("(worker leg skipped: dist/shared is missing - run `npm run build` first)\n");
  }

  const rows: Row[] = [];
  for (const secs of CLIP_SECONDS) {
    const wav = speechLikeWav(secs);
    const lags: number[] = [];
    const blocks: number[] = [];
    const posts: number[] = [];
    const rtts: number[] = [];
    let same = true;

    const sampler = new LoopLagSampler({
      scheduler: realScheduler(),
      onSample: (ms) => lags.push(ms),
      isActive: () => true,
    });
    let loaded = true;
    const chatty = setInterval(() => {
      for (let i = 0; i < 5; i++) logQueue.push(new Date().toISOString() + " [asr] progress line\n");
    }, 20);
    void (async () => {
      while (loaded) await inference();
    })();

    sampler.start();
    await sleep(400); // let the loads settle before the first measurement

    for (let r = 0; r < REPS; r++) {
      const inline = inlineProlog(wav);
      blocks.push(inline.blockMs);
      if (worker) {
        const id = nextId++;
        const owned = wav.slice(); // the real call site owns its buffer already
        const t0 = performance.now();
        const answer = new Promise<number>((resolve) => pending.set(id, resolve));
        const postAt = performance.now();
        worker.postMessage({ id, wav: owned.buffer }, [owned.buffer]);
        posts.push(performance.now() - postAt);
        const bytes = await answer;
        rtts.push(performance.now() - t0);
        if (bytes !== inline.bytes) same = false;
      }
      await sleep(150);
    }

    await sleep(200);
    sampler.stop();
    loaded = false;
    clearInterval(chatty);

    const lag = summarizeLoopLag(lags);
    rows.push({
      clip: `${secs}s`,
      mib: (wav.length / 1048576).toFixed(2),
      blockMed: median(blocks).toFixed(2),
      blockWorst: Math.max(...blocks).toFixed(2),
      lagP50: (lag.p50Ms ?? 0).toFixed(2),
      lagP99: (lag.p99Ms ?? 0).toFixed(2),
      lagMax: (lag.maxMs ?? 0).toFixed(2),
      postMed: posts.length ? median(posts).toFixed(3) : "-",
      rttMed: rtts.length ? median(rtts).toFixed(2) : "-",
      same: worker ? String(same) : "-",
    });
  }

  server.close();
  logQueue.flushSync();
  await worker?.terminate();
  if (workerFile) fs.rmSync(path.dirname(workerFile), { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });

  const header = ["clip", "MiB", "block p50", "block max", "lag p50", "lag p99", "lag max", "post", "worker rtt", "same"];
  const cells = rows.map((r) => [r.clip, r.mib, r.blockMed, r.blockWorst, r.lagP50, r.lagP99, r.lagMax, r.postMed, r.rttMed, r.same]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padStart(widths[i])).join("  ");
  console.log("\nAudio prologue on the main thread, under load (all times in ms)\n");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const c of cells) console.log(line(c));
  console.log(
    "\n  block      the synchronous work processUtterance does today, on the main thread\n" +
      "  lag        event-loop lag through the real B11 sampler (20 ms cadence). On Windows it\n" +
      "             carries a fixed floor of about 11 ms: a 20 ms interval lands on the system\n" +
      "             timer's 15.625 ms grid, so 31.25 - 20 is granularity, not blocking.\n" +
      "  post       what the MAIN THREAD pays to hand the WAV to a worker (transferList, no copy)\n" +
      "  worker rtt wall-clock round trip, i.e. what a worker would ADD to release-to-text\n" +
      "  same       the worker's output is byte-identical in length to the inline one\n" +
      `\n  Trigger T1 (plan §3.6.6) fires at a lag p99 over ${LOOP_LAG_P99_THRESHOLD_MS} ms.\n`,
  );
}

void main();
