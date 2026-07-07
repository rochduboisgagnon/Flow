import { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain, shell } from "electron";
import path from "node:path";
import { HotkeyAdapter } from "./hotkey";
import { OverlayWindow } from "./overlay";
import { WhisperSidecar } from "./asr/sidecar";
import { ensureModel, DEFAULT_MODEL_FILE, AVAILABLE_MODELS } from "./asr/modelStore";
import { FocusProbe } from "./focus/probe";
import { insertViaPaste, leaveOnClipboard } from "./insert";
import { decideRoute } from "../shared/route";
import { comboLabel } from "../shared/combo";
import { loadSettings, saveSettings, sanitizeSettings, type FlowSettings } from "./settings";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import { pcmFromWav, encodeWav } from "../shared/wav";
import { listOllamaModels, cleanTranscript, warmCleanupModel } from "./llm/ollama";
import { CLEANUP_MIN_CHARS } from "../shared/cleanup";
import { LocalApi } from "./api";
import {
  CAPTURE_DONE,
  CAPTURE_ERROR,
  SETTINGS_GET,
  SETTINGS_SET,
  SHORTCUT_RECORD,
  OPEN_MIC_SETTINGS,
  OLLAMA_MODELS,
  MODEL_STATE,
  type CaptureDonePayload,
  type ModelStatePayload,
} from "../shared/ipcContracts";

// AGR Flow: local, on-device dictation. Phase 1 = Windows push-to-talk loop.
// This entry point owns the app lifecycle: single instance, tray, settings window.
// Design rule carried through the whole codebase: THE DICTATION IS NEVER STORED,
// neither on disk nor in a retained buffer. Audio and text live only for the
// duration of one utterance and are handed straight to the insertion path.

const DEV = process.env.AGRFLOW_DEV === "1";

// Settings (shortcut, language, model, microphone) live in ~/.agr-flow,
// outside the install; loaded once at boot, mutated via the settings window.
const settings = loadSettings();

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;

// Second launch = focus the existing instance instead of duplicating tray icons.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());

  app.whenReady().then(() => {
    // The overlay (commit 3) captures the microphone from a renderer: grant media
    // requests from OUR OWN windows only, without a system-style popup. Everything
    // else stays denied by default.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === "media");
    });
    createTray();
    openSettings();
    overlay.create(DEV);
    wireCapture();
    wireSettingsIpc();
    startPtt();
    void warmAsr();
    if (settings.cleanup && settings.cleanupModel) warmCleanupModel(settings.cleanupModel);
    probe = new FocusProbe(focusProbeScript(), DEV ? (m) => console.log(m) : undefined);
    api = new LocalApi({
      version: app.getVersion(),
      isListening: () => listening,
      isRecording: () => false, // long-form capture arrives with phase 4
      isEngineWarm: () => sidecar !== null,
      transcribe: (wav, cleanup) => processUtterance(wav, cleanup),
    });
    api.start().catch((err) => console.error("[api] failed to start:", err));
  });
}

// Local API for the AGR ecosystem (AGR Pilot's mic, AGR Manager's quiet window).
let api: LocalApi | null = null;

// Focus probe: decides insert-at-cursor vs leave-on-clipboard per dictation.
let probe: FocusProbe | null = null;

function focusProbeScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "focus-probe.ps1")
    : path.join(app.getAppPath(), "resources", "focus-probe.ps1");
}

// The warm ASR sidecar: model ensured (first run downloads it into AGR Flow's
// own data folder, outside the install), whisper-server spawned once, model
// loaded once. Dictating while the warm-up is still running simply queues on
// ensureStarted() inside transcribe().
let sidecar: WhisperSidecar | null = null;

function serverBinaryPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", "whisper-server-win32-x64.exe")
    : path.join(app.getAppPath(), "resources", "bin", "whisper-server-win32-x64.exe");
}

function newSidecar(modelPath: string): WhisperSidecar {
  return new WhisperSidecar({
    binaryPath: serverBinaryPath(),
    modelPath,
    language: settings.language,
    log: DEV ? (m) => console.log(m) : undefined,
    onState: (state) => {
      // Tray = the plan's status indicator (ready / listening / error).
      if (state === "warm") tray?.setToolTip("AGR Flow");
      else if (state === "down") tray?.setToolTip("AGR Flow - speech engine restarting...");
      else tray?.setToolTip("AGR Flow - speech engine failed (see Settings)");
    },
  });
}

