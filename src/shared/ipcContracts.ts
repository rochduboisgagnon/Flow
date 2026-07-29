// IPC channel names shared by main and the overlay renderer. One place, typed,
// so a renamed channel cannot silently desynchronize the two sides.

import type { ThemePref, ResolvedTheme } from "./theme";
import type { HookHealth } from "./hookWatchdog";
import type { MicPrewarm } from "./micWarmth";

// main -> overlay
export const CAPTURE_START = "capture:start";
export const CAPTURE_STOP = "capture:stop"; // finish and hand the WAV back
export const CAPTURE_CANCEL = "capture:cancel"; // discard everything
// B2: the microphone pre-warm policy. Deliberately NOT folded into
// CaptureStartPayload: warming has to be able to happen when there is no
// capture at all (at startup, and on a partially-pressed shortcut), which is
// the entire point of it.
export const CAPTURE_WARM = "capture:warm";
export const CAPTURE_COOL = "capture:cool"; // drop the warm microphone and the pre-roll NOW

// overlay -> main
export const CAPTURE_DONE = "capture:done";
export const CAPTURE_ERROR = "capture:error";
// B2/B1: the two §3.3 budgets main cannot see on its own (see
// CaptureTimingPayload).
export const CAPTURE_TIMING = "capture:timing";

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

// ---- V4 D1: the hidden DECODE window (importing an audio file) ----
//
// decodeAudioData and OfflineAudioContext only exist in a renderer, so decoding
// an imported file needs a window - a THIRD hidden one, deliberately not the
// capture window: decoding is the one operation in Flow that can genuinely
// exhaust memory (see shared/audioImport.ts's measured budget), and the process
// that may die must not be the one holding a live microphone.
//
// The renderer never learns WHERE the file is. Main opens it read-only, streams
// it over in 8 MB slices, and the window only ever sees bytes - so no path the
// renderer could act on ever crosses this boundary. main -> decode window:
export const DECODE_BYTES = "decode:bytes"; // one slice of the source, in order
export const DECODE_PROBE = "decode:probe"; // duration BEFORE any decode (plan §5.1.3)
export const DECODE_RUN = "decode:run"; // now decode what you were given
export const DECODE_CANCEL = "decode:cancel"; // drop everything, free the bytes
export const DECODE_FLOW = "decode:flow"; // backpressure: pause/resume the PCM stream
// decode window -> main:
export const DECODE_META = "decode:meta"; // the probed duration
export const DECODE_PCM = "decode:pcm"; // one Int16 mono 16 kHz slice
export const DECODE_DONE = "decode:done";
export const DECODE_ERROR = "decode:error";

export interface DecodeBytesPayload {
  token: number; // the job these bytes belong to; a stale token is dropped
  bytes: Uint8Array;
}

export interface DecodeTokenPayload {
  token: number;
}

export interface DecodeFlowPayload {
  token: number;
  paused: boolean;
}

export interface DecodeMetaPayload {
  token: number;
  /** 0 when the container carries no usable duration - the caller then treats
   * the length as unknown rather than as zero. */
  durationMs: number;
}

export interface DecodePcmPayload {
  token: number;
  pcm: ArrayBuffer; // Int16, mono, 16 kHz - ready for the ASR as-is
}

export interface DecodeDonePayload {
  token: number;
  frames: number; // 16 kHz mono frames actually produced
  channels: number; // what the source turned out to hold, for the memory projection
}

/** Why a decode ended without audio. Kept coarse on purpose: the human sentence
 * is composed in main (shared/audioImport.ts), where the file NAME is known -
 * the renderer knows nothing but bytes. "memory" covers both the honest
 * rejection and the window dying outright. */
export type DecodeFailure = "format" | "memory" | "cancelled" | "internal";

