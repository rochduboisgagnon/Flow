import { BrowserWindow, screen } from "electron";
import path from "node:path";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  type CaptureStartPayload,
} from "../shared/ipcContracts";
import { OverlayVisibility } from "./overlayVisibility";

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
  // Overlap guard (bug Roch: sometimes the animation does not show on press). The window is SHARED
  // and persistent; re-pressing PTT while the previous utterance was still finalizing let the OLD
  // flowDone()/safety-timer hide the NEW capture. The hide policy lives in a pure, unit-tested state
  // machine (overlayVisibility.ts); here we just show/hide when it says so.
  private vis = new OverlayVisibility();

  create(dev: boolean) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    // The overlay is just the animation, no pill. The window only has to hold the canvas plus its
    // drop-shadow halo without clipping; it stays transparent + click-through, so this size is
    // invisible to the user. Roch 2026-07-15: the ribbon shrank to 170x32 (renderer/overlay.tsx),
    // so the window follows - a 440x112 window around a 170x32 ribbon would push the (bottom-
    // anchored) animation needlessly far up the screen. Keep the two in step.
    const W = 220;
    const H = 60;
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
        // The window is hidden between dictations; without this, Chromium throttles the
        // canvas requestAnimationFrame and the ribbon can be blank or late right after a
        // showInactive(). Keep it painting so the animation is there the instant it shows.
        backgroundThrottling: false,
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
    // A new press takes over the shared window: any pending hide from a previous
    // utterance is now stale and must not fire.
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.vis.onStart();
    if (!this.ready) {
      this.pendingStart = cfg;
      return;
    }
    this.win.setAlwaysOnTop(true, "screen-saver"); // re-assert above any fullscreen app
    this.reposition(); // anchor on the display under the cursor (multi-monitor)
    this.win.showInactive(); // show WITHOUT focusing
    this.win.webContents.send(CAPTURE_START, cfg);
  }

  stopCapture() {
    this.pendingStart = null;
    this.vis.onStop();
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(CAPTURE_STOP);
    // Stay visible: the renderer shows "Transcribing..." until the text is routed
    // (flowDone), hiding the model's latency behind honest feedback. A safety timer
    // guarantees the overlay can never linger forever, even if a pipeline never signals.
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.vis.onSafetyTimeout()) this.hideNow();
    }, 10_000);
  }

  /** The utterance finished its journey (inserted, clipboarded, or dropped). */
  flowDone() {
    if (this.vis.onDone()) this.hideNow();
  }

  cancelCapture() {
    this.pendingStart = null;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(CAPTURE_CANCEL);
    // A tapped/aborted press must not yank the overlay from under a PREVIOUS utterance
    // that is still transcribing: only hide when nothing is live.
    if (this.vis.onCancel()) this.hideNow();
  }

  private hideNow() {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
  }

  /** Anchor the strip at the bottom-centre of the display under the cursor, recomputed on
   * each press: the create()-time position is fixed to the primary display, so dictating on
   * a second monitor would put the ribbon on the wrong screen ("it did not show"). */
  private reposition() {
    if (!this.win || this.win.isDestroyed()) return;
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = this.win.getSize();
    this.win.setPosition(
      Math.round(wa.x + (wa.width - w) / 2),
      Math.round(wa.y + wa.height - h - 24),
    );
  }

  /** Microphone list for the Manager's settings view. Device enumeration
   * needs a renderer; the overlay page exposes window.__agrflowListMics
   * (main world, so executeJavaScript reaches it despite contextIsolation). */
  async listMics(): Promise<Array<{ id: string; label: string }>> {
    if (!this.win || this.win.isDestroyed() || !this.ready) return [];
    try {
      const out = (await this.win.webContents.executeJavaScript(
        "window.__agrflowListMics ? window.__agrflowListMics() : []",
        true,
      )) as Array<{ id: string; label: string }>;
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }

  destroy() {
    this.win?.destroy();
    this.win = null;
  }
}
