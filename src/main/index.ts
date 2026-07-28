import { app, session, ipcMain, nativeTheme, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { HotkeyAdapter } from "./hotkey";
import { OverlayWindow } from "./overlay";
import { NativeCapture } from "./capture";
import { WhisperSidecar } from "./asr/sidecar";
// B5: `modelFilePath` is modelStore's modelPath() under another name - index.ts
// already has a local `modelPath` (newSidecar's parameter), and a self-check
// that silently read the wrong one would report on a file nobody uses.
import { ensureModel, DEFAULT_MODEL_FILE, AVAILABLE_MODELS, modelPath as modelFilePath } from "./asr/modelStore";
import { FocusProbe } from "./focus/probe";
import { insertViaPaste, insertTyped, leaveOnClipboard, flushPendingRestore } from "./insert";
import { decideRoute } from "../shared/route";
import { comboLabel } from "../shared/combo";
import { loadSettings, saveSettings, sanitizeSettings, dataDir, type FlowSettings } from "./settings";
import { runMigration } from "./migrate";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import { pcmFromWav, encodeWav } from "../shared/wav";
import { listOllamaModels } from "./llm/ollama";
import { LocalApi } from "./api";
import { LongRecorder, historyRoot, listHistory, resolveHistoryEntry, readHistoryDoc } from "./longform";
import { DownloadManager } from "./downloads";
import type { LongStartResult, LongStopResult } from "../shared/longform";
import { legacyHistoryInfo, type LegacyHistoryInfo } from "./legacyHistory";
import { decideLaunchAtLogin } from "../shared/launchAtLogin";
import { shouldApplyCsp, MAIN_WINDOW_CSP } from "../shared/csp";
import { MainWindow } from "./mainWindow";
import { resourcePath } from "./resources";
import { UiBridge, LOGIN_ARGS } from "./uiBridge";
import { FlowTray } from "./tray";
import { FlowUpdater } from "./updater";
import { hotpath, HOTPATH_ABANDON_REASON } from "../shared/hotpath";
import { hookIsArmed, hookStatusLine } from "../shared/hookWatchdog";
import { silentFailures, SILENT_FAILURE } from "../shared/silentFailures";
import { LogQueue, LOG_QUEUE_FAILURE } from "../shared/logQueue";
import { createFileLogSink } from "./logSink";
import {
  evaluateSelfCheck,
  formatSelfCheckForLog,
  type SelfCheckFacts,
  type SelfCheckReport,
} from "../shared/selfCheck";
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
    let migratedLegacyHistoryDir: string | null = null;
    // Review A10 (major): `npm run dev` runs from source on a machine that may
    // carry a PRODUCTION Flow - a dev boot must never quit it, move its data or
    // delete its install. The destructive pass is for packaged builds only;
    // FLOW_MIGRATE=1 is the explicit escape hatch for testing the migration
    // from source (pair it with a sandboxed home via the migrate.ts options).
    if (app.isPackaged || process.env.FLOW_MIGRATE === "1") {
      try {
        const outcome = await runMigration({ selfVersion: app.getVersion(), selfPid: process.pid });
        migrationLogs = outcome.logs;
        migratedLegacyHistoryDir = outcome.legacyHistoryDir ?? null;
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
    // U2c: FIRST write of the run, before ANY other applySettings() can happen.
    // The raw historyDir the migration just read exists in exactly one place -
    // the settings.json we are about to rewrite - and sanitizeSettings drops it
    // by construction. ensureLaunchAtLogin() thirteen lines below used to fire
    // the first save and erase the only trace of the user's own folder before
    // they could ever read the note. Persisting it here settles that by order.
    captureLegacyHistory(migratedLegacyHistoryDir);
    for (const line of migrationLogs) flowLog(line);
    hotkey.setCombo(settings.combo); // the adapter was built on the defaults above
    applyTheme(settings.theme);
    // U0: a Windows theme flip while theme="system" must repaint in under a
    // frame instead of waiting on uiBridge's 1 Hz push. This handler only
    // READS shouldUseDarkColors - applyTheme() is the sole writer of
    // themeSource, so this can never re-trigger the "updated" event itself.
    nativeTheme.on("updated", () => {
      const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
      mainWindow.applyTheme(resolved);
      uiBridge?.pushNow();
    });
    ensureLaunchAtLogin();

    // The overlay captures the microphone from a renderer: grant media
    // requests from OUR OWN windows only, without a system-style popup.
    // Everything else stays denied by default.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === "media");
    });
    // U3f: PACKAGED-ONLY CSP, applied as a response header rather than a
    // <meta> tag in main.html. A <meta> tag would ship in the SAME file
    // `npm run dev` serves from the Vite dev server, whose HMR client needs
    // inline scripts, eval, and a ws://localhost:5183 socket - a policy tight
    // enough for a shipped build would break every dev reload. DEV is the
    // exact flag serverBinaryPaths() and the migration gate already key off,
    // so this can never drift out of sync with those branches by accident.
    //
    // U3g (review, blocking): the hook is on the DEFAULT session, which every
    // window shares - so the first version of this policy also landed on the
    // overlay and on the hidden capture window, and BOTH load their AudioWorklet
    // from a blob: URL. `script-src 'self'` does not cover a blob: worklet
    // module, so a packaged build would have started no microphone graph at all:
    // dictation capturing nothing, the one thing this app may never do. The
    // policy is therefore scoped to the MAIN WINDOW, which is also where it
    // belongs: it is the only window that renders content the user wrote
    // (snippet HTML). Whom to cover is decided by shared/csp.ts, pure and
    // unit-tested (test/csp.test.ts), rather than inline here.
    if (!DEV) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const mine = shouldApplyCsp(
          { url: details.url, webContentsId: details.webContentsId ?? null },
          // Read LIVE: the main window is lazy (first show()), so at the moment
          // this hook is installed it does not exist yet.
          mainWindow.webContentsId(),
        );
        // An empty response is Electron's documented "do not touch this one".
        // Echoing details.responseHeaders back would also work, but the overlay
        // and the capture window come through HERE - the path that must stay as
        // close to a no-op as the API allows.
        if (!mine) return callback({});
        callback({
          responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [MAIN_WINDOW_CSP] },
        });
      });
    }
    overlay.create(DEV);
    tray = new FlowTray({
      showWindow: () => mainWindow.show(DEV),
      // The DERIVED line (pause overlay + update notice folded in): the tray
      // only reads it for its tooltip, it never writes anything back (A10).
      getStatus: () => engineStatus(),
      pauseHotkey: (v) => hotkey.suspend(v),
      // U4 (blocking review): the SAME "busy" the updater refuses to install
      // through. "Quit Flow" was the one control that walked straight past it.
      isRecording: () => longRec.isBusy,
      parentWindow: () => {
        const wc = mainWindow.contents();
        return wc ? BrowserWindow.fromWebContents(wc) : null;
      },
    });
    if (NativeCapture.available()) nativeCapture.create(DEV); // C2: Windows loopback window
    wireCapture();
    startPtt();
    void warmAsr();
    probe = new FocusProbe(focusProbeScript(), DEV ? (m) => console.log(m) : undefined);
    logLegacyHistoryState(); // U2c: say where the older recordings are, before purging anything
    // U4 (blocking review): the app can die without ever running before-quit -
    // a power cut, a bugcheck, a taskkill. Whatever is still in the staging
    // folder at boot therefore belongs to a session that is over, and staging
    // is a folder nothing lists and nothing rescans: file those recordings into
    // the archive NOW, before the API or the window can start a new one on top.
    // Runs BEFORE the purge so a recovered recording is judged by the date the
    // rescue filed it under, never by the state the crash left behind.
    longRec.rescueOrphanedStaging();
    longRec.purgeHistory(); // C10: retention purge at engine startup, best effort

    // U4a: named so the EXACT SAME closures are handed to both the HTTP API
    // (LocalApi, below) and the main window's IPC bridge (UiBridge, further
    // down) - the founding rule of this whole control surface (see
    // uiBridge.ts's UiBridgeDeps module note): a future cloud connector must
    // find ONE implementation to reuse, never a parallel one that drifted.
    const longStateDep = () => longRec.state();
    const longStartNativeDep = (opts: {
      title?: string;
      keepAudio?: boolean;
      captureSystem?: boolean;
    }): LongStartResult => {
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
          if (!nativeActive) return;
          nativeActive = false;
          // U4 (review, major): abort() - not stop(). abort() is the ONLY entry
          // point that records `lastError`, which is the single field carrying
          // the failure to GET /long/state and to the Record page; it was
          // written for exactly this call site and had no caller at all, so a
          // capture that died mid-meeting ended the recording in silence and
          // the page went on showing a healthy, finished one.
          longRec.abort(msg);
          // Then tear the renderer's audio graph down. Nothing waits on its
          // tail: the recorder has already been stopped with the reason, and a
          // capture that just failed is not going to flush anything.
          nativeCapture.stop(() => {});
        },
      );
      return started;
    };
    const longStopDep = (): LongStopResult => {
      // C2: native mode finalizes the recorder AFTER the renderer flushes its tail
      // (nativeCapture.stop's callback), so the last ~1 s is not lost. Report success
      // now; callers poll long-state (rec -> finalizing -> setup).
      if (nativeActive) {
        nativeActive = false;
        const snap = longRec.state();
        nativeCapture.stop(() => longRec.stop());
        return { ok: true, docPath: snap.docPath };
      }
      return longRec.stop();
    };
    const longMarkDep = () => longRec.mark();
    const longTranscriptDep = (since: number) => longRec.transcriptSince(since);
    const canLoopbackDep = () => NativeCapture.available(); // C2: "this is a PC" gate
    // U5a: named exactly like the long* deps above, and for the identical
    // reason - historyRoot() is fixed (U2a), so BOTH the HTTP archive routes
    // and the UI_HISTORY_* IPC channels always reflect the one place
    // recordings are actually filed, off the SAME two functions.
    const listHistoryDep = () => listHistory(historyRoot(), flowLog);
    const readHistoryDocDep = (id: string) => readHistoryDoc(id, historyRoot());
    // B1: same discipline as every dep above - the Diagnostics panel (IPC) and
    // a `bench:hotpath` run against a live app (HTTP) must read the exact same
    // in-memory ring, never two independently-serialized copies.
    const hotpathSnapshotDep = () => hotpath.snapshot();

    api = new LocalApi({
      version: app.getVersion(),
      log: flowLog, // A10: the api.json no-overwrite path must be visible in a built app
      isUpdateBusy: () => modelTransfers > 0, // A10: a model download blocks /update-readiness too
      isListening: () => listening,
      isRecording: () => longRec.isBusy,
      isEngineWarm: () => sidecar !== null,
      canLoopback: canLoopbackDep,
      hotpathSnapshot: hotpathSnapshotDep,
      // B1: the HTTP /transcribe endpoint (AGR Pilot's phone mic) is
      // deliberately UNTRACED - see processUtterance's module note.
      transcribe: (wav) => processUtterance(wav),
      longState: longStateDep,
      longStart: (opts) => longRec.start({ dir: opts.dir, title: opts.title, keepAudio: !!opts.keepAudio }),
      longStartNative: longStartNativeDep,
      longStop: longStopDep,
      longSave: (dir) => longRec.save(dir), // v6 c7: file the recording at Stop
      longNotesSplice: (docPath, notes) => longRec.notesSplice(docPath, notes),
      longMark: longMarkDep,
      longChunk: (pcm) => {
        markActivity(); // streamed audio = the engine is working (quiet window)
        longRec.onChunk(pcm);
        return { ok: true };
      },
      longGap: (seconds) => longRec.gap(seconds),
      longTranscript: longTranscriptDep,
      // Archive 2026-07-14 / U5a: listHistory and readHistoryDoc are the named
      // consts above, shared byte-for-byte with UiBridge below. resolveHistoryEntry
      // stays route-local (still needed here for streaming /long/history/audio,
      // which has no IPC equivalent - U5c downloads instead, see downloads.ts).
      listHistory: listHistoryDep,
      resolveHistoryEntry: (id) => resolveHistoryEntry(id, historyRoot()),
      readHistoryDoc: readHistoryDocDep,
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
        historyRootDir: () => historyRoot(),
        // U2b: resolved in MAIN, never passed in by the renderer - the bridge
        // opens fixed destinations only (see UI_OPEN_PATH).
        // U2c: null unless the folder is REALLY there, so the bridge can never
        // be asked to open a path that vanished (shell.openPath would just
        // return an error string and the button would look broken).
        legacyHistoryDirPath: () => {
          const info = legacyHistoryForUi();
          return info && info.exists ? info.dir : null;
        },
        log: flowLog,
        logPath: () => path.join(dataDir(), "flow.log"),
        dataDirPath: () => dataDir(),
        checkUpdates: () => flowUpdater.checkNow(),
        // U4a: identical closures to LocalApi's above (longStateDep & co.,
        // defined once, just above) - never a second implementation of the
        // recorder's control surface.
        longState: longStateDep,
        longStartNative: longStartNativeDep,
        longStop: longStopDep,
        longMark: longMarkDep,
        longTranscript: longTranscriptDep,
        canLoopback: canLoopbackDep,
        // U5a: identical closures to LocalApi's above (listHistoryDep &
        // readHistoryDocDep, defined once, just above) - the Notes page's
        // archive view and the HTTP /long/history* routes can never disagree.
        listHistory: listHistoryDep,
        readHistoryDoc: readHistoryDocDep,
        // U5c: browser-style downloads (Roch's decision) - main-only, no HTTP
        // equivalent (a remote PWA has no business writing into this
        // machine's Downloads folder).
        downloadDoc: (id) => downloads.downloadDoc(id),
        downloadAudio: (id) => downloads.downloadAudio(id),
        lastDownloadedPath: () => downloads.lastDownloadedPath(),
        // B1: identical closure to LocalApi's above (hotpathSnapshotDep,
        // defined once, just above) - the Diagnostics panel and a
        // `bench:hotpath` run must never disagree on what is currently open/completed.
        hotpathSnapshot: hotpathSnapshotDep,
      },
      mainWindow,
    );
    // Review U1j: a snapshot the moment the window becomes visible again.
    // Both push channels are visibility-gated, so a theme flip (or any state
    // change) that happened while hidden would otherwise stay invisible for
    // up to a second after a tray "Open Flow" - a dark page under native
    // caption buttons already recolored light.
    mainWindow.setOnShow(() => uiBridge?.pushNow());

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
 * Priority: keyboard hook outage > engine error/progress > tray pause >
 * update-ready notice.
 *
 * B4: the hook comes FIRST, and it is DERIVED (hookStatusLine, pure) rather
 * than written into statusText the way startPtt used to - the same lesson as
 * the tray's pause. A dead keyboard hook is the most total failure this app
 * has: nothing the user can press reaches Flow at all, so a warm speech engine
 * reporting "ready" underneath it would be true and completely useless. */
