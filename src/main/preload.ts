import { contextBridge, ipcRenderer } from "electron";
import type { ResolvedTheme } from "../shared/theme";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  CAPTURE_WARM,
  CAPTURE_COOL,
  CAPTURE_DONE,
  CAPTURE_ERROR,
  CAPTURE_TIMING,
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
  UI_GET_LOGIN_ITEM,
  UI_SET_LOGIN_ITEM,
  UI_CHECK_UPDATES,
  UI_STATE_PUSH,
  UI_HOTPATH_SNAPSHOT,
  UI_SELF_CHECK,
  UI_SNIPPET_LIST,
  UI_SNIPPET_SAVE,
  UI_SNIPPET_DELETE,
  UI_SNIPPET_COPY,
  UI_LONG_STATE,
  UI_LONG_START,
  UI_LONG_STOP,
  UI_LONG_MARK,
  UI_LONG_TRANSCRIPT,
  UI_HISTORY_LIST,
  UI_HISTORY_DOC,
  UI_DOWNLOAD_DOC,
  UI_DOWNLOAD_AUDIO,
  type CaptureStartPayload,
  type CaptureWarmPayload,
  type CaptureTimingPayload,
  type NativeStartPayload,
  type UiStatePayload,
  type UpdateCheckResult,
  type SnippetInput,
  type SnippetsResult,
  type UiLongStartRequest,
  type LongStateSnapshot,
  type LongStartResult,
  type LongStopResult,
  type LongTranscriptResult,
  type HistoryItem,
  type HistoryDocPayload,
  type DownloadResult,
  type HotpathSnapshot,
  type SelfCheckReport,
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
  /** B2: the microphone pre-warm policy. ONE callback for both channels, with
   * `null` meaning "cool down now" - the renderer has a single place that
   * decides what to do with the microphone, so the two commands can never be
   * handled by two subtly different pieces of code. */
  onCaptureWarm(cb: (cfg: CaptureWarmPayload | null) => void) {
    ipcRenderer.on(CAPTURE_WARM, (_e, cfg: CaptureWarmPayload) => cb(cfg));
    ipcRenderer.on(CAPTURE_COOL, () => cb(null));
  },
  sendCaptureDone(wav: ArrayBuffer, durationMs: number) {
    ipcRenderer.send(CAPTURE_DONE, { wav, durationMs });
  },
  /** B2/B1: two DURATIONS measured on this renderer's own clock (see
   * CaptureTimingPayload). Never timestamps: main turns them into marks by
   * adding them to an instant it recorded itself. */
  sendCaptureTiming(t: CaptureTimingPayload) {
    ipcRenderer.send(CAPTURE_TIMING, t);
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
  openPath: (which: "log" | "data" | "history" | "legacy-history" | "repo" | "downloaded-file"): Promise<void> =>
    ipcRenderer.invoke(UI_OPEN_PATH, which),
  getLoginItem: (): Promise<boolean> => ipcRenderer.invoke(UI_GET_LOGIN_ITEM),
  setLoginItem: (on: boolean): Promise<boolean> => ipcRenderer.invoke(UI_SET_LOGIN_ITEM, on),
  checkUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(UI_CHECK_UPDATES),
  // ---- snippets (U3): PULL-only, always the WHOLE library back (see
  // ipcContracts.ts's module note) - snippetDelete and snippetCopy included,
  // so the page can replace its list with whatever comes back and never be
  // stale after a write it did not itself make.
  snippetList: (): Promise<SnippetsResult> => ipcRenderer.invoke(UI_SNIPPET_LIST),
  snippetSave: (input: SnippetInput): Promise<SnippetsResult> => ipcRenderer.invoke(UI_SNIPPET_SAVE, input),
  snippetDelete: (id: string): Promise<SnippetsResult> => ipcRenderer.invoke(UI_SNIPPET_DELETE, id),
  snippetCopy: (id: string): Promise<SnippetsResult> => ipcRenderer.invoke(UI_SNIPPET_COPY, id),
  // ---- long-form recorder (U4a): IPC surface only, no page yet. PULL-only
  // like snippets/state above - the page will poll longTranscript at 1 Hz
  // rather than have the engine push a growing document every second.
  longState: (): Promise<LongStateSnapshot> => ipcRenderer.invoke(UI_LONG_STATE),
  longStart: (opts: UiLongStartRequest): Promise<LongStartResult> => ipcRenderer.invoke(UI_LONG_START, opts),
  longStop: (): Promise<LongStopResult> => ipcRenderer.invoke(UI_LONG_STOP),
  longMark: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(UI_LONG_MARK),
  longTranscript: (since: number): Promise<LongTranscriptResult> => ipcRenderer.invoke(UI_LONG_TRANSCRIPT, since),
  // ---- archive browser (U5a): PULL, on demand - never cached like state's
  // `recent` field (see ipcContracts.ts's module note), so the Notes page
  // always sees the exact on-disk archive.
  historyList: (): Promise<HistoryItem[]> => ipcRenderer.invoke(UI_HISTORY_LIST),
  historyDoc: (id: string): Promise<HistoryDocPayload | null> => ipcRenderer.invoke(UI_HISTORY_DOC, id),
  // ---- capture downloads (U5c): id in, never a path - main resolves and
  // writes straight into the OS Downloads folder, no dialog.
  downloadDoc: (id: string): Promise<DownloadResult> => ipcRenderer.invoke(UI_DOWNLOAD_DOC, id),
  downloadAudio: (id: string): Promise<DownloadResult> => ipcRenderer.invoke(UI_DOWNLOAD_AUDIO, id),
  onState(cb: (s: UiStatePayload) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, s: UiStatePayload) => cb(s);
    ipcRenderer.on(UI_STATE_PUSH, handler);
    return () => ipcRenderer.removeListener(UI_STATE_PUSH, handler);
  },
  // ---- activation hot-path diagnostics (V2, B1): PULL, like snippets above -
  // the Diagnostics page polls this on its own schedule rather than riding
  // the 1 Hz UiStatePayload push (see ipcContracts.ts's module note).
  hotpathSnapshot: (): Promise<HotpathSnapshot | null> => ipcRenderer.invoke(UI_HOTPATH_SNAPSHOT),
  // ---- self-diagnostic (V2, B5): on demand ONLY. Producing it enumerates
  // audio devices and writes a probe file; that belongs to a button press, not
  // to a poll (see ipcContracts.ts's note on UI_SELF_CHECK).
  selfCheck: (): Promise<SelfCheckReport | null> => ipcRenderer.invoke(UI_SELF_CHECK),
};

export type FlowUiApi = typeof ui;
contextBridge.exposeInMainWorld("flowui", ui);
