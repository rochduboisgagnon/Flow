import { app, session, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { HotkeyAdapter } from "./hotkey";
import { OverlayWindow } from "./overlay";
import { NativeCapture } from "./capture";
import { WhisperSidecar } from "./asr/sidecar";
import { ensureModel, DEFAULT_MODEL_FILE, AVAILABLE_MODELS } from "./asr/modelStore";
import { FocusProbe } from "./focus/probe";
import { insertViaPaste, insertTyped, leaveOnClipboard } from "./insert";
import { decideRoute } from "../shared/route";
import { comboLabel } from "../shared/combo";
import { loadSettings, saveSettings, sanitizeSettings, dataDir, type FlowSettings } from "./settings";
import { runMigration } from "./migrate";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import { pcmFromWav, encodeWav } from "../shared/wav";
import { listOllamaModels } from "./llm/ollama";
import { LocalApi } from "./api";
import { LongRecorder, historyRoot, listHistory, resolveHistoryEntry } from "./longform";
import { MainWindow } from "./mainWindow";
import { resourcePath } from "./resources";
import { UiBridge } from "./uiBridge";
import { FlowTray } from "./tray";
import { FlowUpdater } from "./updater";
import {
  CAPTURE_DONE,
  CAPTURE_ERROR,
  type CaptureDonePayload,
  type ModelStatePayload,
  type UiStatePayload,
} from "../shared/ipcContracts";

// AGR Flow: local, on-device dictation + long-recording engine.
// Since plan v2 (chantier A) this process is HEADLESS: no settings window of
// its own, no shortcuts beyond the dictation combo. Since plan V1 (A3) it has
// a face again: a main window (mainWindow.ts) and a tray (tray.ts), both
// ordinary consumers of engine state - closing either never stops dictation.
// The engine must be reachable and controllable (open/pause/quit) even with
// every window closed, which is exactly what the tray is for.
// Design rule carried through the whole codebase: THE DICTATION IS NEVER
// STORED, neither on disk nor in a retained buffer.

const DEV = process.env.AGRFLOW_DEV === "1";

// Settings (shortcut, language, model, microphone) live in ~/.flow, outside the
// install; mutated via the local API and the main window.
//
// A5: this is a MUTABLE singleton holding the defaults until the boot below has
// run the 1.0.0 migration. Reading settings.json any earlier would pin dataDir()
// to the pre-migration folder for the rest of the process (it caches), and every
// later write would land in the folder we just moved away from.
const settings: FlowSettings = sanitizeSettings(null);

// What the Manager shows as the engine status line (replaces the old tray
// tooltip channel). Exposed through GET /settings.
let statusText = "starting";

// Second launch: the single instance stands, and shows its window instead of
// dying silently (V1: Flow has a face now - relaunching means "open Flow").
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => mainWindow.show(DEV));
  app.whenReady().then(async () => {
    // A5: FIRST thing on this machine - move ~/.agr-flow -> ~/.flow, move the
    // model store, and retire the AGR Manager install. It runs AFTER the single
    // instance lock on purpose: a second launch loses the lock and quits above,
    // so it can never end up asking the RUNNING engine to /quit itself. It never
    // throws and never blocks the boot; a failed step is retried next start.
    let migrationLogs: string[] = [];
    // Review A10 (major): `npm run dev` runs from source on a machine that may
    // carry a PRODUCTION Flow - a dev boot must never quit it, move its data or
    // delete its install. The destructive pass is for packaged builds only;
    // FLOW_MIGRATE=1 is the explicit escape hatch for testing the migration
    // from source (pair it with a sandboxed home via the migrate.ts options).
    if (app.isPackaged || process.env.FLOW_MIGRATE === "1") {
      try {
        const outcome = await runMigration({ selfVersion: app.getVersion(), selfPid: process.pid });
        migrationLogs = outcome.logs;
      } catch (err) {
        migrationLogs = [`[migrate] unexpected failure: ${String(err)}`];
      }
    } else {
      migrationLogs = ["[migrate] skipped: development build (set FLOW_MIGRATE=1 to run it from source)"];
    }
    // Only now: dataDir() caches its answer on the first call, and that answer
    // must be the POST-migration folder. flowLog() writes there too, which is
    // why the migration's own log lines are replayed here rather than live.
    Object.assign(settings, loadSettings());
    for (const line of migrationLogs) flowLog(line);
    hotkey.setCombo(settings.combo); // the adapter was built on the defaults above

    // The overlay captures the microphone from a renderer: grant media
    // requests from OUR OWN windows only, without a system-style popup.
    // Everything else stays denied by default.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === "media");
    });
    overlay.create(DEV);
    tray = new FlowTray({
      showWindow: () => mainWindow.show(DEV),
      // The DERIVED line (pause overlay + update notice folded in): the tray
      // only reads it for its tooltip, it never writes anything back (A10).
      getStatus: () => engineStatus(),
      pauseHotkey: (v) => hotkey.suspend(v),
    });
    if (NativeCapture.available()) nativeCapture.create(DEV); // C2: Windows loopback window
    wireCapture();
    startPtt();
    void warmAsr();
    probe = new FocusProbe(focusProbeScript(), DEV ? (m) => console.log(m) : undefined);
    longRec.purgeHistory(); // C10: retention purge at engine startup, best effort
    api = new LocalApi({
      version: app.getVersion(),
      log: flowLog, // A10: the api.json no-overwrite path must be visible in a built app
      isUpdateBusy: () => modelTransfers > 0, // A10: a model download blocks /update-readiness too
      isListening: () => listening,
      isRecording: () => longRec.isBusy,
      isEngineWarm: () => sidecar !== null,
      canLoopback: () => NativeCapture.available(),
      transcribe: (wav) => processUtterance(wav),
      longState: () => longRec.state(),
      longStart: (opts) => longRec.start({ dir: opts.dir, title: opts.title, keepAudio: !!opts.keepAudio }),
      longStartNative: (opts) => {
        // C2: engine captures the PC's sound + mic natively (no picker), then feeds
        // the long recorder directly. Windows-only barrier.
        if (!NativeCapture.available()) return { ok: false, error: "native capture is only available on a Windows PC" };
        const started = longRec.start({ title: opts.title, keepAudio: !!opts.keepAudio, native: true });
        if (!started.ok) return started;
        nativeActive = true;
        nativeCapture.start(
          { micDeviceId: settings.micDeviceId, captureSystem: !!opts.captureSystem },
          (pcm) => {
            longRec.onChunk(pcm);
            longRec.writeNativeAudio(pcm);
          },
          (msg) => {
            flowLog(`[native] capture error: ${msg}`);
            statusText = "native capture failed: " + msg;
            if (nativeActive) {
              nativeActive = false;
              nativeCapture.stop(() => longRec.stop());
            }
          },
        );
        return started;
      },
      longStop: () => {
        // C2: native mode finalizes the recorder AFTER the renderer flushes its tail
        // (nativeCapture.stop's callback), so the last ~1 s is not lost. Report success
        // now; the PWA polls /long/state (rec -> finalizing -> setup).
        if (nativeActive) {
          nativeActive = false;
          const snap = longRec.state();
          nativeCapture.stop(() => longRec.stop());
          return { ok: true, docPath: snap.docPath };
        }
        return longRec.stop();
      },
      longSave: (dir) => longRec.save(dir), // v6 c7: file the recording at Stop
      longNotesSplice: (docPath, notes) => longRec.notesSplice(docPath, notes),
      longMark: () => longRec.mark(),
      longChunk: (pcm) => {
        markActivity(); // streamed audio = the engine is working (quiet window)
        longRec.onChunk(pcm);
        return { ok: true };
      },
      longGap: (seconds) => longRec.gap(seconds),
      longTranscript: (since) => longRec.transcriptSince(since),
      // Archive 2026-07-14: same historyDir resolution as the recorder itself
      // (settings.historyDir, read lazily), so the archive always reflects
      // wherever recordings are actually being filed right now.
      listHistory: () => listHistory(historyRoot(settings.historyDir), flowLog),
      resolveHistoryEntry: (id) => resolveHistoryEntry(id, historyRoot(settings.historyDir)),
      // Settings surface for the Manager's AGR Flow view (chantier A).
      getSettings: () => ({
        settings: { ...settings, combo: [...settings.combo] },
        comboLabel: comboLabel(settings.combo),
        models: AVAILABLE_MODELS,
        modelState: lastModelState,
        status: statusText,
        // C2: the PWA shows "Capture everything on this PC" only when the engine can
        // do native loopback capture (Windows). Absent/false on a phone.
        canLoopback: NativeCapture.available(),
      }),
      setSettings: (patch) => {
        const applied = applySettings(patch);
        return { ...applied, comboLabel: comboLabel(applied.combo) };
      },
      recordShortcut: recordShortcutAndApply,
      listMics: () => listMicsValidated(),
      ollamaModels: () => listOllamaModels(),
      quit: () => {
        // Graceful stop (updater swap, uninstall): answer first, die next.
        setTimeout(() => app.quit(), 60);
      },
    });
    api.start().catch((err) => console.error("[api] failed to start:", err));

    // ---- auto-update (V1, A4) ----
    // Built AFTER the engine: updating is a background chore and the boot must
    // never wait on it (the first check is two minutes out anyway).
    const flowUpdater = new FlowUpdater({
      // The quiet window, non-negotiable: the SAME definition of "busy" that
      // GET /update-readiness reports (engineBusy), injected rather than
      // re-derived, plus continuous inactivity via the activity timestamp
      // (review A10: `listening` drops between two utterances of an active
      // session - only "nothing happened for the whole window" is quiet).
      isBusy: () => engineBusy(),
      quietForMs: () => Date.now() - lastActivityAt,
      log: flowLog,
    });
    updater = flowUpdater; // module-level handle for getUiState() and before-quit
    flowUpdater.start();

    // ---- main window bridge (V1, A1/A2): SAME functions as the HTTP API ----
    uiBridge = new UiBridge(
      {
        getUiState,
        setSettings: (patch) => void applySettings(patch as Partial<FlowSettings>),
        recordShortcut: recordShortcutAndApply,
        listMics: () => listMicsValidated(),
        ollamaModels: () => listOllamaModels(),
        historyRootDir: () => historyRoot(settings.historyDir),
        logPath: () => path.join(dataDir(), "flow.log"),
        dataDirPath: () => dataDir(),
        checkUpdates: () => flowUpdater.checkNow(),
      },
      mainWindow,
    );

    // A login-item launch passes --hidden: engine up, window quiet. Any other
    // launch (installer, Start menu, double-click) shows the window.
    if (!process.argv.includes("--hidden")) mainWindow.show(DEV);
  });
}

