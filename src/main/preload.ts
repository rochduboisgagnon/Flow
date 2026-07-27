import { contextBridge, ipcRenderer } from "electron";
import type { ResolvedTheme } from "../shared/theme";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  CAPTURE_DONE,
  CAPTURE_ERROR,
  NATIVE_START,
  NATIVE_STOP,
  NATIVE_CHUNK,
  NATIVE_ERROR,
  NATIVE_READY,
  NATIVE_DONE,
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
  type CaptureStartPayload,
  type NativeStartPayload,
  type UiStatePayload,
  type UpdateCheckResult,
} from "../shared/ipcContracts";

export type CaptureCommand = "start" | "stop" | "cancel";

// Thin, typed bridge; the overlay is the only window using the capture side.
const api = {
  versions: {
    app: process.env.npm_package_version ?? "",
    electron: process.versions.electron,
    node: process.versions.node,
  },
  onCaptureCommand(cb: (cmd: CaptureCommand, cfg?: CaptureStartPayload) => void) {
    ipcRenderer.on(CAPTURE_START, (_e, cfg: CaptureStartPayload) => cb("start", cfg));
    ipcRenderer.on(CAPTURE_STOP, () => cb("stop"));
    ipcRenderer.on(CAPTURE_CANCEL, () => cb("cancel"));
  },
  sendCaptureDone(wav: ArrayBuffer, durationMs: number) {
    ipcRenderer.send(CAPTURE_DONE, { wav, durationMs });
  },
  sendCaptureError(message: string) {
    ipcRenderer.send(CAPTURE_ERROR, message);
  },
  // C2: native loopback capture bridge (used only by the hidden capture window).
  onNativeCommand(cb: (cmd: "start" | "stop", cfg?: NativeStartPayload) => void) {
    ipcRenderer.on(NATIVE_START, (_e, cfg: NativeStartPayload) => cb("start", cfg));
    ipcRenderer.on(NATIVE_STOP, () => cb("stop"));
  },
  sendNativeChunk(pcm: ArrayBuffer) {
    ipcRenderer.send(NATIVE_CHUNK, pcm);
  },
  sendNativeReady() {
    ipcRenderer.send(NATIVE_READY);
  },
  sendNativeDone() {
    ipcRenderer.send(NATIVE_DONE);
  },
  sendNativeError(message: string) {
    ipcRenderer.send(NATIVE_ERROR, message);
  },
};

export type AgrflowApi = typeof api;
contextBridge.exposeInMainWorld("agrflow", api);

// U1b: read the pre-paint theme argv once at preload load. main.tsx reads
// this BEFORE createRoot to set html.light ahead of the first paint; the
// overlay and capture windows get this same preload too but ignore the field.
const flowThemeArg = process.argv.find((a) => a.startsWith("--flow-theme="));
const initialTheme: ResolvedTheme = flowThemeArg === "--flow-theme=light" ? "light" : "dark";

// ---- main window bridge (plan V1, A1/A2) ----
// Shared preload: the overlay and capture windows see this too, but the
// main-process handlers refuse any sender that is not the main window.
const ui = {
  initialTheme,
  getState: (): Promise<UiStatePayload> => ipcRenderer.invoke(UI_GET_STATE),
  setSettings: (patch: Record<string, unknown>): Promise<UiStatePayload> =>
    ipcRenderer.invoke(UI_SET_SETTINGS, patch),
  /** Long-poll: resolves when the user finishes the gesture (or the 10 s
   * recorder timeout). While it runs, EVERY key is swallowed system-wide. */
  recordShortcut: (): Promise<{ combo: string[] | null; comboLabel?: string }> =>
    ipcRenderer.invoke(UI_RECORD_SHORTCUT),
  listMics: (): Promise<Array<{ id: string; label: string }>> =>
    ipcRenderer.invoke(UI_LIST_MICS),
  ollamaModels: (): Promise<string[] | null> => ipcRenderer.invoke(UI_OLLAMA_MODELS),
  openPath: (which: "log" | "data" | "history" | "legacy-history" | "repo"): Promise<void> =>
    ipcRenderer.invoke(UI_OPEN_PATH, which),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(UI_PICK_FOLDER),
  getLoginItem: (): Promise<boolean> => ipcRenderer.invoke(UI_GET_LOGIN_ITEM),
  setLoginItem: (on: boolean): Promise<boolean> => ipcRenderer.invoke(UI_SET_LOGIN_ITEM, on),
  checkUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(UI_CHECK_UPDATES),
  onState(cb: (s: UiStatePayload) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, s: UiStatePayload) => cb(s);
    ipcRenderer.on(UI_STATE_PUSH, handler);
    return () => ipcRenderer.removeListener(UI_STATE_PUSH, handler);
  },
};

export type FlowUiApi = typeof ui;
contextBridge.exposeInMainWorld("flowui", ui);
