import { ipcMain, shell, dialog, app, BrowserWindow } from "electron";
import {
  UI_GET_STATE,
  UI_SET_SETTINGS,
  UI_RECORD_SHORTCUT,
  UI_LIST_MICS,
  UI_OLLAMA_MODELS,
  UI_OPEN_PATH,
  UI_PICK_FOLDER,
  UI_GET_LOGIN_ITEM,
  UI_SET_LOGIN_ITEM,
  UI_CHECK_UPDATES,
  UI_STATE_PUSH,
  type UiStatePayload,
  type UpdateCheckResult,
} from "../shared/ipcContracts";
import type { MainWindow } from "./mainWindow";

// The main window's bridge into the engine (plan V1, A2). One rule above all:
// these handlers call the SAME functions the local HTTP API is built on
// (applySettings and friends, passed in by index.ts). The bridge owns no
// state and never writes settings.json itself - one source of truth.
//
// Security: the preload is shared by the overlay and capture windows, so
// window.flowui exists there too. Every handler therefore refuses senders
// other than the main window (same discipline as NativeCapture's IPC).

export interface UiBridgeDeps {
  getUiState(): UiStatePayload;
  setSettings(patch: Record<string, unknown>): void;
  recordShortcut(): Promise<{ combo: string[] | null; comboLabel?: string }>;
  listMics(): Promise<Array<{ id: string; label: string }>>;
  ollamaModels(): Promise<string[] | null>;
  historyRootDir(): string;
  logPath(): string;
  dataDirPath(): string;
  /** The Updates tab's "Check now" button (A4: FlowUpdater.checkNow). */
  checkUpdates(): Promise<UpdateCheckResult>;
}

const REPO_URL = "https://github.com/rochduboisgagnon/Flow";

// Review A10: getLoginItemSettings() compares the registry entry ARGS-AND-ALL.
// Reading it without the args we register with reports openAtLogin=false
// forever - the toggle then shows OFF while the entry exists, and turning it
// "off" from that state is a no-op. One constant, used by set AND get, so the
// two can never diverge again.
export const LOGIN_ARGS = ["--hidden"];

export class UiBridge {
  private deps: UiBridgeDeps;
  private mainWindow: MainWindow;
  private pushTimer: NodeJS.Timeout | undefined;

  constructor(deps: UiBridgeDeps, mainWindow: MainWindow) {
    this.deps = deps;
    this.mainWindow = mainWindow;
    this.register();
    // Push a coherent snapshot once a second WHILE the window is visible.
    // Hidden window = zero work: the engine must never pay for an unwatched UI.
    this.pushTimer = setInterval(() => {
      if (!this.mainWindow.isVisible()) return;
      this.mainWindow.contents()?.send(UI_STATE_PUSH, this.deps.getUiState());
    }, 1000);
  }

  /** True when the invoke came from the main window (not overlay/capture). */
  private fromMain(e: Electron.IpcMainInvokeEvent): boolean {
    const c = this.mainWindow.contents();
    return c !== null && e.sender === c;
  }

  private register(): void {
    ipcMain.handle(UI_GET_STATE, (e) => {
      if (!this.fromMain(e)) return null;
      return this.deps.getUiState();
    });
    ipcMain.handle(UI_SET_SETTINGS, (e, patch: Record<string, unknown>) => {
      if (!this.fromMain(e)) return null;
      // Same path as POST /settings: applySettings sanitizes and persists.
      this.deps.setSettings(patch && typeof patch === "object" ? patch : {});
      return this.deps.getUiState();
    });
    ipcMain.handle(UI_RECORD_SHORTCUT, async (e) => {
      if (!this.fromMain(e)) return { combo: null };
      return await this.deps.recordShortcut();
    });
    ipcMain.handle(UI_LIST_MICS, async (e) => {
      if (!this.fromMain(e)) return [];
      return await this.deps.listMics();
    });
    ipcMain.handle(UI_OLLAMA_MODELS, async (e) => {
      if (!this.fromMain(e)) return null;
      return await this.deps.ollamaModels();
    });
    ipcMain.handle(UI_OPEN_PATH, async (e, which: unknown) => {
      if (!this.fromMain(e)) return;
      // Fixed destinations only: the renderer never passes a path, so a
      // compromised page cannot use this as an arbitrary-open primitive.
      if (which === "log") await shell.openPath(this.deps.logPath());
      else if (which === "data") await shell.openPath(this.deps.dataDirPath());
      else if (which === "history") await shell.openPath(this.deps.historyRootDir());
      else if (which === "repo") await shell.openExternal(REPO_URL);
    });
    ipcMain.handle(UI_PICK_FOLDER, async (e) => {
      if (!this.fromMain(e)) return null;
      // Without a parent window, the dialog is app-modal and may open behind the frameless main window.
      const wc = this.mainWindow.contents();
      const parent = wc ? BrowserWindow.fromWebContents(wc) : null;
      const r = parent
        ? await dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory"] });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    });
    ipcMain.handle(UI_GET_LOGIN_ITEM, (e) => {
      if (!this.fromMain(e)) return false;
      return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
    });
    ipcMain.handle(UI_SET_LOGIN_ITEM, (e, on: unknown) => {
      if (!this.fromMain(e)) return false;
      // --hidden: a login launch starts the engine without popping the window.
      app.setLoginItemSettings({ openAtLogin: on === true, args: LOGIN_ARGS });
      return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
    });
    ipcMain.handle(UI_CHECK_UPDATES, async (e): Promise<UpdateCheckResult> => {
      if (!this.fromMain(e)) return { ok: false, message: "unavailable" };
      return await this.deps.checkUpdates();
    });
  }

  /** U0: pushes a snapshot immediately instead of waiting for the 1 Hz timer.
   * A theme flip (OS event or in-app toggle) must repaint the window on the
   * SAME tick, not up to a second later - the same visibility guard as the
   * timer, so this stays a no-op while nobody is looking. */
  pushNow(): void {
    if (!this.mainWindow.isVisible()) return;
    this.mainWindow.contents()?.send(UI_STATE_PUSH, this.deps.getUiState());
  }

  stop(): void {
    clearInterval(this.pushTimer);
    this.pushTimer = undefined;
  }
}