/** The status line the main window and the tray tooltip show. `statusText`
 * stays the engine's own source of truth; two OVERLAY states may borrow the
 * line, and only while the engine has nothing of its own to say ("ready") -
 * a speech-engine failure or a model download outranks both and can never be
 * masked (review A10: the first tray design WROTE its pause into statusText
 * and erased errors raised mid-pause; deriving instead makes that impossible).
 * Priority: engine error/progress > tray pause > update-ready notice. */
function engineStatus(): string {
  if (statusText !== "ready") return statusText;
  const pausedUntil = tray?.pausedUntilMs() ?? null;
  if (pausedUntil !== null) {
    const minutes = Math.max(1, Math.ceil((pausedUntil - Date.now()) / 60_000));
    return `dictation paused (${minutes}m left)`;
  }
  if (updater?.state().phase === "downloaded-waiting-quiet") {
    return "update ready - will install when idle";
  }
  return statusText;
}

/** One coherent snapshot of everything the main window renders. */
function getUiState(): UiStatePayload {
  return {
    version: app.getVersion(),
    status: engineStatus(),
    engineWarm: sidecar !== null,
    listening,
    recording: longRec.isBusy,
    backend: sidecar ? path.basename(sidecar.activeBackend() || "") : "",
    modelState: lastModelState,
    paused: tray !== null && tray.pausedUntilMs() !== null,
    hookOk,
    settings: {
      language: settings.language,
      model: settings.model,
      micDeviceId: settings.micDeviceId,
      sounds: settings.sounds,
      summaryModel: settings.summaryModel,
      forceCpu: settings.forceCpu,
      historyDir: settings.historyDir,
      insertMode: settings.insertMode,
    },
    comboLabel: comboLabel(settings.combo),
    models: [...AVAILABLE_MODELS],
    canLoopback: NativeCapture.available(),
    apiPort: api?.boundPort() ?? 0,
    dataDir: dataDir(),
    logPath: path.join(dataDir(), "flow.log"),
    recent: recentForUi(),
  };
}

