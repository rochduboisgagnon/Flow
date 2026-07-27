import { BrowserWindow, ipcMain, session, desktopCapturer } from "electron";
import path from "node:path";
import { CaptureSession } from "./captureSession";
import {
  NATIVE_START,
  NATIVE_STOP,
  NATIVE_CHUNK,
  NATIVE_ERROR,
  NATIVE_READY,
  NATIVE_DONE,
  type NativeStartPayload,
} from "../shared/ipcContracts";

// C2 (Windows-only): native capture of the PC's own sound + the microphone WITHOUT
// a picker. A hidden window's session installs a display-media handler that returns
// the screen source with audio:'loopback', so getDisplayMedia in the renderer never
// shows a chooser. The renderer mixes loopback + mic into one 16 kHz mono stream and
// streams Int16 PCM back over IPC; the engine feeds it straight to the long recorder.
//
// U4 (review): every decision about WHICH capture a callback belongs to, and
// about a capture that never delivers anything, lives in the pure CaptureSession
// (captureSession.ts) - this class only owns the window and the IPC. Before that
// split, start() was a send into the void: a window that failed to load, a
// renderer that crashed, or a getDisplayMedia that never resolved all looked
// exactly like a healthy recording.
export class NativeCapture {
  private win: BrowserWindow | null = null;
  private wired = false;
  private onChunk: (pcm: Int16Array) => void = () => {};
  private onError: (msg: string) => void = () => {};
  private onDone: (() => void) | null = null;
  private sess = new CaptureSession();
  private log?: (msg: string) => void;

  /** `log` is optional so tests and callers that do not diagnose can skip it,
   * but index.ts passes flowLog: a capture window that dies before any
   * recording exists is exactly the failure that used to leave no trace. */
  constructor(log?: (msg: string) => void) {
    this.log = log;
  }

  /** loopback capture is a Windows-only barrier (the "this is a PC" gate). */
  static available(): boolean {
    return process.platform === "win32";
  }

  create(dev: boolean): void {
    if (this.win && !this.win.isDestroyed()) return;
    // audio:'loopback' = the PC's own sound, no picker; desktopCapturer picks the
    // screen source programmatically and the renderer drops the video track. Set on
    // the default session (only this window ever calls getDisplayMedia), which also
    // carries the media grant from index.ts, so the mic needs no extra prompt.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_req, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => callback(sources.length ? { video: sources[0], audio: "loopback" } : {}))
          .catch(() => callback({}));
      },
      { useSystemPicker: false },
    );
    this.win = new BrowserWindow({
      width: 200,
      height: 120,
      show: false, // hidden: it only mixes audio, there is nothing to see
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // the preload pulls ../shared/ipcContracts (Electron 20+)
        backgroundThrottling: false, // keep the audio graph running while hidden
      },
    });
    // U4 (blocking): the window carrying the whole capture could crash or fail
    // to load without a single line anywhere. Both are now the end of the
    // recording, said out loud - per window, because these listeners belong to
    // the webContents this call just created.
    const wc = this.win.webContents;
    wc.on("render-process-gone", (_e, details) => this.died(`the capture window crashed (${details.reason})`));
    wc.on("did-fail-load", (_e, code, desc) =>
      this.died(`the capture window failed to load (${desc || code})`),
    );
    if (!this.wired) {
      this.wired = true;
      ipcMain.on(NATIVE_CHUNK, (e, buf: ArrayBuffer) => {
        if (!this.win || e.sender !== this.win.webContents) return;
        const gen = this.sess.token;
        // The token, not a swapped-out callback, is what keeps a late tail slice
        // from reaching a recorder that already finished (and, worse, one that
        // started since).
        if (!this.sess.current(gen)) return;
        this.sess.prove(gen); // audio is really flowing: disarm the watchdog
        const b = Buffer.from(buf);
        const pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
        this.onChunk(pcm.slice(0)); // copy off the shared buffer before it is reused
      });
      ipcMain.on(NATIVE_ERROR, (e, msg: string) => {
        if (this.win && e.sender === this.win.webContents) this.died(String(msg));
      });
      ipcMain.on(NATIVE_READY, (e) => {
        if (!this.win || e.sender !== this.win.webContents) return;
        // U4 (blocking): this used to be received and deliberately ignored. It
        // is the ONE message that says the capture graph exists, so it is what
        // arms the session and calls the watchdog off.
        this.sess.prove(this.sess.token);
        this.log?.("[native] capture graph is live");
      });
      ipcMain.on(NATIVE_DONE, (e) => {
        // The renderer flushed its final tail slice; NOW the recorder may finalize.
        if (this.win && e.sender === this.win.webContents) this.finishStop(this.sess.token);
      });
    }
    if (dev) void this.win.loadURL("http://localhost:5183/capture.html");
    else void this.win.loadFile(path.join(__dirname, "..", "renderer", "capture.html"));
  }

  start(cfg: NativeStartPayload, onChunk: (pcm: Int16Array) => void, onError: (msg: string) => void): void {
    this.onChunk = onChunk;
    this.onError = onError;
    if (!this.win || this.win.isDestroyed()) {
      onError("native capture window is not available");
      return;
    }
    // A NEW session: the previous one's watchdog and tail timer are cancelled
    // here, so neither can reach in and stop the recording about to begin.
    // `onError` is the closure of THIS start, so a watchdog that somehow
    // outlived its session could still only ever talk about its own.
    const gen = this.sess.start((msg) => {
      this.log?.(`[native] ${msg}`);
      onError(msg);
    });
    const send = () => this.win?.webContents.send(NATIVE_START, cfg);
    // Fire-and-forget by nature: nothing acknowledges NATIVE_START. The
    // watchdog armed above is what turns that into a bounded wait instead of an
    // indefinite one - if neither native:ready nor a chunk lands in time, this
    // capture is declared dead (gen is what keeps that verdict on this session).
    if (this.win.webContents.isLoading()) this.win.webContents.once("did-finish-load", send);
    else send();
    this.log?.(`[native] capture session ${gen} requested`);
  }

  /** Ask the renderer to stop. It flushes its final tail slice (still consumed by
   * onChunk), then sends NATIVE_DONE, which fires `onDone` (where the caller finalizes
   * the recorder). A safety timer finalizes anyway if the renderer never answers. */
  stop(onDone: () => void): void {
    const gen = this.sess.token;
    this.onDone = onDone;
    const alive = !!this.win && !this.win.isDestroyed();
    if (alive) this.win?.webContents.send(NATIVE_STOP);
    // A window that is gone, or a session already closed by a failure, has no
    // tail coming: settle now rather than leave the caller waiting seconds for a
    // flush that will never arrive.
    if (!alive || !this.sess.stop(gen, () => this.finishStop(gen))) this.finishStop(gen, true);
  }

  /** `settled` = "the session is already over and this call IS the settlement"
   * (no window, or a capture that failed): the token check would otherwise
   * refuse it and the caller's callback would never run. */
  private finishStop(gen: number, settled = false): void {
    // U4 (major): a tail that lands after a NEW recording started belongs to the
    // previous one; acting on it would finalize the recording currently running.
    if (!settled && !this.sess.finish(gen)) return;
    const done = this.onDone;
    this.onDone = null;
    if (done) done();
  }

  /** The capture died on us. Logged always, reported to the caller only while
   * it is THIS recording that is dying (a crash between two recordings must not
   * abort the next one). */
  private died(msg: string): void {
    this.log?.(`[native] ${msg}`);
    if (this.sess.fail(this.sess.token)) this.onError(msg);
  }

  destroy(): void {
    this.sess.cancel();
    this.win?.destroy();
    this.win = null;
  }
}
