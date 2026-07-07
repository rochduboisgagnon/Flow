import { app, session, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
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
import { listOllamaModels } from "./llm/ollama";
import { LocalApi } from "./api";
import { LongRecorder } from "./longform";
import {
  CAPTURE_DONE,
  CAPTURE_ERROR,
  type CaptureDonePayload,
  type ModelStatePayload,
} from "../shared/ipcContracts";

// AGR Flow: local, on-device dictation + long-recording engine.
// Since plan v2 (chantier A) this process is HEADLESS: no settings window, no
// tray, no shortcuts of its own. The only visible surface is the dictation
// overlay; every user-facing control lives in AGR Manager's AGR Flow view,
// which talks to the local API below. The Manager also launches, watches and
// stops this process, exactly like the AGR Pilot server.
// Design rule carried through the whole codebase: THE DICTATION IS NEVER
// STORED, neither on disk nor in a retained buffer.

const DEV = process.env.AGRFLOW_DEV === "1";

// Settings (shortcut, language, model, microphone) live in ~/.agr-flow,
// outside the install; loaded once at boot, mutated via the local API.
const settings = loadSettings();

// What the Manager shows as the engine status line (replaces the old tray
// tooltip channel). Exposed through GET /settings.
let statusText = "starting";

// Second launch = nothing to show (headless); the single instance stands.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    // The overlay captures the microphone from a renderer: grant media
    // requests from OUR OWN windows only, without a system-style popup.
    // Everything else stays denied by default.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === "media");
    });
    overlay.create(DEV);
    wireCapture();
    startPtt();
    void warmAsr();
    probe = new FocusProbe(focusProbeScript(), DEV ? (m) => console.log(m) : undefined);
    api = new LocalApi({
      version: app.getVersion(),
      isListening: () => listening,
      isRecording: () => longRec.isBusy,
      isEngineWarm: () => sidecar !== null,
      transcribe: (wav) => processUtterance(wav),
      longState: () => longRec.state(),
      longStart: (opts) => longRec.start({ dir: opts.dir, title: opts.title, keepAudio: !!opts.keepAudio }),
      longStop: () => longRec.stop(),
      longSave: (dir) => longRec.save(dir), // v6 c7: file the recording at Stop
      longMark: () => longRec.mark(),
      longChunk: (pcm) => {
        longRec.onChunk(pcm);
        return { ok: true };
      },
      longGap: (seconds) => longRec.gap(seconds),
      longTranscript: (since) => longRec.transcriptSince(since),
      // Settings surface for the Manager's AGR Flow view (chantier A).
      getSettings: () => ({
        settings: { ...settings, combo: [...settings.combo] },
        comboLabel: comboLabel(settings.combo),
        models: AVAILABLE_MODELS,
        modelState: lastModelState,
        status: statusText,
      }),
      setSettings: (patch) => {
        const applied = applySettings(patch);
        return { ...applied, comboLabel: comboLabel(applied.combo) };
      },
      recordShortcut: async () => {
        const combo = await hotkey.record();
        if (combo && combo.length > 0) {
          applySettings({ combo });
          return { combo, comboLabel: comboLabel(combo) };
        }
        return { combo: null };
      },
      recordOpenShortcut: async () => {
        // v5 c2: same gesture recorder, applied to the "open AGR Pilot" combo.
        const combo = await hotkey.record();
        if (combo && combo.length > 0) {
          applySettings({ openPilotCombo: combo });
          return { combo, comboLabel: comboLabel(combo) };
        }
        return { combo: null };
      },
      listMics: () => overlay.listMics(),
      ollamaModels: () => listOllamaModels(),
      quit: () => {
        // Graceful stop for the Manager (swap/uninstall): answer first, die next.
        setTimeout(() => app.quit(), 60);
      },
    });
    api.start().catch((err) => console.error("[api] failed to start:", err));
  });
}

// Local API for the AGR ecosystem (AGR Pilot's mic + long mode, AGR Manager's
// settings view and quiet window).
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

// v5 c1: ordered whisper-server candidates. The Vulkan build is GPU-accelerated
// on ANY modern GPU (NVIDIA/AMD/Intel), sub-second (e.g. Roch's RTX 4080); the CPU
// build is the universal fallback. The sidecar freezes the first that starts.
function serverBinaryPaths(): string[] {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, "bin")
    : path.join(app.getAppPath(), "resources", "bin");
  return [
    path.join(dir, "whisper-server-win32-x64-vulkan.exe"),
    path.join(dir, "whisper-server-win32-x64-cpu.exe"),
  ];
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
    log: DEV ? (m) => console.log(m) : undefined,
    onState: (state) => {
      if (state === "warm") statusText = "ready";
      else if (state === "down") statusText = "speech engine restarting...";
      else statusText = "speech engine failed";
    },
  });
}

