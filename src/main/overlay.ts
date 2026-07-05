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
    if (dev) this.win.loadURL("http://localhost:5183/overlay.html");
    else this.win.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
  }

  startCapture() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.showInactive(); // show WITHOUT focusing
    this.win.webContents.send(CAPTURE_START);
  }

  stopCapture() {
    this.win?.webContents.send(CAPTURE_STOP);
    this.win?.hide();
  }

  cancelCapture() {
    this.win?.webContents.send(CAPTURE_CANCEL);
    this.win?.hide();
  }

  destroy() {
    this.win?.destroy();
    this.win = null;
  }
}
