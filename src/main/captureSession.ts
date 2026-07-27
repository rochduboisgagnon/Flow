// The lifecycle arbiter of ONE native capture session, kept PURE (no Electron)
// so it can be unit-tested - the same discipline, and for the same reason, as
// overlayVisibility.ts: NativeCapture owns a BrowserWindow and cannot be
// instantiated outside a real Electron process, so the policy has to live
// somewhere a test can reach it.
//
// Two U4 review findings live here. They are the same blind spot seen from two
// sides: the main process had no way to tell WHICH capture a callback belonged
// to, nor whether a capture had ever started at all.
//
//  - blocking: NativeCapture.start() is a fire-and-forget IPC send. If the
//    capture window had not loaded, or getDisplayMedia never resolved, not one
//    chunk ever arrived - and the engine went on reporting a perfectly healthy
//    recording. Forty minutes of nothing, with a timer counting up. native:ready
//    was received and thrown away, and nobody watched the window die.
//  - major: the stop() tail timer (and a late native:done) carried no token, so
//    one that fired AFTER a new recording had started silenced and finalized
//    THAT one instead. The capture renderer already defends its own side with a
//    generation counter; this is the missing half, on the main side.
//
// The invariant both serve: Flow never shows an indicator that lies, and never
// lets one recording end another.

/** How long a capture may stay silent before it is declared dead.
 *
 * The capture window is created at boot and has normally been sitting loaded
 * for minutes by the time anyone presses Start, so the real path to the first
 * chunk is getDisplayMedia + getUserMedia + one AudioWorklet - well under a
 * second. Eight seconds is far past any honest cold start (a first-ever
 * loopback grant, a page still loading from the Vite dev server, an audio
 * stack waking up), and short enough that the user learns in the same breath
 * they pressed the button instead of at the end of a meeting. */
export const CAPTURE_START_DEADLINE_MS = 8_000;

/** How long stop() waits for the renderer's final tail slice before finalizing
 * anyway (the pre-existing safety timer, moved here so a NEW session cancels
 * it by construction). */
export const CAPTURE_TAIL_MS = 3_000;

/** What the user is told when the capture never delivered anything. Written to
 * be read on the Record page, not in a log: it says what happened AND what Flow
 * did about it. */
export function captureDeadMessage(ms: number): string {
  return (
    `The audio capture never started: no sound reached Flow within ${Math.round(ms / 1000)} seconds. ` +
    `The recording was stopped rather than left running on silence.`
  );
}

/** Timer seam, so the deadlines above are testable without waiting for them. */
export interface CaptureTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: CaptureTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CaptureSession {
  private timers: CaptureTimers;
  private startDeadlineMs: number;
  private tailMs: number;
  // The token. Every session gets a fresh one; nothing older may ever act.
  private gen = 0;
  // No session is running until start() says so - and an idle arbiter must
  // refuse every callback, not just the ones from a previous session.
  private over = true;
  // The capture proved it is really producing audio (native:ready, or a chunk).
  private proven = false;
  private startTimer: unknown = null;
  private tailTimer: unknown = null;

  constructor(opts: { timers?: CaptureTimers; startDeadlineMs?: number; tailMs?: number } = {}) {
    this.timers = opts.timers ?? REAL_TIMERS;
    this.startDeadlineMs = opts.startDeadlineMs ?? CAPTURE_START_DEADLINE_MS;
    this.tailMs = opts.tailMs ?? CAPTURE_TAIL_MS;
  }

  /** The token of the session currently running (0 before the first start). */
  get token(): number {
    return this.gen;
  }

  /** True while `gen` names the session that is still running. The one check
   * every late callback goes through. */
  current(gen: number): boolean {
    return gen === this.gen && !this.over;
  }

  /** True once the capture has proven itself and before it ended - what a
   * status line may honestly call "recording". */
  get live(): boolean {
    return !this.over && this.proven;
  }

  /** Open a new session and arm the watchdog. Everything the previous session
   * had pending (its watchdog, its tail timer) is cancelled here: that is the
   * whole point of the token, and the reason start() must be the only place
   * that bumps it. `onDead` fires at most once, and only if this session never
   * proved itself; the session is already closed when it does, so the caller
   * only has to report and clean up. */
  start(onDead: (msg: string) => void): number {
    this.clearTimers();
    const gen = ++this.gen;
    this.over = false;
    this.proven = false;
    this.startTimer = this.timers.set(() => {
      this.startTimer = null;
      if (!this.current(gen) || this.proven) return;
      this.over = true;
      this.clearTimers();
      onDead(captureDeadMessage(this.startDeadlineMs));
    }, this.startDeadlineMs);
    return gen;
  }

  /** native:ready, or the first PCM chunk: this capture is real. Disarms the
   * watchdog. Idempotent - a chunk arrives every second after that. */
  prove(gen: number): void {
    if (!this.current(gen) || this.proven) return;
    this.proven = true;
    this.timers.clear(this.startTimer);
    this.startTimer = null;
  }

  /** The capture failed (renderer error, window crash, failed load). Returns
   * whether the caller should surface it: a failure reported by a session that
   * already ended is not news, and telling the user about it would step on
   * whatever is running now. */
  fail(gen: number): boolean {
    if (!this.current(gen)) return false;
    this.over = true;
    this.clearTimers();
    return true;
  }

  /** Stop requested: arm the tail timer so a renderer that never answers can
   * still not wedge the recorder. Returns false when there is no live session
   * to stop (already failed, already finished), so the caller can settle
   * immediately instead of waiting for a flush that will never come. */
  stop(gen: number, onTail: () => void): boolean {
    if (!this.current(gen)) return false;
    this.timers.clear(this.tailTimer);
    this.tailTimer = this.timers.set(() => {
      this.tailTimer = null;
      onTail();
    }, this.tailMs);
    return true;
  }

  /** The tail is in (native:done, or the tail timer fired). True exactly once,
   * and only for the session still running: a tail that lands after the next
   * recording started must not finalize it. */
  finish(gen: number): boolean {
    if (!this.current(gen)) return false;
    this.over = true;
    this.clearTimers();
    return true;
  }

  /** The capture window is going away (destroy, quit): nothing pending may act. */
  cancel(): void {
    this.over = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    this.timers.clear(this.startTimer);
    this.timers.clear(this.tailTimer);
    this.startTimer = null;
    this.tailTimer = null;
  }
}
