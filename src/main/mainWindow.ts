import { BrowserWindow } from "electron";
import path from "node:path";
import { THEME_BG, type ResolvedTheme } from "../shared/theme";

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
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed preloads cannot require() relative files (Electron 20+),
        // same constraint as the overlay/capture windows.
        sandbox: false,
      },
    });
    this.win.once("ready-to-show", () => this.win?.show());
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
    if (this.win && !this.win.isDestroyed()) this.win.setBackgroundColor(THEME_BG[resolved]);
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
