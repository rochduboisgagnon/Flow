// IPC channel names shared by main and the overlay renderer. One place, typed,
// so a renamed channel cannot silently desynchronize the two sides.

import type { ThemePref, ResolvedTheme } from "./theme";

// main -> overlay
export const CAPTURE_START = "capture:start";
export const CAPTURE_STOP = "capture:stop"; // finish and hand the WAV back
export const CAPTURE_CANCEL = "capture:cancel"; // discard everything

// overlay -> main
export const CAPTURE_DONE = "capture:done";
export const CAPTURE_ERROR = "capture:error";

// C2 native loopback capture (Windows-only): a hidden capture window mixes the PC's
// own sound (loopback) with the microphone into one 16 kHz mono stream and streams
// Int16 PCM slices to the engine, which feeds the long recorder directly (no PWA,
// no network hop). main -> capture window:
export const NATIVE_START = "native:start";
export const NATIVE_STOP = "native:stop";
// capture window -> main:
export const NATIVE_CHUNK = "native:chunk"; // one Int16 mono 16 kHz PCM slice (~1 s)
export const NATIVE_ERROR = "native:error";
export const NATIVE_READY = "native:ready"; // the capture graph is live
export const NATIVE_DONE = "native:done"; // the tail has been flushed; the recorder may finalize

export interface NativeStartPayload {
  micDeviceId: string; // "" = system default microphone
  captureSystem: boolean; // also mix in the PC's own sound (loopback)
}

export interface CaptureStartPayload {
  // Per-capture config so the overlay never holds stale settings.
  sounds: boolean; // audible start/stop cues
  micDeviceId: string; // "" = system default microphone
}

export interface CaptureDonePayload {
  // 16 kHz mono 16-bit WAV, alive only for this one utterance (never stored).
  wav: ArrayBuffer;
  durationMs: number;
}


// Model download/swap progress, surfaced through the local API and the main
// window (Flow owns its settings UI since the standalone turn, plan V1).
export interface ModelStatePayload {
  status: "idle" | "downloading" | "ready" | "error";
  pct?: number;
  message?: string;
}

export interface ModelChoice {
  file: string;
  label: string;
  size: string;
}

// ---- main window bridge (plan V1, A1/A2) ----
// The main window drives the engine over invoke/handle channels. The handlers
// call the SAME functions the local HTTP API uses (applySettings & friends):
// one source of truth, never a second writer of settings.json (A2).

export const UI_GET_STATE = "ui:get-state";
export const UI_SET_SETTINGS = "ui:set-settings";
export const UI_RECORD_SHORTCUT = "ui:record-shortcut";
export const UI_LIST_MICS = "ui:list-mics";
export const UI_OLLAMA_MODELS = "ui:ollama-models";
export const UI_OPEN_PATH = "ui:open-path"; // "log" | "data" | "history" | "legacy-history" | "repo"
export const UI_PICK_FOLDER = "ui:pick-folder";
export const UI_GET_LOGIN_ITEM = "ui:get-login-item";
export const UI_SET_LOGIN_ITEM = "ui:set-login-item";
export const UI_CHECK_UPDATES = "ui:check-updates";
export const UI_STATE_PUSH = "ui:state"; // main -> window, periodic while visible

// ---- snippets (U3) ----
// PULL-only, deliberately: the snippet library is user content of unbounded
// size, and UiStatePayload is re-serialized and pushed EVERY SECOND while the
// window is visible. Putting the library in the snapshot would turn a status
// heartbeat into a data bus and re-render every page once a second.
export const UI_SNIPPET_LIST = "ui:snippet-list";
export const UI_SNIPPET_SAVE = "ui:snippet-save"; // create when id is "", else update
export const UI_SNIPPET_DELETE = "ui:snippet-delete";
export const UI_SNIPPET_COPY = "ui:snippet-copy"; // put it on the clipboard, rich when html

/** One snippet as it lives on disk and travels over IPC.
 *
 * `text` is ALWAYS present, including for html snippets: the plain-text
 * fallback is STORED and user-editable, never derived at paste time. CF_HTML
 * consumers disagree (Outlook renders a <p> as a paragraph break where the
 * user expected none), so the user must see and fix exactly what lands in a
 * plain-text target. `html` is sanitized by the MAIN process at WRITE time. */
export interface Snippet {
  id: string;
  cue: string; // what the user says (the spoken runtime belongs to the dictation wave)
  enabled: boolean;
  format: "text" | "html";
  text: string; // the stored plain-text fallback, always authoritative for "type" mode
  html?: string; // sanitized rich version, only when format === "html"
  createdIso: string;
}

