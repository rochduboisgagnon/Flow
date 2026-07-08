import { contextBridge, ipcRenderer } from "electron";
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
  type CaptureStartPayload,
  type NativeStartPayload,
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
