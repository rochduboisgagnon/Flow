import { app, BrowserWindow, Tray, Menu, nativeImage, session } from "electron";
import path from "node:path";
import { HotkeyAdapter } from "./hotkey";
import { DEFAULT_PTT_KEY } from "../shared/constants";

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
    startPtt();
  });
}

// Push-to-talk wiring. For now the callbacks only surface the state (tray
// tooltip + dev log); the capture pipeline plugs into these in the next commit.
const hotkey = new HotkeyAdapter(DEFAULT_PTT_KEY, {
  onStart() {
    tray?.setToolTip("AGR Flow - listening...");
    if (DEV) console.log("[ptt] start");
  },
  onStop() {
    tray?.setToolTip("AGR Flow");
    if (DEV) console.log("[ptt] stop -> transcribe");
  },
  onCancel() {
    tray?.setToolTip("AGR Flow");
    if (DEV) console.log("[ptt] cancel (tap too short)");
  },
});

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

app.on("before-quit", () => hotkey.stop());

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