function engineStatus(): string {
  const hookLine = hookStatusLine(hotkey.health());
  if (hookLine) return hookLine;
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
  // B4: read ONCE. hookOk and the incident record must describe the same
  // instant - a card saying "armed" next to "restarting" would be the kind of
  // self-contradiction that makes a diagnostic panel worthless.
  const hook = hotkey.health();
  return {
    version: app.getVersion(),
    status: engineStatus(),
    engineWarm: sidecar !== null,
    listening,
    recording: longRec.isBusy,
    backend: sidecar ? path.basename(sidecar.activeBackend() || "") : "",
    modelState: lastModelState,
    paused: tray !== null && tray.pausedUntilMs() !== null,
    hookOk: hookIsArmed(hook),
    hook,
    settings: {
      language: settings.language,
      model: settings.model,
      micDeviceId: settings.micDeviceId,
      sounds: settings.sounds,
      summaryModel: settings.summaryModel,
      forceCpu: settings.forceCpu,
      insertMode: settings.insertMode,
      theme: settings.theme,
    },
    // U0: what to actually paint right now, separate from the preference above.
    resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    comboLabel: comboLabel(settings.combo),
    models: [...AVAILABLE_MODELS],
    canLoopback: NativeCapture.available(),
    apiPort: api?.boundPort() ?? 0,
    dataDir: dataDir(),
    logPath: path.join(dataDir(), "flow.log"),
    legacyHistory: legacyHistoryForUi(),
    historyPurgeSuspended: settings.historyPurgeSuspended,
    recent: recentForUi(),
  };
}

