import { GlobalKeyboardListener } from "keyspy";
import type { IConfig, IGlobalKeyEvent } from "keyspy";
import { createComboMatcher, normalizeCombo, type ComboMatcher } from "../shared/combo";
import { MIN_HOLD_MS, DOUBLE_TAP_MS } from "../shared/constants";
import { hotpath, HOTPATH_ABANDON_REASON, HOTPATH_EVENT, type HotpathAbandonReason } from "../shared/hotpath";
import {
  HookWatchdog,
  hookIsArmed,
  type HookHealth,
  type HookTimers,
  type HookWatchdogPolicy,
} from "../shared/hookWatchdog";

// HotkeyAdapter: the only place that touches keyspy. The rest of the app sees
// three callbacks (start / stop / cancel), so the listener library can be
// swapped (uiohook-napi is the documented fallback) without touching the loop.
//
// All matching lives in the pure combo matcher (src/shared/combo.ts): keyspy
// only reports raw keydown/keyup and applies our swallow verdicts. The verdict
// (return value) is what blocks a Win keypress from reaching the OS - the
// Start-menu trap of the default Ctrl+Win shortcut (plan 5.8).
//
// B4 - THE SILENT DEATH. keyspy's Windows backend spawns WinKeyServer.exe and
// installs its "close" handler CONDITIONALLY:
//
//     if (this.config.onError) this.proc.on("close", this.config.onError);
//
// This class used to build `new GlobalKeyboardListener()` with no config at
// all, so no handler existed. When that process died, nothing heard it: no
// alert, no restart, no log line. Push-to-talk was over for the rest of the
// session while every surface still said "ready" - a whole class of "it just
// did not work" with no visible cause. And unlike keyspy's Linux and macOS
// backends, the Windows one has no restart logic of its own.
//
// The fix is in three parts, each answering one of those gaps:
//   1. an `onError` (and an `onInfo`) is always passed, so the handler exists;
//   2. the death is turned into a bounded restart (the crash-loop policy lives
//      in shared/hookWatchdog.ts, pure and tested);
//   3. the incident is COUNTED and surfaced - tray tooltip, Home card,
//      Diagnostics, flow.log, and the hot-path event ring.

export interface PttCallbacks {
  onStart(): void;
  onStop(): void;
  /** B1: why the press in flight is being abandoned - either the matcher's
   * own verdict (short tap / extra key) or one of the "off-band" cancels
   * below (recorder / setCombo / suspend / B4's hook death), which are not
   * driven by a keyboard event at all but still cut a live hold short. Always
   * provided: every call site below names one. */
  onCancel(reason: HotpathAbandonReason): void;
}

/** The slice of keyspy's GlobalKeyboardListener this adapter uses, declared as
 * an interface so a test can hand in a fake. Nothing else here is testable
 * otherwise: the real listener spawns WinKeyServer.exe, which means the restart
 * path - the entire point of B4 - could only ever be exercised against a live
 * binary on a live Windows session. Same seam, same reason, as
 * SidecarOptions.spawnProc in main/asr/sidecar.ts. */
export interface HookListener {
  addListener(listener: (event: IGlobalKeyEvent) => boolean): Promise<void>;
  kill(): void;
}

export type HookListenerFactory = (config: IConfig) => HookListener;

export interface HotkeyOptions {
  /** Engine log (flow.log in a packaged build). Hook incidents are exactly the
   * kind of failure that used to leave no trace anywhere. */
  log?(msg: string): void;
  /** Fired whenever hook health CHANGES. The tray tooltip refreshes on a 30 s
   * timer and the window on a 1 s push; a hook outage that heals in a second
   * would be invisible on both. This lets index.ts poke them immediately -
   * which matters most exactly when the window is closed and the tooltip is
   * the only surface left. */
  onHealthChange?(health: HookHealth): void;
  /** Tests only. */
  createListener?: HookListenerFactory;
  timers?: HookTimers;
  policy?: HookWatchdogPolicy;
}

