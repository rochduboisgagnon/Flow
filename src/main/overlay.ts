import { BrowserWindow, screen } from "electron";
import path from "node:path";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  LONG_START,
  LONG_STOP,
  type CaptureStartPayload,
} from "../shared/ipcContracts";

// The overlay window: a small transparent strip near the bottom of the screen,
// shown while dictating. HARD CONSTRAINT: it must NEVER take focus - the whole
// product inserts into the field the user was in; stealing focus would make
// the focus probe (and the insertion) target ourselves.
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  // A PTT press in the first second after boot can beat the renderer's load:
  // sending CAPTURE_START into a page with no listener would silently lose the
  // dictation. Defer the last START until did-finish-load; a stop/cancel that
  // arrives meanwhile clears it (nothing was captured, nothing to deliver).
  private ready = false;
  private pendingStart: CaptureStartPayload | null = null;
  private hideTimer: NodeJS.Timeout | undefined;

  create(dev: boolean) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const W = 320;
    const H = 52;
    this.win = new BrowserWindow({
      width: W,
      height: H,
      x: Math.round((width - W) / 2),
      y: height - H - 24,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false, // never steal focus from the dictation target
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed preloads cannot require() relative files (Electron 20+):
        // ours pulls ../shared/ipcContracts, so the preload silently failed to
        // load and window.agrflow never existed - no capture at all in the
        // packaged app. contextIsolation stays on; both windows load only our
        // own local pages.
        sandbox: false,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true); // clicks pass through to whatever is under it
    this.win.webContents.on("did-finish-load", () => {
      this.ready = true;
      if (this.pendingStart) {
        const cfg = this.pendingStart;
        this.pendingStart = null;
        this.startCapture(cfg);
      }
    });
    if (dev) this.win.loadURL("http://localhost:5183/overlay.html");
    else this.win.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
  }

  startCapture(cfg: CaptureStartPayload) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.ready) {
      this.pendingStart = cfg;
      return;
    }
    this.win.showInactive(); // show WITHOUT focusing
    this.win.webContents.send(CAPTURE_START, cfg);
  }

  stopCapture() {
    this.pendingStart = null;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(CAPTURE_STOP);
    // Stay visible: the renderer shows "Transcribing..." until the text is
    // routed (flowDone), hiding the model's latency behind honest feedback.
    // A safety timer guarantees the overlay can never linger forever.
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.win?.hide(), 10_000);
  }

  /** The utterance finished its journey (inserted, clipboarded, or dropped). */
  flowDone() {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
  }

  cancelCapture() {
    this.pendingStart = null;
    clearTimeout(this.hideTimer);
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(CAPTURE_CANCEL);
    this.win.hide();
  }

  // ---- long-form capture (plan §6): the pill stays visible for the whole
  // recording (red dot + elapsed), chunks stream to main every few seconds. ----
  startLong(cfg: CaptureStartPayload) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.ready) return; // long mode is user-driven, never boot-raced
    this.win.showInactive();
    this.win.webContents.send(LONG_START, cfg);
  }

  stopLong() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(LONG_STOP);
    this.win.hide();
  }

  destroy() {
    this.win?.destroy();
    this.win = null;
  }
}