// Local API for optional companions (AGR Pilot's mic + long mode) and the
// updater's quiet window. Loopback only, like everything that listens here.
let api: LocalApi | null = null;

// The app's own face (V1): lazy window + IPC bridge into the same control
// functions the HTTP API uses. Closing the window never touches the engine.
// flowLog is a hoisted function declaration (below), so referencing it here
// at module load time is safe - see U3f: MainWindow logs a refused
// navigation/popup through the same file everything else diagnoses into.
const mainWindow = new MainWindow(flowLog);
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
  } catch (err) {
    // B6: was silent - the sidecar just picked a backend without the real-decode
    // check (R1). Not on the keyboard hook's call stack (only runs at sidecar
    // construction: boot / model swap), so a synchronous log line costs nothing here.
    silentFailures.increment(SILENT_FAILURE.probeWavLoadFailed);
    flowLog(`[asr] probe.wav could not be read: ${String(err)}`);
    return undefined;
  }
}

// R1: engine diagnostics must be visible in a BUILT app (no dev console). Append to
// a small rotating log in AGR Flow's data folder; whisper-server stderr, backend
// choices and fallbacks all land here. Never throws (logging must not break the app).
// B4b: the buffered writer behind flowLog. Every line this app logs used to
// cost an fs.statSync plus an fs.appendFileSync ON THE MAIN THREAD - the same
// thread that owes Windows a swallow verdict for every keystroke on the machine
// (menace §3.2.2). whisper-server's stderr alone is chatty enough during a long
// transcription to put a write under most keypresses. Now a line is an array
// push, and the write happens asynchronously on a later tick. The policy (order,
// rotation, overflow) is pure and unit-tested in shared/logQueue.ts; the two
// lines of real I/O are in ./logSink.
//
// The path is resolved INSIDE the sink, at write time, never here: dataDir()
// caches its answer on the first call and that answer must be the
// post-migration folder (see settings.ts). Deferring the write only makes that
// safer than the synchronous version was.
const logQueue = new LogQueue(createFileLogSink(() => path.join(dataDir(), "flow.log")), {
  onFailure: (kind) => {
    // The SAME two counters the synchronous version incremented (B6), so a
    // machine that could not write its log still says so in Diagnostics.
    // Deliberately not logged: a logger cannot log its own failure to write.
    if (kind === LOG_QUEUE_FAILURE.rotate) silentFailures.increment(SILENT_FAILURE.flowLogRotateFailed);
    else silentFailures.increment(SILENT_FAILURE.flowLogWriteFailed);
  },
});

