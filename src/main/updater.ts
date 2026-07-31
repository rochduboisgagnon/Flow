import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateCheckResult } from "../shared/ipcContracts";

// Auto-update (plan V1, A4). Flow is an autonomous app now: nothing else on the
// machine updates it, so it updates itself from its own GitHub Releases
// (electron-builder publishes the NSIS installer + latest.yml; electron-updater
// reads that manifest). No account, no telemetry, no server of ours in between.
//
// THE INVARIANT OF THIS FILE: an update NEVER installs while a dictation or a
// long recording is in flight. Swapping the binary mid-sentence would kill the
// keyboard hook and the warm ASR under the user's voice, and a meeting
// recording cannot be replayed. This is the same condition the local API's
// GET /update-readiness has always reported (index.ts: listening || isBusy),
// injected here rather than re-derived, so there is one definition of "busy".
//
// The rest is deliberately boring: download in the background, install at the
// first real lull, and - whatever happens - let autoInstallOnAppQuit catch the
// update on the next manual quit. Nothing here ever blocks the engine.

/** How long the engine gets to itself before the first network round trip. */
const BOOT_DELAY_MS = 2 * 60 * 1000;
/** Steady-state check cadence. Flow ships rarely; four hours is plenty. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** With an update downloaded, how often we look for a lull. Roch (1.1.0
 * validation): at 5 minutes the app sat visibly "update ready" long after the
 * machine went idle - the restart must FEEL automatic. 30 s polling means the
 * swap starts at most ~90 s after real quiet begins (poll + confirmation
 * pause), and the poll itself is a two-comparison callback: free. */
const QUIET_POLL_MS = 30 * 1000;
/** How long the lull must hold before we dare swap the binary. */
const QUIET_CONFIRM_MS = 30 * 1000;

export type UpdaterPhase =
  | "idle" // nothing checked yet
  | "checking"
  | "up-to-date"
  | "downloading"
  | "downloaded-waiting-quiet" // ready, held back by the quiet window
  | "error";

export interface UpdaterState {
  phase: UpdaterPhase;
  /** The version the phase is about; "" when none is in play. */
  version: string;
  /** 0-100, only meaningful while downloading. */
  pct: number;
  /** Human-readable detail; the error text when phase is "error". */
  message: string;
}

export interface FlowUpdaterDeps {
  /** True while a dictation, a long recording OR a model transfer is in
   * flight. One of the two things standing between a downloaded update and a
   * binary swap. */
  isBusy(): boolean;
  /** Milliseconds since the engine last DID anything (hotkey press/release,
   * transcription, insertion, long-form chunk). Review A10: `listening` drops
   * to false between two utterances, so two instant samples 30 s apart could
   * both land in gaps of an ACTIVE dictation session. Real quiet is "no
   * activity at all for the whole confirmation window", which only an
   * activity timestamp can prove. */
  quietForMs(): number;
  /** The engine's rotating log (flowLog), so a failed update is not invisible
   * in a built app - there is no dev console out there. */
  log(msg: string): void;
}

export class FlowUpdater {
  private deps: FlowUpdaterDeps;
  private enabled: boolean;
  private st: UpdaterState = { phase: "idle", version: "", pct: 0, message: "" };
  /** 2026-07-30: set by checkNow(), i.e. by a HUMAN clicking the button.
   *
   * The quiet window exists so a background update never interrupts someone who
   * did not ask for one. A click is the opposite situation: the user is sitting
   * in front of the app, asking. Making them then wait through up to a minute of
   * "continuous inactivity" - with nothing on screen explaining the pause - is
   * what produced the report that updating "takes two clicks and does not work".
   * So an update the user ASKED for installs as soon as the engine is free,
   * without the confirmation pause. It still never interrupts a live dictation
   * or recording: isBusy() is checked either way, and that is the guarantee
   * that actually matters. */
  private userAsked = false;
  private bootTimer: NodeJS.Timeout | undefined;
  private periodicTimer: NodeJS.Timeout | undefined;
  private quietTimer: NodeJS.Timeout | undefined;
  private confirmTimer: NodeJS.Timeout | undefined;
  /** A lull is being confirmed right now; the poll must not stack a second one. */
  private confirming = false;

  constructor(deps: FlowUpdaterDeps) {
    this.deps = deps;
    // `npm run dev` runs from source: there is no installer to swap, and
    // electron-updater would only throw about a missing dev-app-update.yml.
    // One honest line, then this object is inert for the whole session.
    this.enabled = app.isPackaged;
    if (!this.enabled) {
      this.deps.log("[updater] disabled: this is a development build, nothing to update in place");
      return;
    }

    // Explicit rather than relying on the library defaults: these two are the
    // whole update strategy, and a future major flipping a default silently is
    // exactly the kind of surprise this app cannot afford.
    autoUpdater.autoDownload = true; // fetch in the background; installing is the guarded part
    autoUpdater.autoInstallOnAppQuit = true; // the natural swap: user quits, next launch is new

    autoUpdater.logger = {
      info: (m?: unknown) => this.deps.log(`[updater] ${String(m)}`),
      warn: (m?: unknown) => this.deps.log(`[updater] warn: ${String(m)}`),
      error: (m?: unknown) => this.deps.log(`[updater] error: ${String(m)}`),
    };

    this.wireEvents();
  }

  /** A copy, so no caller can mutate the updater's view of itself. */
  state(): UpdaterState {
    return { ...this.st };
  }

