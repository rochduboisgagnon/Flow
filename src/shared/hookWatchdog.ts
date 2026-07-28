// The restart policy for the global keyboard hook (plan V2, B4), kept PURE (no
// keyspy, no Electron, no timers of its own) for the same reason and with the
// same discipline as overlayVisibility.ts and captureSession.ts: HotkeyAdapter
// owns a real child process (keyspy spawns WinKeyServer.exe) and cannot decide
// anything a test can observe without that binary. So the DECISION - restart or
// give up, and how long to wait - lives here, where a test can drive it.
//
// WHY THIS EXISTS AT ALL. keyspy's Windows backend
// (node_modules/keyspy/dist/platforms/windows/index.js) installs its process
// "close" handler CONDITIONALLY:
//
//     if (this.config.onError) this.proc.on("close", this.config.onError);
//
// Flow used to build `new GlobalKeyboardListener()` with no config whatsoever,
// so there was no handler at all: if WinKeyServer.exe died, nothing in the app
// heard it. And unlike the Linux and macOS backends, the Windows one carries no
// restart logic of its own - the process simply stayed dead. Push-to-talk was
// over for the rest of the session, the status line still said "ready", and the
// user had no way to tell dictation apart from a shortcut they mistyped.
//
// CLOCK: `now` is wall-clock (Date.now) supplied by the caller, deliberately -
// unlike hotpath.ts, which measures single-digit-millisecond budgets and needs a
// monotonic clock. Here the two uses are a FIVE MINUTE window and a timestamp
// shown to a human ("last incident: 14:32"), and a human-readable instant is
// exactly what a monotonic per-process origin cannot give. This mirrors
// asr/sidecar.ts's respawn window, which is also Date.now-based.

/** What the hook is doing, as the tray tooltip, the Home card and Diagnostics
 * all read it. "abandoned" is TERMINAL: nothing retries after it (that is the
 * whole point of a crash-loop guard), so the shortcut is off until Flow is
 * restarted - and every surface says so rather than pretending to be armed. */
export type HookState = "starting" | "armed" | "restarting" | "abandoned" | "stopped";

export interface HookWatchdogPolicy {
  /** How many automatic restarts are allowed inside `windowMs`. */
  maxRestarts: number;
  windowMs: number;
  /** First backoff delay; doubles per restart inside the window, capped. */
  baseDelayMs: number;
  maxDelayMs: number;
}

// Same shape and the same numbers as the whisper sidecar's crash-loop guard
// (RESPAWN_MAX / RESPAWN_WINDOW_MS / RESPAWN_DELAY_MS in main/asr/sidecar.ts):
// three restarts inside five minutes, one second before the first one. The only
// deliberate difference is that the delay BACKS OFF (1 s, 2 s, 4 s) instead of
// staying flat, and the reason is specific to this process: whisper-server dies
// of things local to itself (a bad model, an OOM), whereas WinKeyServer.exe
// usually dies of something system-wide - a fast user switch, the secure
// desktop, security software objecting to a low-level keyboard hook. Retrying a
// system-wide condition at a fixed 1 Hz is how a watchdog turns a two-second
// hiccup into a hundred spawned processes, so each attempt waits longer than
// the last. Four seconds is the cap: past that the guard gives up anyway.
export const HOOK_WATCHDOG_POLICY: HookWatchdogPolicy = {
  maxRestarts: 3,
  windowMs: 5 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
};

export type HookDecision =
  | { action: "restart"; delayMs: number; attempt: number }
  /** The crash-loop guard tripped: no further restart is scheduled, ever. */
  | { action: "give-up"; deathsInWindow: number }
  /** Nothing to do: the hook was stopped on purpose, or has already been
   * abandoned. Notably, keyspy's own kill() closes the child process and
   * therefore fires the SAME "close" callback a crash does - without this
   * branch, quitting Flow would look exactly like a crash. */
  | { action: "ignore" };

/** The incident record, as it travels to the window in UiStatePayload. Counts
 * and one short reason string; nothing here can carry dictated content. */
export interface HookHealth {
  state: HookState;
  /** How many times the key server has died in this run (all causes). */
  deaths: number;
  /** How many of those deaths were followed by a successful re-arm. */
  restarts: number;
  /** Wall-clock ms of the most recent death, or null if there has never been one. */
  lastIncidentAt: number | null;
  /** Short, human-readable cause ("exit code 1", "spawn failed: ..."). */
  lastIncidentDetail: string | null;
}