function flowLog(msg: string): void {
  if (DEV) console.log(msg);
  // The timestamp is taken HERE, not at write time: the queue may hold this
  // line for a tick, and a log whose timestamps were the moment of the WRITE
  // would silently reorder cause and effect under exactly the load that makes
  // a log worth reading.
  logQueue.push(new Date().toISOString() + " " + msg + "\n");
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

// B6: flowLog injected (matches FocusProbe/NativeCapture's own constructor
// convention below) so the overlay's own best-effort catches stop being
// invisible too - see overlay.ts's startCapture for how the log write is
// deferred off the keyboard hook's synchronous call stack.
const overlay = new OverlayWindow(flowLog);
// C2: the hidden native-capture window (Windows-only). Created at startup so
// getDisplayMedia is instant on the first native recording; idle until asked.
// U4: flowLog goes in, because a capture window that crashes or fails to load
// used to leave no trace anywhere - the failure mode that let the engine report
// a healthy recording while capturing nothing at all.
const nativeCapture = new NativeCapture(flowLog);
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
// sniff. B4: it is no longer a module-level boolean written once by startPtt -
// that version could only ever say "the hook failed to START", and the failure
// that actually happens in the field is the hook DYING later. The adapter owns
// the record now (HotkeyAdapter.health), so a death and a recovery both move
// the same flag the cards already read.

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

/** U2c: persist, ONCE, what the migration just learned about this machine, and
 * suspend the retention purge because of it.
 *
 * `dir` non-empty means settings.json still named a recordings folder of the
 * user's own, i.e. the fixed folder we now purge (dataDir()/history) is NOT the
 * one Flow was filing into: it was frozen the day the user switched, it still
 * carries the marker from when it was the default, and its dated folders are
 * all older than the 90-day retention. Purging it would delete an untouched
 * archive on the first boot after the update, before the window even appears.
 *
 * Two FACTS are written, never configuration: where the recordings are, and
 * that Flow must not clean up a folder it was not managing. Both are cleared
 * together by the Settings button, which is the user's explicit "yes, that
 * folder is mine to clean". */
function captureLegacyHistory(dir: string | null): void {
  if (!dir) return;
  if (settings.legacyHistoryDir) return; // already recorded on an earlier boot
  applySettings({ legacyHistoryDir: dir, historyPurgeSuspended: true });
}

/** U2c (minor finding): the archive view lists the FIXED folder only, so for
 * these users it goes from "all my meetings" to "empty" with no explanation on
 * that screen. Until the Notes page can carry the pointer (wave U5), a startup
 * log line is the floor - not a substitute. */
function logLegacyHistoryState(): void {
  const info = legacyHistoryInfo(settings.legacyHistoryDir);
  if (!info) return;
  flowLog(
    `[history] the recordings archive lists ${historyRoot()} only. Recordings made before this update are in ` +
      `${info.dir}${info.exists ? "" : " (Flow does not find that folder any more)"}; nothing was moved or deleted.` +
      (settings.historyPurgeSuspended ? " The 90-day cleanup is suspended until you resume it in Settings > Storage." : ""),
  );
}

/** U2c: the legacy-folder note for the UI, existence PROBED, cached like the
 * recent list and for the same reason (review A10): the window pushes a
 * snapshot every second, and an existsSync on a disconnected network share is
 * synchronous I/O sitting right under the keyboard hook's verdict path. The
 * cache is keyed on the folder too, so the note disappears on the very next
 * push when the user resumes cleanup. */
let legacyCache: { at: number; dir: string | null; value: LegacyHistoryInfo | undefined } = {
  at: 0,
  dir: null, // never equal to a settings string: the first call always probes
  value: undefined,
};
function legacyHistoryForUi(): LegacyHistoryInfo | undefined {
  const dir = settings.legacyHistoryDir;
  if (legacyCache.dir !== dir || Date.now() - legacyCache.at > RECENT_CACHE_MS) {
    legacyCache = { at: Date.now(), dir, value: legacyHistoryInfo(dir) };
  }
  return legacyCache.value;
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
  // U2c: read lazily, so the Settings button that resumes cleanup takes effect
  // on the very next purge instead of needing a restart.
  historyPurgeSuspended: () => settings.historyPurgeSuspended,
  log: flowLog, // R1: long-recording diagnostics visible in a built app too
});

