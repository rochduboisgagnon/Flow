import { app, session, ipcMain, nativeTheme, BrowserWindow, powerMonitor, dialog, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { HotkeyAdapter } from "./hotkey";
import { OverlayWindow } from "./overlay";
import { NativeCapture } from "./capture";
import { WhisperSidecar } from "./asr/sidecar";
import { BatchEngine } from "./asr/batchEngine";
// B5: `modelFilePath` is modelStore's modelPath() under another name - index.ts
// already has a local `modelPath` (newSidecar's parameter), and a self-check
// that silently read the wrong one would report on a file nobody uses.
import { ensureModel, DEFAULT_MODEL_FILE, AVAILABLE_MODELS, modelPath as modelFilePath } from "./asr/modelStore";
import { FocusProbe } from "./focus/probe";
import { insertViaPaste, insertTyped, leaveOnClipboard, flushPendingRestore } from "./insert";
import { decideRoute } from "../shared/route";
import { comboLabel } from "../shared/combo";
import { loadSettings, saveSettings, sanitizeSettings, dataDir, useSettingsBacking, type FlowSettings } from "./settings";
import { runMigration } from "./migrate";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import { pcmFromWav, encodeWav } from "../shared/wav";
import { OllamaProvider, listOllamaModels, type LlmProvider } from "./llm/provider";
import { LocalSidecarProvider } from "./llm/localSidecar";
import { LlamaServer } from "./llm/llamaServer";
import { notesModelPath, ensureNotesModel } from "./asr/modelStore";
import { SessionStore } from "./data/sessionStore";
import { createFlowClient } from "./data/client";
import { Auth } from "./data/auth";
import { Repo } from "./data/repo";
import { WorkingCopy } from "./data/workingCopy";
import { WorkingCopyCaptureStore } from "./data/captureStore";
import { AudioLocal, audioDirIn, migrateAudioDir } from "./audioLocal";
import { LocalApi } from "./api";
import { LongRecorder } from "./longform";
import { historyDownloadStem } from "../shared/downloadName";
import { MAX_DOC_DISPLAY_BYTES, type RecordingSummary } from "../shared/recordings";
import { LiveNotesStore } from "./liveNotes";
import { AudioDecodeWindow } from "./audioDecode";
import { ImportQueue } from "./audioImport";
import { SUPPORTED_AUDIO_EXTENSIONS } from "../shared/audioImport";
import { DownloadManager } from "./downloads";
import { Redactor } from "./redact";
import { StatsStore } from "./stats";
import { DictationHistoryStore } from "./dictationHistory";
import { countWords } from "../shared/wordCount";
import {
  primeDictionary,
  dictationPrompt,
  applyDictionaryReplacements,
  useDictionaryBacking,
  refreshDictionaryCache,
} from "./dictionary";
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
import { LoopLagSampler, realScheduler } from "../shared/loopLag";
import { hookIsArmed, hookStatusLine } from "../shared/hookWatchdog";
import { silentFailures, SILENT_FAILURE } from "../shared/silentFailures";
import { LogQueue, LOG_QUEUE_FAILURE } from "../shared/logQueue";
import { createFileLogSink } from "./logSink";
import { SystemWatch } from "./systemWatch";
import { judgeCaptureShortfall, preRollCreditMs, shortfallLogLine } from "../shared/captureContinuity";
import { warmPolicy } from "../shared/micWarmth";
import {
  evaluateSelfCheck,
  formatSelfCheckForLog,
  type SelfCheckFacts,
  type SelfCheckReport,
} from "../shared/selfCheck";
import {
  CAPTURE_DONE,
  CAPTURE_ERROR,
  CAPTURE_TIMING,
  type CaptureDonePayload,
  type CaptureTimingPayload,
  type ModelStatePayload,
  type AccountSnapshot,
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
    // U6a/U6e: load the dictionary ONCE, here, and write the shipped default
    // terms on a machine that has never had a dictionary.json. Both storeys
    // read a cache from now on, so no dictation ever pays a synchronous read
    // (main/dictionary.ts's cache note). It is after loadSettings() for the
    // same reason everything else is: dataDir() must already be the
    // post-migration folder.
    primeDictionary(flowLog);
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
    applyDictationSuspension(); // le compte n'est pas charge au boot : la dictee part suspendue
    tray = new FlowTray({
      showWindow: () => mainWindow.show(DEV),
      // The DERIVED line (pause overlay + update notice folded in): the tray
      // only reads it for its tooltip, it never writes anything back (A10).
      getStatus: () => engineStatus(),
      pauseHotkey: (v) => {
        trayPaused = v;
        applyDictationSuspension();
      },
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
    // B11: started right after the hook, because the hook is what it measures
    // for. From here on, every stretch where Flow is working is sampled at
    // 20 ms and every idle stretch at 500 ms (see shared/loopLag.ts).
    loopLagSampler.start();
    // B9: the machine itself - sleep, wake, lock, unlock. Built right after the
    // hook, because the hook is what it exists to protect: Windows removes a
    // low-level hook that overran its budget WITHOUT telling the application
    // (documented, see shared/systemResilience.ts), so B4's watchdog - which
    // watches the key server PROCESS - cannot see it. Every decision is in the
    // pure policy; this only supplies the four facts it reads and performs what
    // it returns.
    systemWatch = new SystemWatch({
      // Review B10 (major): the truth about a hold lives in the MATCHER, never
      // in this module's `listening` copy. The two disagree on exactly the path
      // B3 added: when a long recording is running, onStart refuses and returns
      // WITHOUT setting the flag, while the keys are genuinely held down. A
      // sleep during that hold used to clean up nothing.
      holdInFlight: () => hotkey.holdInFlight(),
      hookState: () => hotkey.health().state,
      // Review B10 (blocking): called on EVERY transition, hold or not. A
      // shortcut half held down when Windows switched to the secure desktop
      // loses its key-up events there; believing those keys still down makes
      // the NEXT combination start a dictation nobody asked for.
      forgetKeys: () => hotkey.forgetKeys(),
      interruptHold: () => {
        // No blind guard here any more: the policy knows whether a hold exists
        // (holdInFlight above) and only calls this when there really is one.
        listening = false;
        overlay.cancelCapture();
      },
      rearmHook: () => {
        void hotkey.rearm().catch((err) => {
          // arm() already routed the failure through the B4 watchdog (counted,
          // logged, retry scheduled); this catch only stops a rejected promise
          // from escaping a powerMonitor callback.
          flowLog(`[system] rebuilding the keyboard hook failed: ${String(err)}`);
        });
      },
      log: flowLog,
    });
    systemWatch.start();
    // Deliberately SEPARATE from SystemWatch: that one decides about the HOOK,
    // this decides about the MICROPHONE. Two subjects, no duplicated decision.
    powerMonitor.on("lock-screen", () => setMicWarmthSuspended(true));
    powerMonitor.on("suspend", () => setMicWarmthSuspended(true));
    powerMonitor.on("unlock-screen", () => setMicWarmthSuspended(false));
    powerMonitor.on("resume", () => setMicWarmthSuspended(false));
    void warmAsr();
    probe = new FocusProbe(focusProbeScript(), DEV ? (m) => console.log(m) : undefined);
    // B2: the same treatment warmAsr() already gives the speech engine, applied
    // to the other lazily-started child process on the hot path. B1 measured the
    // first dictation of a session paying ~457 ms (and 535 ms on a second start)
    // for nothing but spawning powershell.exe inside probe() - the single worst
    // number on the bench, and one that only ever hit the FIRST press, which is
    // exactly the press a user judges the product on. Fire-and-forget: a probe
    // that fails to warm is retried by probe() and falls back to the clipboard,
    // unchanged.
    void probe.warm();
    // B2: push the microphone pre-warm policy now that the overlay window
    // exists. The renderer replays it on load (see OverlayWindow), so this
    // arriving before the page is not a race - and this is what makes the FIRST
    // press after a start a warm one instead of the coldest of the session.
    applyMicWarmth();
    // U7b: arm the 60 s counter flush. Reads NOTHING from disk here - the store
    // loads lazily at its first flush or read - so a boot pays nothing for it,
    // and an install where the counters are off never even creates the file.
    stats.start();
    // B2 : history.start() a disparu avec son minuteur de vidage - il n'y a plus
    // de fichier a vider, la copie de travail tient la file.
    noticeRetiredHistoryFolder(); // B3d : signaler <dataDir>/history s'il porte encore des reunions
    // 2026-08-04 : `pending-audio` devient `audio`. Ici, et pas plus tard : le
    // balayage et le recorder lisent tous les deux le nouveau nom, et une fenetre
    // ou les deux dossiers sont vivants ferait passer un audio pour absent.
    migrateAudioDir(dataDir(), flowLog);
    // 2026-08-04 : `pending-audio` devient `audio`. Ici, et pas plus tard : le
    // balayage et le recorder lisent tous les deux le nouveau nom, et une fenetre
    // ou les deux dossiers sont vivants ferait passer un audio pour absent.
    migrateAudioDir(dataDir(), flowLog);
    logLegacyHistoryState(); // et dire ou elles sont, une fois par lancement
    // B3d : plus rien a balayer ni a purger au demarrage du moteur.
    //
    // Ce que ces deux lignes faisaient - recuperer un dossier `staging/` laisse
    // par une session morte, puis purger l'archive de plus de 90 jours - n'a plus
    // d'objet : une reunion interrompue est une LIGNE du compte restee ouverte, et
    // c'est `rescueAbandoned()` qui la ferme, au chargement du compte plutot
    // qu'ici. La difference n'est pas cosmetique : ce moment-ci n'a pas de
    // session, donc il ne peut pas lire une ligne.

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
      const refusal = refuseIfNoAccount();
      if (refusal) return { ok: false, error: refusal };
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
        return { ok: true, recordingId: snap.recordingId };
      }
      return longRec.stop();
    };
    const longMarkDep = () => longRec.mark();
    const longTranscriptDep = (since: number) => longRec.transcriptSince(since);
    const canLoopbackDep = () => NativeCapture.available(); // C2: "this is a PC" gate
    // B3e : nommes exactement comme les deps long* ci-dessus, et pour la meme
    // raison - les routes HTTP de l'archive et les canaux UI_HISTORY_* doivent
    // lire la MEME chose, par les MEMES deux fonctions. Ce qu'elles lisent est
    // maintenant le compte.
    //
    // Le plafond de lecture s'applique ICI et non dans le depot : couper un
    // document a la lecture ferait qu'une annotation le reecrirait tronque, ce
    // qui detruirait la fin du transcript de quelqu'un. L'affichage borne, le
    // depot rend tout.
    /**
     * LA LISTE, PLUS UN FAIT QUE SEULE CETTE MACHINE CONNAIT.
     *
     * 2026-08-04 : le depot dit qu'une reunion a garde son audio ; il ne peut pas
     * dire si le fichier est ICI. Un seul `readdir` repond pour toute la liste -
     * jamais un `existsSync` par ligne, parce que ce processus porte le crochet
     * clavier et qu'une liste peut compter deux mille reunions.
     */
    const listRecordingsDep = async () => {
      const r = await repo.listRecordings();
      if (!r.ok) flowLog(`[data] la liste des reunions n'a pas pu etre lue : ${r.error}`);
      const here = await audioLocal.present();
      return r.data.map((item) => ({ ...item, audioLocal: here.has(item.id) }));
    };
    const readRecordingDocDep = async (id: string) => {
      const r = await captureStore.read(id);
      if (!r) return null;
      const text =
        Buffer.byteLength(r.doc, "utf8") > MAX_DOC_DISPLAY_BYTES
          ? Buffer.from(r.doc, "utf8").subarray(0, MAX_DOC_DISPLAY_BYTES).toString("utf8")
          : r.doc;
      return { id: r.id, title: r.title, startedIso: r.startedIso, text };
    };
    const deleteRecordingDep = async (id: string) => {
      // La ligne d'abord, l'objet audio ensuite : une ligne supprimee dont
      // l'audio survit est un objet orphelin dans un seau prive, ce qui coute de
      // la place. L'inverse - un audio supprime sous une reunion encore listee -
      // serait un lecteur qui clique « telecharger l'audio » et n'obtient rien.
      const row = await captureStore.read(id);
      const gone = await repo.deleteRecording(id);
      if (!gone.ok) flowLog(`[data] la reunion n'a pas pu etre supprimee : ${gone.error}`);
      if (gone.ok) {
        // 2026-08-04 : LE FICHIER LOCAL AUSSI, et c'est le cas normal maintenant.
        // Sans cette ligne, supprimer une reunion laisserait 101 Mo que plus rien
        // ne peut nommer - le pire genre de fuite, parce qu'elle est invisible.
        await audioLocal.remove(id);
        // Et l'objet du seau quand la reunion vient d'une version 2.0.x et que le
        // balayage n'est pas encore passe.
        if (row?.audioPath) {
          const wiped = await repo.deleteAudio(row.audioPath);
          if (!wiped.ok) flowLog(`[data] l'audio de la reunion supprimee est reste : ${wiped.error}`);
        }
      }
      return listRecordingsDep();
    };
    // B1: same discipline as every dep above - the Diagnostics panel (IPC) and
    // a `bench:hotpath` run against a live app (HTTP) must read the exact same
    // in-memory ring, never two independently-serialized copies.
    const hotpathSnapshotDep = () => hotpath.snapshot();
    // B5: same discipline again - the Diagnostics panel's "Run the checks" button
    // (IPC) and a support request read over the loopback API must produce the
    // SAME six verdicts, off one implementation, at one instant.
    const selfCheckDep = () => gatherSelfCheck();

    api = new LocalApi({
      version: app.getVersion(),
      log: flowLog, // A10: the api.json no-overwrite path must be visible in a built app
      isUpdateBusy: () => modelTransfers > 0, // A10: a model download blocks /update-readiness too
      isListening: () => listening,
      isRecording: () => longRec.isBusy,
      isEngineWarm: () => sidecar !== null,
      canLoopback: canLoopbackDep,
      hotpathSnapshot: hotpathSnapshotDep,
      selfCheck: selfCheckDep,
      // B1: the HTTP /transcribe endpoint (AGR Pilot's phone mic) is
      // deliberately UNTRACED - see processUtterance's module note.
      // Le micro d'un telephone qui dicte a travers l'API locale. MEME porte que
      // le raccourci : sans compte, le dictionnaire ne s'appliquerait pas, et le
      // texte rendu aurait l'air juste sans l'etre.
      transcribe: (wav) => {
        const refusal = refuseIfNoAccount();
        if (refusal) return Promise.resolve({ text: "", ms: 0, error: refusal });
        return processUtterance(wav);
      },
      longState: longStateDep,
      longStart: (opts) => {
        const refusal = refuseIfNoAccount();
        return refusal ? { ok: false, error: refusal } : longRec.start({ title: opts.title, keepAudio: !!opts.keepAudio });
      },
      longStartNative: longStartNativeDep,
      longStop: longStopDep,
      longSave: (dir) => longRec.save(dir), // v6 c7: file the recording at Stop
      longNotesSplice: (recordingId, notes) => longRec.notesSplice(recordingId, notes),
      longMark: longMarkDep,
      longChunk: (pcm) => {
        markActivity(); // streamed audio = the engine is working (quiet window)
        longRec.onChunk(pcm);
        return { ok: true };
      },
      longGap: (seconds) => longRec.gap(seconds),
      longTranscript: longTranscriptDep,
      // B3e : les deux consts ci-dessus, partagees octet pour octet avec
      // UiBridge. `resolveHistoryEntry` a disparu avec le dossier.
      //
      // 2026-08-04 : la route /long/history/audio diffuse a nouveau un FICHIER
      // local - c'est la seule chose qu'elle puisse faire depuis que l'audio ne
      // monte plus. Le chemin est resolu ICI, jamais recu d'un client, donc cette
      // route ne peut pas devenir une primitive de lecture arbitraire. L'URL
      // signee reste derriere, pour les reunions faites par une version 2.0.x.
      localAudioPath: localAudioPathDep,
      listHistory: listRecordingsDep,
      readHistoryDoc: readRecordingDocDep,
      signAudio: (id) => signAudioDep(id),
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
        downloadNotesModel: () => downloadNotesModel(),
        signIn: (email, password) => auth.signIn(email, password),
        signOut: () => auth.signOut(),
        // B3d : les enregistrements vivent dans le compte, mais un dossier peut
        // encore porter ceux d'avant. Le bouton « Ouvrir le dossier » pointe donc
        // vers CE dossier-la quand il existe, et vers rien quand il n'existe pas -
        // jamais vers un dossier que Flow ne remplit plus.
        historyRootDir: () => legacyHistoryForUi()?.dir ?? "",
        // U2b: resolved in MAIN, never passed in by the renderer - the bridge
        // opens fixed destinations only (see UI_OPEN_PATH).
        // U2c: null unless the folder is REALLY there, so the bridge can never
        // be asked to open a path that vanished (shell.openPath would just
        // return an error string and the button would look broken).
        legacyHistoryDirPath: () => {
          const info = legacyHistoryForUi();
          return info && info.exists ? info.dir : null;
        },
        pendingAudioDir: () => audioLocal.dir(),
        audioUsage: () => audioLocal.totalBytes(),
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
        // D7: main-only, no HTTP twin (see ipcContracts.ts). `startedIso` comes
        // from the PAGE and is checked by the store against the slot; `atMs` is
        // computed HERE from the recorder's own snapshot, never from the
        // renderer, so the note's offset and the transcript's offsets come from
        // one clock and one start instant. A note arriving while nothing is
        // recording gets 0 and is refused by the store anyway (no slot matches).
        liveNotesList: () => liveNotes.list(),
        liveNoteAdd: (startedIso, text) => {
          const snap = longStateDep();
          const atMs = snap.active ? snap.durationMs : 0;
          return liveNotes.add(startedIso, text, atMs);
        },
        liveNoteEdit: (startedIso, id, text) => liveNotes.edit(startedIso, id, text),
        liveNoteDelete: (startedIso, id) => liveNotes.remove(startedIso, id),
        canLoopback: canLoopbackDep,
        // U5a: identical closures to LocalApi's above (listHistoryDep &
        // readHistoryDocDep, defined once, just above) - the Notes page's
        // archive view and the HTTP /long/history* routes can never disagree.
        listHistory: listRecordingsDep,
        // Deliberately NOT given to LocalApi, unlike listHistory beside it: a
        // phone on the local network may READ the archive, and must never be
        // able to delete a recording from it.
        deleteHistory: (id: string) => deleteRecordingDep(id),
        readHistoryDoc: readRecordingDocDep,
        // U5c: browser-style downloads (Roch's decision) - main-only, no HTTP
        // equivalent (a remote PWA has no business writing into this
        // machine's Downloads folder).
        downloadDoc: (id) => downloads.downloadDoc(id),
        downloadAudio: (id) => downloads.downloadAudio(id),
        lastDownloadedPath: () => downloads.lastDownloadedPath(),
        // D11: main-only for a stronger reason than the downloads above - this
        // one destroys, irreversibly. Deliberately NOT given to LocalApi.
        redactPassages: (id, targets) => redactor.remove(id, targets),
        // D2: main-only too. ui:import-start hands the engine a path to READ,
        // and a phone answering the local API over the network has no business
        // naming files on this machine. The queue itself refuses anything that
        // is not an existing regular file with a supported audio extension.
        importState: () => importQueue.snapshot(),
        // Un fichier importe produit une reunion, exactement comme une capture :
        // sans compte, elle n'aurait nulle part ou aller. Le refus arrive AVANT que
        // le fichier soit decode - decouvrir le probleme apres vingt minutes de
        // transcription serait la meme faute, en plus long.
        importStart: (req) => {
          const refusal = refuseIfNoAccount();
          // La forme complete d'un refus, et non un objet abrege : la page lit
          // `rejected` pour dire QUELS fichiers ont ete refuses, et un tableau
          // absent lui ferait afficher un refus sans nommer ce qui a ete refuse.
          if (refusal) return { ok: false, accepted: [], rejected: [], error: refusal };
          return importQueue.start(req);
        },
        importCancel: (id) => importQueue.cancel(id),
        importPick: () => pickAudioFiles(),
        // B1: identical closure to LocalApi's above (hotpathSnapshotDep,
        // defined once, just above) - the Diagnostics panel and a
        // `bench:hotpath` run must never disagree on what is currently open/completed.
        hotpathSnapshot: hotpathSnapshotDep,
        // B5: identical closure to LocalApi's above (selfCheckDep, defined once,
        // just above) - the panel's button and the loopback route can never
        // answer two different diagnoses of the same machine.
        selfCheck: selfCheckDep,
        // U7: deliberately NOT given to LocalApi. These counters describe the
        // person sitting at this machine, and the local API answers a remote
        // PWA over the network; there is no reason for a phone to be able to
        // read - or erase - them.
        statsRead: () => stats.read(),
        statsClear: () => stats.clear(),
        // 2026-07-30: the dictation history. Deliberately NOT given to
        // LocalApi, like the counters: a phone on the local network has no
        // business reading back a month of what was dictated on this machine.
        historyRead: () => ({ ok: true, ...history.read() }),
        historyClear: () => ({ ok: true, ...history.clear() }),
        // V5 E5: deliberately NOT given to LocalApi, for the same reason as the
      },
      mainWindow,
    );
    // Review U1j: a snapshot the moment the window becomes visible again.
    // Both push channels are visibility-gated, so a theme flip (or any state
    // change) that happened while hidden would otherwise stay invisible for
    // up to a second after a tray "Open Flow" - a dark page under native
    // caption buttons already recolored light.
    mainWindow.setOnShow(() => uiBridge?.pushNow());

    // B5: the startup self-diagnostic, into flow.log. It runs LAST and on a
    // delay (see runStartupSelfCheck) so it describes a settled engine, and it
    // is deliberately fire-and-forget: a boot must never wait on a diagnostic.
    runStartupSelfCheck();

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
    update: (() => {
      const u = updater?.state();
      return { phase: u?.phase ?? "idle", version: u?.version ?? "", pct: u?.pct ?? 0 };
    })(),
    version: app.getVersion(),
    status: engineStatus(),
    engineWarm: asrWarm,
    listening,
    recording: longRec.isBusy,
    backend: sidecar ? path.basename(sidecar.activeBackend() || "") : "",
    modelState: lastModelState,
    // D1: l'autre modele - celui qui redige - a son propre etat, parce que c'est
    // un autre fichier, un autre telechargement et une autre panne.
    notesModel: notesModelSnapshot(),
    // A2: qui est connecte. Jamais son jeton - voir shared/ipcContracts.ts.
    account: accountSnapshot,
    // B4 : etre connecte ne suffit pas a pouvoir enregistrer - la copie de travail
    // peut ne pas avoir charge. La fenetre a besoin des DEUX pour dire la verite
    // plutot que « connecte » au-dessus d'un bouton qui refuse.
    accountDataReady: workingCopy.isReady(),
    // Ce qui n'est pas encore monte dans le compte, toutes files confondues. Pour
    // le DIRE : une reunion en cours hors ligne est en securite, mais quelqu'un
    // doit pouvoir le savoir plutot que de l'esperer.
    // 2026-08-04 : l'audio ne fait plus partie de ce compte. Il n'y a plus qu'une
    // file - celle du document - et « unsent » redit exactement ce qu'il dit :
    // ce qui n'est pas encore monte dans le compte.
    unsent: workingCopy.pending(),
    // F1: derived on every snapshot from the live settings AND the live process,
    // never remembered here - the Settings row that reads it must not be able to
    // outlive the fact it describes.
    batchEngine: batchEngine.state(),
    paused: tray !== null && tray.pausedUntilMs() !== null,
    hookOk: hookIsArmed(hook),
    hook,
    settings: {
      language: settings.language,
      model: settings.model,
      batchModel: settings.batchModel, // F1: "" = batch work shares the dictation engine
      micDeviceId: settings.micDeviceId,
      sounds: settings.sounds,
      summaryModel: settings.summaryModel,
      forceCpu: settings.forceCpu,
      insertMode: settings.insertMode,
      theme: settings.theme,
      // U7a: the two switches only - the counters themselves are PULLED
      // (ui:stats-read), never pushed once a second (ipcContracts.ts).
      stats: settings.stats,
      statsPerApp: settings.statsPerApp,
      // U8: the SWITCH only - the suggestions themselves are PULLED
      // (ui:assist-poll), never pushed once a second (ipcContracts.ts).
    },
    // U0: what to actually paint right now, separate from the preference above.
    resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    comboLabel: comboLabel(settings.combo),
    models: [...AVAILABLE_MODELS],
    canLoopback: NativeCapture.available(),
    apiPort: api?.boundPort() ?? 0,
    apiToken: api?.sessionToken() ?? "",
    dataDir: dataDir(),
    logPath: path.join(dataDir(), "flow.log"),
    legacyHistory: legacyHistoryForUi(),
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
// B9: sleep / wake / lock / unlock. Same lifecycle again - powerMonitor only
// answers once the app is ready, and its subscriptions are released on quit.
let systemWatch: SystemWatch | null = null;

// Focus probe: decides insert-at-cursor vs leave-on-clipboard per dictation.
let probe: FocusProbe | null = null;

function focusProbeScript(): string {
  return resourcePath("focus-probe.ps1");
}

// The warm ASR sidecar: model ensured (first run downloads it into AGR Flow's
// own data folder, outside the install), whisper-server spawned once, model
// loaded once. Dictating while the warm-up is still running simply queues on
// ensureStarted() inside transcribe().
//
// Second scan F3 (3/3): that sentence was FALSE when it was written and is true
// again now. ensureStarted() returned early on `proc && port`, both of which are
// assigned before the model has loaded - so an early utterance POSTed to a port
// nothing was listening on yet, the refusal killed the loading child, and the
// GPU backend landed in badBackends for the whole session. A several-fold
// slowdown, silent, with no visible cause. The gate is now `verified`.
// Review B10 (major): the self-check and the UI used to read `sidecar !== null`
// as "the engine is warm". The object is assigned BEFORE ensureStarted() is
// awaited, so a backend that FAILED to start still answered "Warm" - the one
// question a self-diagnostic exists to answer honestly. This flag is fed ONLY
// by the sidecar's own onState callback (see shared/selfCheck.ts engineWarm).
let asrWarm = false;
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
    // U6b (storey 1): the seed PLUS a bounded slice of the user's dictionary.
    // A function, not a string: the sidecar outlives every edit to the
    // dictionary, and dictationPrompt() returns a cached string rebuilt at each
    // write - so a term added at 10:00 is in the prompt of the 10:00:01
    // dictation, without this path ever reading a file.
    initialPrompt: () => dictationPrompt(FRENCH_PROMPT),
    probeWav: loadProbeWav(), // R1: real decode gate at backend selection
    log: flowLog, // R1: always-on log file (dev also echoes to console)
    onState: (state, detail) => {
      asrWarm = state === "warm"; // the ONE writer; see the flag's declaration
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
    // Review B10 (major): lastModelState used to be written ONLY by swapModel,
    // so the very first launch - the one that downloads 550 MB - left it at
    // "idle" and the self-check reported a FAILURE while the app was doing
    // exactly what it should. Same shape as swapModel's own loop, on purpose.
    lastModelState = { status: "downloading", pct: 0 };
    const model = await ensureModel(settings.model ?? DEFAULT_MODEL_FILE, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        lastModelState = { status: "downloading", pct };
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
    lastModelState = { status: "ready" };
  } catch (err) {
    console.error("[asr] warm-up failed:", err);
    flowLog(`[asr] warm-up failed: ${err}`); // R1: visible in a built app
    lastModelState = { status: "error", message: String(err instanceof Error ? err.message : err) };
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
// P1: one provider for the whole process. Its model resolution is the one that
// used to be copy-pasted in longform.finalize and audioImport.
const ollamaProvider = new OllamaProvider({
  preferredModel: () => settings.summaryModel,
  listModels: () => listOllamaModels(),
});
// D1 : le modele embarque. P9 avait ecrit le fournisseur et epingle les
// empreintes ; il manquait le telechargement du binaire, son lanceur et ce
// cablage-ci. La release 1.22.0 a tout de meme annonce que l'invariant « un ami
// qui installe Flow a le produit complet » etait ferme. Il ne l'etait pas : la
// classe existait, rien ne l'appelait.
//
// MESURE du 2026-08-03, sur cette machine : llama-server demarre en 2,5 s et
// Qwen2.5-3B produit de vraies notes de reunion en 10,7 s, sans Ollama.
const llamaServer = new LlamaServer({
  binPath: () => path.join(resourcePath("bin"), "llama-server.exe"),
  modelPath: () => notesModelPath(),
  log: flowLog,
});
const embeddedProvider = new LocalSidecarProvider({
  baseUrl: () => llamaServer.baseUrl(),
  apiKey: () => llamaServer.apiKey(),
  log: flowLog,
});

/** D : un seul LIEU d'execution - cette machine - et aucun reglage pour en
 * changer. Deux implementations tout de meme, choisies toutes seules :
 * l'embarque par defaut, Ollama s'il est la et que l'embarque ne l'est pas.
 *
 * Le choix est fait A CHAQUE APPEL et jamais capture : telecharger le modele
 * embarque doit prendre effet au resume suivant, pas au prochain redemarrage.
 *
 * Le serveur n'est demarre que lorsqu'on lui demande vraiment quelque chose.
 * Charger 1,9 Go au lancement de Flow pour une reunion qui n'aura peut-etre pas
 * lieu serait payer la VRAM et le disque pour rien. */
const llmProvider: LlmProvider = {
  get id() { return ollamaProvider.id; },
  get locality() { return "on-this-machine" as const; },
  get vendor() { return ""; },
  available: async () => {
    // « Installe », pas « deja demarre ». La distinction n'est pas theorique :
    // c'est le defaut que la verification en lancant l'application a trouve, et
    // aucune des quatre portes ne pouvait l'attraper.
    //
    // Ce que faisait la premiere version : demander a embeddedProvider s'il
    // etait disponible, c'est-a-dire si baseUrl() etait non vide, c'est-a-dire
    // si le serveur TOURNAIT DEJA. Or il ne demarre qu'a la premiere demande de
    // resume. Donc, a la fin de chaque enregistrement, longform demandait « est-
    // ce que quelqu'un peut resumer ? », s'entendait repondre non, et ecrivait
    // « no model available: transcript only, no summary » - avec le binaire et
    // les 1,9 Go de poids sagement installes a cote.
    //
    // La question que longform pose vraiment est « est-ce que ca vaut la peine
    // de lire tout le transcript ? ». La bonne reponse est donc l'existence des
    // deux fichiers, pas l'etat d'un processus.
    if (llamaServer.ready()) return { found: true, responded: true };
    return ollamaProvider.available();
  },
  long: async (prompt, opts) => {
    if (llamaServer.ready()) {
      try {
        await llamaServer.ensureStarted();
        return await embeddedProvider.long(prompt, opts);
      } catch (err) {
        // Le modele embarque n'a pas demarre : on ne perd pas le resume pour
        // autant si Ollama est la. Le document sort avec son transcript seul
        // dans le pire cas, ce que tous les appelants savent traiter.
        flowLog("[llm] embedded model unavailable, falling back: " + String(err));
      }
    }
    // `opts` n'est pas transmis, et ce n'est pas un oubli : OllamaProvider.long
    // ne prend qu'un argument. L'interface declare `opts?` parce que le
    // fournisseur embarque, lui, sait annuler ; le repli sur Ollama garde le
    // comportement qu'il a toujours eu. Le lui passer ne compile pas, ce qui est
    // la bonne facon d'apprendre ce genre de chose.
    return ollamaProvider.long(prompt);
  },
  short: async (prompt, opts) => {
    if (llamaServer.ready()) {
      try {
        await llamaServer.ensureStarted();
        return await embeddedProvider.short(prompt, opts);
      } catch {
        /* meme repli */
      }
    }
    return ollamaProvider.short(prompt, opts);
  },
};

// D1 : l'etat du modele de redaction, tel que la page Reglages le montre.
//
// « idle » veut dire PAS INSTALLE, et c'est un etat normal du produit : sans
// lui, un enregistrement rend tout de meme son transcript horodate complet.
// Seules les notes manquent.
let notesModelState: ModelStatePayload = { status: "idle" };
let notesModelDownloading = false;

function notesModelSnapshot(): ModelStatePayload {
  // Pendant un telechargement, l'avancement fait foi. Sinon c'est le disque qui
  // repond, et jamais une variable : le fichier peut avoir ete telecharge par
  // un lancement precedent, ou efface a la main entre deux ouvertures de la
  // page.
  if (notesModelDownloading) return notesModelState;
  // Le disque a le dernier mot sur une erreur passee : un echec suivi d'une
  // reussite ne doit pas laisser « download failed » a l'ecran pour toujours.
  if (llamaServer.ready()) return { status: "ready" };
  return notesModelState.status === "error" ? notesModelState : { status: "idle" };
}

/** Va chercher les 1,9 Go, sur pression d'un bouton et jamais autrement.
 *
 * Un seul telechargement a la fois, et un second appel est ignore plutot que
 * mis en file : le bouton est deja desactive dans la page, donc un second appel
 * ne peut venir que d'un double clic ou d'une deuxieme fenetre. */
async function downloadNotesModel(): Promise<void> {
  if (notesModelDownloading) return;
  notesModelDownloading = true;
  let lastPct = -1;
  notesModelState = { status: "downloading", pct: 0 };
  try {
    await ensureNotesModel((pct) => {
      if (pct === lastPct) return;
      lastPct = pct;
      notesModelState = { status: "downloading", pct };
    });
    notesModelState = { status: "ready" };
  } catch (err) {
    // Dit, pas avale. Le cas le plus probable n'est pas une attaque mais une
    // coupure reseau au milieu de 1,9 Go, et l'utilisateur doit pouvoir
    // reappuyer sur le bouton en sachant pourquoi.
    flowLog("[notes-model] download failed: " + String(err));
    notesModelState = { status: "error", message: String(err instanceof Error ? err.message : err) };
  } finally {
    notesModelDownloading = false;
  }
}

// ---------------------------------------------------------------------------
// A2 : le compte.
//
// Construit au demarrage mais SANS aucun appel reseau : le magasin relit le
// jeton chiffre du disque a son premier acces, et le client ne parle a Supabase
// que lorsqu'on lui demande quelque chose. Flow doit pouvoir se lancer, armer
// le clavier et dicter sans qu'une connexion Internet soit necessaire.
// ---------------------------------------------------------------------------
const sessionStore = new SessionStore({
  dir: () => dataDir(),
  // safeStorage est passe en trois fonctions plutot qu'en objet : c'est ce qui
  // rend le magasin testable sans Electron, et surtout ce qui rend testable le
  // chemin « pas de trousseau », qui ne s'execute jamais sur une vraie machine
  // Windows et pourrirait donc sans bruit.
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (cipher) => safeStorage.decryptString(cipher),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  log: flowLog,
});
const supabase = createFlowClient({ storage: sessionStore });
const auth = new Auth({ client: supabase, store: sessionStore, log: flowLog });

// B1/B2 : la copie de travail. Tout ce que Flow gardait sur le disque de
// l'utilisateur - reglages, dictionnaire, statistiques, dictees - vit ici en
// memoire pendant la session, et dans le compte le reste du temps.
//
// LES TROIS MAGASINS SONT BRANCHES ICI ET PAS AILLEURS, au chargement du
// module, AVANT que quoi que ce soit ne lise un reglage. Les brancher plus tard
// laisserait une fenetre pendant laquelle loadSettings() rendrait les defauts a
// des appelants qui les garderaient.
const repo = new Repo({ client: supabase, log: flowLog });
const workingCopy = new WorkingCopy({ repo, log: flowLog });
useSettingsBacking(workingCopy);
useDictionaryBacking(workingCopy);

// B3a : le magasin d'une capture. Nomme ici, a cote de la copie de travail dont
// il depend, et non a cote du recorder : c'est une piece de la couche donnees.
const captureStore = new WorkingCopyCaptureStore({ workingCopy, repo });

/** Ou les .wav en transit attendent leur televersement. `dataDir()` est appele
 * ici - main/index.ts en a le droit, longform.ts non. */
/**
 * OU VIVENT LES .WAV DES REUNIONS, ET LE MODULE QUI EN REPOND.
 *
 * 2026-08-04, decision de Roch : l'audio reste sur la machine, seul le document
 * se synchronise. Ce qui vivait ici - une file de televersement TUS, son client
 * HTTP, ses reprises et ses tranches de 6 Mo - a ete supprime, pas desactive.
 *
 * `dataDir()` est appele ICI : main/index.ts a le droit de resoudre un chemin,
 * longform.ts et audioImport.ts non.
 */
const audioDir = audioDirIn(dataDir());
const audioLocal = new AudioLocal({ dir: () => audioDir, log: flowLog });

/** La liste des reunions, pour le BALAYAGE de l'audio.
 *
 * Une fonction de module et non la fermeture `listRecordingsDep` : celle-la vit
 * dans `whenReady`, et le balayage part de `loadAccountData`. Ce qu'elle rend est
 * la meme chose, calculee de la meme facon - le depot, puis ce que ce disque a -
 * et le balayage n'a besoin de rien de plus.
 */
async function listRecordingsForSweep(): Promise<RecordingSummary[]> {
  const r = await repo.listRecordings();
  if (!r.ok) throw new Error(r.error);
  const here = await audioLocal.present();
  return r.data.map((item) => ({ ...item, audioLocal: here.has(item.id) }));
}

/** Charge le compte, puis reveille ce qui en depend.
 *
 * L'ORDRE DES TROIS DERNIERES LIGNES EST LE SUJET. `refreshDictionaryCache()`
 * est ce qui evite la deuxieme des sept regressions du plan - un terme present
 * dans la page et sans aucun effet sur ce qui est dicte, parce que la table de
 * regles compilee date d'avant la connexion. `history.adopt()` remonte ce qui a
 * ete dicte AVANT la connexion plutot que de le laisser mourir a la fermeture. */
async function loadAccountData(): Promise<void> {
  const r = await workingCopy.load();
  if (!r.ok) {
    flowLog(`[data] le compte n'a pas pu etre charge : ${r.error}`);
    return;
  }
  refreshDictionaryCache();
  primeDictionary(flowLog);
  history.adopt();
  noAccountSaid = false; // le compte est la : un futur refus devra se dire a nouveau
  applyDictationSuspension(); // et la dictee se reveille, si le plateau ne la retient pas
  applySettings({}); // reapplique ce qui vient d'arriver : raccourci, langue, theme
  // B3b : LE SAUVETAGE DES REUNIONS INTERROMPUES.
  //
  // Ici et pas au demarrage du moteur, parce qu'il lui faut une session : une
  // ligne ouverte est une ligne du COMPTE, et avant la connexion il n'y a rien a
  // lire. C'est aussi le seul moment garanti de chaque session, la meme raison
  // qui a fait mettre la purge de retention dans workingCopy.load().
  //
  // EN ARRIERE-PLAN, delibere : la connexion ne doit pas attendre que des
  // reunions soient recollees, et un sauvetage qui echoue - hors ligne, par
  // exemple - sera refait au prochain lancement. La ligne reste ouverte
  // entre-temps, ce qui est precisement ce qui le rend rejouable.
  void longRec.rescueAbandoned().then(
    (n) => {
      if (n > 0) flowLog(`[long] ${n} reunion(s) interrompue(s) retrouvee(s) et fermee(s)`);
    },
    (err) => flowLog(`[long] le sauvetage des reunions interrompues a echoue : ${err}`),
  );
  // 2026-08-04 : LE BALAYAGE DE L'AUDIO. Il ne televerse plus rien ; il RAMENE
  // l'audio des reunions faites par une version 2.0.x, pour que la decision de
  // Roch soit vraie des reunions deja enregistrees et pas seulement des
  // prochaines. Meme discipline que le sauvetage juste au-dessus : en
  // arriere-plan, rejouable, et destructeur uniquement sur un fait certain.
  void audioLocal
    .sweep({
      list: listRecordingsForSweep,
      read: (id) => captureStore.read(id),
      write: (row) => captureStore.write(row),
      fetch: (objectName, destPath) => repo.downloadAudioTo(objectName, destPath),
      releaseObject: async (objectName) => {
        const wiped = await repo.deleteAudio(objectName);
        // Pas une erreur bloquante : l'objet peut deja ne pas exister (c'est le
        // cas d'une reunion dont l'audio avait ete refuse pour sa taille), et
        // l'audio est en securite sur le disque de toute facon.
        if (!wiped.ok) flowLog(`[audio] l'objet du compte n'a pas pu etre lache : ${wiped.error}`);
      },
      recordingNow: () => (longRec.isBusy ? longRec.state().recordingId : ""),
    })
    .catch((err) => flowLog(`[audio] le balayage a echoue : ${err}`));
}

/** Le dernier etat de compte connu, rafraichi par la poussee a 1 Hz.
 *
 * Une COPIE plutot qu'un appel dans getUiState(), parce que getUiState est
 * synchrone et que lire la session ne l'est pas. Le decalage maximal est d'une
 * seconde, ce qui est invisible pour un ecran qui affiche « connecte en tant
 * que ... » - et bien preferable a rendre synchrone une chose qui ne l'est
 * pas. */
let accountSnapshot: AccountSnapshot = { signedIn: false, email: "", userId: "" };
void auth.account().then((a) => {
  accountSnapshot = a;
});
// Et ensuite par evenement, jamais par sondage : connexion, deconnexion, et le
// rafraichissement automatique du jeton toutes les heures.
auth.onChange((a) => {
  const wasSignedIn = accountSnapshot.signedIn;
  accountSnapshot = a;
  if (a.signedIn && !wasSignedIn) {
    void loadAccountData();
  } else if (!a.signedIn && wasSignedIn) {
    // La copie de l'ancien compte ne doit pas survivre : la personne suivante a
    // se connecter sur cette machine verrait son dictionnaire.
    workingCopy.reset();
    // Et la dictee se rendort dans le meme souffle : `reset()` vide la copie, donc
    // `isReady()` est deja faux quand cette ligne s'execute.
    applyDictationSuspension();
  }
});

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
// D2: utterances currently inside processUtterance - the tail AFTER the key is
// released, where the model decode and the insertion happen. `listening` alone
// covers press-to-release and drops the moment the key comes up, which is
// precisely when the engine gets busy: an import that only watched `listening`
// would step back in and contend for the GPU with the dictation it was standing
// aside for. Counted, not a boolean: the local /transcribe endpoint can overlap
// a local press.
let utterancesInFlight = 0;

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
  // D2: an import counts. It runs for minutes on the speech engine, and an
  // update that restarted the app in the middle of one would leave a partial
  // document to be rescued at the next boot instead of a finished note.
  return listening || longRec.isBusy || importQueue.isBusy || modelTransfers > 0;
}

// B11: the event-loop lag sampler - the measurement B1 never had (plan §3.6.2)
// and the trigger T1 that can reopen the B7 no-go (plan §3.6.6). The policy,
// the two cadences and the reasoning behind them are in shared/loopLag.ts; this
// is only the wiring: a real timer, the ring next to handlerLatenciesMs, and the
// one predicate that decides the cadence.
//
// `isActive` deliberately reuses the pair this file already keeps for the
// updater's quiet window rather than inventing a second notion of "busy": one
// definition that can be wrong is better than two that can disagree. The tail
// keeps the fast cadence running for a few seconds past the last transition,
// because the work that blocks the loop (the WAV decode, the VAD, the sidecar's
// stderr burst) lands just AFTER a press ends, not during it. Date.now() here is
// a cadence decision, never a measurement - the lag itself is timed on the
// monotonic clock inside the sampler.
const LOOP_LAG_ACTIVE_TAIL_MS = 5_000;
const loopLagSampler = new LoopLagSampler({
  scheduler: realScheduler(),
  onSample: (ms) => hotpath.sampleLoopLag(ms),
  isActive: () => engineBusy() || Date.now() - lastActivityAt < LOOP_LAG_ACTIVE_TAIL_MS,
});
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

// ---- B5: the self-diagnostic ----
//
// The JUDGMENT (green / amber / red, and what to do about a red) is pure and
// unit-tested in shared/selfCheck.ts. Everything below only OBSERVES: it is the
// one place in the app allowed to answer "can Flow actually write where it keeps
// everything", and the only place that reads six unrelated pieces of state at
// one instant so they can be compared honestly.

/** The real test, not a permission bit: write a byte and delete it. `fs.access`
 * lies on Windows often enough to be useless (it reports the ACL, not what a
 * disconnected network drive or a read-only container will actually do), and
 * this check exists precisely for the machines where the obvious answer is
 * wrong. Synchronous on purpose: it runs at startup and on demand, never on the
 * keyboard hook's path. */
function probeDataDirWritable(): { writable: boolean; error?: string } {
  const dir = dataDir();
  const probeFile = path.join(dir, ".write-probe");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probeFile, "flow self-check");
    fs.unlinkSync(probeFile);
    return { writable: true };
  } catch (err) {
    return { writable: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/** One coherent set of observations, then the pure verdict. Async only because
 * enumerating audio devices needs a round trip to a renderer. */
async function gatherSelfCheck(): Promise<SelfCheckReport> {
  const mics = await overlay.listMics();
  // An empty list means two different things (see OverlayWindow.canListMics):
  // report "not established" rather than inventing "this machine has no
  // microphone" out of a page that simply has not loaded yet.
  const ready = overlay.canListMics();
  let modelPresent: boolean | null = null;
  try {
    modelPresent = fs.existsSync(modelFilePath(settings.model));
  } catch {
    // The models folder can live on another volume (%LOCALAPPDATA%): a stat that
    // cannot even run is "unknown", never a claim that the model is missing.
    modelPresent = null;
  }
  const disk = probeDataDirWritable();
  const facts: SelfCheckFacts = {
    hook: hotkey.health(),
    micCount: ready ? mics.length : null,
    micError: ready ? undefined : "the window that enumerates audio devices has not finished loading",
    engineWarm: asrWarm,
    backend: sidecar ? path.basename(sidecar.activeBackend() || "") : "",
    modelFile: settings.model,
    modelPresent,
    modelState: lastModelState,
    apiPort: api?.boundPort() ?? 0,
    // NOT the token: this object is the SELF-CHECK's facts, and a self-check
    // is a thing you show to someone or paste into a report. The port is
    // diagnostics; the token is a credential, and the two do not travel
    // together no matter how adjacent they look at the call site.
    dataDir: dataDir(),
    dataDirWritable: disk.writable,
    dataDirError: disk.error,
    nowIso: new Date().toISOString(),
  };
  return evaluateSelfCheck(facts);
}

/** Long enough for the ASR warm-up to have chosen a backend, the API to have
 * bound a port and the overlay renderer to have loaded, so the startup report
 * describes a settled machine instead of a booting one - and short enough that
 * it is in the log before the user's first dictation. A first run downloading
 * a 550 MB model will still be at "downloading (n%)", which the report states
 * as amber rather than as a failure. */
const SELF_CHECK_STARTUP_DELAY_MS = 5_000;

function runStartupSelfCheck(): void {
  setTimeout(() => {
    void gatherSelfCheck()
      .then((report) => {
        for (const line of formatSelfCheckForLog(report)) flowLog(line);
      })
      .catch((err) => flowLog(`[selfcheck] could not run the startup self-check: ${String(err)}`));
  }, SELF_CHECK_STARTUP_DELAY_MS);
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
  applySettings({ legacyHistoryDir: dir });
}

/**
 * B3d : LE DOSSIER QUE FLOW GERAIT LUI-MEME, ET QU'IL NE GERE PLUS.
 *
 * Le mecanisme ci-dessus existait pour une machine qui avait deplace ses
 * enregistrements ailleurs avant la 1.0.0. Il couvre maintenant le cas beaucoup
 * plus courant : `<dataDir>/history`, le dossier que CE Flow remplissait jusqu'a
 * cette vague. Les documents y sont, complets, et rien ne les lit plus.
 *
 * Ils ne sont ni deplaces ni supprimes, et c'est le seul choix defendable :
 * remonter automatiquement des annees de reunions dans un compte serait une
 * decision que personne n'a demandee, et les effacer serait la pire chose que
 * cette application puisse faire. Ils sont SIGNALES - un chemin, dans Reglages et
 * dans la page Notes - pour que la reponse a « ou sont passes mes
 * enregistrements » ne soit jamais « nulle part ».
 */
function noticeRetiredHistoryFolder(): void {
  if (settings.legacyHistoryDir) return; // un dossier est deja signale : ne pas l'ecraser
  const retired = path.join(dataDir(), "history");
  try {
    if (!fs.existsSync(retired)) return;
    // Un dossier vide n'a rien a signaler : il ne contient aucune reunion, et
    // pointer l'utilisateur vers rien serait une inquietude gratuite.
    if (fs.readdirSync(retired).filter((n) => !n.startsWith(".")).length === 0) return;
  } catch {
    return;
  }
  applySettings({ legacyHistoryDir: retired });
  flowLog(`[history] ${retired} contient des enregistrements que Flow ne gere plus : ils y restent, intacts`);
}

/** U2c (minor finding): the archive view lists the FIXED folder only, so for
 * these users it goes from "all my meetings" to "empty" with no explanation on
 * that screen. Until the Notes page can carry the pointer (wave U5), a startup
 * log line is the floor - not a substitute. */
function logLegacyHistoryState(): void {
  const info = legacyHistoryInfo(settings.legacyHistoryDir);
  if (!info) return;
  flowLog(
    `[history] la page Notes liste les reunions de votre COMPTE. Celles enregistrees avant cette mise a jour sont dans ` +
      `${info.dir}${info.exists ? "" : " (Flow ne trouve plus ce dossier)"} ; rien n'a ete deplace ni supprime.`,
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
// D7: the slot holding the notes the user types DURING a recording. Built before
// the recorder because the recorder is given it: the recorder is the ONE writer
// of the document, so the notes reach the document through it and never through a
// second writer. Nothing here resolves a path at module load - liveNotesPath()
// is called inside the store, on each operation (main/liveNotes.ts).
const liveNotes = new LiveNotesStore({
  log: flowLog,
  // Null tant que le compte n'a pas charge : les notes restent alors en
  // memoire pour la page, ce qui est deja mieux que de les refuser - et elles
  // partiront a la premiere ecriture qui trouve un magasin.
  backing: () => (workingCopy.isReady() ? workingCopy : null),
});

// F1: the SECOND speech engine, the one a meeting or an imported file runs on
// when the user has asked for a different model there. Built here - before the
// two consumers below - and deliberately holding NOTHING until batch work
// actually arrives: with the default settings (batchModel === "") it never
// spawns a process at all and every call goes straight to the warm dictation
// engine.
//
// The four facts that make "a dictation never waits for a model to load" a
// structural property rather than a hope are written out in
// main/asr/batchEngine.ts's module note. Two of them are visible right here:
// `dictationEngine` is a GETTER (so a swapModel() never leaves batch work
// holding a dead engine), and `makeSidecar` is newSidecar - the same function
// warmAsr and swapModel use - so the batch engine inherits the backend list,
// `forceCpu`, the beam size, the French seed and the dictionary prompt instead of
// restating any of them.
const batchEngine = new BatchEngine({
  dictationEngine: () => sidecar,
  dictationModel: () => settings.model,
  batchModel: () => settings.batchModel,
  ensureModel: (file) => ensureModel(file),
  makeSidecar: (modelPath) => newSidecar(modelPath),
  setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }),
  clearTimer: (t) => clearTimeout(t.id as ReturnType<typeof setTimeout>),
  log: flowLog,
  onFallback: () => silentFailures.increment(SILENT_FAILURE.batchEngineFallback),
});

const longRec = new LongRecorder({
  // F1: a meeting's segments go through the batch engine, which - with the
  // default settings - IS the warm dictation engine, byte for byte the same call
  // this dep made before. `allowEmptyDemote: false` moved inside it, because both
  // batch callers passed it for the same reason (see BatchEngine.transcribe).
  transcribeSegment: (wav) => batchEngine.transcribe(wav),
  // P1: the recorder no longer knows which model, nor whose. It asks the
  // provider, and the provider is the only thing in the process that had to
  // learn a second implementation exists.
  llm: llmProvider,
  // B3a : le document part ICI, et nulle part ailleurs. Le recorder ne sait pas
  // que Supabase existe.
  store: captureStore,
  // B3a : le .wav de la reunion. `dataDir()` est appele dans audioLocal, jamais
  // ici ni dans longform.ts, pour que le recorder n'ait aucune idee de l'endroit
  // ou vivent les donnees de cette machine.
  audioDir,
  // D7: the recorder opens the slot at start() and folds it into the document on
  // both of its end paths (normal finalize, quit rescue). Narrowed to those three
  // methods on purpose: the recorder has no business listing or editing notes,
  // which is the page's job. Le sauvetage au demarrage, lui, lit les notes depuis
  // le COMPTE (captureStore.readLiveNotes) : celles d'une seance morte ne sont
  // dans la memoire de personne.
  liveNotes: {
    open: (startedIso) => liveNotes.open(startedIso),
    read: (startedIso) => liveNotes.read(startedIso),
    clear: (startedIso) => liveNotes.clear(startedIso),
  },
  log: flowLog, // R1: long-recording diagnostics visible in a built app too
});

// U5c (Roch's decision): the archive's download flow - browser-style, straight
// into the OS Downloads folder, no dialog. app.getPath("downloads") is read
// LAZILY (inside the closure), never at module load: it is correct on Windows
// AND macOS and follows a folder the user relocated, but calling it this early
// would run before app.whenReady() for no benefit (download only actually
// happens well after boot).
const downloads = new DownloadManager({
  // B3e : le nom du fichier telecharge est compose ici, a partir de faits sur la
  // reunion (sa date, son titre) et non du nom de son dossier - il n'y a plus de
  // dossier. historyDownloadStem garde toutes ses regles de securite de nom
  // (caracteres interdits de Windows, noms de peripheriques reserves, longueur).
  readDoc: async (id) => {
    const row = await captureStore.read(id);
    if (!row) return null;
    return { stem: downloadStemFor(row.title, row.startedIso), text: row.doc };
  },
  openAudio: async (id) => {
    const row = await captureStore.read(id);
    if (!row?.audioPath) return null;
    const stream = await repo.openAudioStream(row.audioPath);
    if (!stream.ok || !stream.data) {
      flowLog(`[download] l'audio n'a pas pu etre ouvert : ${stream.error}`);
      return null;
    }
    return { stem: downloadStemFor(row.title, row.startedIso), bytes: row.audioBytes, body: stream.data };
  },
  downloadsDir: () => app.getPath("downloads"),
  log: flowLog,
});

/** Le nom de fichier d'une reunion telechargee : sa date locale puis son titre.
 * UNE fonction, parce que le document et l'audio d'une meme reunion doivent
 * porter le meme nom - sinon les deux moities ne se retrouvent plus dans le
 * dossier Telechargements. */
function downloadStemFor(title: string, startedIso: string): string {
  const d = new Date(Date.parse(startedIso) || Date.now());
  const p = (n: number) => String(n).padStart(2, "0");
  return historyDownloadStem(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, title);
}

/**
 * LE .WAV DE CETTE REUNION SUR CETTE MACHINE, OU "".
 *
 * SYNCHRONE, et c'est ce qui la rend utilisable par la route HTTP sans la faire
 * attendre : un `existsSync` sur un chemin compose, rien d'autre. Il n'y a pas de
 * lecture de ligne ici - le nom du fichier EST l'identifiant de la reunion, donc
 * la question « ce disque a-t-il cet audio » se repond sans le compte.
 *
 * Le chemin ne vient jamais d'un appelant : la route ne peut donc pas devenir une
 * primitive de lecture arbitraire, exactement comme avant.
 */
function localAudioPathDep(id: string): string {
  if (!id) return "";
  const p = audioLocal.pathFor(id);
  return fs.existsSync(p) ? p : "";
}

/** Une URL signee, courte, pour que la page PWA puisse ecouter l'audio d'une
 * reunion. Signee et non publique : le seau est prive, et il doit le rester -
 * l'audio d'une reunion en dit autant que son transcript. */
async function signAudioDep(id: string): Promise<{ url: string; bytes: number } | null> {
  const row = await captureStore.read(id);
  if (!row?.audioPath) return null;
  const signed = await repo.signAudioUrl(row.audioPath);
  if (!signed.ok) {
    flowLog(`[api] l'audio n'a pas pu etre signe : ${signed.error}`);
    return null;
  }
  return { url: signed.data, bytes: row.audioBytes };
}

// D11: removing a sensitive passage from an archived capture - the transcript
// AND the matching range of the audio. Same lazy historyRoot() closure as
// `downloads` just above (nothing may resolve a path at module load), and the
// same containment: it can only ever write inside a folder Flow itself
// established as a history root.
const redactor = new Redactor({
  readRecording: async (id) => {
    const row = await captureStore.read(id);
    if (!row) return null;
    return {
      doc: row.doc,
      audioObject: row.audioPath,
      audioBytes: row.audioBytes,
      // Ce que Storage a CONFIRME. Voir redact.ts : c'est ce nombre, et non le
      // chemin, qui dit s'il y a un objet a nettoyer.
      audioUploaded: row.audioUploaded,
    };
  },
  // Mise en file, jamais attendue jusqu'a Supabase : voir RedactDeps.writeDoc sur
  // pourquoi l'ordre du bandeau de redact.ts tient quand meme.
  writeDoc: (id, doc) => {
    void captureStore.read(id).then((row) => {
      if (row) captureStore.write({ ...row, doc });
    });
  },
  // 2026-08-04 : LE SILENCE S'ECRIT SUR PLACE. Le trajet « descendre, reecrire,
  // remonter » a disparu avec le televersement : le fichier est ici, et c'est
  // celui-la qu'on nettoie. Trois etapes reseau de moins, et le pire etat
  // atteignable est meilleur - il n'existe plus d'instant ou une copie nettoyee
  // attend de remplacer un objet distant.
  audioFile: (id) => audioLocal.pathFor(id),
  log: flowLog,
});

// ---- V4 D1/D2: importing an audio file ----
// The hidden decode window (Chromium's own codecs, no ffmpeg) and the pipeline
// that turns its PCM into a document in the archive. Same lazy-path discipline
// as `downloads` and `redactor` above: every folder is a closure, nothing
// resolves at module load.
const audioDecode = new AudioDecodeWindow(flowLog);
const importQueue = new ImportQueue({
  // The decode window is built on the FIRST import, not at boot: a hidden
  // renderer nobody has asked for should not cost a session's memory. create()
  // is idempotent, so this stays one line rather than a lifecycle.
  decode: (call) => {
    audioDecode.create(DEV);
    return audioDecode.decode(call);
  },
  // F1: the batch engine, exactly like a recorded meeting's segments - an import
  // is the other half of what "batch" means. With the default settings this is
  // still the warm dictation engine, and `allowEmptyDemote: false` (an imported
  // file legitimately contains music and ambience, so an empty decode must not
  // demote a healthy GPU) now lives inside the one call both callers make.
  transcribe: (wav) => batchEngine.transcribe(wav),
  // THE DICTATION ALWAYS WINS (plan §5.1.4, master invariant 2). The import
  // reads this before every segment and stands aside; the dictation path reads
  // NOTHING of the import's, holds no lock and acquires nothing, so a press can
  // never end up queued behind an import. `utterancesInFlight` is what makes
  // this cover the decode-and-insert tail after the key comes back up.
  userEngineClaim: () =>
    listening || utterancesInFlight > 0 ? "dictation" : longRec.isBusy ? "recording" : null,
  // B3e : LE MEME magasin qu'une capture en direct, ce qui remplace le partage du
  // dossier `staging/`. Un import que l'application ne finit pas laisse une ligne
  // OUVERTE, et `rescueAbandoned()` la ferme au prochain lancement : une seule
  // implementation, et exactement ce que le §5.1.4 promet - un import interrompu
  // est visible comme interrompu, jamais disparu.
  store: captureStore,
  audioDir: () => audioLocal.ensure(),
  summaryModel: () => settings.summaryModel,
  ollamaModels: () => listOllamaModels(),
  summarize: (_model, prompt) => llmProvider.long(prompt),
  log: flowLog,
});


// U7 (Roch's privacy policy, plan §10 - read shared/stats.ts's module note):
// the AGGREGATED dictation counters. Every dep is a closure for the same reason
// as `downloads` just above: dataDir() caches the POST-migration folder on its
// first call, so nothing here may resolve a path at module load.
//
// It is fed from exactly ONE place, the dictation path in wireCapture() below.
// The HTTP /transcribe endpoint (AGR Pilot's phone microphone) deliberately
// does NOT feed it: that dictation happens on another device, with no key press
// behind it and no focused app on this machine, so folding it in would make
// both the streak and the words-per-minute describe a mixture of two machines.
// Same opt-in-per-call-site reasoning as the hot-path trace.
const stats = new StatsStore({
  // B2 : null tant que le compte n'a pas charge. Les compteurs s'accumulent
  // alors en memoire et partent au premier vidage qui trouve un magasin.
  backing: () => (workingCopy.isReady() ? workingCopy : null),
  counting: () => settings.stats,
  perApp: () => settings.statsPerApp,
  log: flowLog,
});

// 2026-07-30: the dictation history. Same construction discipline as the
// statistics above - `file` is a CLOSURE because dataDir() caches the
// post-migration folder on its first call and this runs at module load.
const history = new DictationHistoryStore({
  // Null tant que le compte n'a pas fini de charger : `record()` garde alors la
  // dictee en memoire pour la page, et `adopt()` la remonte a la connexion.
  backing: () => (workingCopy.isReady() ? workingCopy : null),
  log: flowLog,
});

// NOTE: the "open AGR Pilot" shortcut used to live here (v5 c2, fired from Flow's keyspy),
// which coupled it to AGR Flow - disabling Flow killed the shortcut. It now belongs entirely to
// AGR Manager (its always-on LL hook), which owns Pilot and runs whether or not Flow does. This
// adapter only handles the dictation combo.
/**
 * POURQUOI FLOW PEUT REFUSER DE PRODUIRE QUELQUE CHOSE.
 *
 * ---------------------------------------------------------------------------
 * QUATRE CHEMINS, UNE SEULE FONCTION - ET C'EST TOUT LE SUJET
 * ---------------------------------------------------------------------------
 *
 * B4 avait ferme DEUX chemins sur quatre : le bouton d'enregistrement et
 * l'enregistrement pilote par l'API. Roch a installe la 2.0.0 le 2026-08-04 et a
 * trouve le troisieme en trente secondes - le raccourci de dictee fonctionnait
 * sans compte. Le quatrieme (l'import d'un fichier audio) n'etait pas ferme non
 * plus.
 *
 * Une porte fermee sur deux entrees d'une maison qui en a quatre n'est pas une
 * porte a moitie fermee : c'est une maison ouverte. La fonction est donc UNE,
 * nommee, au niveau du module, et chaque entree l'appelle - plutot que quatre
 * verifications qui se ressemblent et dont on decouvre la quatrieme en
 * l'installant.
 *
 * ---------------------------------------------------------------------------
 * CE QUE PRODUISAIT L'OUBLI DE LA DICTEE, et pourquoi c'est le pire des quatre
 * ---------------------------------------------------------------------------
 *
 * Le texte partait BIEN au curseur : le moteur de parole est local, il n'a besoin
 * de personne. Mais le dictionnaire vient de la copie de travail, qui etait VIDE.
 * Les termes appris ne s'appliquaient donc pas, sans un mot - et le resultat
 * avait l'air juste. C'est exactement la deuxieme des sept regressions que le
 * plan demande de chercher (« un terme de dictionnaire sans effet »), sous sa
 * forme la plus vicieuse. L'historique et les statistiques, eux, tombaient dans
 * une file qui echoue et mouraient avec le processus.
 *
 * ---------------------------------------------------------------------------
 * `isReady()` ET NON `signedIn`
 * ---------------------------------------------------------------------------
 *
 * Etre connecte ne suffit pas : la copie de travail peut avoir echoue a charger -
 * hors ligne au lancement - et c'est ELLE qui porte le dictionnaire. Les deux cas
 * ont deux messages, parce que « connectez-vous » et « ca charge » ne veulent pas
 * dire la meme chose : les confondre ferait retaper un mot de passe pour un
 * probleme de reseau.
 *
 * Rend "" quand tout va bien, et la phrase a montrer sinon.
 */
function refuseIfNoAccount(): string {
  if (workingCopy.isReady()) return "";
  return accountSnapshot.signedIn
    ? "Flow n'a pas encore charge votre compte. Attendez un instant, ou verifiez votre connexion : ce qui serait produit maintenant n'aurait nulle part ou aller, et votre dictionnaire ne s'appliquerait pas."
    : "Connectez-vous d'abord. Vos reglages, votre dictionnaire et vos reunions vivent dans votre compte - sans lui, votre dictionnaire ne s'appliquerait pas et ce qui serait produit serait perdu a la fermeture.";
}

/**
 * LA DICTEE EST-ELLE SUSPENDUE ? UNE SEULE DECISION, DEUX FAITS.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CE N'EST PAS UN REFUS DANS `onStart`
 * ---------------------------------------------------------------------------
 *
 * Roch, le 2026-08-04 : « le raccourci s'allume et s'eteint directement, meme si
 * on n'est pas logine. Il fonctionne pas, mais faut pas que ca apparaisse.
 * L'application est TURN OFF, rien fonctionne. On fait une pause complete. »
 *
 * Ma premiere version refusait DANS `onStart` : elle jouait le son, montrait la
 * pastille un quart de seconde, puis la retirait - en se disant qu'« une pression
 * doit toujours etre ressentie ». Cet argument vaut quand Flow POSSEDE la touche.
 * Sans compte, Flow ne possede rien : montrer sa pastille est alors une
 * application qui fait semblant d'etre vivante, ce qui est pire que le silence.
 *
 * `suspend(true)` laisse les touches passer a l'OS SANS etre interceptees. Il n'y
 * a donc rien a refuser, rien a montrer, rien a annuler : la dictee n'existe pas.
 * C'est le meme mecanisme que la pause du plateau, et c'est deliberement le meme -
 * « Flow ne dicte pas en ce moment » est un seul etat, pas deux qui se ressemblent.
 *
 * ---------------------------------------------------------------------------
 * DEUX PROPRIETAIRES, UNE SEULE ECRITURE
 * ---------------------------------------------------------------------------
 *
 * La pause du plateau et le compte veulent tous les deux suspendre. S'ils
 * appelaient `suspend()` chacun de leur cote, celui qui parle en dernier gagne :
 * charger le compte reveillerait une dictee que le plateau venait de mettre en
 * pause, et le plateau reveillerait une dictee qui n'a pas de compte. Les deux
 * FAITS sont donc gardes separement, et une seule fonction en derive l'etat.
 *
 * Le micro suit, pour la raison qui a fait ajouter cette ligne a la pause du
 * plateau : suspendre le raccourci seul laissait le microphone ouvert et son
 * temoin allume, juste apres qu'on ait demande a Flow de ne plus ecouter.
 */
let trayPaused = false;

function applyDictationSuspension(): void {
  const suspended = trayPaused || !workingCopy.isReady();
  hotkey.suspend(suspended);
  setMicWarmthSuspended(suspended);
}

/** Le refus « pas de compte » a-t-il deja ete dit ? Remis a zero des que le
 * compte charge, pour que la prochaine session hors compte le dise a nouveau. */
let noAccountSaid = false;

const hotkey = new HotkeyAdapter(settings.combo, {
  onStart() {
    markActivity();
    // ---------------------------------------------------------------------
    // LA DICTEE AUSSI A BESOIN DU COMPTE, et l'oublier etait un vrai defaut.
    //
    // Signale par Roch le 2026-08-04, en installant la 2.0.0 : le raccourci
    // fonctionnait sans etre connecte. B4 avait ferme la porte pour
    // l'enregistrement et n'avait pas pose la meme question a la dictee.
    //
    // CE QUE CA PRODUISAIT, et pourquoi c'est pire qu'un simple oubli : le
    // texte partait BIEN au curseur - le moteur de parole est local, il n'a
    // besoin de personne - mais le dictionnaire vient de la copie de travail,
    // qui etait VIDE. Donc les termes appris ne s'appliquaient pas, sans un
    // mot. C'est exactement la deuxieme des sept regressions que le plan
    // demande de chercher (« un terme de dictionnaire sans effet »), et sa
    // forme la plus vicieuse : le resultat a l'air juste.
    //
    // L'historique de dictee et les statistiques, eux, tombaient dans une file
    // qui echoue et mouraient avec le processus.
    //
    // LE REFUS EST RESSENTI, jamais silencieux : meme `startAndRefuse` que le
    // refus « une reunion tient le moteur » - son, pastille, et la session
    // demontee un instant plus tard. Quelqu'un qui appuie doit toujours sentir
    // qu'il a appuye, y compris quand la reponse est non (voir le commentaire
    // de startAndRefuse dans overlay.ts).
    // SANS COMPTE, ON NE DEVRAIT PAS ETRE ICI DU TOUT : `applyDictationSuspension`
    // a laisse les touches passer a l'OS, donc `onStart` n'est jamais appele.
    //
    // Cette garde reste quand meme, et elle n'est pas de la ceinture et des
    // bretelles : la suspension est appliquee au chargement du compte et a la
    // deconnexion, donc il existe une fenetre - courte, mais reelle - entre
    // l'instant ou la copie de travail se vide et celui ou la touche cesse d'etre
    // ecoutee. Une dictee qui partirait dans cette fenetre n'aurait ni
    // dictionnaire ni destination.
    //
    // RIEN N'EST MONTRE : pas de son, pas de pastille. Sans compte, Flow ne
    // possede pas cette touche, et montrer sa pastille serait une application qui
    // fait semblant d'etre vivante.
    if (!workingCopy.isReady()) {
      hotpath.abandon(HOTPATH_ABANDON_REASON.noAccount);
      if (!noAccountSaid) {
        noAccountSaid = true;
        flowLog("[hotkey] dictee ignoree : la dictee est suspendue tant qu'aucun compte n'est charge");
      }
      return;
    }
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
    pressStartedAt = Date.now(); // B9: see noteCaptureContinuity
    hotpath.mark("captureStartDecided");
    overlay.startCapture({ sounds: settings.sounds, micDeviceId: settings.micDeviceId });
  },
  onStop() {
    markActivity();
    listening = false;
    pressEndedAt = Date.now(); // B9: see noteCaptureContinuity
    overlay.stopCapture(); // marks "overlayStopSent"
  },
  onCancel(reason) {
    markActivity();
    listening = false;
    overlay.cancelCapture(); // marks "overlayCancelSent" on the still-open trace
    hotpath.abandon(reason);
  },
  // B2: the shortcut is one key away from complete (only ever true for a
  // three-key-or-longer shortcut - see ComboMatcher.preArmed for why the
  // default two-key one deliberately never reaches here). Re-sending the SAME
  // policy is what "warm now" means: it opens the microphone if it is closed
  // and restarts the hold window if it is already open, with no second code
  // path to keep in step with the first.
  onPreArm() {
    applyMicWarmth();
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

/** B2: the ONE place the microphone pre-warm policy is derived and pushed.
 *
 * Deliberately a single function called from four places (boot, a settings
 * change, the pre-arm edge, and the renderer's own replay on load) rather than
 * a policy computed at each of them: "how long may Flow hold the microphone"
 * is a privacy decision, and a privacy decision computed in four places is a
 * privacy decision that will eventually disagree with itself. The mapping
 * itself is pure and unit-tested in shared/micWarmth.ts. */
/** Review B10 (major): the warm microphone is SUSPENDED by an outside order -
 * the session locking, the machine sleeping, dictation paused from the tray.
 * Kept apart from the (now unconditional) warm window on purpose: a transient
 * overwrite what the user chose. A microphone left open through a gesture that
 * MEANS "stop listening" is a privacy breach in the most literal sense, and the
 * Windows indicator would sit there saying so. */
let micWarmthSuspended = false;
function setMicWarmthSuspended(v: boolean): void {
  if (micWarmthSuspended === v) return;
  micWarmthSuspended = v;
  applyMicWarmth();
}

function applyMicWarmth(): void {
  overlay.setWarmPolicy(
    micWarmthSuspended ? null : warmPolicy(settings.micDeviceId),
  );
}

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
  // D2: and the import queue stands aside for exactly this window - the model
  // decode plus the insertion, which is where a dictation actually needs the
  // engine. Incremented BEFORE the first await, released in the finally, so
  // there is no instant where an utterance is running and nothing says so.
  utterancesInFlight++;
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
    // U6c (storey 2): the deterministic substitutions, on the FINAL text -
    // after every existing filter and before anything downstream inserts it.
    //
    // The order is the point. Before gateTranscript, a rule could rewrite a
    // known hallucination into something the gate no longer recognizes, and the
    // phantom string would land at the cursor. After it, the only text a rule
    // can touch is text Flow has already decided to keep.
    //
    // Cost: linear in the transcript, independent of the number of rules, and
    // literally the same string back when the user has none (shared/
    // dictionary.ts). This runs once per utterance on the process that carries
    // the keyboard hook, so that bound is a requirement, not a nicety.
    return { text: applyDictionaryReplacements(clean), ms };
  } finally {
    utterancesInFlight--;
    markActivity();
  }
}

// B9: when the current press began and ended, main-process clock. Two numbers,
// nothing else - they exist so noteCaptureContinuity below can tell a clip that
// is simply SHORT from a microphone that STOPPED partway through the press, a
// failure nothing in this app could see before (see shared/captureContinuity.ts).
let pressStartedAt = 0;
let pressEndedAt = 0;

/** Judge the press that just ended, then forget it. Reads the pair above ONCE
 * and clears it, so a WAV that arrives without a press behind it - the HTTP
 * /transcribe endpoint, or a press refused because a long recording owns the
 * engine - can never be judged against a stale press window. */
function noteCaptureContinuity(capturedMs: number, preRollMs: number): void {
  const startedAt = pressStartedAt;
  const endedAt = pressEndedAt;
  pressStartedAt = 0;
  pressEndedAt = 0;
  if (startedAt === 0 || endedAt <= startedAt) return;
  const verdict = judgeCaptureShortfall(endedAt - startedAt, capturedMs, preRollMs);
  if (!verdict.dropped) return;
  silentFailures.increment(SILENT_FAILURE.micDroppedMidDictation);
  flowLog(shortfallLogLine(verdict));
}

function wireCapture() {
  // Security scan (LOW, 2026-08-02): these three were the app's only ipcMain
  // listeners without a sender check. See OverlayWindow.isFrom for why it is
  // worth one line even though the panel voted the finding down 0/3.
  ipcMain.on(CAPTURE_DONE, (ev, payload: CaptureDonePayload) => {
    if (!overlay.isFrom(ev.sender)) return;
    // B1: the WAV genuinely arrived - mark it before any early return, so a
    // too-short clip still closes as an honest (abandoned) trace instead of
    // leaving its open trace to be swept 30 s later as "stale".
    hotpath.markWavReceived(payload.durationMs);
    // B9: BEFORE the 300 ms early return below, on purpose. A microphone that
    // died two seconds into a five-second press is exactly the case that comes
    // back as a near-empty clip and gets dropped as "release noise" - the
    // loudest version of this failure is the one that would otherwise leave the
    // quietest trace.
    // Review B10 (major): a warm capture carries up to preRollCreditMs of audio
    // from BEFORE the key went down, so the raw WAV duration can EXCEED the hold.
    // Both the shortfall judge and the release-noise guard below must reason on
    // the hold's own audio, never on the padded clip.
    const preRoll = preRollCreditMs();
    noteCaptureContinuity(payload.durationMs, preRoll);
    // NOTHING is retained: the WAV lives in this handler, feeds one inference,
    // and every reference dies with it. Sub-300 ms of audio is release noise.
    // Every exit path calls overlay.flowDone() so the "Transcribing..." pill
    // never outlives the utterance.
    if (payload.durationMs - preRoll < 300) {
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
        // 2026-07-30: what you dictated is what gets inserted, full stop.
        //
        // Two features used to sit between these lines and the cursor. A VOICE
        // FUNCTION could send the transcript to a model to be rewritten, and a
        // SNIPPET CUE could swap the whole utterance for a stored block. Both
        // are gone at Roch's request, and the path is better for it: there is no
        // longer any question to answer between "the engine produced text" and
        // "the text is inserted", so nothing here can fail, stall, or substitute.
        //
        // It is also synchronous now, which matters beyond tidiness: the focus
        // probe below is no longer racing seconds of model time during which the
        // user may well have moved to another window.
        //
        // Probe the focus WHILE nothing else has stolen it, then route and act.
        const focus = (await probe?.probe()) ?? null;
        hotpath.mark("focusProbed");
        const route = decideRoute(focus);
        hotpath.mark("routeDecided");
        if (route === "insert") {
          // "type" mode keystrokes the text (paste-hostile apps); default pastes.
          // The rich-text branch went with snippets: a transcript is plain text,
          // and there is nothing left on this path that could carry formatting.
          if (settings.insertMode === "type") await insertTyped(text);
          else await insertViaPaste(text);
        } else leaveOnClipboard(text);
        // B1: textChars is a LENGTH, recorded after the text has already done
        // its job - never the text itself (see hotpath.ts's zero-retention note).
        hotpath.complete(route === "insert" ? "inserted" : "clipboarded", text.length);
        // U7b: the aggregated counters. This is the ONLY thing the statistics
        // feature ever learns about an utterance: a word COUNT, a duration, and
        // - only if the user turned attribution on - the application name the
        // focus probe already read a few lines above for routing. The text
        // itself never enters the subsystem: countWords consumes it here and
        // StatsUtterance carries a number (main/stats.ts). Memory only; the
        // disk is touched on a timer and at quit, never on this path.
        // 2026-07-30: the history gets the text that was actually INSERTED,
        // after every filter, so what the page shows is what landed rather
        // than what the model first said. Memory only here; the disk is
        // touched on a timer and at quit, never on this path.
        history.record(text);
        stats.record({
          words: countWords(text),
          // The HOLD's own audio. A warm capture carries up to preRollCreditMs
          // of sound from BEFORE the key went down (review B10), and counting
          // that as speaking time would quietly understate every
          // words-per-minute reading the page shows.
          ms: Math.max(0, payload.durationMs - preRoll),
          app: focus?.app,
        });
        // `text` goes out of scope here. It is no longer true that a dictation
        // is never retained: history.record above keeps it for a rolling month
        // (Roch's decision, 2026-07-30). Nothing else on this path does.
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
  // B2/B1: the two §3.3 budgets that live in the renderer. Both arrive as
  // DURATIONS on the overlay's own clock; hotpath.markOverlayTimings turns them
  // into marks by adding them to overlayStartSent, an instant THIS process
  // recorded. Correlation is the same FIFO-by-age rule wavReceived already uses,
  // and a message that finds no matching open trace (a refused press, closed
  // synchronously by onStart) is dropped rather than mis-attributed.
  ipcMain.on(CAPTURE_TIMING, (ev, payload: CaptureTimingPayload) => {
    if (!overlay.isFrom(ev.sender)) return;
    hotpath.markOverlayTimings(payload.firstPaintMs, payload.firstSampleMs);
  });
  ipcMain.on(CAPTURE_ERROR, (ev, message: string) => {
    if (!overlay.isFrom(ev.sender)) return;
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
  // F1: read BEFORE the assignment like every other flag here. Deliberately NOT
  // folded into `modelChanged`: the whole point of the batch model is that
  // choosing it can never make the DICTATION engine reload, and folding it in
  // would do exactly that (`modelChanged` drives swapModel). forceCpu counts here
  // too, because it changes the backend candidate list the batch sidecar was built
  // with - the same reason it forces a dictation swap one line up.
  const batchModelChanged = next.batchModel !== settings.batchModel || backendChanged;
  const themeChanged = next.theme !== settings.theme;
  // B2: both inputs of the pre-warm policy. The microphone matters as much as
  // the mode: a warm graph is bound to ONE device, so picking another one has
  // to close it - otherwise the next dictation would be captured, warm and
  // fast, from the microphone the user just stopped choosing.
  const warmthChanged =
    next.micDeviceId !== settings.micDeviceId;
  // U7a: read BEFORE the assignment, like every other change flag here - the
  // store reads the LIVE settings, so it must be told after they have moved.
  const statsChanged = next.stats !== settings.stats || next.statsPerApp !== settings.statsPerApp;
  Object.assign(settings, next);
  saveSettings(settings);
  if (comboChanged) hotkey.setCombo(settings.combo);
  if (langChanged) sidecar?.setLanguage(settings.language);
  if (modelChanged || backendChanged) void swapModel(settings.model);
  // F1: drops a batch engine the user stopped asking for, and clears a stale
  // failure. It starts nothing: the batch engine only ever loads when batch work
  // arrives, which is what keeps this setting free for anyone who never records
  // or imports anything.
  if (batchModelChanged) batchEngine.settingsChanged();
  if (themeChanged) applyTheme(settings.theme);
  // Applied IMMEDIATELY, never at the next restart: turning this off is the
  // user asking for the microphone to be closed, and "it will be, later" is not
  // an answer to that request.
  if (warmthChanged) applyMicWarmth();
  // U7a: the same rule for the other privacy switches - both act on the SPOT,
  // in both directions. Turning attribution off ERASES what is already on disk
  // (settingsChanged rewrites the file without any apps field), and turning the
  // counters off drops what is sitting in memory before it can ever be written.
  // "It will take effect at the next restart" is not an answer to a privacy
  // switch either.
  if (statsChanged) stats.settingsChanged();
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

/** D2/D3: the native open dialog for an import, opened by MAIN. The renderer
 * never enumerates the filesystem and never gets a path it did not already have;
 * everything this returns went through the OS picker with the user's own hands
 * on it. Modal to the main window when it exists (a picker floating loose behind
 * the app is how a dialog gets lost), and an empty list for a cancel - which is
 * also what a refused sender gets, so the page treats the two identically. */
async function pickAudioFiles(): Promise<string[]> {
  const contents = mainWindow.contents();
  const parent = contents ? BrowserWindow.fromWebContents(contents) : null;
  const options: Electron.OpenDialogOptions = {
    title: "Import audio",
    // multiSelections: a queue exists precisely so several files can be dropped
    // (or picked) at once. openFile only: a folder would be an unbounded walk.
    properties: ["openFile", "multiSelections", "dontAddToRecent"],
    filters: [
      { name: "Audio", extensions: SUPPORTED_AUDIO_EXTENSIONS.map((e) => e.slice(1)) },
      { name: "All files", extensions: ["*"] },
    ],
  };
  try {
    const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return r.canceled ? [] : r.filePaths;
  } catch (err) {
    flowLog(`[import] the file picker failed: ${err}`);
    return [];
  }
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
  // B9: BEFORE hotkey.stop(). A resume or a lock delivered while the app is
  // tearing itself down would otherwise ask a stopping adapter to rebuild its
  // hook - harmless (rearm() checks `stopped`) but exactly the kind of race
  // that is cheaper to make impossible than to reason about at 2 a.m.
  systemWatch?.stop();
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
  // D2: the same synchronous discipline for an import in flight. Whatever it had
  // already transcribed is filed WITH the note saying how far it got; an import
  // that had produced nothing leaves nothing behind. Before the decode window is
  // destroyed, so nothing races the teardown.
  importQueue.rescueOnQuit();
  audioDecode.destroy();
  nativeCapture.destroy();
  asrWarm = false;
  sidecar?.stop();
  // D1: et le modele de redaction avec lui. Sans ceci, un llama-server survit a
  // la fermeture de Flow et garde 1,9 Go de VRAM - `child.kill()` n'atteint pas
  // les petits-enfants sur Windows, d'ou le taskkill en arbre du lanceur.
  llamaServer.stop();
  // F1: AFTER the two rescues above, which are the last things that can ask it to
  // transcribe anything. Both are synchronous and neither reaches the engine (they
  // file what is already on disk), so nothing is cut short - this only kills the
  // second whisper-server instead of leaving it to the process teardown. A no-op
  // on the overwhelming majority of machines, where no second engine ever loaded.
  batchEngine.stop();
  probe?.stop();
  api?.stop();
  // U7b: the last counter flush, synchronously, while the process still exists.
  // Same reasoning and the same place in the sequence as flushPendingRestore()
  // and logQueue.flushSync() below: whatever is only in memory at this instant
  // is lost forever otherwise, and up to a minute of counters is exactly what
  // the 60 s timer trades away for keeping the disk off the dictation path.
  stats.stop();
  // B2 : rien a arreter, et surtout rien a attendre - before-quit est
  // synchrone (voir workingCopy.pending()).
  // B4b: LAST, on purpose. Every line the shutdown above just wrote (the
  // recorder's rescue, the API's cleanup) is still sitting in the queue: the
  // writes are asynchronous now, and this handler is synchronous with the
  // process dying right after it, so no scheduled drain would ever run. Same
  // reasoning and the same place in the sequence as flushPendingRestore() and
  // rescueOnQuit() above - the last diagnostics of a session are very often the
  // ones that explain why it ended.
  logQueue.flushSync();
});

// A headless engine must not die when its only (hidden) window closes.
app.on("window-all-closed", () => {
  /* keep running */
});
