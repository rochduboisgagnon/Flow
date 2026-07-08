import { BrowserWindow, ipcMain, session, desktopCapturer } from "electron";
import path from "node:path";
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
export class NativeCapture {
  private win: BrowserWindow | null = null;
  private wired = false;
  private onChunk: (pcm: Int16Array) => void = () => {};
  private onError: (msg: string) => void = () => {};
  private onDone: (() => void) | null = null;
  private doneTimer: NodeJS.Timeout | undefined;

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
    if (!this.wired) {
      this.wired = true;
      ipcMain.on(NATIVE_CHUNK, (e, buf: ArrayBuffer) => {
        if (!this.win || e.sender !== this.win.webContents) return;
        const b = Buffer.from(buf);
        const pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
        this.onChunk(pcm.slice(0)); // copy off the shared buffer before it is reused
      });
      ipcMain.on(NATIVE_ERROR, (e, msg: string) => {
        if (this.win && e.sender === this.win.webContents) this.onError(String(msg));
      });
      ipcMain.on(NATIVE_READY, () => {
        /* the graph is live; nothing to do beyond letting chunks flow */
      });
      ipcMain.on(NATIVE_DONE, (e) => {
        // The renderer flushed its final tail slice; NOW the recorder may finalize.
        if (this.win && e.sender === this.win.webContents) this.finishStop();
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
    const send = () => this.win?.webContents.send(NATIVE_START, cfg);
    if (this.win.webContents.isLoading()) this.win.webContents.once("did-finish-load", send);
    else send();
  }

  /** Ask the renderer to stop. It flushes its final tail slice (still consumed by
   * onChunk), then sends NATIVE_DONE, which fires `onDone` (where the caller finalizes
   * the recorder). A safety timer finalizes anyway if the renderer never answers. */
  stop(onDone: () => void): void {
    this.onDone = onDone;
    if (!this.win || this.win.isDestroyed()) {
      this.finishStop();
      return;
    }
    this.win.webContents.send(NATIVE_STOP);
    clearTimeout(this.doneTimer);
    this.doneTimer = setTimeout(() => this.finishStop(), 3000);
  }

  private finishStop(): void {
    clearTimeout(this.doneTimer);
    const done = this.onDone;
    this.onDone = null;
    this.onChunk = () => {}; // the tail is in; ignore anything late now
    if (done) done();
  }

  destroy(): void {
    clearTimeout(this.doneTimer);
    this.win?.destroy();
    this.win = null;
  }
}
