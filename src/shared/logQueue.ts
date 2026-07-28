// The engine log's write policy (plan V2, B4b), kept PURE (no fs, no Electron,
// no timers of its own) for the same reason and with the same discipline as
// hookWatchdog.ts and overlayVisibility.ts: everything decidable lives here,
// where a test can drive it line by line, and the two lines of real disk I/O
// live in the adapter (src/main/logSink.ts).
//
// WHY THIS EXISTS AT ALL. flowLog() used to be, per line:
//
//     fs.statSync(p)            // is the file over 1 MB?
//     fs.renameSync(p, p + ".1")// occasionally
//     fs.appendFileSync(p, ...) // every single line
//
// Three SYNCHRONOUS filesystem calls on the main thread, and flowLog is called
// from everywhere - including once per line of whisper-server's stderr, which
// is chatty during a long transcription. The main thread is also the thread
// that owes Windows a swallow verdict for every keystroke on the machine
// (hotkey.ts), inside a budget Windows measures and silently revokes the hook
// for missing. A slow disk, a network-mapped home folder, or antivirus opening
// flow.log to inspect it therefore lands DIRECTLY on the keyboard hook. That is
// menace §3.2.2 of the plan, and it is why "the shortcut sometimes does not
// react" and "sometimes the Start menu opens" were never reproducible.
//
// WHAT THIS CHANGES, and what it deliberately does not:
//   - push() is now a single array push. No syscall, no allocation beyond the
//     string the caller already built. That is the whole point.
//   - The write happens on a LATER TICK (LogSink.schedule -> setImmediate), and
//     it is a genuinely ASYNCHRONOUS write. Deferring a *synchronous* write
//     would not have been enough: keyspy delivers key events as stdout "data"
//     on this same event loop, so a blocking write on any tick still delays the
//     NEXT verdict. Only a write that hands off to the threadpool keeps the loop
//     free.
//   - ORDER IS PRESERVED, by construction: at most ONE write is in flight at a
//     time, and lines pushed while it is in flight are written by the next
//     drain, in the order they arrived. Two concurrent appendFile calls would
//     interleave, which is exactly what a log must never do.
//   - NO LINE IS LOST between push() and the disk: a line is either still in
//     `pending`, or in the chunk currently in flight, or written. The two ways a
//     line can genuinely disappear are named, counted and reported: the disk
//     refused the write (see LOG_QUEUE_FAILURE.append), or the queue overflowed
//     (see maxPendingLines) - and the overflow announces itself IN the log file.
//   - Rotation keeps its old meaning exactly (rotate when the file on disk is
//     already past the ceiling, then append), it just happens once per DRAIN
//     instead of once per LINE.

/** Why a log write did not happen. Closed vocabulary so a counter cannot be
 * typo'd into a bucket nothing reads (same discipline as hotpath.ts's reasons). */
export const LOG_QUEUE_FAILURE = {
  /** stat/rename at the rotation ceiling threw. The lines are appended anyway;
   * the only consequence is a log file that grows past its ceiling. */
  rotate: "rotate",
  /** The append itself failed (disk full, permission denied, folder gone).
   * Those lines are gone - this counter is the ONLY trace they can ever leave,
   * because by construction the logger cannot log its own failure to write. */
  append: "append",
  /** The queue hit maxPendingLines: the disk has not accepted a write for long
   * enough that buffering further would be a memory leak. */
  overflow: "overflow",
} as const;
export type LogQueueFailure = (typeof LOG_QUEUE_FAILURE)[keyof typeof LOG_QUEUE_FAILURE];

/** The three filesystem verbs and the one scheduling verb this queue needs,
 * declared as an interface so the whole policy above is testable without a
 * disk - the same seam, for the same reason, as HookTimers in hookWatchdog.ts
 * and SidecarOptions.spawnProc in main/asr/sidecar.ts. */
export interface LogSink {
  /** Append asynchronously. MUST call `done` exactly once, and MUST NOT block
   * the caller - the entire contract of this module rests on that. */
  append(text: string, done: (err?: unknown) => void): void;
  /** Append synchronously. Used ONLY by flushSync() (before-quit), where there
   * is no later tick left to run on. May throw. */
  appendSync(text: string): void;
  /** Current size of the log file in bytes, or null when there is no file yet
   * (first run) or it cannot be measured. May throw; the queue tolerates it. */
  size(): number | null;
  /** Move the log aside (flow.log -> flow.log.1). May throw. */
  rotate(): void;
  /** Run `fn` on a later tick (setImmediate in the app). Never synchronously:
   * calling `fn` inline would put the write back on the hot path this module
   * exists to clear. */
  schedule(fn: () => void): void;
}

export interface LogQueueOptions {
  /** Rotate once the file on disk is already past this. Matches the historical
   * 1 MB ceiling flowLog() used. */
  rotateAtBytes?: number;
  /** Hard ceiling on buffered lines. Reaching it means the sink has not
   * accepted a write in a very long time; see push() for what happens then. */
  maxPendingLines?: number;
  /** Fired on each named failure above. Memory-only by contract: a logger that
   * logged its own write failures would recurse. */
  onFailure?(kind: LogQueueFailure): void;
}