interface RecorderState {
  down: Set<string>;
  keys: Set<string>;
  timer: NodeJS.Timeout;
  done: (combo: string[] | null) => void;
}

/** One generation of listener. The token exists for the invariant that matters
 * most here: a respawn must NEVER leave two live listeners, because two
 * listeners means two swallow verdicts for the same keypress, and a disagreement
 * between them is worse than the outage it was meant to fix. Every callback
 * checks its own instance against the current one before acting. */
interface HookInstance {
  listener: HookListener;
  /** addListener() resolved: this instance is the one taking events. */
  live: boolean;
  /** Its key server closed. Recorded on the instance so a death that races the
   * startup handshake is not lost (see arm()). */
  dead: boolean;
  /** The close code keyspy reported, kept only to name the incident. */
  code: number | null;
}

// The recorder auto-cancels after this long: while it runs, EVERY key is
// swallowed system-wide, so it must never be able to linger.
const RECORD_TIMEOUT_MS = 10_000;

// WinKeyServer.exe normally writes nothing to stderr, but a machine where it
// misbehaves could write a great deal - and flowLog appends SYNCHRONOUSLY, on
// the very thread that owes Windows a hook verdict inside ~1 s. So the
// diagnostic that was missing gets a hard budget rather than an open channel.
const MAX_INFO_LINES = 20;