// Local API for optional companions (AGR Pilot's mic + long mode) and the
// updater's quiet window. Loopback only, like everything that listens here.
let api: LocalApi | null = null;

// The app's own face (V1): lazy window + IPC bridge into the same control
// functions the HTTP API uses. Closing the window never touches the engine.
const mainWindow = new MainWindow();
let uiBridge: UiBridge | null = null;
// The tray (V1, A3): created once the app is ready (see whenReady above), so
// it can be destroyed on before-quit alongside everything else engine-owned.
let tray: FlowTray | null = null;
// The auto-updater (V1, A4): same lifecycle. Null until the boot below builds
// it, which is why engineStatus() reads it optionally.
let updater: FlowUpdater | null = null;

// Focus probe: decides insert-at-cursor vs leave-on-clipboard per dictation.
let probe: FocusProbe | null = null;

function focusProbeScript(): string {
  return resourcePath("focus-probe.ps1");
}

// The warm ASR sidecar: model ensured (first run downloads it into AGR Flow's
// own data folder, outside the install), whisper-server spawned once, model
// loaded once. Dictating while the warm-up is still running simply queues on
// ensureStarted() inside transcribe().
let sidecar: WhisperSidecar | null = null;

// v5 c1: ordered whisper-server candidates. The Vulkan build is GPU-accelerated
// on ANY modern GPU (NVIDIA/AMD/Intel), sub-second (e.g. Roch's RTX 4080); the CPU
// build is the universal fallback. The sidecar freezes the first that starts.
function serverBinaryPaths(): string[] {
  const dir = resourcePath("bin");
  const vulkan = path.join(dir, "whisper-server-win32-x64-vulkan.exe");
  const cpu = path.join(dir, "whisper-server-win32-x64-cpu.exe");
  // R1: escape hatch for a capricious GPU. FLOW_FORCE_CPU (env) or the forceCpu
  // setting drops the Vulkan build entirely and runs CPU only.
  const forceCpu = /^(1|true|yes|on)$/i.test(process.env.FLOW_FORCE_CPU ?? "") || settings.forceCpu === true;
  return forceCpu ? [cpu] : [vulkan, cpu];
}