async function warmAsr() {
  try {
    let lastPct = -1;
    const model = await ensureModel(settings.model ?? DEFAULT_MODEL_FILE, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        statusText = `downloading the speech model (${pct}%)`;
      }
    });
    sidecar = newSidecar(model);
    await sidecar.ensureStarted();
    statusText = "ready";
  } catch (err) {
    console.error("[asr] warm-up failed:", err);
    statusText = "speech engine unavailable";
  }
}

const overlay = new OverlayWindow();

// The dictation loop, main-process side. PTT drives the overlay (which owns the
// microphone); the finished WAV comes back once per utterance and is handed to
// the ASR sidecar, then every reference is dropped.
let listening = false; // dictation capture in flight (drives /update-readiness)

// Long-form recorder (plan §6 + v2 chantier C): remote-controlled through the
// local API by AGR Pilot's PWA page, which ALSO streams the audio from the
// recording device (/long/chunk). It shares the warm ASR with dictation;
// while it records, push-to-talk is politely refused.
const longRec = new LongRecorder({
  getSidecar: () => sidecar,
  cleanupModel: () => settings.cleanupModel,
  ollamaModels: () => listOllamaModels(),
  log: (m) => (DEV ? console.log(m) : undefined),
});

// v5 c2: the "open AGR Pilot" shortcut. Flow's keyspy runs on a DEDICATED thread
// that only pumps keys, so it never drops the combo the way a hook on the Manager's
// busy UI thread did (v4). On a match, Flow launches the Manager with --open-pilot;
// the Manager's single-instance handler signals the running Manager to open the AGR
// Pilot window (Program.cs). Best-effort: a failed launch never crashes the thread.
function openPilotApp(): void {
  try {
    // Flow lives at <hub>\AGR Flow\AGR Flow.exe; AGR-Manager.exe is one level up.
    const mgr = path.join(path.dirname(path.dirname(app.getPath("exe"))), "AGR-Manager.exe");
    if (!fs.existsSync(mgr)) return;
    spawn(mgr, ["--open-pilot"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* best effort */
  }
}

const hotkey = new HotkeyAdapter(settings.combo, settings.openPilotCombo, {
  onStart() {
    if (longRec.isBusy) {
      // The transcript belongs to the long recording; a dictation mid-meeting
      // would fight it for the warm engine.
      return;
    }
    listening = true;
    overlay.startCapture({ sounds: settings.sounds, micDeviceId: settings.micDeviceId });
  },
  onStop() {
    listening = false;
    overlay.stopCapture();
  },
  onCancel() {
    listening = false;
    overlay.cancelCapture();
  },
  onOpenPilot: openPilotApp,
});

/** The shared utterance pipeline (PTT loop AND local API): anti-hallucination
 * gate #1 (energy VAD - an accidental press must not insert invented text,
 * and trimming silence shortens the decode), warm ASR, then gates #2/#3
 * (per-segment no-speech in the protocol parser, known-hallucination list).
 * Empty text = gated. Nothing is retained. */
async function processUtterance(
  wav: Uint8Array,
): Promise<{ text: string; ms: number }> {
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
  const openComboChanged = JSON.stringify(next.openPilotCombo) !== JSON.stringify(settings.openPilotCombo);
  Object.assign(settings, next);
  saveSettings(settings);
  if (comboChanged) hotkey.setCombo(settings.combo);
  if (openComboChanged) hotkey.setOpenCombo(settings.openPilotCombo); // v5 c2: re-arm the open shortcut
  if (langChanged) sidecar?.setLanguage(settings.language);
  if (modelChanged) void swapModel(settings.model);
  return { ...settings, combo: [...settings.combo] };
}

async function startPtt() {
  try {
    await hotkey.start();
    if (DEV) console.log(`[ptt] armed on ${comboLabel(settings.combo)}`);
  } catch (err) {
    // Dictation without a hotkey is dead: surface it instead of dying silently.
    console.error("[ptt] key listener failed to start:", err);
    statusText = "keyboard hook unavailable";
  }
}

app.on("before-quit", () => {
  hotkey.stop();
  overlay.destroy();
  sidecar?.stop();
  probe?.stop();
  api?.stop();
});

// A headless engine must not die when its only (hidden) window closes.
app.on("window-all-closed", () => {
  /* keep running */
});