const REAL_TIMERS: HookTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class HotkeyAdapter {
  private matcher: ComboMatcher;
  private suspended = false;
  private recorder: RecorderState | null = null;
  private cbs: PttCallbacks;
  private opts: HotkeyOptions;
  private createListener: HookListenerFactory;
  private timers: HookTimers;

  private watchdog: HookWatchdog;
  private current: HookInstance | null = null;
  private restartTimer: unknown = null;
  /** stop() was called: every later close event belongs to that decision. */
  private stopped = false;
  private infoLines = 0;

  // The "open AGR Pilot" shortcut used to live here too (v5 c2), which coupled it to AGR Flow:
  // disabling Flow killed the shortcut. It now belongs entirely to AGR Manager (its own always-on
  // LL hook), independent of Flow. This adapter only owns the dictation combo.
  constructor(combo: string[], cbs: PttCallbacks, opts: HotkeyOptions = {}) {
    this.matcher = createComboMatcher(combo, {
      minHoldMs: MIN_HOLD_MS,
      doubleTapMs: DOUBLE_TAP_MS,
    });
    this.cbs = cbs;
    this.opts = opts;
    this.createListener = opts.createListener ?? ((config) => new GlobalKeyboardListener(config));
    this.timers = opts.timers ?? REAL_TIMERS;
    this.watchdog = new HookWatchdog(opts.policy);
  }

  /** Arms the hook. Rejects if the FIRST attempt fails - the caller logs it -
   * but a retry is already scheduled by then: a start that fails and a hook
   * that dies are the same outage seen at two different moments, and they go
   * through the same policy rather than two hand-written ones. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.arm();
  }

  /** Current hook health, for the status line, the tray tooltip and Diagnostics. */
  health(): HookHealth {
    return this.watchdog.health();
  }

  /** The one boolean UiStatePayload.hookOk carries. */
  isArmed(): boolean {
    return hookIsArmed(this.watchdog.health());
  }

  /** Build ONE listener and hand it our handler. Every path into this method
   * disposes of whatever came before it first, so there is never a moment with
   * two live listeners - the invariant this whole class defends. */
  private async arm(): Promise<void> {
    this.disposeListener();
    if (this.stopped) return;
    // A rearm inherits nothing from the dead listener's key state: it never saw
    // the UP events that happened while the hook was down, and a stale "CTRL is
    // held" would fire a capture nobody asked for. A press lost during the
    // outage is acceptable; a PHANTOM press is not.
    this.matcher.reset();
    const inst: HookInstance = {
      listener: this.createListener({
        windows: {
          // THE fix. Without this callback keyspy installs no "close" handler
          // at all, and the death of WinKeyServer.exe is unobservable.
          onError: (code: number) => this.onServerClosed(inst, code),
          onInfo: (data: string) => this.onServerInfo(data),
        },
      }),
      live: false,
      dead: false,
      code: null,
    };
    this.current = inst;
    try {
      await inst.listener.addListener(this.handleKey);
    } catch (err) {
      // The key server could not be spawned at all (missing binary, blocked by
      // security software). Same event, one moment earlier: same policy.
      if (this.current === inst) this.handleDeath(inst, `start failed: ${String(err)}`);
      throw err;
    }
    // Superseded while we were awaiting (a stop, or a newer arm): the instance
    // we just built is not the one the app should be talking to.
    if (this.current !== inst) {
      this.killListener(inst.listener);
      return;
    }
    inst.live = true;
    if (inst.dead) {
      // It died DURING the handshake. keyspy resolves start() on the "spawn"
      // event, so a process that spawns and immediately exits resolves happily;
      // without this branch the adapter would report a perfectly armed hook
      // with no process behind it - the exact lie B4 exists to remove.
      this.handleDeath(inst, this.exitDetail(inst.code));
      throw new Error(`the key server died while starting (${this.exitDetail(inst.code)})`);
    }
    const wasRestart = this.watchdog.state === "restarting";
    this.watchdog.armed();
    if (wasRestart) {
      hotpath.event(HOTPATH_EVENT.hookRestarted);
      const h = this.watchdog.health();
      this.opts.log?.(
        `[hotkey] keyboard hook restored (${h.restarts} recovery/recoveries, ${h.deaths} death(s) this session)`,
      );
    }
    this.announce();
  }

  /** keyspy's windows.onError: the key server's child process closed. It fires
   * for a CRASH and for our own kill() alike (WinKeyServer.stop() kills the
   * process, which closes it), which is why every guard below exists. */
  private onServerClosed(inst: HookInstance, code: number | null): void {
    if (inst.dead) return; // one death per instance, whatever keyspy emits
    inst.dead = true;
    inst.code = code;
    if (this.stopped) return; // we asked for this
    if (this.current !== inst) return; // an instance we already replaced
    if (!inst.live) return; // still handshaking: arm() owns this failure
    this.handleDeath(inst, this.exitDetail(code));
  }

  /** keyspy's windows.onInfo: WinKeyServer.exe's stderr, previously discarded
   * entirely. Bounded on purpose (see MAX_INFO_LINES). */
  private onServerInfo(data: string): void {
    const line = data.trim();
    if (!line) return;
    if (this.infoLines >= MAX_INFO_LINES) return;
    this.infoLines++;
    this.opts.log?.(`[hotkey] key server: ${line.slice(0, 200)}`);
    if (this.infoLines === MAX_INFO_LINES) {
      this.opts.log?.("[hotkey] key server output is chatty; further lines are dropped for this run");
    }
  }

  /** The one place a death is turned into a decision. Deliberately does nothing
   * synchronous and costly: it runs on the same thread that owes Windows a hook
   * verdict, so it counts, logs one line, and hands the waiting to a timer. */
  private handleDeath(inst: HookInstance, detail: string): void {
    hotpath.event(HOTPATH_EVENT.hookDied);
    // A hold that was in flight can never be released now: its UP event died
    // with the hook. Close it honestly instead of leaving a hot microphone and
    // an overlay pinned open behind a key nobody can lift.
    if (this.matcher.capturing()) this.cbs.onCancel(HOTPATH_ABANDON_REASON.hookDied);
    this.matcher.reset();
    // The shortcut recorder swallows EVERY key while it runs and only finishes
    // when the last key comes back up. Those UPs are gone, so a recorder left
    // running across a respawn would swallow the whole keyboard until its 10 s
    // timeout. Cancel it: the user retries a gesture, they do not lose a system.
    this.recorder?.done(null);

    const decision = this.watchdog.died(Date.now(), detail);
    if (decision.action === "ignore") return;
    if (decision.action === "give-up") {
      hotpath.event(HOTPATH_EVENT.hookAbandoned);
      this.opts.log?.(
        `[hotkey] the key server died ${decision.deathsInWindow} times in a row (${detail}); ` +
          "giving up - the dictation shortcut is off until Flow is restarted",
      );
      this.announce();
      return;
    }
    this.opts.log?.(
      `[hotkey] the key server died (${detail}); restarting in ${decision.delayMs} ms ` +
        `(attempt ${decision.attempt})`,
    );
    this.announce();
    this.timers.clear(this.restartTimer);
    this.restartTimer = this.timers.set(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      void this.arm().catch((err) => {
        // arm() already routed this through the policy; this catch only exists
        // so a rejected promise cannot escape a timer callback.
        this.opts.log?.(`[hotkey] restart attempt failed: ${String(err)}`);
      });
    }, decision.delayMs);
  }

  private exitDetail(code: number | null): string {
    return code === null || code === undefined ? "the key server exited" : `the key server exited (code ${code})`;
  }

  private announce(): void {
    this.opts.onHealthChange?.(this.watchdog.health());
  }

  /** Bound once and reused for every generation of listener: keyspy keeps the
   * function itself in an array, so a fresh closure per arm would be one more
   * way to end up with two handlers reacting to one key. */
  private handleKey = (e: IGlobalKeyEvent): boolean => {
    // B1: the earliest instant this JS handler can timestamp. The OS
    // delivered the event some unknowable amount of time before this line -
    // that gap is outside JS's reach - so this is our zero baseline for
    // "how long did OUR code hold the hook".
    const t0 = performance.now();
    // The low-level hook gives the OS ~1 s per event before it silently
    // removes us: this handler must stay trivial (pure state machine, no IO).
    if (!e.name) return false;
    // keyspy also reports mouse buttons: clicking while dictating must not
    // cancel the capture, and a click is never part of a shortcut.
    if (e.name.startsWith("MOUSE")) return false;
    // The recorder OUTRANKS the pause (audit): recording a new shortcut from
    // Settings must work - and keep swallowing every key - even while the
    // tray pause has the PTT suspended. The old order made the recorder go
    // deaf during a pause AND let the keys leak to the OS (Start menu).
    // B1: not instrumented (see hotpath.ts's module note) - both branches
    // below are rare/short-lived states, out of scope for the dictation
    // hot path this task measures.
    if (this.recorder) return this.handleRecording(e);
    if (this.suspended) return false;
    const { action, swallow } = this.matcher.handle(
      { key: e.name, state: e.state },
      Date.now(),
    );
    const verdictAt = performance.now();
    if (action === "start") {
      hotpath.mark("keyEventReceived", t0);
      hotpath.mark("verdictRendered", verdictAt);
    } else if (action === "stop" || action === "cancel") {
      // B1: the release/cancel-triggering event's own instant - the anchor
      // for the "release -> text" budget (§3.3). e.state distinguishes WHY
      // a cancel fired for free: the matcher only cancels on an UP (a tap
      // shorter than MIN_HOLD_MS) or on a DOWN of a key outside the combo
      // (an OS shortcut invoked mid-hold) - see shared/combo.ts.
      hotpath.mark("releaseObserved", t0);
    }
    if (action === "start") this.cbs.onStart();
    else if (action === "stop") this.cbs.onStop();
    else if (action === "cancel") {
      this.cbs.onCancel(e.state === "UP" ? HOTPATH_ABANDON_REASON.shortTap : HOTPATH_ABANDON_REASON.extraKey);
    }
    // menace §3.2.2: the FULL synchronous cost of this hook callback - the
    // matcher AND every onStart/onStop/onCancel side effect the two lines
    // above just ran (window show, IPC send) - because all of it happens
    // before `return swallow`, on the SAME thread, inside the SAME budget
    // Windows measures. This is the number that actually answers "is this
    // hook at risk of being silently removed", not verdictLatencyMs alone.
    hotpath.sampleHandlerLatency(performance.now() - t0);
    return swallow;
  };

  /** Shortcut recorder (plan 5.8): the hook itself captures the gesture, so
   * modifiers-only combos work and NOTHING leaks to the OS while recording
   * (pressing Win cannot open the Start menu mid-recording). The combo is
   * finalized when every key is released; Esc cancels; Backspace clears. */
  record(): Promise<string[] | null> {
    if (this.recorder) return Promise.resolve(null); // one recorder at a time
    if (this.matcher.capturing()) this.cbs.onCancel(HOTPATH_ABANDON_REASON.shortcutRecorder);
    this.matcher.reset();
    return new Promise((resolve) => {
      const finish = (combo: string[] | null) => {
        if (!this.recorder) return;
        clearTimeout(this.recorder.timer);
        this.recorder = null;
        resolve(combo);
      };
      this.recorder = {
        down: new Set(),
        keys: new Set(),
        timer: setTimeout(() => finish(null), RECORD_TIMEOUT_MS),
        done: finish,
      };
    });
  }

  private handleRecording(e: IGlobalKeyEvent): boolean {
    const r = this.recorder!;
    const key = e.name!;
    if (e.state === "DOWN") {
      if (key === "ESCAPE") {
        r.done(null);
        return true;
      }
      if (key === "BACKSPACE") {
        // Clear and let the user start the gesture over (held keys will
        // re-register through their auto-repeat DOWNs).
        r.keys.clear();
        r.down.clear();
        return true;
      }
      r.down.add(key);
      r.keys.add(key);
    } else {
      r.down.delete(key);
      if (r.down.size === 0 && r.keys.size > 0) {
        r.done(normalizeCombo([...r.keys]));
      }
    }
    return true; // swallow everything while recording
  }

  /** Applies a new shortcut immediately (from the settings recorder). */
  setCombo(combo: string[]) {
    const wasCapturing = this.matcher.capturing();
    this.matcher.setCombo(combo);
    // Never leave a hot microphone behind a state reset.
    if (wasCapturing) this.cbs.onCancel(HOTPATH_ABANDON_REASON.comboChanged);
  }

  /** User-facing pause (the tray's "Pause dictation"): PTT keys pass through
   * untouched. The shortcut RECORDER keeps working while suspended.
   *
   * B4: this is a FILTER, not a teardown - the listener stays armed and the
   * watchdog stays exactly where it was. A pause must never read as an outage
   * (nor an outage as a pause): they are two independent facts and the tray
   * shows both, which only works because neither touches the other's state. */
  suspend(v: boolean) {
    if (v && this.matcher.capturing()) this.cbs.onCancel(HOTPATH_ABANDON_REASON.paused);
    this.suspended = v;
    this.matcher.reset();
  }

  stop() {
    // Order matters: mark the intent BEFORE killing, because kill() closes the
    // child process and therefore fires the very same callback a crash does.
    this.stopped = true;
    this.watchdog.stopped();
    this.timers.clear(this.restartTimer);
    this.restartTimer = null;
    this.disposeListener();
  }

  private disposeListener(): void {
    const inst = this.current;
    this.current = null;
    if (inst) this.killListener(inst.listener);
  }

  private killListener(listener: HookListener): void {
    try {
      listener.kill();
    } catch (err) {
      // Killing an already-dead key server is the NORMAL path here (that is
      // what a respawn is), and keyspy's stop() reaches into a child process it
      // assumes is alive. A throw must never stop the replacement from arming.
      this.opts.log?.(`[hotkey] tearing down the previous key listener: ${String(err)}`);
    }
  }
}
