import { Tray, Menu, nativeImage, app, dialog, type BrowserWindow } from "electron";
import { resourcePath } from "./resources";

// The tray (plan V1, A3): the app's ONLY always-there surface once the main
// window is closed (mainWindow.ts hides rather than kills on close). Without
// it, a headless-looking engine with no visible off switch is a support
// nightmare - this gives the user "open", "pause", and "quit" at all times.
//
// Review A10: the tray is NOT a writer of the engine's status line. Its first
// design wrote "dictation paused" into statusText and restored the old text on
// resume - which silently erased any engine error that happened DURING the
// pause. Pause is now an overlay state the tray merely exposes
// (pausedUntilMs); index.ts DERIVES the displayed line from it, the same way
// it already derives the updater's "update ready" notice. One writer, layered
// readers.
export interface FlowTrayDeps {
  /** Reveal (creating if needed) the main window. */
  showWindow(): void;
  /** Current DERIVED status line, for the tooltip only. */
  getStatus(): string;
  /** Suspend/resume the push-to-talk hotkey (HotkeyAdapter.suspend). */
  pauseHotkey(paused: boolean): void;
  /** U4 (blocking review): longRec.isBusy - a long recording running or still
   * finalizing. The updater already holds itself back on this exact value; the
   * tray's own "Quit Flow" was the one control that quit straight through it,
   * with no way for the user to know a meeting was in flight. */
  isRecording(): boolean;
  /** The main window, when it exists, so the confirmation is parented to it
   * instead of opening as a detached app-modal box behind everything. Null is
   * normal (the window is lazy and may never have been shown). */
  parentWindow(): BrowserWindow | null;
}

const PAUSE_MS = 30 * 60 * 1000;
// The tooltip and the menu label only need minute-level freshness for the
// "Nm left" countdown - unlike the main window's 1 Hz push (uiBridge.ts), the
// tray has no visible surface demanding faster updates.
const REFRESH_MS = 30_000;

export class FlowTray {
  private tray: Tray | null = null;
  private deps: FlowTrayDeps;
  private refreshTimer: NodeJS.Timeout | undefined;
  private pauseTimer: NodeJS.Timeout | undefined;
  private pausedUntil: number | null = null; // epoch ms; null = not paused

  constructor(deps: FlowTrayDeps) {
    this.deps = deps;
    const img = nativeImage.createFromPath(resourcePath("icon.png")).resize({ width: 16, height: 16 });
    this.tray = new Tray(img);
    this.tray.on("double-click", () => this.deps.showWindow());
    this.rebuild();
    this.refreshTimer = setInterval(() => this.rebuild(), REFRESH_MS);
  }



  /** The overlay state index.ts derives the status line from. null = active. */
  pausedUntilMs(): number | null {
    return this.pausedUntil;
  }

  /** B4: repaint the tooltip NOW, because something the derived status line
   * depends on just changed. The 30 s timer below is calibrated for a countdown
   * that moves once a minute; a keyboard-hook outage that is detected, restarted
   * and healed inside two seconds would never appear on it at all. And the
   * tooltip is the only surface left once every window is closed - exactly the
   * state in which the user assumes dictation still works. */
  refreshNow(): void {
    this.rebuild();
  }

  private get paused(): boolean {
    return this.pausedUntil !== null;
  }

  private minutesLeft(): number {
    if (this.pausedUntil === null) return 0;
    // Ceil so the label reads "1m left" until the very last second, never "0m".
    return Math.max(1, Math.ceil((this.pausedUntil - Date.now()) / 60_000));
  }

  private togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  private pause(): void {
    this.pausedUntil = Date.now() + PAUSE_MS;
    this.deps.pauseHotkey(true);
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => this.resume(), PAUSE_MS);
    this.rebuild();
  }

  private resume(): void {
    if (!this.paused) return;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    this.pausedUntil = null;
    this.deps.pauseHotkey(false);
    // Nothing to restore: this class never overwrote the status line, so
    // whatever the engine has to say (including an error raised mid-pause)
    // is simply visible again through the derived line.
    this.rebuild();
  }

  private rebuild(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      { label: "Open Flow", click: () => this.deps.showWindow() },
      { type: "separator" },
      {
        label: this.paused ? `Resume dictation (${this.minutesLeft()}m left)` : "Pause dictation for 30 min",
        click: () => this.togglePause(),
      },
      { type: "separator" },
      { label: "Quit Flow", click: () => this.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`Flow - ${this.deps.getStatus()}`);
  }

  /** U4 (blocking review): "Quit Flow" used to call app.quit() without ever
   * looking at whether a recording was running - the same isBusy the updater
   * already refuses to install through. Quitting mid-meeting is still allowed
   * (before-quit's rescueOnQuit files the document into the archive whatever
   * the user chooses here, so nothing is lost either way); what was missing is
   * that nobody TOLD them, and a meeting filed without its summary or its
   * queued transcription is not what someone clicking a menu item expects. */
  private quit(): void {
    if (this.deps.isRecording() && !this.confirmQuit()) return;
    app.quit();
  }

  /** Synchronous on purpose: this runs inside a menu click, and the answer has
   * to gate the quit that follows it on the same tick. */
  private confirmQuit(): boolean {
    const opts: Electron.MessageBoxSyncOptions = {
      type: "warning",
      buttons: ["Keep recording", "Quit anyway"],
      defaultId: 0,
      cancelId: 0, // Esc / the close button = the safe answer
      noLink: true,
      title: "Flow is recording",
      message: "A recording is still running.",
      detail:
        "Flow will file it into your recordings as it stands: it gets no summary, " +
        "and any audio still waiting to be transcribed is lost.",
    };
    const parent = this.deps.parentWindow();
    const choice = parent ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
    return choice === 1;
  }

  destroy(): void {
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    this.tray?.destroy();
    this.tray = null;
  }
}
