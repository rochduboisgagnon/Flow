import { BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  DECODE_BYTES,
  DECODE_PROBE,
  DECODE_RUN,
  DECODE_CANCEL,
  DECODE_FLOW,
  DECODE_META,
  DECODE_PCM,
  DECODE_DONE,
  DECODE_ERROR,
  type DecodeDonePayload,
  type DecodeErrorPayload,
  type DecodeFailure,
  type DecodeMetaPayload,
  type DecodePcmPayload,
} from "../shared/ipcContracts";

// V4 D1, main side: owns the hidden decode window (src/renderer/decode.tsx) and
// the one operation it performs - "these bytes in, 16 kHz mono PCM out".
//
// THE INVARIANT THIS CLASS EXISTS TO ENFORCE (plan §5.1.1): an import is a READ.
// This is the only place in the import that ever touches the user's file, and it
// opens it with flags "r" and nothing else. There is no fs call in this file
// that can create, truncate, rename, move or delete anything - not on the happy
// path, not on the error path, not on the cancellation path. The renderer never
// receives the path either, only bytes, so no compromised page could act on it.
//
// The second thing it owns is CONTAINMENT. Decoding is the one operation in Flow
// that can genuinely exhaust memory (see shared/audioImport.ts's measured
// budget), so it happens in its own window, away from the microphone: when that
// window dies, the death is a typed result ("memory") and a rebuilt window, not
// a mystery. Everything is keyed on a token, the same discipline
// main/capture.ts uses, so a message from a job that is over can never be read
// as belonging to the one that followed it.

export interface DecodeSource {
  /** Opened READ-ONLY. Never written, never moved, never removed. */
  path: string;
  /** Byte range to read, for a sliced decode. Absent = the whole file. */
  start?: number;
  end?: number; // inclusive, fs.createReadStream semantics
  /** Bytes sent BEFORE the range - a rebuilt WAV header, which is what makes a
   * byte range of a PCM file a decodable file in its own right. */
  prefix?: Uint8Array;
}

export type DecodeVerdict = { ok: true } | { ok: false; reason: DecodeFailure; detail: string };

export interface DecodeCall {
  source: DecodeSource;
  /** Probe the duration and let `accept` rule on it BEFORE any decode happens.
   * This is plan §5.1.3's "read the duration before the full decode", and it is
   * the only thing standing between a six-hour file and a dead renderer. */
  probe?: boolean;
  accept?(durationMs: number): DecodeVerdict;
  /** One ~5 s slice of 16 kHz mono PCM. Returning a promise PAUSES the renderer
   * until it settles - real backpressure, so a decode that outruns the disk
   * cannot pile the whole recording up in this process's memory. */
  onPcm(pcm: Int16Array): void | Promise<void>;
  /** Checked between slices: a cancelled import stops at the next one. */
  isCancelled?(): boolean;
}

export type DecodeResult =
  | { ok: true; frames: number; durationMs: number; channels: number }
  | { ok: false; reason: DecodeFailure; detail: string };

/** 8 MB per IPC message. One 200 MB message is not a thing to ship: mojo has its
 * own limits, and a single copy that large is exactly the allocation the whole
 * budget above exists to avoid. */
const TRANSFER_BYTES = 8 * 1024 * 1024;

/** Nothing from the window for this long = it is not coming back. Generous: a
 * four-hour file spends ~8 s inside decodeAudioData without saying a word, and a
 * slow machine several times that. */
const STALL_MS = 180_000;

interface Job {
  token: number;
  call: DecodeCall;
  settle(r: DecodeResult): void;
  frames: number;
  channels: number;
  durationMs: number;
  meta: ((durationMs: number) => void) | null;
  chain: Promise<void>; // serializes onPcm, so slices reach the caller in order
  paused: boolean;
  stall: NodeJS.Timeout | undefined;
}

export class AudioDecodeWindow {
  private win: BrowserWindow | null = null;
  private wired = false;
  private dev = false;
  private token = 0;
  private job: Job | null = null;

  constructor(private readonly log?: (msg: string) => void) {}

