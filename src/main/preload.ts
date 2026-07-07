import { contextBridge, ipcRenderer } from "electron";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  CAPTURE_DONE,
  CAPTURE_ERROR,
  SETTINGS_GET,
  SETTINGS_SET,
  SHORTCUT_RECORD,
  OPEN_MIC_SETTINGS,
  OLLAMA_MODELS,
  MODEL_STATE,
  type CaptureStartPayload,
  type ModelStatePayload,
  type ModelChoice,
} from "../shared/ipcContracts";
import type { FlowSettings } from "./settings";

export type CaptureCommand = "start" | "stop" | "cancel";

export interface SettingsBundle {
  settings: FlowSettings;
  models: readonly ModelChoice[];
}

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
  // Settings window side.
  getSettings(): Promise<SettingsBundle> {
    return ipcRenderer.invoke(SETTINGS_GET) as Promise<SettingsBundle>;
  },
  setSettings(patch: Partial<FlowSettings>): Promise<FlowSettings> {
    return ipcRenderer.invoke(SETTINGS_SET, patch) as Promise<FlowSettings>;
  },
  /** Resolves with the newly applied combo, or null on cancel/timeout. */
  recordShortcut(): Promise<string[] | null> {
    return ipcRenderer.invoke(SHORTCUT_RECORD) as Promise<string[] | null>;
  },
  onModelState(cb: (state: ModelStatePayload) => void) {
    ipcRenderer.on(MODEL_STATE, (_e, s: ModelStatePayload) => cb(s));
  },
  openMicSettings(): Promise<void> {
    return ipcRenderer.invoke(OPEN_MIC_SETTINGS) as Promise<void>;
  },
  listOllamaModels(): Promise<string[] | null> {
    return ipcRenderer.invoke(OLLAMA_MODELS) as Promise<string[] | null>;
  },
};

export type AgrflowApi = typeof api;
contextBridge.exposeInMainWorld("agrflow", api);