// R1: a resources-bundled known-speech WAV; the sidecar requires a backend to
// decode it to non-empty text before trusting it (so a GPU build that loads but
// cannot decode is skipped for CPU). Absent = the readiness check is the only gate.
function loadProbeWav(): Uint8Array | undefined {
  try {
    const p = resourcePath("probe.wav");
    return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : undefined;
  } catch {
    return undefined;
  }
}

// R1: engine diagnostics must be visible in a BUILT app (no dev console). Append to
// a small rotating log in AGR Flow's data folder; whisper-server stderr, backend
// choices and fallbacks all land here. Never throws (logging must not break the app).
function flowLog(msg: string): void {
  if (DEV) console.log(msg);
  try {
    const p = path.join(dataDir(), "flow.log");
    try {
      if (fs.statSync(p).size > 1_000_000) fs.renameSync(p, p + ".1");
    } catch {
      /* no file yet, or rename raced: append anyway */
    }
    fs.appendFileSync(p, new Date().toISOString() + " " + msg + "\n");
  } catch {
    /* diagnostics are best-effort */
  }
}

// v5 c1: a SHORT, clean French seed (no word list, which whisper injected into short clips),
// sent as a per-request UTF-8 prompt only for an explicit French language. It biases accents,
// casing and punctuation without leaking vocabulary. Beam search is the second accuracy lever.
const FRENCH_PROMPT = "Transcription en français, avec la ponctuation et les accents.";
const BEAM_SIZE = 5;

function newSidecar(modelPath: string): WhisperSidecar {
  return new WhisperSidecar({
    binaryPaths: serverBinaryPaths(),
    modelPath,
    language: settings.language,
    beamSize: BEAM_SIZE,
    initialPrompt: FRENCH_PROMPT,
    probeWav: loadProbeWav(), // R1: real decode gate at backend selection
    log: flowLog, // R1: always-on log file (dev also echoes to console)
    onState: (state, detail) => {
      // R1: keep the detail (which backend, why it switched) in the status the
      // Manager shows, so a silent fallback is no longer invisible.
      if (state === "warm") statusText = "ready";
      else if (state === "down") statusText = detail ? "speech engine: " + detail : "speech engine restarting...";
      else statusText = detail ? "speech engine failed: " + detail : "speech engine failed";
    },
  });
}