/** What the save channel accepts. An absent/empty id creates. */
export interface SnippetInput {
  id?: string;
  cue: string;
  enabled: boolean;
  format: "text" | "html";
  text: string;
  html?: string;
}

/** Every snippet channel answers with the WHOLE library, so the page never
 * holds a stale list after a write it did not make. */
export interface SnippetsResult {
  ok: boolean;
  items: Snippet[];
  error?: string; // human-readable, shown as-is by the page
}

/** One recent long-form capture, as the window shows it (a subset of the
 * engine's RecentEntry: the window never needs the staging internals). */
export interface UiRecentCapture {
  title: string;
  startedIso: string;
  durationMs: number;
}

/** Everything the main window renders, pushed as one coherent snapshot.
 * Anything that can be slow (model download, engine warm-up) carries its own
 * progress/error state rather than pretending to be instant (plan A1). */
export interface UiStatePayload {
  version: string;
  status: string; // the engine status line (same text the HTTP API exposes)
  engineWarm: boolean;
  listening: boolean;
  recording: boolean;
  backend: string; // active whisper-server binary basename, "" while selecting
  modelState: ModelStatePayload;
  /** Typed overlay states (audit: the cards must not sniff the status STRING). */
  paused: boolean; // tray pause in effect
  hookOk: boolean; // the low-level keyboard hook is armed
  settings: {
    language: string;
    model: string;
    micDeviceId: string;
    sounds: boolean;
    summaryModel: string;
    forceCpu: boolean;
    insertMode: "paste" | "type";
    theme: ThemePref;
  };
  // U0: settings.theme is the PREFERENCE (what the Settings tab shows/edits);
  // resolvedTheme is what to actually PAINT right now. They diverge exactly
  // when theme="system" - two different questions, so two different fields.
  resolvedTheme: ResolvedTheme;
  comboLabel: string;
  models: ModelChoice[];
  canLoopback: boolean;
  apiPort: number;
  dataDir: string;
  logPath: string;
  /** U2b/U2c: the recordings folder this machine had configured before the
   * setting was removed, when it differs from the fixed one. Present only for
   * the few users concerned - the Settings page shows a note ONLY when it is
   * set, and the note is purely informational: those recordings were never
   * moved. `exists` is PROBED in main, never assumed: the note claims the files
   * are still there only when Flow has actually looked, and the "Open" button
   * exists only when there is something to open. */
  legacyHistory?: { dir: string; exists: boolean };
  /** U2c: the 90-day retention purge is off (Flow does not manage what is in
   * the history folder). Drives the "Resume automatic cleanup" control and the
   * wording of the retention line - a UI that still promised a 90-day purge
   * while it is suspended would be the same lie in the other direction. */
  historyPurgeSuspended: boolean;
  recent: UiRecentCapture[];
}

export interface UpdateCheckResult {
  ok: boolean;
  message: string; // human-readable outcome ("up to date", "1.1.0 available", error text)
}

// ---- long-form recorder (U4a) ----
// The IPC surface only - no page consumes it yet (the plan wants this surface
// reviewed as its own unit before the page exists). Every handler in
// main/uiBridge.ts calls the SAME functions the HTTP /long/* routes call
// (main/api.ts, injected by main/index.ts) - never a parallel implementation,
// which is what lets a future cloud connector inherit this control surface
// for free. State and transcript results are NOT re-invented here: they
// reuse LongRecorder's own result types (shared/longform.ts), re-exported
// below so a consumer needs only this one import line.
export const UI_LONG_STATE = "ui:long-state";
export const UI_LONG_START = "ui:long-start";
export const UI_LONG_STOP = "ui:long-stop";
export const UI_LONG_MARK = "ui:long-mark";
// Takes `since` (a byte offset), answers the increment from there: what lets
// the future page poll at 1 Hz without re-transferring the whole transcript.
export const UI_LONG_TRANSCRIPT = "ui:long-transcript";

export type { LongStateSnapshot, LongStartResult, LongStopResult, LongTranscriptResult } from "./longform";

/** The three source choices UI_LONG_START accepts. "system" (the PC's own
 * sound, no microphone) is a real, typed value - see shared/longStart.ts's
 * module note for why the handler currently refuses it rather than silently
 * keeping the microphone on: the native capture window
 * (src/renderer/capture.tsx) grabs it unconditionally today. */
export type LongAudioSource = "mic" | "system" | "both";

export interface UiLongStartRequest {
  source: LongAudioSource;
  title?: string;
  keepAudio?: boolean; // v3 chantier 4 parity: keep the listenable .wav (default off)
}