  /** Arm the boot check and the steady cadence. Safe to call once. */
  start(): void {
    if (!this.enabled) return;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = undefined;
      void this.silentCheck();
      this.periodicTimer = setInterval(() => void this.silentCheck(), CHECK_EVERY_MS);
    }, BOOT_DELAY_MS);
  }

  /** The Updates tab's "Check now" button (UI_CHECK_UPDATES -> uiBridge). */
  async checkNow(): Promise<UpdateCheckResult> {
    if (!this.enabled) {
      return { ok: false, message: "Updates apply to the installed app; this is a development build." };
    }
    // Answer from state when something is already in flight: electron-updater
    // would hand back the same in-flight promise, but "downloading 63%" tells
    // the person who just clicked far more than a re-run of the check would.
    if (this.st.phase === "downloading") {
      return { ok: true, message: `Downloading version ${this.st.version} (${this.st.pct}%)...` };
    }
    if (this.st.phase === "downloaded-waiting-quiet") {
      return {
        ok: true,
        message: `Version ${this.st.version} is downloaded. It installs itself as soon as you are neither dictating nor recording.`,
      };
    }
    try {
      this.userAsked = true;
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable) {
        // autoDownload is on, so the download has already started; from here
        // the event handlers own the state.
        return { ok: true, message: `Version ${result.updateInfo.version} is available - downloading it now.` };
      }
      return { ok: true, message: `Flow ${app.getVersion()} is up to date.` };
    } catch (err) {
      // The "error" event handler has already recorded the phase; this is only
      // about what the button says.
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Could not check for updates: ${msg}` };
    }
  }

  /** Drop every timer. Does NOT touch autoInstallOnAppQuit: stopping our own
   * polling must never cancel the swap electron-updater performs on a manual
   * quit - that path is what catches every update we chose not to force. */
  stop(): void {
    clearTimeout(this.bootTimer);
    this.bootTimer = undefined;
    clearInterval(this.periodicTimer);
    this.periodicTimer = undefined;
    clearInterval(this.quietTimer);
    this.quietTimer = undefined;
    clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
    this.confirming = false;
  }

  private wireEvents(): void {
    autoUpdater.on("checking-for-update", () => {
      this.st = { phase: "checking", version: "", pct: 0, message: "" };
    });
    autoUpdater.on("update-not-available", (info) => {
      this.st = { phase: "up-to-date", version: info.version, pct: 0, message: "" };
    });
    autoUpdater.on("update-available", (info) => {
      this.st = { phase: "downloading", version: info.version, pct: 0, message: "" };
    });
    autoUpdater.on("download-progress", (progress) => {
      // Guarded: a straggling progress event after "update-downloaded" would
      // otherwise demote the one phase the UI must not lose.
      if (this.st.phase !== "downloading") return;
      this.st = { ...this.st, pct: Math.max(0, Math.min(100, Math.round(progress.percent))) };
    });
    autoUpdater.on("update-downloaded", (event) => {
      this.st = { phase: "downloaded-waiting-quiet", version: event.version, pct: 100, message: "" };
      this.deps.log(`[updater] version ${event.version} downloaded; waiting for a quiet moment to install`);
      this.waitForQuiet();
    });
    autoUpdater.on("error", (err) => {
      // No cloud, no account: an update failure is a nuisance, never a stop.
      // It is recorded, shown on request, and retried at the next cadence tick.
      this.st = { phase: "error", version: this.st.version, pct: 0, message: err.message };
    });
  }

  private async silentCheck(): Promise<void> {
    // An update already downloaded (or downloading) makes another check
    // pointless: what is missing is a lull, not a newer manifest.
    if (this.st.phase === "downloading" || this.st.phase === "downloaded-waiting-quiet") return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* the "error" event already recorded and logged it */
    }
  }

  private waitForQuiet(): void {
    if (this.quietTimer) return; // already waiting (a second download event)
    this.quietTimer = setInterval(() => this.tryInstall(), QUIET_POLL_MS);
    this.tryInstall(); // most of the time the machine is idle right now
  }

  private tryInstall(): void {
    if (this.confirming) return;
    if (this.deps.isBusy()) return;
    // Idle THIS INSTANT is not enough: a dictation lasts a few seconds, so a
    // single sample lands in the gap between two utterances often enough to
    // matter. The quiet window is judged on CONTINUOUS inactivity: the engine
    // must not have done anything for QUIET_CONFIRM_MS already, and still be
    // untouched after one more confirmation pause (review A10).
    if (!this.userAsked && this.deps.quietForMs() < QUIET_CONFIRM_MS) return;
    if (this.userAsked) {
      // Asked for, and the engine is free: go. No confirmation pause, because
      // the person who would be interrupted by it is the person who asked.
      this.deps.log(`[updater] installing version ${this.st.version} - requested by the user`);
      this.stop();
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    this.confirming = true;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      this.confirming = false;
      // Anything at all happened during the pause = not quiet, poll retries.
      if (this.deps.isBusy() || this.deps.quietForMs() < QUIET_CONFIRM_MS) return;
      this.deps.log(`[updater] quiet window confirmed; installing version ${this.st.version}`);
      this.stop(); // no more polling: the process is about to be replaced
      // Silent install, then relaunch. Relaunching matters: Flow is a hotkey
      // daemon, and an update that leaves the machine with no push-to-talk
      // until the next login is a worse outcome than a window reappearing.
      autoUpdater.quitAndInstall(true, true);
    }, QUIET_CONFIRM_MS);
  }
}