// U5c (Roch's decision): the archive's download flow - browser-style, straight
// into the OS Downloads folder, no dialog. app.getPath("downloads") is read
// LAZILY (inside the closure), never at module load: it is correct on Windows
// AND macOS and follows a folder the user relocated, but calling it this early
// would run before app.whenReady() for no benefit (download only actually
// happens well after boot).
const downloads = new DownloadManager({
  historyRoot: () => historyRoot(),
  downloadsDir: () => app.getPath("downloads"),
  log: flowLog,
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
      // B3: this used to return here with NOTHING sent to the overlay at all -
      // the user presses, and gets no sound, no animation, no explanation: the
      // exact "three things always happen together" contract broken. Fire the
      // same start signal a real capture would (sound + pill + an armed mic
      // session the overlay tears down a beat later, never reaching a WAV) so
      // the press is always felt, even as a refusal - see overlay.ts's
      // startAndRefuse doc comment for the full reasoning.
      overlay.startAndRefuse({ sounds: settings.sounds, micDeviceId: settings.micDeviceId });
      // B1: the trace hotkey.ts just opened (keyEventReceived/verdictRendered)
      // would otherwise sit open forever - no capture ever starts, so nothing
      // would ever mark it done. Close it honestly instead of relying on the
      // 30 s staleness sweep. Called AFTER startAndRefuse so the overlayStartSent
      // mark it just made lands on this SAME trace before it closes.
      hotpath.abandon(HOTPATH_ABANDON_REASON.busyLongRecording);
      return;
    }
    listening = true;
    hotpath.mark("captureStartDecided");
    overlay.startCapture({ sounds: settings.sounds, micDeviceId: settings.micDeviceId });
  },
  onStop() {
    markActivity();
    listening = false;
    overlay.stopCapture(); // marks "overlayStopSent"
  },
  onCancel(reason) {
    markActivity();
    listening = false;
    overlay.cancelCapture(); // marks "overlayCancelSent" on the still-open trace
    hotpath.abandon(reason);
  },
}, {
  log: flowLog, // B4: hook incidents must be readable in a packaged build
  // B4: the tray tooltip rebuilds every 30 s and the window is pushed every
  // second - both far too slow for an outage that heals in about one. This
  // repaints them on the transition itself. The tray matters most: with every
  // window closed it is the ONLY surface the user has, and that is precisely
  // the situation where they believe dictation is working.
  onHealthChange: () => {
    tray?.refreshNow();
    uiBridge?.pushNow();
  },
});

