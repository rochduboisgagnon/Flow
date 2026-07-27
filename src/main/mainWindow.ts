import { BrowserWindow } from "electron";
import path from "node:path";
import { THEME_BG, THEME_TITLEBAR, type ResolvedTheme } from "../shared/theme";
import { TITLEBAR_H } from "../shared/constants";

// The main window (plan V1, A1): Flow's own face, now that the Manager no
// longer hosts the settings. Three rules, all engine-protecting:
//  - LAZY: the window is created on first show(), never at boot. The engine
//    (hook, ASR, API) must come up at full speed whether or not anyone looks.
//  - CLOSE = HIDE: closing the window never kills the engine. Real quit goes
//    through the tray or app.quit(), which flips `quitting` in before-quit.
//  - The window is an ORDINARY consumer of engine state over IPC. It owns
//    nothing; killing it loses nothing.
export class MainWindow {
  private win: BrowserWindow | null = null;
  private quitting = false;
  // U0: the last resolved theme, kept even while the window is hidden/absent
  // so a create-after-a-theme-flip show() paints the right color from frame 1
  // instead of the "dark" the class was built with.
  private resolved: ResolvedTheme = "dark";
  // Review U1j: fired on every native "show"/"restore". Both push channels
  // (the 1 Hz timer and pushNow) are visibility-gated, so WITHOUT this a
  // theme flip or status change that happened while the window was hidden
  // reaches the renderer only on the next timer tick - up to a full second of
  // a dark page under already-light native caption buttons on reopen.
  private onShowCb: (() => void) | null = null;

  setOnShow(cb: () => void): void {
    this.onShowCb = cb;
  }

  /** Create (if needed) and show the window. Safe to call repeatedly. */
  show(dev: boolean): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 1100,
      height: 740,
      minWidth: 900,
      minHeight: 600,
      show: false, // shown on ready-to-show: no white flash
      autoHideMenuBar: true,
      // What Chromium paints during resize/maximize, before the page itself
      // has painted a pixel - must track the CURRENTLY resolved theme (U0).
      backgroundColor: THEME_BG[this.resolved],
      // U1: the OS keeps drawing the caption buttons, we just take the bar.
      // titleBarStyle "hidden" + titleBarOverlay means Windows still owns
      // min/max/close - so Snap Layouts on maximize-hover, correct hit targets
      // and hovers at every DPI, and the close button's red all come for free,
      // where frame:false would have thrown them away and forced us to redraw
      // (badly) what the OS already does. "hidden" WITHOUT the overlay is the
      // one state that must never exist: a window nobody can close.
      // height MUST equal the CSS --titlebar-h, otherwise the native buttons
      // float above or below the custom row - hence the shared TITLEBAR_H.
      ...(process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: { ...THEME_TITLEBAR[this.resolved], height: TITLEBAR_H },
          }
        : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed preloads cannot require() relative files (Electron 20+),
        // same constraint as the overlay/capture windows.
        sandbox: false,
        // U1b: synchronous pre-paint theme channel. The renderer's first paint
        // happens before getState() resolves, so without this a light-theme
        // user would eat one dark frame on every open. Read at process start,
        // so the value set at this ONE-TIME window creation is correct.
        additionalArguments: ["--flow-theme=" + this.resolved],
      },
    });
    this.win.once("ready-to-show", () => this.win?.show());
    // Native events, not our show() method: they also cover a taskbar-click
    // restore of a minimized window, which never goes through show().
    this.win.on("show", () => this.onShowCb?.());
    this.win.on("restore", () => this.onShowCb?.());
    this.win.on("close", (e) => {
      // Closing hides; the engine keeps running (tray keeps the app reachable).
      if (!this.quitting) {
        e.preventDefault();
        this.win?.hide();
      }
    });
    if (dev) void this.win.loadURL("http://localhost:5183/main.html");
    else void this.win.loadFile(path.join(__dirname, "..", "renderer", "main.html"));
  }

  /** before-quit flips this so the close handler lets the window die. */
  setQuitting(v: boolean): void {
    this.quitting = v;
  }

  /** U0: applies (and remembers) the resolved theme's background paint. Called
   * on EVERY theme flip, window visible or hidden - not just at show() time -
   * so a maximize right after a hidden-window theme change never flashes the
   * previous theme's color before the page repaints. */
  applyTheme(resolved: ResolvedTheme): void {
    this.resolved = resolved;
    if (this.win && !this.win.isDestroyed()) {
      this.win.setBackgroundColor(THEME_BG[resolved]);
      // U1: recolor the NATIVE caption buttons on the same flip, or they keep
      // the other theme's ink over the new background. try/catch because the
      // API throws when the window has no overlay to update - a window built
      // on a platform where we did not pass titleBarOverlay at all.
      if (process.platform === "win32") {
        try {
          this.win.setTitleBarOverlay({ ...THEME_TITLEBAR[resolved], height: TITLEBAR_H });
        } catch {
          // No overlay on this window: the background repaint above is enough.
        }
      }
    }
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** The live webContents when the window exists (for state pushes). */
  contents(): Electron.WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }
}