async function warmAsr() {
  // A10: a first-run download is up to 1.1 GB - an update swap killing it
  // mid-transfer wastes the whole thing. Counted as busy for its duration.
  modelTransfers++;
  try {
    let lastPct = -1;
    const model = await ensureModel(settings.model ?? DEFAULT_MODEL_FILE, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        statusText = `downloading the speech model (${pct}%)`;
      }
    });
    // Audit: an EARLY model change from the fresh window can have swapModel
    // install a sidecar while this warm-up was still downloading. First one
    // in wins; the loser shuts its engine down instead of orphaning a
    // whisper-server child and silently overriding the user's choice.
    if (sidecar !== null || modelSwapping) {
      flowLog("[asr] warm-up superseded by a model swap; discarding the boot engine");
      return;
    }
    sidecar = newSidecar(model);
    await sidecar.ensureStarted();
    statusText = "ready";
  } catch (err) {
    console.error("[asr] warm-up failed:", err);
    flowLog(`[asr] warm-up failed: ${err}`); // R1: visible in a built app
    statusText = "speech engine unavailable: " + String(err instanceof Error ? err.message : err);
  } finally {
    modelTransfers--;
    markActivity();
  }
}

const overlay = new OverlayWindow();
// C2: the hidden native-capture window (Windows-only). Created at startup so
// getDisplayMedia is instant on the first native recording; idle until asked.
const nativeCapture = new NativeCapture();
let nativeActive = false; // a native (engine-side) capture is feeding the long recorder

// The dictation loop, main-process side. PTT drives the overlay (which owns the
// microphone); the finished WAV comes back once per utterance and is handed to
// the ASR sidecar, then every reference is dropped.
let listening = false; // dictation capture in flight (drives /update-readiness)

// ---- the ONE definition of "busy" (review A10) ----
// Everything that must hold an update back: a capture, a long recording, or a
// model transfer (killing a 1 GB ensureModel mid-flight wastes the download).
// `lastActivityAt` stamps every transition so the updater can require REAL
// continuous quiet, not two lucky samples between utterances.
// Audit: a COUNTER, not a boolean. warmAsr and swapModel can overlap (first
// boot download + an early model change from the fresh window); a shared
// boolean cleared by whichever finishes FIRST would reopen the quiet window
// while the other transfer is still moving gigabytes.
let modelTransfers = 0;
let lastActivityAt = Date.now();
function markActivity(): void {
  lastActivityAt = Date.now();
}
function engineBusy(): boolean {
  return listening || longRec.isBusy || modelTransfers > 0;
}
// Audit: the keyboard hook's health as a typed flag, not a status-string
// sniff. Set by startPtt, read by the window's cards.
let hookOk = true;

/** Microphone list + self-healing (review A10): the productName rename moved
 * Electron's userData folder, which can invalidate persisted deviceIds. A
 * saved mic that no longer appears in a NON-EMPTY enumeration is reset to the
 * system default - honestly, with a log line - instead of silently capturing
 * from a device the user did not choose. An empty enumeration (overlay not
 * ready yet) proves nothing and never clears the choice. */
async function listMicsValidated(): Promise<Array<{ id: string; label: string }>> {
  const mics = await overlay.listMics();
  if (settings.micDeviceId && mics.length > 0 && !mics.some((m) => m.id === settings.micDeviceId)) {
    flowLog(`[audio] saved microphone ${settings.micDeviceId} no longer exists; resetting to system default`);
    applySettings({ micDeviceId: "" });
  }
  return mics;
}

/** The recent-captures snapshot for the UI, cached briefly (review A10): the
 * window's 1 Hz push otherwise re-reads recent.json and stats every entry
 * ON THE MAIN THREAD each second - synchronous I/O sitting right under the
 * keyboard hook's verdict path. 15 s of staleness on a "last capture" card is
 * invisible; a blocked hook verdict is not. */
let recentCache: { at: number; value: UiStatePayload["recent"] } = { at: 0, value: [] };
const RECENT_CACHE_MS = 15_000;
function recentForUi(): UiStatePayload["recent"] {
  if (Date.now() - recentCache.at > RECENT_CACHE_MS) {
    recentCache = {
      at: Date.now(),
      value: longRec.state().recent.map((r) => ({
        title: r.title,
        startedIso: r.startedIso,
        durationMs: r.durationMs,
      })),
    };
  }
  return recentCache.value;
}