/** Timer seam, so the backoff above is testable without waiting for it - the
 * same seam, for the same reason, as captureSession.ts's CaptureTimers. Lives
 * here rather than in main/ because main/hotkey.ts is the only consumer and the
 * policy it belongs to is here. */
export interface HookTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export class HookWatchdog {
  private policy: HookWatchdogPolicy;
  private stateValue: HookState = "starting";
  private deathsTotal = 0;
  private restartsTotal = 0;
  private lastIncidentAt: number | null = null;
  private lastIncidentDetail: string | null = null;
  private recentDeaths: number[] = []; // timestamps inside the window

  constructor(policy: HookWatchdogPolicy = HOOK_WATCHDOG_POLICY) {
    this.policy = policy;
  }

  get state(): HookState {
    return this.stateValue;
  }

  /** The listener is live and receiving events. Called after the FIRST start
   * and after every successful restart; only the latter counts as a recovery,
   * which is why the previous state decides rather than a separate flag. */
  armed(): void {
    if (this.stateValue === "stopped") return; // a late success after a deliberate stop
    if (this.stateValue === "restarting") this.restartsTotal++;
    this.stateValue = "armed";
  }

  /** The key server died (or a start attempt failed - the same event seen one
   * moment earlier, and handled by the same path on purpose: a binary that
   * cannot spawn and a binary that spawns then dies are the same outage). */
  died(now: number, detail: string): HookDecision {
    // A deliberate stop closes the process itself, and an abandoned hook has no
    // process left to lose: neither is an incident, and counting them would
    // inflate the very numbers the user reads to judge their machine.
    if (this.stateValue === "stopped" || this.stateValue === "abandoned") return { action: "ignore" };

    this.deathsTotal++;
    this.lastIncidentAt = now;
    this.lastIncidentDetail = detail;
    this.recentDeaths = this.recentDeaths.filter((t) => now - t < this.policy.windowMs);

    if (this.recentDeaths.length >= this.policy.maxRestarts) {
      this.stateValue = "abandoned";
      return { action: "give-up", deathsInWindow: this.recentDeaths.length + 1 };
    }
    const attempt = this.recentDeaths.length + 1;
    this.recentDeaths.push(now);
    this.stateValue = "restarting";
    return { action: "restart", delayMs: this.backoffMs(attempt), attempt };
  }

  /** Flow is quitting (or the adapter is being torn down): every later close
   * event belongs to that decision, not to a failure. */
  stopped(): void {
    this.stateValue = "stopped";
  }

  health(): HookHealth {
    return {
      state: this.stateValue,
      deaths: this.deathsTotal,
      restarts: this.restartsTotal,
      lastIncidentAt: this.lastIncidentAt,
      lastIncidentDetail: this.lastIncidentDetail,
    };
  }

  private backoffMs(attempt: number): number {
    // attempt 1 -> base, 2 -> 2x, 3 -> 4x, capped.
    return Math.min(this.policy.baseDelayMs * 2 ** (attempt - 1), this.policy.maxDelayMs);
  }
}

/** The one place that turns hook health into the single boolean the window's
 * cards key off (UiStatePayload.hookOk). Written as a function, not inlined at
 * the call site, so "is the shortcut actually working right now" has exactly
 * one definition: only "armed" is honest - "restarting" is a live outage the
 * user is entitled to see, however brief. */
export function hookIsArmed(health: HookHealth): boolean {
  return health.state === "armed";
}

/** The status line for a hook OUTAGE, or null when the hook has nothing to add
 * to what the engine is already saying. Pure, so index.ts's engineStatus() and
 * its test agree by construction.
 *
 * "starting" deliberately answers null: it lasts the ~200 ms keyspy needs to
 * spawn its key server, and it would otherwise mask the engine's own boot line
 * (including "downloading the speech model (43%)", which is the ONE thing a
 * first-run user needs to see). The two states below are real outages and DO
 * outrank the engine line - a warm speech engine is worth nothing when no
 * keypress can reach it. */
export function hookStatusLine(health: HookHealth): string | null {
  switch (health.state) {
    case "abandoned":
      return "keyboard shortcut unavailable - restart Flow";
    case "restarting":
      return "keyboard shortcut restarting...";
    default:
      return null;
  }
}
