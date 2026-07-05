import { contextBridge, ipcRenderer } from "electron";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  CAPTURE_DONE,
  CAPTURE_ERROR,
} from "../shared/ipcContracts";

export type CaptureCommand = "start" | "stop" | "cancel";

// Thin, typed bridge; the overlay is the only window using the capture side.
const api = {
  versions: {
    app: process.env.npm_package_version ?? "",
    electron: process.versions.electron,
    node: process.versions.node,
  },
  onCaptureCommand(cb: (cmd: CaptureCommand) => void) {
    ipcRenderer.on(CAPTURE_START, () => cb("start"));
    ipcRenderer.on(CAPTURE_STOP, () => cb("stop"));
    ipcRenderer.on(CAPTURE_CANCEL, () => cb("cancel"));
  },
  sendCaptureDone(wav: ArrayBuffer, durationMs: number) {
    ipcRenderer.send(CAPTURE_DONE, { wav, durationMs });
  },
  sendCaptureError(message: string) {
    ipcRenderer.send(CAPTURE_ERROR, message);
  },
};

export type AgrflowApi = typeof api;
contextBridge.exposeInMainWorld("agrflow", api);
