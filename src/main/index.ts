import { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain } from "electron";
import path from "node:path";
import { HotkeyAdapter } from "./hotkey";
import { OverlayWindow } from "./overlay";
import { WhisperSidecar } from "./asr/sidecar";
import { ensureModel, DEFAULT_MODEL_FILE } from "./asr/modelStore";
import { DEFAULT_PTT_KEY } from "../shared/constants";
import { CAPTURE_DONE, CAPTURE_ERROR, type CaptureDonePayload } from "../shared/ipcContracts";

// AGR Flow: local, on-device dictation. Phase 1 = Windows push-to-talk loop.
// This entry point owns the app lifecycle: single instance, tray, settings window.
// Design rule carried through the whole codebase: THE DICTATION IS NEVER STORED,
// neither on disk nor in a retained buffer. Audio and text live only for the
// duration of one utterance and are handed straight to the insertion path.

const DEV = process.env.AGRFLOW_DEV === "1";

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
    startPtt();
    void warmAsr();
  });
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

async function warmAsr() {
  try {
    let lastPct = -1;
    const model = await ensureModel(DEFAULT_MODEL_FILE, (pct) => {
      if (pct !== lastPct) {
        lastPct = pct;
        tray?.setToolTip(`AGR Flow - downloading the speech model (${pct}%)`);
      }
    });
    sidecar = new WhisperSidecar({
      binaryPath: serverBinaryPath(),
      modelPath: model,
      log: DEV ? (m) => console.log(m) : undefined,
    });
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
// the next stage, then every reference is dropped. Next commit: the ASR sidecar
// consumes it; today we only log its size in dev.
const hotkey = new HotkeyAdapter(DEFAULT_PTT_KEY, {
  onStart() {
    tray?.setToolTip("AGR Flow - listening...");
    overlay.startCapture();
  },
  onStop() {
    tray?.setToolTip("AGR Flow");
    overlay.stopCapture();
  },
  onCancel() {
    tray?.setToolTip("AGR Flow");
    overlay.cancelCapture();
  },
});

function wireCapture() {
  ipcMain.on(CAPTURE_DONE, (_ev, payload: CaptureDonePayload) => {
    // NOTHING is retained: the WAV lives in this handler, feeds one inference,
    // and every reference dies with it. Sub-300 ms of audio is release noise.
    if (payload.durationMs < 300) return;
    if (!sidecar) {
      console.error("[asr] utterance dropped: engine not ready");
      return;
    }
    void sidecar
      .transcribe(new Uint8Array(payload.wav))
      .then(({ text, ms }) => {
        // Next commits: focus probe + insertion. Today the loop ends here.
        if (DEV) console.log(`[asr] ${ms} ms -> "${text}"`);
      })
      .catch((err) => console.error("[asr] transcription failed:", err));
  });
  ipcMain.on(CAPTURE_ERROR, (_ev, message: string) => {
    console.error("[capture] failed:", message);
    tray?.setToolTip("AGR Flow - microphone unavailable");
  });
}

async function startPtt() {
  try {
    await hotkey.start();
    if (DEV) console.log(`[ptt] armed on ${DEFAULT_PTT_KEY}`);
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