export interface DecodeErrorPayload {
  token: number;
  reason: DecodeFailure;
  detail: string;
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

/** B2: how the overlay should keep the microphone warm between dictations.
 * Built in exactly one place (shared/micWarmth.ts's warmPolicy), from exactly
 * one setting, so "what the user chose" and "what the renderer does" cannot
 * drift apart. Absence of this payload (the CAPTURE_COOL channel) is itself a
 * meaning: release the microphone and erase the pre-roll now. */
export interface CaptureWarmPayload {
  micDeviceId: string; // "" = system default microphone; a change releases the warm graph
  preRollMs: number; // ring capacity, in milliseconds of audio - never exceeded
  holdMs: number | null; // release after this long; null = keep it for as long as Flow runs
}

/** B2/B1: the two budgets of plan §3.3 that no amount of main-process
 * instrumentation can answer - "press -> first animation frame" and "press ->
 * the microphone is actually capturing" - both of which happen inside the
 * overlay renderer, a SEPARATE process whose performance.now() has its own
 * origin.
 *
 * So these are DURATIONS, never instants: the renderer measures both against
 * its own clock, from the moment it received CAPTURE_START, and main adds them
 * to the instant it already recorded for that same message (overlayStartSent).
 * Two clocks are never compared - which is the one thing that would make these
 * numbers quietly wrong instead of merely imprecise. The one-way IPC hop
 * between the send and the receive is therefore NOT counted, which makes both
 * numbers a lower bound; see hotpath.ts's markOverlayTimings. */
export interface CaptureTimingPayload {
  /** ms from CAPTURE_START to the first animation frame drawn for this press. */
  firstPaintMs: number;
  /** ms from CAPTURE_START to this capture's buffer holding audio that covers
   * the keypress. Zero when a pre-roll was available: the audio from before
   * the press was already in hand. */
  firstSampleMs: number;
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
// "log" | "data" | "history" | "legacy-history" | "repo" | "downloaded-file"
// (U5c: "downloaded-file" reveals the LAST file U5c's downloads wrote, tracked
// in main - never a path the renderer supplies).
export const UI_OPEN_PATH = "ui:open-path";
export const UI_GET_LOGIN_ITEM = "ui:get-login-item";
export const UI_SET_LOGIN_ITEM = "ui:set-login-item";
export const UI_CHECK_UPDATES = "ui:check-updates";
export const UI_STATE_PUSH = "ui:state"; // main -> window, periodic while visible

// ---- activation hot-path diagnostics (plan V2, B1) ----
// PULL-only, same reasoning as snippets below: the ring can hold up to 200
// traces plus thousands of raw latency samples, and UiStatePayload is
// re-serialized every second regardless of whether Diagnostics is even open -
// putting this there would turn a status heartbeat into a data bus.
export const UI_HOTPATH_SNAPSHOT = "ui:hotpath-snapshot";
export type {
  HotpathSnapshot,
  HotpathTrace,
  HotpathStep,
  HotpathAbandonReason,
  HotpathEvent,
  HotpathEventKind,
} from "./hotpath";
// B4: re-exported here for the same reason as the hot-path types above - a page
// needs one import line to render everything one payload carries.
export type { HookHealth, HookState } from "./hookWatchdog";

// ---- self-diagnostic (plan V2, B5) ----
// PULL, and NOT on the 1 Hz push, for a reason specific to this one: producing
// the report enumerates audio devices through a renderer round trip and writes
// a probe file to disk. That is exactly the kind of work that must happen when
// a human asks for it, never once a second under the keyboard hook.
export const UI_SELF_CHECK = "ui:self-check";
export type { SelfCheckReport, SelfCheckLine, SelfCheckStatus, SelfCheckId } from "./selfCheck";

// ---- statistics (U7) ----
// PULL-only, for the same reason as snippets and the hot-path ring: a year of
// daily counters is up to 366 objects, and UiStatePayload is re-serialized and
// pushed EVERY SECOND while the window is visible. The two SETTINGS live in
// UiStatePayload.settings (they are two booleans a Settings tab has to render);
// the DATA never does.
//
// UI_STATS_CLEAR (U7d) answers with the same StatsPayload as UI_STATS_READ so
// the page can replace its state with whatever comes back, and never has to
// guess what "cleared" looks like - exactly the discipline the snippet channels
// follow with SnippetsResult.
export const UI_STATS_READ = "ui:stats-read";
export const UI_STATS_CLEAR = "ui:stats-clear";
export type { StatsPayload, StatsDay, StatsAppShare } from "./stats";

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

// ---- dictionary (U6) ----
// PULL-only, for the SAME reason as snippets above: the dictionary is user
// content of unbounded size and UiStatePayload is re-serialized every second
// while the window is visible. Nothing about the dictionary belongs in that
// heartbeat - not the entries, not a count, not a "last changed" stamp.
export const UI_DICT_LIST = "ui:dict-list";
export const UI_DICT_SAVE = "ui:dict-save"; // create when id is absent/empty, else update
export const UI_DICT_DELETE = "ui:dict-delete";

/** Which of the dictionary's three storeys an entry feeds (plan-standalone
 * §4.1, and shared/dictionary.ts's module note):
 *  - "vocabulary": storey 1 only. Its term is offered to whisper's initial
 *    prompt, biasing recognition. It NEVER rewrites a transcript, which makes
 *    it the right (and only safe) choice for a word whose misheard form is an
 *    ordinary word - "Claude" heard as "cloud".
 *  - "replacement": storeys 1 and 2. Its term is prompted AND guaranteed: every
 *    alias, plus the term itself, is substituted on the final text. */
export type DictKind = "vocabulary" | "replacement";

/** One dictionary entry as it lives on disk (~/.flow/dictionary.json, never
 * settings.json) and travels over IPC.
 *
 * `aliases` are the WRONG spellings ("cloud code", "loi vingt-cinq") - what the
 * engine writes when it mishears the term. They drive storey 2 and are
 * deliberately kept OUT of the whisper prompt: prompting a misspelling teaches
 * the decoder to produce it. On a "vocabulary" entry they are inert, stored but
 * unused, so that flipping an entry's kind never silently discards work. */
export interface DictEntry {
  id: string;
  term: string; // the canonical spelling, the one that ends up in the text
  aliases: string[];
  kind: DictKind;
  starred: boolean; // first in line for the bounded prompt budget
  createdIso: string;
}

/** What the save channel accepts. An absent/empty id creates; an id that
 * matches nothing is REFUSED, never treated as a creation key. */
export interface DictInput {
  id?: string;
  term: string;
  aliases: string[];
  kind: DictKind;
  starred: boolean;
}

/** Every dictionary channel answers with the WHOLE dictionary, so the page can
 * never hold a stale list after a write it did not make (same contract as
 * SnippetsResult). */
export interface DictResult {
  ok: boolean;
  items: DictEntry[];
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
  hookOk: boolean; // the low-level keyboard hook is armed RIGHT NOW
  /** B4: the keyboard hook's incident record - how many times its key server
   * died, how many of those it recovered from, and when the last one was. It
   * rides the 1 Hz push (unlike the hot-path ring, which is pulled) because it
   * is five scalars of fixed size, and because the Home card has to be able to
   * say "recovered from an interruption" without the user opening a panel. */
  hook: HookHealth;
  settings: {
    language: string;
    model: string;
    micDeviceId: string;
    sounds: boolean;
    summaryModel: string;
    forceCpu: boolean;
    insertMode: "paste" | "type";
    theme: ThemePref;
    /** B2: "off" | "after" | "always" - see shared/micWarmth.ts. */
    micPrewarm: MicPrewarm;
    /** U7a: aggregated counters are being written (default true). */
    stats: boolean;
    /** U7a: per-application attribution is being written (default FALSE).
     * Two booleans ride the 1 Hz push because they are settings a tab renders;
     * the counters themselves are pulled (see UI_STATS_READ above). */
    statsPerApp: boolean;
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

// ---- archive browser (U5a) ----
// The Notes page's read surface, on the SAME functions as the HTTP
// /long/history* routes (main/api.ts) - main/index.ts injects the IDENTICAL
// closures into both LocalApi and UiBridge, never a parallel implementation
// (same discipline as the UI_LONG_* deps above). Deliberately NOT cached like
// UiStatePayload.recent (15 s) or LongStateSnapshot.recent (3 s): those exist
// to keep synchronous I/O off the keyboard hook's 1 Hz poll, but the archive
// list/doc are pulled on demand by the Notes page, which needs the EXACT
// on-disk state - a page showing a capture that was just downloaded/deleted
// as if it still matched a few seconds ago would be the wrong kind of stale.
export const UI_HISTORY_LIST = "ui:history-list";
export const UI_HISTORY_DOC = "ui:history-doc"; // takes an id, answers one entry's transcript or null

export type { HistoryItem, HistoryDocPayload } from "./longform";

// ---- capture downloads (U5c, Roch's decision) ----
// Browser-style: straight into the OS Downloads folder, no dialog. The
// renderer only ever passes an id (never a path) - main/downloads.ts resolves
// it the same way the archive's read routes do, refusing a forged/stale id.
export const UI_DOWNLOAD_DOC = "ui:download-doc";
export const UI_DOWNLOAD_AUDIO = "ui:download-audio";

/** Defined HERE, not in main/downloads.ts: ipcContracts.ts is compiled into
 * the renderer/preload build too (tsconfig.json never lists src/main), so the
 * type has to live where both builds can see it - main/downloads.ts imports it
 * back from here, same direction as every other shared shape in this file. */
export interface DownloadResult {
  ok: boolean;
  path?: string; // where it landed - the page's "Show in folder" needs this
  error?: string; // human-readable, shown as-is by the page
}

// ---- removing a passage from a capture (D11) ----
// Main-process only, with NO HTTP equivalent, for a stronger version of the
// reason downloads has none: the local API answers a remote PWA over the
// network, and a phone has no business DESTROYING part of a recording on this
// machine. The renderer passes an id and passage indices - never a path, never
// a character offset, never the text itself.
//
// The channel is `ui:redact-passages` and it is IRREVERSIBLE by design (see
// shared/redact.ts's DECISION 4): nothing is kept anywhere, so the confirmation
// that precedes it has to name the exact text and time ranges. The page builds
// that confirmation from the SAME pure functions main acts on
// (shared/redact.ts's parseTranscriptPassages / planRedaction), which is what
// makes "what the user was shown" and "what main removes" one thing.
export const UI_REDACT_PASSAGES = "ui:redact-passages";

/** One passage the caller means to remove, named by its index AND by the start
 * offset the caller SAW there. Main refuses the whole request if any index no
 * longer starts at that offset: between the page's parse and the human's click,
 * a notes regeneration or a startup rescue can rewrite the document and move
 * every index, and acting on a stale one would irreversibly destroy a passage
 * nobody looked at. */
export interface RedactTarget {
  index: number;
  startMs: number;
}

export interface RedactResult {
  ok: boolean;
  /** True when the derived notes/summary block was dropped along with the
   * passage (shared/redact.ts's DECISION 2). The page has to be able to say it
   * happened: losing the meeting notes surprises more than losing the passage
   * the user aimed at. */
  notesDropped?: boolean;
  /** True when the matching range of the recording's audio was silenced. False
   * means the recording kept no audio at all - never "the audio was left
   * playable", which this operation refuses to do silently. */
  audioSilenced?: boolean;
  error?: string; // human-readable, shown as-is by the page
}

export type { TranscriptPassage, RedactionRange, RedactionPlan } from "./redact";

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

// ---- audio file import (V4, D1/D2) ----
//
// Four channels, no more: start an import, follow it, cancel it, and (because a
// drag-and-drop is not the only way in) ask main for a file picker. The queue
// snapshot carries BOTH the progress of what is running and the state of what is
// waiting, so a page never has to stitch two polls together to know where it
// stands - the same "one coherent snapshot" rule as UI_LONG_STATE.
//
// PULL, at the page's own cadence, like every other channel that is not the 1 Hz
// heartbeat: an import runs for minutes and nothing about it belongs in
// UiStatePayload.
//
// UI_IMPORT_START is the only channel in this whole surface that accepts a PATH
// from the renderer, and that is unavoidable: a dropped file IS a path. What
// makes it safe is what main does with it and nothing else - it is opened
// read-only, and refused unless it is an existing regular file with a supported
// audio extension. An import never writes, renames, moves or deletes the file it
// was pointed at, on any path, including cancellation and failure (plan §5.1.1).
export const UI_IMPORT_STATE = "ui:import-state";
export const UI_IMPORT_START = "ui:import-start";
export const UI_IMPORT_CANCEL = "ui:import-cancel"; // takes an item id
export const UI_IMPORT_PICK = "ui:import-pick"; // native open dialog, answers paths

export type {
  ImportItem,
  ImportPhase,
  ImportQueueSnapshot,
  ImportRequest,
  ImportStartResult,
} from "./audioImport";