async function warmAsr() {
  try {
    let lastPct = -1;
    const model = await ensureModel(settings.model ?? DEFAULT_MODEL_FILE, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        tray?.setToolTip(`AGR Flow - downloading the speech model (${pct}%)`);
      }
    });
    sidecar = newSidecar(model);
    await sidecar.ensureStarted();
    tray?.setToolTip("AGR Flow");
  } catch (err) {
    console.error("[asr] warm-up failed:", err);
    tray?.setToolTip("AGR Flow - speech engine unavailable");
  }
}

const overlay = new OverlayWindow();

// The dictation loop, main-process side. PTT drives the overlay (which owns the
// microphone); the finished WAV comes back once per utterance and is handed to
// the ASR sidecar, then every reference is dropped.
let listening = false; // dictation capture in flight (drives /update-readiness)

const hotkey = new HotkeyAdapter(settings.combo, {
  onStart() {
    listening = true;
    tray?.setToolTip("AGR Flow - listening...");
    overlay.startCapture({ sounds: settings.sounds, micDeviceId: settings.micDeviceId });
  },
  onStop() {
    listening = false;
    tray?.setToolTip("AGR Flow");
    overlay.stopCapture();
  },
  onCancel() {
    listening = false;
    tray?.setToolTip("AGR Flow");
    overlay.cancelCapture();
  },
});

/** The shared utterance pipeline (PTT loop AND local API): anti-hallucination
 * gate #1 (energy VAD - an accidental press must not insert invented text,
 * and trimming silence shortens the decode), warm ASR, then gates #2/#3
 * (per-segment no-speech in the protocol parser, known-hallucination list),
 * then the optional Ollama pass. Empty text = gated. Nothing is retained. */
async function processUtterance(
  wav: Uint8Array,
  cleanup: boolean,
): Promise<{ text: string; ms: number }> {
  if (!sidecar) throw new Error("speech engine not ready");
  const pcm = pcmFromWav(wav);
  const speech = analyzeSpeech(pcm);
  if (!hasSpeech(speech)) {
    if (DEV) console.log(`[vad] dropped: ${speech.voicedMs} ms voiced`);
    return { text: "", ms: 0 };
  }
  const { text, ms } = await sidecar.transcribe(encodeWav(trimToSpeech(pcm, speech)));
  let clean = gateTranscript(text);
  if (!clean) {
    if (DEV) console.log(`[gate] dropped: ${JSON.stringify(text)}`);
    return { text: "", ms };
  }
  // Optional Ollama pass (plan 5.1 step 4): punctuation + spoken formatting
  // commands. Opt-in, long texts only, falls back to the raw transcript on
  // any failure - never a gate, never a blocker.
  if (cleanup && settings.cleanupModel && clean.length > CLEANUP_MIN_CHARS) {
    clean = await cleanTranscript(settings.cleanupModel, clean);
  }
  return { text: clean, ms };
}

function wireCapture() {
  ipcMain.on(CAPTURE_DONE, (_ev, payload: CaptureDonePayload) => {
    // NOTHING is retained: the WAV lives in this handler, feeds one inference,
    // and every reference dies with it. Sub-300 ms of audio is release noise.
    // Every exit path calls overlay.flowDone() so the "Transcribing..." pill
    // never outlives the utterance.
    if (payload.durationMs < 300) return overlay.flowDone();
    void processUtterance(new Uint8Array(payload.wav), settings.cleanup)
      .then(async ({ text, ms }) => {
        if (!text) return;
        // Probe the focus WHILE nothing else has stolen it, then route and act.
        const focus = (await probe?.probe()) ?? null;
        const route = decideRoute(focus);
        if (route === "insert") await insertViaPaste(text);
        else leaveOnClipboard(text);
        // `text` goes out of scope here: the dictation is never retained (5.4).
        if (DEV)
          console.log(`[flow] ${ms} ms | focus=${focus?.control ?? "none"} -> ${route}`);
      })
      .catch((err) => console.error("[flow] failed:", err))
      .finally(() => overlay.flowDone());
  });
  ipcMain.on(CAPTURE_ERROR, (_ev, message: string) => {
    console.error("[capture] failed:", message);
    tray?.setToolTip("AGR Flow - microphone unavailable");
  });
}