const DEFAULT_ROTATE_AT_BYTES = 1_000_000;
// Chosen high enough that no realistic burst reaches it (whisper-server's
// chattiest minute is a few thousand lines) and low enough that a wedged disk
// cannot turn the log into a memory leak on a machine that runs for weeks.
const DEFAULT_MAX_PENDING_LINES = 20_000;

export class LogQueue {
  private readonly pending: string[] = [];
  private inFlight = false;
  private scheduled = false;
  private droppedTotal = 0;
  private droppedSinceMarker = 0;
  private readonly rotateAtBytes: number;
  private readonly maxPendingLines: number;

  constructor(
    private readonly sink: LogSink,
    private readonly opts: LogQueueOptions = {},
  ) {
    this.rotateAtBytes = opts.rotateAtBytes ?? DEFAULT_ROTATE_AT_BYTES;
    this.maxPendingLines = opts.maxPendingLines ?? DEFAULT_MAX_PENDING_LINES;
  }

  /** THE hot-path entry point. `line` must already end in "\n" - the caller
   * owns the format (timestamp + message), this owns only when it reaches the
   * disk. One array push and, at most, one schedule() call: no syscall, no
   * string work, nothing that can block. */
  push(line: string): void {
    if (this.pending.length >= this.maxPendingLines) {
      // Overflow keeps the OLDEST lines and counts the rest. That direction is
      // deliberate: when a machine wedges, the lines that explain WHY are the
      // ones at the start of the outage, and the tail is a thousand repetitions
      // of the consequence. The count is not silent - drainMarker() writes it
      // into the log itself as soon as the disk accepts anything again.
      this.droppedTotal++;
      this.droppedSinceMarker++;
      this.opts.onFailure?.(LOG_QUEUE_FAILURE.overflow);
      return;
    }
    this.pending.push(line);
    this.schedule();
  }

  /** Hand back everything still buffered, RIGHT NOW, synchronously.
   *
   * before-quit is the one moment with no later tick to run on: Electron's
   * handler is synchronous and the process dies immediately after it, so a
   * scheduled drain would simply never happen and the last diagnostics of the
   * session - very often the ones explaining why the user is quitting - would
   * be lost. Same reasoning, and the same place in the shutdown sequence, as
   * flushPendingRestore() and rescueOnQuit() in main/index.ts.
   *
   * A chunk already handed to the sink's ASYNC append is deliberately NOT
   * rewritten here: those bytes are already with the OS, and writing them again
   * would duplicate them in the file. */
  flushSync(): void {
    const text = this.take();
    if (text === null) return;
    try {
      this.rotateIfNeeded();
      this.sink.appendSync(text);
    } catch {
      this.opts.onFailure?.(LOG_QUEUE_FAILURE.append);
    }
  }

  /** Lines buffered but not yet written. Diagnostics and tests only. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Lines this queue never managed to write, all causes. Diagnostics only. */
  droppedCount(): number {
    return this.droppedTotal;
  }

  private schedule(): void {
    if (this.scheduled || this.inFlight) return;
    this.scheduled = true;
    this.sink.schedule(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    // One write at a time, always: this single guard is what guarantees the
    // file's line order matches the push order.
    if (this.inFlight) return;
    const text = this.take();
    if (text === null) return;
    this.inFlight = true;
    try {
      this.rotateIfNeeded();
    } catch {
      /* rotateIfNeeded already reported it; the append below still runs */
    }
    let settled = false;
    this.sink.append(text, (err) => {
      // A sink that called back twice would let two writes run at once and
      // reorder the file - cheaper to make impossible than to debug.
      if (settled) return;
      settled = true;
      this.inFlight = false;
      if (err) this.opts.onFailure?.(LOG_QUEUE_FAILURE.append);
      if (this.pending.length) this.schedule();
    });
  }

  /** Everything buffered, as one string, plus the overflow marker when lines
   * were dropped since the last one. Returns null when there is nothing to
   * write, so callers never hand the sink an empty append. */
  private take(): string | null {
    if (!this.pending.length && !this.droppedSinceMarker) return null;
    const marker = this.droppedSinceMarker
      ? `[log] ${this.droppedSinceMarker} log line(s) were dropped before this point: the log queue overflowed ` +
        `(the disk was not accepting writes)\n`
      : "";
    this.droppedSinceMarker = 0;
    const text = marker + this.pending.join("");
    this.pending.length = 0;
    return text;
  }

  /** Same meaning as the old per-line check (rotate when the file on disk is
   * ALREADY past the ceiling), just once per drain instead of once per line.
   * Never lets a rotation failure cost the append that follows it. */
  private rotateIfNeeded(): void {
    let size: number | null;
    try {
      size = this.sink.size();
    } catch {
      // No file yet, or it cannot be measured. Appending creates it; the next
      // drain will measure it. Not a failure worth a counter.
      return;
    }
    if (size === null || size <= this.rotateAtBytes) return;
    try {
      this.sink.rotate();
    } catch {
      this.opts.onFailure?.(LOG_QUEUE_FAILURE.rotate);
    }
  }
}
