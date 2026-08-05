import type { UpdateCheckResult } from "../shared/ipcContracts";
import type { ChannelEvent, UpdateChannel } from "./update/channel";

// Auto-update (plan V1, A4). Flow is an autonomous app now: nothing else on the
// machine updates it, so it updates itself from its own GitHub Releases.
// No account, no telemetry, no server of ours in between.
//
// THE INVARIANT OF THIS FILE: an update NEVER installs while a dictation or a
// long recording is in flight. Swapping the binary mid-sentence would kill the
// keyboard hook and the warm ASR under the user's voice, and a meeting
// recording cannot be replayed. This is the same condition the local API's
// GET /update-readiness has always reported (index.ts: listening || isBusy),
// injected here rather than re-derived, so there is one definition of "busy".
//
// The rest is deliberately boring: download in the background, install at the
// first real lull, and - whatever happens - let the channel's own quit hook
// catch the update on the next manual quit. Nothing here ever blocks the engine.
//
// 2026-08-04 : CE FICHIER NE CONTIENT PLUS AUCUN MECANISME, et il ne connait ni
// electron ni electron-updater. Le portage macOS avait besoin d'un second
// mecanisme (Squirrel.Mac exige un Developer ID que Roch a decide de ne pas
// acheter) derriere exactement la meme politique, et dupliquer le sas calme
// aurait produit deux definitions du calme qui divergent. Le mecanisme est donc
// injecte (src/main/update/channel.ts).
//
// Le vrai gain n'est pas l'elegance : c'est que l'invariant ci-dessus a
// desormais des tests (test/updater.test.ts). Il n'en avait aucun, parce que ce
// fichier importait `electron` au niveau module et ne pouvait pas etre importe
// hors d'un processus Electron.

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

/** Timer seam, so four hours and two minutes are testable without waiting for
 * them. Same shape and same reason as CaptureTimers and HookTimers. */
export interface UpdaterTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  every(fn: () => void, ms: number): unknown;
  clearEvery(handle: unknown): void;
}

const REAL_TIMERS: UpdaterTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  every: (fn, ms) => setInterval(fn, ms),
  clearEvery: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

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
  /** app.isPackaged, injected: `npm run dev` runs from source and there is no
   * installed app to swap. Injected rather than imported so this file stays
   * testable. */
  isPackaged(): boolean;
  /** app.getVersion(), for the one sentence the button says when up to date. */
  currentVersion(): string;
  /** The mechanism. `null` means nothing is published for this platform, which
   * is a different fact from "this is a development build" and gets its own
   * message. See src/shared/updateChannelChoice.ts. */
  channel: UpdateChannel | null;
  timers?: UpdaterTimers;
}

export class FlowUpdater {
  private deps: FlowUpdaterDeps;
  private timers: UpdaterTimers;
  private channel: UpdateChannel | null;
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
  private bootTimer: unknown = null;
  private periodicTimer: unknown = null;
  private quietTimer: unknown = null;
  private confirmTimer: unknown = null;
  /** A lull is being confirmed right now; the poll must not stack a second one. */
  private confirming = false;

  constructor(deps: FlowUpdaterDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.channel = deps.channel;

    // Two different facts, two different messages. Conflating them is how a
    // packaged macOS build would have reported itself as a development build.
    if (!deps.isPackaged()) {
      this.enabled = false;
      this.deps.log("[updater] disabled: this is a development build, nothing to update in place");
      return;
    }
    if (!this.channel) {
      this.enabled = false;
      this.deps.log("[updater] disabled: no update channel is published for this platform");
      return;
    }

    this.enabled = true;
    this.deps.log(`[updater] channel: ${this.channel.kind}`);
    this.channel.onEvent((e) => this.onChannelEvent(e));
  }

  /** A copy, so no caller can mutate the updater's view of itself. */
  state(): UpdaterState {
    return { ...this.st };
  }

  /** Arm the boot check and the steady cadence. Safe to call once. */
  start(): void {
    if (!this.enabled) return;
    this.bootTimer = this.timers.set(() => {
      this.bootTimer = null;
      void this.silentCheck();
      this.periodicTimer = this.timers.every(() => void this.silentCheck(), CHECK_EVERY_MS);
    }, BOOT_DELAY_MS);
  }