// ---- Settings IPC: get / set (applied live) / shortcut recorder ----

function sendModelState(state: ModelStatePayload) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send(MODEL_STATE, state);
  }
}

// Swapping the ASR model: download if missing (progress to the settings
// window and the tray), then replace the warm sidecar. One swap at a time;
// a failed swap leaves the previous engine running.
let modelSwapping = false;
async function swapModel(file: string) {
  if (modelSwapping) return;
  modelSwapping = true;
  const old = sidecar;
  try {
    let lastPct = -1;
    sendModelState({ status: "downloading", pct: 0 });
    const model = await ensureModel(file, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        sendModelState({ status: "downloading", pct });
        tray?.setToolTip(`AGR Flow - downloading the speech model (${pct}%)`);
      }
    });
    const next = newSidecar(model);
    await next.ensureStarted();
    sidecar = next;
    old?.stop();
    tray?.setToolTip("AGR Flow");
    sendModelState({ status: "ready" });
  } catch (err) {
    console.error("[asr] model swap failed:", err);
    sendModelState({ status: "error", message: String(err) });
    tray?.setToolTip("AGR Flow");
  } finally {
    modelSwapping = false;
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
  const cleanupTurnedOn =
    next.cleanup && next.cleanupModel && (!settings.cleanup || next.cleanupModel !== settings.cleanupModel);
  Object.assign(settings, next);
  saveSettings(settings);
  if (comboChanged) hotkey.setCombo(settings.combo);
  if (langChanged) sidecar?.setLanguage(settings.language);
  if (modelChanged) void swapModel(settings.model);
  if (cleanupTurnedOn) warmCleanupModel(settings.cleanupModel);
  return { ...settings, combo: [...settings.combo] };
}

function wireSettingsIpc() {
  ipcMain.handle(SETTINGS_GET, () => ({
    settings: { ...settings, combo: [...settings.combo] },
    models: AVAILABLE_MODELS,
  }));
  ipcMain.handle(SETTINGS_SET, (_ev, patch: Partial<FlowSettings>) => applySettings(patch));
  ipcMain.handle(SHORTCUT_RECORD, async () => {
    const combo = await hotkey.record();
    if (combo && combo.length > 0) return applySettings({ combo }).combo;
    return null;
  });
  ipcMain.handle(OPEN_MIC_SETTINGS, () =>
    // Windows microphone privacy panel: the onboarding path when access is
    // denied (plan 5.9). macOS gets its own panels in phase 5.
    shell.openExternal("ms-settings:privacy-microphone"),
  );
  ipcMain.handle(OLLAMA_MODELS, () => listOllamaModels());
}

async function startPtt() {
  try {
    await hotkey.start();
    if (DEV) console.log(`[ptt] armed on ${comboLabel(settings.combo)}`);
  } catch (err) {
    // Dictation without a hotkey is dead: surface it instead of dying silently.
    console.error("[ptt] key listener failed to start:", err);
    tray?.setToolTip("AGR Flow - hotkey unavailable (see Settings)");
  }
}

app.on("before-quit", () => {
  hotkey.stop();
  overlay.destroy();
  sidecar?.stop();
  probe?.stop();
  api?.stop();
});

function iconPath(): string {
  // Packaged: resources/ sits next to the app; dev: repo root.
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "resources", "icon.png");
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("AGR Flow");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Settings", click: () => openSettings() },
      { type: "separator" },
      { label: "Quit AGR Flow", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => openSettings());
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 480,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Closing the settings window keeps the app alive in the tray (it is a
  // background dictation tool); only the tray menu quits it.
  settingsWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      settingsWin?.hide();
    }
  });
  if (DEV) settingsWin.loadURL("http://localhost:5183");
  else settingsWin.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

// A tray app must not die when its last window closes.
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