// Long-form recorder (plan §6 + v2 chantier C): remote-controlled through the
// local API by AGR Pilot's PWA page, which ALSO streams the audio from the
// recording device (/long/chunk). It shares the warm ASR with dictation;
// while it records, push-to-talk is politely refused.
const longRec = new LongRecorder({
  getSidecar: () => sidecar,
  summaryModel: () => settings.summaryModel,
  ollamaModels: () => listOllamaModels(),
  log: flowLog, // R1: long-recording diagnostics visible in a built app too
  historyDir: () => settings.historyDir, // C10: read lazily, so a live settings change applies immediately
});

// NOTE: the "open AGR Pilot" shortcut used to live here (v5 c2, fired from Flow's keyspy),
// which coupled it to AGR Flow - disabling Flow killed the shortcut. It now belongs entirely to
// AGR Manager (its always-on LL hook), which owns Pilot and runs whether or not Flow does. This
// adapter only handles the dictation combo.
const hotkey = new HotkeyAdapter(settings.combo, {
  onStart() {
    markActivity();
    if (longRec.isBusy) {
      // The transcript belongs to the long recording; a dictation mid-meeting
      // would fight it for the warm engine.
      return;
    }
    listening = true;
    overlay.startCapture({ sounds: settings.sounds, micDeviceId: settings.micDeviceId });
  },
  onStop() {
    markActivity();
    listening = false;
    overlay.stopCapture();
  },
  onCancel() {
    markActivity();
    listening = false;
    overlay.cancelCapture();
  },
});

/** The shared utterance pipeline (PTT loop AND local API): anti-hallucination
 * gate #1 (energy VAD - an accidental press must not insert invented text,
 * and trimming silence shortens the decode), warm ASR, then gates #2/#3
 * (per-segment no-speech in the protocol parser, known-hallucination list).
 * Empty text = gated. Nothing is retained. */
async function processUtterance(
  wav: Uint8Array,
): Promise<{ text: string; ms: number }> {
  // The whole decode counts as activity (A10): entry AND exit are stamped so
  // the updater's quiet window can never open in the middle of a transcription.
  markActivity();
  try {
    if (!sidecar) throw new Error("speech engine not ready");
    const pcm = pcmFromWav(wav);
    const speech = analyzeSpeech(pcm);
    if (!hasSpeech(speech)) {
      if (DEV) console.log(`[vad] dropped: ${speech.voicedMs} ms voiced`);
      return { text: "", ms: 0 };
    }
    const { text, ms } = await sidecar.transcribe(encodeWav(trimToSpeech(pcm, speech)));
    const clean = gateTranscript(text);
    if (!clean) {
      if (DEV) console.log(`[gate] dropped: ${JSON.stringify(text)}`);
      return { text: "", ms };
    }
    return { text: clean, ms };
  } finally {
    markActivity();
  }
}

function wireCapture() {
  ipcMain.on(CAPTURE_DONE, (_ev, payload: CaptureDonePayload) => {
    // NOTHING is retained: the WAV lives in this handler, feeds one inference,
    // and every reference dies with it. Sub-300 ms of audio is release noise.
    // Every exit path calls overlay.flowDone() so the "Transcribing..." pill
    // never outlives the utterance.
    if (payload.durationMs < 300) return overlay.flowDone();
    void processUtterance(new Uint8Array(payload.wav))
      .then(async ({ text, ms }) => {
        if (!text) return;
        // Probe the focus WHILE nothing else has stolen it, then route and act.
        const focus = (await probe?.probe()) ?? null;
        const route = decideRoute(focus);
        if (route === "insert") {
          // "type" mode keystrokes the text (paste-hostile apps); default pastes.
          if (settings.insertMode === "type") await insertTyped(text);
          else await insertViaPaste(text);
        } else leaveOnClipboard(text);
        // `text` goes out of scope here: the dictation is never retained (5.4).
        if (DEV)
          console.log(`[flow] ${ms} ms | focus=${focus?.control ?? "none"} -> ${route}`);
      })
      .catch((err) => console.error("[flow] failed:", err))
      .finally(() => {
        markActivity(); // insertion/clipboard included: the utterance JUST ended
        overlay.flowDone();
      });
  });
  ipcMain.on(CAPTURE_ERROR, (_ev, message: string) => {
    console.error("[capture] failed:", message);
    statusText = "microphone unavailable";
  });
}

