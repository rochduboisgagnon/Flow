import { BrowserWindow, screen } from "electron";
import path from "node:path";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
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
  private pendingStart = false;

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
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true); // clicks pass through to whatever is under it
    this.win.webContents.on("did-finish-load", () => {
      this.ready = true;
      if (this.pendingStart) {
        this.pendingStart = false;
        this.startCapture();
      }
    });
    if (dev) this.win.loadURL("http://localhost:5183/overlay.html");
    else this.win.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
  }

  startCapture() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.ready) {
      this.pendingStart = true;
      return;
    }
    this.win.showInactive(); // show WITHOUT focusing
    this.win.webContents.send(CAPTURE_START);
  }

  stopCapture() {
    this.pendingStart = false;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(CAPTURE_STOP);
    this.win.hide();
  }

  cancelCapture() {
    this.pendingStart = false;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(CAPTURE_CANCEL);
    this.win.hide();
  }

  destroy() {
    this.win?.destroy();
    this.win = null;
  }
}