  /** The Updates tab's "Check now" button (UI_CHECK_UPDATES -> uiBridge). */
  async checkNow(): Promise<UpdateCheckResult> {
    if (!this.enabled || !this.channel) {
      return {
        ok: false,
        message: this.deps.isPackaged()
          ? "Flow does not publish an update package for this platform yet, so there is nothing to check."
          : "Updates apply to the installed app; this is a development build.",
      };
    }
    // Answer from state when something is already in flight: the channel would
    // hand back the same in-flight work, but "downloading 63%" tells the person
    // who just clicked far more than a re-run of the check would.
    if (this.st.phase === "downloading") {
      return { ok: true, message: `Downloading version ${this.st.version} (${this.st.pct}%)...` };
    }
    if (this.st.phase === "downloaded-waiting-quiet") {
      return {
        ok: true,
        message: `Version ${this.st.version} is downloaded. It installs itself as soon as you are neither dictating nor recording.`,
      };
    }
    this.userAsked = true;
    const outcome = await this.channel.check();
    if (!outcome.ok) {
      // The "error" event has already recorded the phase; this is only about
      // what the button says.
      return { ok: false, message: `Could not check for updates: ${outcome.message}` };
    }
    if (outcome.available) {
      return { ok: true, message: `Version ${outcome.version} is available - downloading it now.` };
    }
    return { ok: true, message: `Flow ${this.deps.currentVersion()} is up to date.` };
  }

  /** Drop every timer. Does NOT cancel whatever the channel has armed for the
   * next quit: on Windows that is electron-updater's autoInstallOnAppQuit, on
   * macOS it is a detached swap script already waiting on this PID. Stopping our
   * own polling must never cancel the swap that happens on a manual quit - that
   * path is what catches every update we chose not to force. */
  stop(): void {
    this.timers.clear(this.bootTimer);
    this.bootTimer = null;
    this.timers.clearEvery(this.periodicTimer);
    this.periodicTimer = null;
    this.timers.clearEvery(this.quietTimer);
    this.quietTimer = null;
    this.timers.clear(this.confirmTimer);
    this.confirmTimer = null;
    this.confirming = false;
  }

  private onChannelEvent(e: ChannelEvent): void {
    switch (e.kind) {
      case "checking":
        this.st = { phase: "checking", version: "", pct: 0, message: "" };
        return;
      case "not-available":
        this.st = { phase: "up-to-date", version: e.version, pct: 0, message: "" };
        return;
      case "available":
        this.st = { phase: "downloading", version: e.version, pct: 0, message: "" };
        return;
      case "progress":
        // Guarded: a straggling progress event after "downloaded" would
        // otherwise demote the one phase the UI must not lose.
        if (this.st.phase !== "downloading") return;
        this.st = { ...this.st, pct: Math.max(0, Math.min(100, Math.round(e.pct))) };
        return;
      case "downloaded":
        this.st = { phase: "downloaded-waiting-quiet", version: e.version, pct: 100, message: "" };
        this.deps.log(`[updater] version ${e.version} downloaded; waiting for a quiet moment to install`);
        this.waitForQuiet();
        return;
      case "error":
        // No cloud, no account: an update failure is a nuisance, never a stop.
        // It is recorded, shown on request, and retried at the next cadence tick.
        this.st = { phase: "error", version: this.st.version, pct: 0, message: e.message };
        return;
    }
  }

  private async silentCheck(): Promise<void> {
    // An update already downloaded (or downloading) makes another check
    // pointless: what is missing is a lull, not a newer manifest.
    if (this.st.phase === "downloading" || this.st.phase === "downloaded-waiting-quiet") return;
    // The verdict is deliberately dropped: on failure the channel has already
    // emitted "error", which recorded the phase and logged it. A background
    // check has nobody to answer to.
    await this.channel?.check();
  }

  private waitForQuiet(): void {
    if (this.quietTimer) return; // already waiting (a second download event)
    this.quietTimer = this.timers.every(() => this.tryInstall(), QUIET_POLL_MS);
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
      this.swap();
      return;
    }
    this.confirming = true;
    this.confirmTimer = this.timers.set(() => {
      this.confirmTimer = null;
      this.confirming = false;
      // Anything at all happened during the pause = not quiet, poll retries.
      if (this.deps.isBusy() || this.deps.quietForMs() < QUIET_CONFIRM_MS) return;
      this.deps.log(`[updater] quiet window confirmed; installing version ${this.st.version}`);
      this.swap();
    }, QUIET_CONFIRM_MS);
  }

  /** The one irreversible gesture. stop() FIRST: the process is about to be
   * replaced, and an interval that survived into the swap would poll a machine
   * that no longer has the binary it was polling for. */
  private swap(): void {
    this.stop();
    this.channel?.install();
  }
}