/** The shared utterance pipeline (PTT loop AND local API): anti-hallucination
 * gate #1 (energy VAD - an accidental press must not insert invented text,
 * and trimming silence shortens the decode), warm ASR, then gates #2/#3
 * (per-segment no-speech in the protocol parser, known-hallucination list).
 * Empty text = gated. Nothing is retained. */
async function processUtterance(
  wav: Uint8Array,
  // B1: `trace` is true ONLY for the hotkey/overlay path (wireCapture, below).
  // processUtterance is ALSO the HTTP /transcribe endpoint's implementation
  // (AGR Pilot's phone-mic button, api.ts) - that call never went through a
  // keyboard press, so it has no open hotpath trace to attach to; marking it
  // anyway would either no-op (harmless) or, worse, mis-attach to an
  // unrelated hotkey trace that happens to be open at the same moment. Opting
  // in per call site is cheaper and safer than trying to tell the two apart
  // after the fact.
  opts: { trace?: boolean } = {},
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
    if (opts.trace) hotpath.mark("transcriptionStarted");
    const { text, ms } = await sidecar.transcribe(encodeWav(trimToSpeech(pcm, speech)));
    if (opts.trace) hotpath.mark("transcriptionFinished");
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
    // B1: the WAV genuinely arrived - mark it before any early return, so a
    // too-short clip still closes as an honest (abandoned) trace instead of
    // leaving its open trace to be swept 30 s later as "stale".
    hotpath.markWavReceived(payload.durationMs);
    // NOTHING is retained: the WAV lives in this handler, feeds one inference,
    // and every reference dies with it. Sub-300 ms of audio is release noise.
    // Every exit path calls overlay.flowDone() so the "Transcribing..." pill
    // never outlives the utterance.
    if (payload.durationMs < 300) {
      hotpath.abandon(HOTPATH_ABANDON_REASON.tooShortClip);
      return overlay.flowDone();
    }
    void processUtterance(new Uint8Array(payload.wav), { trace: true })
      .then(async ({ text, ms }) => {
        if (!text) {
          // B1: processUtterance returns the same {text:"",...} shape for two
          // different causes; ms===0 is the existing, already-latent signal
          // for "the energy VAD found nothing to send to the model at all"
          // (the ms===0 branch returns before ever calling the sidecar) versus
          // "the model answered and gateTranscript rejected it" (ms>0).
          hotpath.abandon(ms === 0 ? HOTPATH_ABANDON_REASON.noSpeech : HOTPATH_ABANDON_REASON.hallucinationGate);
          return;
        }
        // Probe the focus WHILE nothing else has stolen it, then route and act.
        const focus = (await probe?.probe()) ?? null;
        hotpath.mark("focusProbed");
        const route = decideRoute(focus);
        hotpath.mark("routeDecided");
        if (route === "insert") {
          // "type" mode keystrokes the text (paste-hostile apps); default pastes.
          if (settings.insertMode === "type") await insertTyped(text);
          else await insertViaPaste(text);
        } else leaveOnClipboard(text);
        // B1: textChars is a LENGTH, recorded after `text` has already done its
        // job - never the text itself (see hotpath.ts's zero-retention note).
        hotpath.complete(route === "insert" ? "inserted" : "clipboarded", text.length);
        // `text` goes out of scope here: the dictation is never retained (5.4).
        if (DEV)
          console.log(`[flow] ${ms} ms | focus=${focus?.control ?? "none"} -> ${route}`);
      })
      .catch((err) => {
        hotpath.abandon(HOTPATH_ABANDON_REASON.pipelineError);
        console.error("[flow] failed:", err);
      })
      .finally(() => {
        markActivity(); // insertion/clipboard included: the utterance JUST ended
        overlay.flowDone();
      });
  });
  ipcMain.on(CAPTURE_ERROR, (_ev, message: string) => {
    hotpath.abandon(HOTPATH_ABANDON_REASON.captureError);
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

/** Roch 2026-07-27: Flow starts with Windows by DEFAULT. A dictation daemon
 * that is not running dictates nothing, and the AGR Manager watchdog that used
 * to guarantee it is gone since the standalone turn.
 *
 * Registered exactly ONCE, gated by a persisted flag rather than re-asserted at
 * every boot: re-registering each time would silently undo a user who turned
 * the toggle off, which is the difference between a sane default and a fight.
 *
 * U2c (review finding): a dev checkout does NOTHING here - it neither registers
 * nor writes the flag. Dev and prod share the same ~/.flow/settings.json, so
 * burning the flag from source meant one `npm run dev` permanently cost the
 * PACKAGED app its only chance to register itself. The decision lives in
 * shared/launchAtLogin.ts so both branches are unit-testable without Electron.
 *
 * LOGIN_ARGS lives in uiBridge (--hidden: the engine comes up, the window does
 * not); reusing the same constant keeps the registry entry identical to the one
 * the Settings toggle reads, otherwise the toggle would report OFF forever. */
function ensureLaunchAtLogin(): void {
  const decision = decideLaunchAtLogin({
    alreadyInitialized: settings.loginItemInitialized,
    packaged: app.isPackaged,
  });
  if (!decision.register && !decision.recordFlag) return;
  try {
    if (decision.register) {
      app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS });
      flowLog("[startup] registered Flow to start with Windows (default on first run; the Settings toggle owns it from now on)");
    }
    if (decision.recordFlag) applySettings({ loginItemInitialized: true });
  } catch (err) {
    // A locked registry hive must never cost the engine its boot.
    flowLog(`[startup] could not register the login item: ${String(err)}`);
  }
}