// ---- settings application (driven by the Manager through the local API) ----

let lastModelState: ModelStatePayload = { status: "idle" };

// Swapping the ASR model: download if missing (progress readable by the
// Manager through GET /settings), then replace the warm sidecar. One swap at
// a time; a failed swap leaves the previous engine running.
let modelSwapping = false;
async function swapModel(file: string) {
  if (modelSwapping) return;
  modelSwapping = true;
  modelTransfers++; // A10: same quiet-window protection as warmAsr
  const old = sidecar;
  try {
    let lastPct = -1;
    lastModelState = { status: "downloading", pct: 0 };
    const model = await ensureModel(file, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        lastModelState = { status: "downloading", pct };
        statusText = `downloading the speech model (${pct}%)`;
      }
    });
    const next = newSidecar(model);
    await next.ensureStarted();
    sidecar = next;
    old?.stop();
    statusText = "ready";
    lastModelState = { status: "ready" };
  } catch (err) {
    console.error("[asr] model swap failed:", err);
    lastModelState = { status: "error", message: String(err) };
    // Audit: without this line the progress text ("downloading ... 43%") is
    // frozen forever - and engineStatus() then hides the tray pause and the
    // update notice behind it. Same wording as warmAsr's failure path.
    statusText = sidecar
      ? "ready"
      : "speech engine unavailable: " + String(err instanceof Error ? err.message : err);
  } finally {
    modelSwapping = false;
    modelTransfers--;
    markActivity();
  }
}

/** Applies a settings patch immediately: shortcut re-armed, language applied
 * to the next utterance, model swapped (with download), mic/sounds picked up
 * by the next capture. Persisted atomically. */
function applySettings(patch: Partial<FlowSettings>): FlowSettings {
  const next = sanitizeSettings({ ...settings, ...patch });
  const comboChanged = JSON.stringify(next.combo) !== JSON.stringify(settings.combo);
  const modelChanged = next.model !== settings.model;
  const langChanged = next.language !== settings.language;
  // Audit: forceCpu only feeds serverBinaryPaths() at sidecar creation, so
  // without a swap the toggle was a lie until the next restart. Same model,
  // fresh sidecar = the backend list is re-evaluated (the model is already on
  // disk, so this is a reload, not a download).
  const backendChanged = next.forceCpu !== settings.forceCpu;
  Object.assign(settings, next);
  saveSettings(settings);
  if (comboChanged) hotkey.setCombo(settings.combo);
  if (langChanged) sidecar?.setLanguage(settings.language);
  if (modelChanged || backendChanged) void swapModel(settings.model);
  return { ...settings, combo: [...settings.combo] };
}

async function startPtt() {
  try {
    await hotkey.start();
    hookOk = true;
    if (DEV) console.log(`[ptt] armed on ${comboLabel(settings.combo)}`);
  } catch (err) {
    // Dictation without a hotkey is dead: surface it instead of dying silently.
    console.error("[ptt] key listener failed to start:", err);
    hookOk = false;
    statusText = "keyboard hook unavailable";
  }
}

/** The ONE shortcut-recording flow (audit: it was pasted verbatim in the HTTP
 * API deps and the window bridge deps). Long-poll: resolves when the user
 * finishes the gesture or the 10 s recorder timeout fires. */
async function recordShortcutAndApply(): Promise<{ combo: string[] | null; comboLabel?: string }> {
  const combo = await hotkey.record();
  if (combo && combo.length > 0) {
    applySettings({ combo });
    return { combo, comboLabel: comboLabel(combo) };
  }
  return { combo: null };
}

app.on("before-quit", () => {
  mainWindow.setQuitting(true);
  uiBridge?.stop();
  // Only our polling timers: electron-updater's own autoInstallOnAppQuit hook
  // stays armed, so a downloaded update still lands on this manual quit.
  updater?.stop();
  tray?.destroy();
  hotkey.stop();
  overlay.destroy();
  // C2: an abrupt quit mid native-recording would otherwise leave a size-0 .wav
  // header (file looks empty). Patch it synchronously so the kept audio is valid.
  nativeActive = false;
  longRec.flushNativeAudioSync();
  nativeCapture.destroy();
  sidecar?.stop();
  probe?.stop();
  api?.stop();
});

// A headless engine must not die when its only (hidden) window closes.
app.on("window-all-closed", () => {
  /* keep running */
});
