// Event-loop lag sampler (plan V2, B11 - the trigger T1 of §3.6.6).
//
// WHY THIS EXISTS. B1 measures the keyboard hook handler's OWN synchronous
// execution time, and only that. But the budget Windows enforces on a
// WH_KEYBOARD_LL hook covers four segments (plan §3.6.2): the key server's
// pipe out, THE WAIT IN NODE'S EVENT-LOOP QUEUE before our handler is even
// called, our handler, and the verdict's pipe back. B1 sees segment 3. If the
// loop is blocked for 200 ms, the event arrives 200 ms late and our handler
// still measures 0.07 ms - a cheerful number about the one term that was never
// in question. This module measures segment 2, the only one that can plausibly
// fill (or empty) the go-criteria G1 and G2 of the B7 decision.
//
// WHAT "LAG" MEANS HERE, exactly. A repeating timer asks to be called every
// `period` ms. Lag is `observed - expected` for ONE tick: how much later than
// its own appointment the callback actually ran. It is deliberately NOT the raw
// delta between two ticks - that number is ~`period` even on a perfectly idle
// loop, and comparing it against a threshold would mean baking the cadence into
// the threshold.
//
// The `expected` instant is derived from when the PREVIOUS tick actually ran,
// plus the period - never from an absolute grid anchored at start. Node
// reschedules a repeating timer from the moment it fired, not from an ideal
// schedule, so an absolute grid would treat one 500 ms stall as permanent drift
// and report a growing lag forever after a single hiccup.
//
// PURE and dependency-free, like hotpath.ts and hookWatchdog.ts: it owns no
// storage and no statistics (those live next to handlerLatenciesMs in
// hotpath.ts), it takes its clock and its timer through `deps` so a test can
// drive it tick by tick, and it never touches Electron, fs or a real timer
// unless the caller hands it one.
//
// ZERO RETENTION (plan §5.4): a sample is a duration in milliseconds. There is
// nothing else in this file to leak.

/** The two things this module needs from the outside world. Injected rather
 * than imported so a test can drive an entire session in zero real time. */
export interface LagScheduler {
  /** Call `fn` about every `periodMs`. Returns the function that stops it. */
  every(periodMs: number, fn: () => void): () => void;
  /** Monotonic milliseconds, same contract as performance.now(). */
  now(): number;
}

// CADENCE, and the cost decision behind it (asked for explicitly by the task).
//
// A 20 ms period is 50 wakeups per second. On a machine where Flow sits idle in
// the tray for eight hours - the normal case, since dictation is bursty - that
// is 1.4 million timer callbacks bought to measure a loop that has nothing on
// it, and 50 Hz is precisely the cadence that keeps a laptop's CPU out of its
// deeper idle states. Paying battery to confirm a zero is a bad trade.
//
// So the sampler has TWO cadences and never stops:
//   - ACTIVE, 20 ms, while Flow is doing something that could block the loop
//     (a press in flight, a long recording, a model transfer, or anything
//     within a few seconds of the last such activity). This is the resolution
//     the T1 threshold needs, and it runs exactly when blocking is possible.
//   - IDLE, 500 ms, the rest of the time. 2 wakeups per second, which no power
//     profile notices, and still enough to catch a pathological stall that has
//     nothing to do with dictation (a GC pause, a settings save, a tray
//     rebuild): a tick that lands 200 ms late reports 200 ms whatever its
//     period is.
//
// Stopping entirely when idle was the other option, and it was rejected: "a
// dictation is possible" is true whenever the hook is armed, i.e. essentially
// always, so a sampler that only ran when a dictation was possible would be a
// sampler that always ran. Halving the question to "is anything happening"
// gives a 25x cost cut for the sample the trigger actually reads.
//
// The honest consequence, stated rather than discovered: the ring mixes samples
// taken at two cadences, so a percentile read from it is a percentile over
// OBSERVATIONS, not over wall-clock time. The bias is in the conservative
// direction for a trigger meant to catch blocking - the fast cadence only runs
// while Flow is working, so the ring is dominated by exactly the moments that
// can block.
export const LOOP_LAG_ACTIVE_PERIOD_MS = 20;
export const LOOP_LAG_IDLE_PERIOD_MS = 500;

export interface LoopLagSamplerDeps {
  scheduler: LagScheduler;
  /** One measured lag, in ms, already clamped at zero. */
  onSample: (lagMs: number) => void;
  /** "Is Flow doing something that could block the loop right now?" Evaluated
   * on every tick, so a cadence change costs at most one period of the slower
   * cadence - never a call from inside the keyboard hook's callback. */
  isActive: () => boolean;
  activePeriodMs?: number;
  idlePeriodMs?: number;
}

export class LoopLagSampler {
  private stopTimer: (() => void) | null = null;
  private period = 0;
  private expected = 0;
  private readonly activeMs: number;
  private readonly idleMs: number;

  constructor(private readonly deps: LoopLagSamplerDeps) {
    this.activeMs = deps.activePeriodMs ?? LOOP_LAG_ACTIVE_PERIOD_MS;
    this.idleMs = deps.idlePeriodMs ?? LOOP_LAG_IDLE_PERIOD_MS;
  }

  /** Idempotent: starting an already-running sampler re-arms it rather than
   * leaving two timers feeding the same ring. */
  start(): void {
    this.arm(this.deps.isActive() ? this.activeMs : this.idleMs);
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /** The cadence currently in force, in ms - for tests and for the panel's
   * caption; never a decision input anywhere else. */
  get periodMs(): number {
    return this.period;
  }

  get running(): boolean {
    return this.stopTimer !== null;
  }

  private arm(period: number): void {
    this.stop();
    this.period = period;
    // The baseline is taken NOW, so the first tick after a cadence change is
    // measured against a fresh appointment instead of inheriting the previous
    // cadence's expectation (which would report the difference between the two
    // periods as lag).
    this.expected = this.deps.scheduler.now() + period;
    this.stopTimer = this.deps.scheduler.every(period, () => this.tick());
  }

  private tick(): void {
    const now = this.deps.scheduler.now();
    // Clamped at zero: a timer that fires a hair EARLY (Node coalesces timers
    // and may round down by a millisecond) is not negative lag, it is no lag.
    // Letting a negative through would quietly pull every percentile down.
    const lag = now - this.expected;
    this.deps.onSample(lag > 0 ? lag : 0);
    this.expected = now + this.period;
    const wanted = this.deps.isActive() ? this.activeMs : this.idleMs;
    if (wanted !== this.period) this.arm(wanted);
  }
}

/** The real timer, for the main process. `unref` so the sampler can never be
 * the reason the process refuses to exit - a diagnostic must not hold a quit
 * open. Guarded because a browser/test scheduler has no unref. */
export function realScheduler(): LagScheduler {
  return {
    every(periodMs, fn) {
      const handle: ReturnType<typeof setInterval> = setInterval(fn, periodMs);
      handle.unref?.();
      return () => clearInterval(handle);
    },
    now: () => performance.now(),
  };
}