/** U0: the ONE writer of nativeTheme.themeSource. Setting themeSource TRIGGERS
 * the "updated" event wired in whenReady - that handler only ever READS
 * shouldUseDarkColors, never writes themeSource itself, or the two would loop. */
function applyTheme(pref: FlowSettings["theme"]): void {
  nativeTheme.themeSource = pref;
  const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  mainWindow.applyTheme(resolved);
  uiBridge?.pushNow();
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
  const themeChanged = next.theme !== settings.theme;
  Object.assign(settings, next);
  saveSettings(settings);
  if (comboChanged) hotkey.setCombo(settings.combo);
  if (langChanged) sidecar?.setLanguage(settings.language);
  if (modelChanged || backendChanged) void swapModel(settings.model);
  if (themeChanged) applyTheme(settings.theme);
  return { ...settings, combo: [...settings.combo] };
}

async function startPtt() {
  try {
    await hotkey.start();
    if (DEV) console.log(`[ptt] armed on ${comboLabel(settings.combo)}`);
  } catch (err) {
    // Dictation without a hotkey is dead: surface it instead of dying silently.
    // B4: no longer writes statusText. The adapter has already counted this as
    // an incident and (unless the crash-loop guard tripped) scheduled a retry,
    // so engineStatus() derives the line from hook health - which means the
    // line also DISAPPEARS by itself the moment the retry succeeds, instead of
    // freezing "keyboard hook unavailable" over a hook that came back.
    console.error("[ptt] key listener failed to start:", err);
    flowLog(`[ptt] key listener failed to start: ${String(err)}`);
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
  // U3e: quitting inside the ~250 ms restore window would kill the timer that
  // owes the user their clipboard back. Hand it back first, while we still can.
  flushPendingRestore();
  uiBridge?.stop();
  // Only our polling timers: electron-updater's own autoInstallOnAppQuit hook
  // stays armed, so a downloaded update still lands on this manual quit.
  updater?.stop();
  tray?.destroy();
  hotkey.stop();
  overlay.destroy();
  nativeActive = false;
  // U4 (blocking review): quitting mid-recording used to bury the meeting. This
  // handler is SYNCHRONOUS and Electron awaits nothing it starts, so calling
  // stop() here would only launch finalize() - an ASR drain plus an Ollama
  // round-trip - and the process would die first, leaving the document in
  // <dataDir>/staging where no surface of the app can see it. rescueOnQuit()
  // does the whole job synchronously: flush the .wav, note the interruption in
  // the document, file it into the archive, index it in recent.json.
  longRec.rescueOnQuit();
  // C2: an abrupt quit mid native-recording would otherwise leave a size-0 .wav
  // header (file looks empty). Patch it synchronously so the kept audio is
  // valid. A no-op after a rescue, which flushes the stream itself first.
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
