import { contextBridge, ipcRenderer, webUtils } from "electron";
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
  DECODE_BYTES,
  DECODE_PROBE,
  DECODE_RUN,
  DECODE_CANCEL,
  DECODE_FLOW,
  DECODE_META,
  DECODE_PCM,
  DECODE_DONE,
  DECODE_ERROR,
  UI_IMPORT_STATE,
  UI_IMPORT_START,
  UI_IMPORT_CANCEL,
  UI_IMPORT_PICK,
  UI_GET_STATE,
  UI_SET_SETTINGS,
  UI_RECORD_SHORTCUT,
  UI_LIST_MICS,
  UI_DOWNLOAD_NOTES_MODEL,
  UI_OPEN_PATH,
  UI_GET_LOGIN_ITEM,
  UI_SET_LOGIN_ITEM,
  UI_CHECK_UPDATES,
  UI_STATE_PUSH,
  UI_HOTPATH_SNAPSHOT,
  UI_SELF_CHECK,
  UI_STATS_READ,
  UI_HISTORY_READ,
  UI_HISTORY_CLEAR,
  UI_STATS_CLEAR,
  UI_DICT_LIST,
  UI_DICT_SAVE,
  UI_DICT_DELETE,
  UI_LONG_STATE,
  UI_LONG_START,
  UI_LONG_STOP,
  UI_LONG_MARK,
  UI_LONG_TRANSCRIPT,
  UI_LIVE_NOTES_LIST,
  UI_LIVE_NOTES_ADD,
  UI_LIVE_NOTES_EDIT,
  UI_LIVE_NOTES_DELETE,
  UI_HISTORY_LIST,
  UI_HISTORY_DELETE,
  UI_HISTORY_DOC,
  UI_DOWNLOAD_DOC,
  UI_DOWNLOAD_AUDIO,
  UI_REDACT_PASSAGES,
  type CaptureStartPayload,
  type CaptureWarmPayload,
  type CaptureTimingPayload,
  type NativeStartPayload,
  type DecodeBytesPayload,
  type DecodeTokenPayload,
  type DecodeFlowPayload,
  type DecodeMetaPayload,
  type DecodePcmPayload,
  type DecodeDonePayload,
  type DecodeErrorPayload,
  type ImportQueueSnapshot,
  type ImportStartResult,
  type UiStatePayload,
  type UpdateCheckResult,
  type DictInput,
  type DictResult,
  type UiLongStartRequest,
  type LongStateSnapshot,
  type LongStartResult,
  type LongStopResult,
  type LongTranscriptResult,
  type LiveNotesResult,
  type HistoryItem,
  type HistoryDocPayload,
  type DownloadResult,
  type RedactTarget,
  type RedactResult,
  type HotpathSnapshot,
  type SelfCheckReport,
  type StatsPayload,
  type HistoryPayload,
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
  // V4 D1: the hidden decode window's bridge. ONE callback for the four
  // main->window commands, same reasoning as onCaptureWarm above: the renderer
  // has a single place that decides what to do with a job, so two commands can
  // never end up handled by two subtly different pieces of code.
  onDecodeCommand(
    cb: (
      cmd: "bytes" | "probe" | "run" | "cancel" | "flow",
      payload: DecodeBytesPayload | DecodeTokenPayload | DecodeFlowPayload,
    ) => void,
  ) {
    ipcRenderer.on(DECODE_BYTES, (_e, p: DecodeBytesPayload) => cb("bytes", p));
    ipcRenderer.on(DECODE_PROBE, (_e, p: DecodeTokenPayload) => cb("probe", p));
    ipcRenderer.on(DECODE_RUN, (_e, p: DecodeTokenPayload) => cb("run", p));
    ipcRenderer.on(DECODE_CANCEL, (_e, p: DecodeTokenPayload) => cb("cancel", p));
    ipcRenderer.on(DECODE_FLOW, (_e, p: DecodeFlowPayload) => cb("flow", p));
  },
  sendDecodeMeta(p: DecodeMetaPayload) {
    ipcRenderer.send(DECODE_META, p);
  },
  sendDecodePcm(p: DecodePcmPayload) {
    ipcRenderer.send(DECODE_PCM, p);
  },
  sendDecodeDone(p: DecodeDonePayload) {
    ipcRenderer.send(DECODE_DONE, p);
  },
  sendDecodeError(p: DecodeErrorPayload) {
    ipcRenderer.send(DECODE_ERROR, p);
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
  downloadNotesModel: (): Promise<void> => ipcRenderer.invoke(UI_DOWNLOAD_NOTES_MODEL),
  openPath: (which: "log" | "data" | "history" | "legacy-history" | "repo" | "downloaded-file"): Promise<void> =>
    ipcRenderer.invoke(UI_OPEN_PATH, which),
  getLoginItem: (): Promise<boolean> => ipcRenderer.invoke(UI_GET_LOGIN_ITEM),
  setLoginItem: (on: boolean): Promise<boolean> => ipcRenderer.invoke(UI_SET_LOGIN_ITEM, on),
  checkUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(UI_CHECK_UPDATES),
  // ---- dictionary (U6): PULL-only, and all three answer with the WHOLE
  // dictionary - including dictDelete - so the page replaces its list with what
  // comes back rather than mutating its own copy and drifting from disk.
  // ---- voice functions (V5): PULL-only, and all three writes answer with the
  // WHOLE library - same contract as the dictionary above, so the page replaces
  // its list with what comes back rather than mutating its own copy.
  /** The dry run: what a dictation of this exact text would produce. SLOW by
   * nature - it calls the local model - and it inserts nothing anywhere. */
  dictList: (): Promise<DictResult> => ipcRenderer.invoke(UI_DICT_LIST),
  dictSave: (input: DictInput): Promise<DictResult> => ipcRenderer.invoke(UI_DICT_SAVE, input),
  dictDelete: (id: string): Promise<DictResult> => ipcRenderer.invoke(UI_DICT_DELETE, id),
  // ---- long-form recorder (U4a): IPC surface only, no page yet. PULL-only
  // like state above - the page will poll longTranscript at 1 Hz
  // rather than have the engine push a growing document every second.
  longState: (): Promise<LongStateSnapshot> => ipcRenderer.invoke(UI_LONG_STATE),
  longStart: (opts: UiLongStartRequest): Promise<LongStartResult> => ipcRenderer.invoke(UI_LONG_START, opts),
  longStop: (): Promise<LongStopResult> => ipcRenderer.invoke(UI_LONG_STOP),
  longMark: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(UI_LONG_MARK),
  longTranscript: (since: number): Promise<LongTranscriptResult> => ipcRenderer.invoke(UI_LONG_TRANSCRIPT, since),
  // ---- live notes (D7): PULL, and every channel answers with the WHOLE list
  // plus the recording it belongs to (see ipcContracts.ts). `startedIso` is
  // passed on every call, never remembered on this side: the page states which
  // recording it believes it is annotating and main refuses a mismatch, which is
  // what stops a note from landing on the next meeting.
  liveNotesList: (): Promise<LiveNotesResult> => ipcRenderer.invoke(UI_LIVE_NOTES_LIST),
  liveNoteAdd: (startedIso: string, text: string): Promise<LiveNotesResult> =>
    ipcRenderer.invoke(UI_LIVE_NOTES_ADD, startedIso, text),
  liveNoteEdit: (startedIso: string, id: string, text: string): Promise<LiveNotesResult> =>
    ipcRenderer.invoke(UI_LIVE_NOTES_EDIT, startedIso, id, text),
  liveNoteDelete: (startedIso: string, id: string): Promise<LiveNotesResult> =>
    ipcRenderer.invoke(UI_LIVE_NOTES_DELETE, startedIso, id),
  // ---- archive browser (U5a): PULL, on demand - never cached like state's
  // `recent` field (see ipcContracts.ts's module note), so the Notes page
  // always sees the exact on-disk archive.
  historyList: (): Promise<HistoryItem[]> => ipcRenderer.invoke(UI_HISTORY_LIST),
  historyDelete: (id: string): Promise<HistoryItem[]> => ipcRenderer.invoke(UI_HISTORY_DELETE, id),
  historyDoc: (id: string): Promise<HistoryDocPayload | null> => ipcRenderer.invoke(UI_HISTORY_DOC, id),
  // ---- capture downloads (U5c): id in, never a path - main resolves and
  // writes straight into the OS Downloads folder, no dialog.
  downloadDoc: (id: string): Promise<DownloadResult> => ipcRenderer.invoke(UI_DOWNLOAD_DOC, id),
  downloadAudio: (id: string): Promise<DownloadResult> => ipcRenderer.invoke(UI_DOWNLOAD_AUDIO, id),
  // ---- audio file import (V4, D1/D2): PULL, at the page's own cadence. An
  // import runs for minutes; polling importState is how a page follows it
  // without the engine pushing a growing object once a second.
  importState: (): Promise<ImportQueueSnapshot | null> => ipcRenderer.invoke(UI_IMPORT_STATE),
  importStart: (req: { paths: string[]; keepAudio?: boolean; notes?: boolean }): Promise<ImportStartResult> =>
    ipcRenderer.invoke(UI_IMPORT_START, req),
  importCancel: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(UI_IMPORT_CANCEL, id),
  /** The native picker, opened by MAIN: the safest possible source of paths, and
   * the only way in for a user who does not drag files. */
  importPick: (): Promise<string[]> => ipcRenderer.invoke(UI_IMPORT_PICK),
  /** The path behind a dropped File. Electron removed File.path (32+), so a
   * drag-and-drop page cannot obtain it on its own - webUtils lives in the
   * preload precisely for this. Returns "" rather than throwing for anything
   * that is not a real file (a dragged selection of text, a browser URL), so a
   * page can filter without a try/catch. */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  // ---- removing a passage (D11): id + passage targets in, never a path and
  // never the text. IRREVERSIBLE - the page must have confirmed against the
  // exact text and ranges before this is ever called (see ipcContracts.ts).
  redactPassages: (id: string, targets: RedactTarget[]): Promise<RedactResult> =>
    ipcRenderer.invoke(UI_REDACT_PASSAGES, id, targets),
  onState(cb: (s: UiStatePayload) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, s: UiStatePayload) => cb(s);
    ipcRenderer.on(UI_STATE_PUSH, handler);
    return () => ipcRenderer.removeListener(UI_STATE_PUSH, handler);
  },
  // ---- activation hot-path diagnostics (V2, B1): PULL -
  // the Diagnostics page polls this on its own schedule rather than riding
  // the 1 Hz UiStatePayload push (see ipcContracts.ts's module note).
  hotpathSnapshot: (): Promise<HotpathSnapshot | null> => ipcRenderer.invoke(UI_HOTPATH_SNAPSHOT),
  // ---- self-diagnostic (V2, B5): on demand ONLY. Producing it enumerates
  // audio devices and writes a probe file; that belongs to a button press, not
  // to a poll (see ipcContracts.ts's note on UI_SELF_CHECK).
  selfCheck: (): Promise<SelfCheckReport | null> => ipcRenderer.invoke(UI_SELF_CHECK),
  // ---- statistics (U7): PULL, on demand. statsClear answers with the SAME
  // payload shape as statsRead, so the page replaces its state with what comes
  // back instead of assuming what "cleared" looks like (see ipcContracts.ts).
  // ---- dictation history (2026-07-30): PULL, on demand. historyClear answers
  // with the SAME payload shape as historyRead, so the page replaces its state
  // with what comes back instead of guessing what "erased" looks like.
  historyRead: (): Promise<HistoryPayload> => ipcRenderer.invoke(UI_HISTORY_READ),
  historyClear: (): Promise<HistoryPayload> => ipcRenderer.invoke(UI_HISTORY_CLEAR),
  statsRead: (): Promise<StatsPayload> => ipcRenderer.invoke(UI_STATS_READ),
  statsClear: (): Promise<StatsPayload> => ipcRenderer.invoke(UI_STATS_CLEAR),
};

export type FlowUiApi = typeof ui;
contextBridge.exposeInMainWorld("flowui", ui);