  create(dev: boolean): void {
    this.dev = dev;
    if (this.win && !this.win.isDestroyed()) return;
    this.win = new BrowserWindow({
      width: 200,
      height: 120,
      show: false, // hidden: it decodes audio, there is nothing to see
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // the preload pulls ../shared/ipcContracts (Electron 20+)
        // The Int16 fold walks the buffer across many turns of the event loop;
        // a throttled hidden window would stretch a 3-second job into minutes.
        backgroundThrottling: false,
      },
    });
    const wc = this.win.webContents;
    // The two ways this window dies. Both END the job in flight, with a typed
    // reason: a decode that took the renderer down with it is the failure mode
    // the plan describes as "a window that dies without a message", and the
    // whole point of doing this here is that it stops being silent.
    wc.on("render-process-gone", (_e, details) =>
      this.died(`the decode window stopped (${details.reason})`, details.reason === "crashed" ? "memory" : "internal"),
    );
    wc.on("did-fail-load", (_e, code, desc) => this.died(`the decode window failed to load (${desc || code})`, "internal"));
    if (!this.wired) {
      this.wired = true;
      ipcMain.on(DECODE_META, (e, p: DecodeMetaPayload) => {
        const job = this.forSender(e, p.token);
        if (!job) return;
        this.touch(job);
        job.durationMs = p.durationMs;
        const cb = job.meta;
        job.meta = null;
        cb?.(p.durationMs);
      });
      ipcMain.on(DECODE_PCM, (e, p: DecodePcmPayload) => {
        const job = this.forSender(e, p.token);
        if (!job) return;
        this.touch(job);
        const buf = Buffer.from(p.pcm);
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)).slice(0);
        job.frames += pcm.length;
        if (job.call.isCancelled?.()) {
          this.cancelJob(job, "cancelled", "cancelled by the user");
          return;
        }
        // Serialized, and only ever awaited through this chain: the caller sees
        // the slices in order, and a caller that needs time (a disk write that
        // has to drain) pauses the renderer instead of being outrun by it.
        job.chain = job.chain.then(async () => {
          const r = job.call.onPcm(pcm);
          if (r && typeof (r as Promise<void>).then === "function") {
            this.flow(job, true);
            try {
              await r;
            } finally {
              this.flow(job, false);
            }
          }
        });
      });
      ipcMain.on(DECODE_DONE, (e, p: DecodeDonePayload) => {
        const job = this.forSender(e, p.token);
        if (!job) return;
        job.channels = p.channels;
        // Wait out the write chain: "done" means the caller has SEEN every slice,
        // not merely that the renderer stopped sending them.
        void job.chain.then(
          () => this.finish(job, { ok: true, frames: job.frames, durationMs: job.durationMs, channels: p.channels }),
          (err) => this.finish(job, { ok: false, reason: "internal", detail: String(err) }),
        );
      });
      ipcMain.on(DECODE_ERROR, (e, p: DecodeErrorPayload) => {
        const job = this.forSender(e, p.token);
        if (!job) return;
        this.finish(job, { ok: false, reason: p.reason, detail: p.detail });
      });
    }
    if (dev) void this.win.loadURL("http://localhost:5183/decode.html");
    else void this.win.loadFile(path.join(__dirname, "..", "renderer", "decode.html"));
  }

  /** The job a message belongs to, or null: wrong sender, wrong token, or no job
   * at all. Same gate as NativeCapture's - the preload is shared, so every other
   * window can technically send on these channels. */
  private forSender(e: Electron.IpcMainEvent, token: number): Job | null {
    if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents) return null;
    const job = this.job;
    if (!job || job.token !== token) return null;
    return job;
  }

  private touch(job: Job): void {
    clearTimeout(job.stall);
    job.stall = setTimeout(
      () => this.finish(job, { ok: false, reason: "internal", detail: "the decode window stopped answering" }),
      STALL_MS,
    );
  }

  private flow(job: Job, paused: boolean): void {
    if (job.paused === paused) return;
    job.paused = paused;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(DECODE_FLOW, { token: job.token, paused });
  }

  private cancelJob(job: Job, reason: DecodeFailure, detail: string): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(DECODE_CANCEL, { token: job.token });
    this.finish(job, { ok: false, reason, detail });
  }

  private finish(job: Job, result: DecodeResult): void {
    if (this.job !== job) return; // already settled: first verdict wins
    clearTimeout(job.stall);
    this.job = null;
    job.settle(result);
  }

  /** The window went away. Settle whatever it was doing, then rebuild it so the
   * NEXT import is not silently impossible. */
  private died(msg: string, reason: DecodeFailure): void {
    this.log?.(`[import] ${msg}`);
    const job = this.job;
    if (job) this.finish(job, { ok: false, reason, detail: msg });
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    // Rebuilt lazily on the next decode() rather than here: a window recreated
    // inside its own death handler is a good way to loop.
  }

  /** Decode one decodable unit: a whole file, or one re-headered slice of a WAV.
   * Never throws - every outcome, including a dead window, comes back as a
   * typed result the pipeline can put in front of a human. */
  async decode(call: DecodeCall): Promise<DecodeResult> {
    if (this.job) return { ok: false, reason: "internal", detail: "a decode is already running" };
    if (!this.win || this.win.isDestroyed()) this.create(this.dev);
    const win = this.win;
    if (!win || win.isDestroyed()) return { ok: false, reason: "internal", detail: "no decode window" };
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        win.webContents.once("did-finish-load", done);
        setTimeout(done, 10_000); // a page that never loads must not hang the queue
      });
    }
    const token = ++this.token;
    let settle!: (r: DecodeResult) => void;
    const done = new Promise<DecodeResult>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      token,
      call,
      settle,
      frames: 0,
      channels: 0,
      durationMs: 0,
      meta: null,
      chain: Promise.resolve(),
      paused: false,
      stall: undefined,
    };
    this.job = job;
    this.touch(job);
    try {
      await this.sendBytes(job, call.source);
    } catch (err) {
      // A file that cannot be READ is a legitimate outcome (a USB key pulled
      // mid-import is exactly the scenario the plan names); nothing was written
      // anywhere, and the source is untouched by construction - we only ever
      // opened it for reading.
      this.finish(job, { ok: false, reason: "format", detail: String(err instanceof Error ? err.message : err) });
      return done;
    }
    if (this.job !== job) return done; // died / cancelled while streaming the bytes
    if (call.isCancelled?.()) {
      this.cancelJob(job, "cancelled", "cancelled by the user");
      return done;
    }
    if (call.probe) {
      const durationMs = await new Promise<number>((resolve) => {
        job.meta = resolve;
        win.webContents.send(DECODE_PROBE, { token });
        // If the window never answers, the stall timer settles the job and this
        // resolves with 0 only to unblock the await; the verdict below is then
        // irrelevant because this.job is already null.
        setTimeout(() => resolve(job.durationMs), STALL_MS);
      });
      if (this.job !== job) return done;
      const verdict = call.accept ? call.accept(durationMs) : ({ ok: true } as DecodeVerdict);
      if (!verdict.ok) {
        // Refused BEFORE decoding: the bytes are dropped, nothing is allocated,
        // and the caller gets a reason it can put in front of a human.
        this.cancelJob(job, verdict.reason, verdict.detail);
        return done;
      }
    }
    win.webContents.send(DECODE_RUN, { token });
    return done;
  }

  /** Stream the source into the window in bounded slices. READ-ONLY: "r", and a
   * stream that is only ever read from. */
  private sendBytes(job: Job, src: DecodeSource): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const win = this.win;
      if (!win || win.isDestroyed()) return reject(new Error("no decode window"));
      if (src.prefix && src.prefix.length > 0) {
        win.webContents.send(DECODE_BYTES, { token: job.token, bytes: Buffer.from(src.prefix) });
      }
      const stream = fs.createReadStream(src.path, {
        flags: "r",
        highWaterMark: TRANSFER_BYTES,
        ...(src.start !== undefined ? { start: src.start } : {}),
        ...(src.end !== undefined ? { end: src.end } : {}),
      });
      stream.on("data", (chunk) => {
        if (this.job !== job || !this.win || this.win.isDestroyed()) {
          stream.destroy();
          resolve();
          return;
        }
        this.touch(job);
        this.win.webContents.send(DECODE_BYTES, { token: job.token, bytes: chunk });
      });
      stream.on("error", (err) => reject(err));
      stream.on("end", () => resolve());
    });
  }

  destroy(): void {
    const job = this.job;
    if (job) this.finish(job, { ok: false, reason: "cancelled", detail: "Flow is closing" });
    this.win?.destroy();
    this.win = null;
  }
}
