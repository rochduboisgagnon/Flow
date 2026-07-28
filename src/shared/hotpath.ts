// Hot-path timing instrumentation (plan V2, B1). Pure, Electron-free: every
// module that calls into this file (hotkey.ts, index.ts, overlay.ts) runs in
// the SAME Node.js main process, so plain performance.now() marks from all
// three are directly comparable on one clock - no cross-process alignment is
// needed, which is exactly why this module never has to reach into the
// overlay renderer (a separate process with its own performance.now() origin).
//
// CLOCK CHOICE, argued: performance.now(), not Date.now().
//   - Date.now() is wall-clock time: NTP sync, a user changing the clock, or a
//     DST transition can make it jump - including BACKWARD. A backward jump
//     mid-trace would produce a negative duration, which is worse than a
//     merely-imprecise one: it is actively misleading. Windows also runs
//     Date.now() off a system timer whose default granularity is commonly
//     ~15.6 ms - useless for budgets measured in single-digit milliseconds.
//   - performance.now() is monotonic (Node backs it with a high-resolution
//     clock; on Windows that is QueryPerformanceCounter) and sub-millisecond.
//     It never goes backward and is unaffected by wall-clock adjustments -
//     exactly the property a 30 ms budget needs. Its origin is arbitrary and
//     PER PROCESS, which is fine and in fact the reason this module stays
//     entirely inside the main process: comparing a main-process reading
//     against a renderer-process reading would be comparing two different
//     origins, silently wrong. If the overlay renderer is ever instrumented
//     (see the B1 report for what that would take), its marks would need
//     their own trace lane, never mixed into these ones.
//
// SECURITY (non-negotiable, plan §5.4 - zero retention): a trace NEVER
// carries dictated content. Not the text, not a hash, not a fragment. Only
// step names, timestamps (ms, relative to process start), a handful of
// closed-vocabulary reason strings, and small integer counts (a character
// COUNT, a duration in ms) are ever stored. `textChars` is a length, useless
// for reconstructing anything.
//
// COST, argued: every call on the hot path (mark, sampleHandlerLatency) is a
// property read/write and, at most, a bounded array push into a pre-sized
// ring - no disk I/O, no JSON, no allocation beyond the occasional new trace
// object (one small object per PRESS, not per keystroke). That is what "a
// memory write, never a log" requires, and is the same order of cost as the
// Set operations the combo matcher already does per event.

import { silentFailures, type SilentFailureName } from "./silentFailures";

export type HotpathStep =
  | "keyEventReceived" // the physical DOWN event that completed the combo (a press)
  | "verdictRendered" // the matcher's decision for that same event, about to be returned to keyspy
  | "captureStartDecided" // main decided to start capture (HotkeyAdapter's onStart callback, entry)
  | "overlayStartSent" // CAPTURE_START actually dispatched to the overlay window (overlay.ts)
  | "releaseObserved" // the physical event that ended the press: UP (stop) or an extra key (cancel)
  | "overlayStopSent" // CAPTURE_STOP dispatched (trace continues toward a completion)
  | "overlayCancelSent" // CAPTURE_CANCEL dispatched (trace is about to be abandoned)
  | "wavReceived" // CAPTURE_DONE received back from the overlay
  | "transcriptionStarted" // right before the ASR sidecar's /inference call
  | "transcriptionFinished" // right after it resolves
  | "focusProbed" // right after the focus probe resolves
  | "routeDecided" // right after decideRoute() returns
  | "textInserted"; // right after the text landed (paste, typed keystrokes, or clipboard)

export interface HotpathMark {
  step: HotpathStep;
  t: number; // performance.now(), ms
}

export type HotpathOutcome = "in-progress" | "completed" | "abandoned";

// Closed vocabulary, so a call site can never typo a free-form reason into
// something the report's grouping silently drops.
export const HOTPATH_ABANDON_REASON = {
  shortTap: "short-tap", // held for less than MIN_HOLD_MS
  extraKey: "extra-key", // another key was pressed while holding
  shortcutRecorder: "shortcut-recorder", // pre-empted by Settings' shortcut recorder
  comboChanged: "combo-changed", // the shortcut itself was changed mid-hold
  paused: "paused", // the tray's "pause dictation" pre-empted a live hold
  busyLongRecording: "busy-long-recording", // refused: a long recording owns the engine
  tooShortClip: "too-short-clip", // < 300 ms of audio, treated as release noise
  noSpeech: "gated-no-speech", // the energy VAD found nothing to send to the model
  hallucinationGate: "gated-hallucination", // the model answered, textGate rejected it
  hookDied: "hook-died", // B4: the keyboard hook died mid-hold; the press can never be released
  captureError: "capture-error", // the overlay reported a capture failure (e.g. no microphone)
  pipelineError: "pipeline-error", // an exception past the WAV (transcribe/probe/insert)
  staleTimeout: "stale-timeout", // never resolved within STALE_OPEN_MS: swept, not lost forever
  openQueueFull: "open-queue-full", // defensive eviction so the open queue cannot grow unbounded
} as const;
export type HotpathAbandonReason = (typeof HOTPATH_ABANDON_REASON)[keyof typeof HOTPATH_ABANDON_REASON];

export type HotpathResult = "inserted" | "clipboarded";

// B4: hot-path events that belong to NO single press. A trace is opened by a
// keypress and closed by its outcome; the death of the keyboard hook is the
// opposite - it is the reason no trace will open at all. Recording it as a
// trace would be a lie (there was no press), and dropping it would leave the
// Diagnostics panel showing a suspiciously quiet minute with no explanation.
// So it gets its own small lane in the same snapshot, on the same clock.
export const HOTPATH_EVENT = {
  hookDied: "hook-died", // the key server process closed unexpectedly
  hookRestarted: "hook-restarted", // a replacement listener is live again
  hookAbandoned: "hook-abandoned", // the crash-loop guard gave up; terminal
} as const;
export type HotpathEventKind = (typeof HOTPATH_EVENT)[keyof typeof HOTPATH_EVENT];

export interface HotpathEvent {
  kind: HotpathEventKind;
  t: number; // performance.now(), same clock/origin as every mark above
}

export interface HotpathTrace {
  id: number;
  outcome: HotpathOutcome;
  marks: HotpathMark[];
  reason?: HotpathAbandonReason; // present when outcome === "abandoned"
  result?: HotpathResult; // present when outcome === "completed"
  utteranceMs?: number; // the captured clip's own duration (a NUMBER, never its content)
  textChars?: number; // character COUNT of what was inserted, never the characters
}

// ---- bounded ring buffer (generic, reused for traces and raw numbers) ----
// Pre-allocated, overwrite-oldest: size never exceeds `capacity`, by
// construction - this is what "must never grow without bound" requires for a
// structure that lives for the whole life of the keyboard hook's process.
export class Ring<T> {
  private buf: (T | undefined)[];
  private start = 0;
  private len = 0;
  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("Ring capacity must be >= 1");
    this.buf = new Array(capacity);
  }
  push(item: T): void {
    const idx = (this.start + this.len) % this.capacity;
    this.buf[idx] = item;
    if (this.len < this.capacity) this.len++;
    else this.start = (this.start + 1) % this.capacity;
  }
  toArray(): T[] {
    const out: T[] = new Array(this.len);
    for (let i = 0; i < this.len; i++) out[i] = this.buf[(this.start + i) % this.capacity] as T;
    return out;
  }
  get size(): number {
    return this.len;
  }
  clear(): void {
    this.start = 0;
    this.len = 0;
    this.buf = new Array(this.capacity);
  }
}

const DEFAULT_TRACE_CAPACITY = 200;
const DEFAULT_LATENCY_CAPACITY = 2000;
// B4: hook incidents are rare by nature (the crash-loop guard caps automatic
// restarts at 3 in five minutes), so a small ring holds a whole session's worth
// and still cannot grow.
const DEFAULT_EVENT_CAPACITY = 50;
// Defensive cap on traces awaiting resolution at once. In normal operation
// there is at most one (occasionally two, if a press overlaps the previous
// utterance's still-finalizing pipeline - see overlayVisibility.ts). This
// exists purely so a pathological sequence of never-resolving presses cannot
// grow the open queue without bound.
const OPEN_QUEUE_CAP = 8;
// An utterance pipeline that has not resolved in this long is not "slow", it
// is stuck (crashed probe, hung sidecar, a dropped IPC message). Sweeping it
// keeps the open queue's FIFO correlation (see findOpenMissing) from being
// blocked forever by a trace that will never receive its next mark.
const STALE_OPEN_MS = 30_000;

function nowMs(): number {
  return performance.now();
}

export class HotpathLog {
  private nextId = 1;
  private open: HotpathTrace[] = [];
  private readonly completed: Ring<HotpathTrace>;
  private readonly handlerLatencies: Ring<number>;
  private readonly events: Ring<HotpathEvent>;

  constructor(
    traceCapacity = DEFAULT_TRACE_CAPACITY,
    latencyCapacity = DEFAULT_LATENCY_CAPACITY,
    eventCapacity = DEFAULT_EVENT_CAPACITY,
  ) {
    this.completed = new Ring(traceCapacity);
    this.handlerLatencies = new Ring(latencyCapacity);
    this.events = new Ring(eventCapacity);
  }

  /** B4: one press-less hot-path event (see HOTPATH_EVENT). Deliberately does
   * NOT touch the open queue: a hook death does not resolve a press, and the
   * press it interrupted is abandoned explicitly by the adapter with the
   * `hook-died` reason - two different facts, recorded separately. */
  event(kind: HotpathEventKind, t: number = nowMs()): void {
    this.events.push({ kind, t });
  }

  /** menace §3.2.2: the keyboard hook's OWN synchronous execution time for
   * ONE event (any event - not just combo-relevant ones). This is the number
   * Windows' hook-timeout risk is actually about; sampled for every event
   * that reaches the matcher, regardless of whether a trace is open. */
  sampleHandlerLatency(ms: number): void {
    this.handlerLatencies.push(ms);
  }

  /**
   * Record one named step. `keyEventReceived` always OPENS a new trace (it is
   * by construction the first mark of any press). Every other step attaches
   * to the OLDEST open trace that does not yet have it.
   *
   * Correlation is deliberately id-less: the overlay renderer (out of scope
   * for this task - see the B1 report) cannot be made to echo an id back, so
   * `wavReceived` in particular has nothing to match against except arrival
   * order. FIFO-by-age is correct here because the app can only ever be
   * capturing ONE press at a time (the combo matcher enforces that) - the
   * only overlap is a NEW press starting while the PREVIOUS utterance's
   * pipeline is still finalizing (transcribe/probe/insert), and in that
   * scenario the older trace is also the one closer to completion, so it is
   * always the correct match for the next arriving mark of a given step.
   *
   * Never throws: a step with no correlated open trace (e.g. processUtterance
   * called from the HTTP /transcribe endpoint, untraced by design - see
   * index.ts) is silently dropped rather than mis-attributed.
   */
  mark(step: HotpathStep, t: number = nowMs()): void {
    this.sweepStale(t);
    if (step === "keyEventReceived") {
      if (this.open.length >= OPEN_QUEUE_CAP) {
        const evicted = this.open.shift();
        if (evicted) this.close(evicted, "abandoned", HOTPATH_ABANDON_REASON.openQueueFull, t);
      }
      this.open.push({ id: this.nextId++, outcome: "in-progress", marks: [{ step, t }] });
      return;
    }
    const trace = this.findOpenMissing(step);
    if (!trace) return;
    trace.marks.push({ step, t });
  }

  /** `wavReceived` carries an extra number (the clip's own duration) that has
   * nowhere to live in a plain mark, so it gets its own method rather than
   * overloading `mark()`'s signature for every step. */
  markWavReceived(utteranceMs: number, t: number = nowMs()): void {
    this.sweepStale(t);
    const trace = this.findOpenMissing("wavReceived");
    if (!trace) return;
    trace.marks.push({ step: "wavReceived", t });
    trace.utteranceMs = utteranceMs;
  }

  /** Close the oldest open trace as a success: appends `textInserted` itself
   * (never a separate mark() call) so the timestamp of "done" and the
   * timestamp of "closed" can never drift apart. */
  complete(result: HotpathResult, textChars: number, t: number = nowMs()): void {
    this.sweepStale(t);
    const trace = this.open.shift();
    if (!trace) return;
    trace.marks.push({ step: "textInserted", t });
    trace.result = result;
    trace.textChars = textChars;
    this.close(trace, "completed", undefined, t);
  }

  /** Close the oldest open trace as abandoned (no text ever reached the
   * cursor or the clipboard for it): a short tap, a cancel, a VAD/hallucination
   * gate, or a pipeline failure. */
  abandon(reason: HotpathAbandonReason, t: number = nowMs()): void {
    this.sweepStale(t);
    const trace = this.open.shift();
    if (!trace) return;
    this.close(trace, "abandoned", reason, t);
  }

  /** A read-only, defensively-copied view for the Diagnostics panel and
   * `bench:hotpath` - callers can freely hold onto or mutate what they get
   * back without touching internal state. */
  snapshot(): HotpathSnapshot {
    return {
      generatedAt: nowMs(),
      completed: this.completed.toArray().map(cloneTrace),
      open: this.open.map(cloneTrace),
      handlerLatenciesMs: this.handlerLatencies.toArray(),
      events: this.events.toArray().map((e) => ({ ...e })),
      // B6: rides this EXISTING snapshot/channel rather than opening a new
      // one - Diagnostics already polls UI_HOTPATH_SNAPSHOT. See
      // silentFailures.ts for what each name counts; this file only carries
      // the tally through, it never increments anything itself.
      silentFailureCounts: silentFailures.snapshot(),
    };
  }

  private findOpenMissing(step: HotpathStep): HotpathTrace | undefined {
    return this.open.find((tr) => !tr.marks.some((m) => m.step === step));
  }

  private close(
    trace: HotpathTrace,
    outcome: "completed" | "abandoned",
    reason: HotpathAbandonReason | undefined,
    _t: number,
  ): void {
    trace.outcome = outcome;
    if (reason) trace.reason = reason;
    this.completed.push(trace);
  }

  private sweepStale(now: number): void {
    while (this.open.length && now - this.open[0].marks[0].t > STALE_OPEN_MS) {
      const tr = this.open.shift()!;
      this.close(tr, "abandoned", HOTPATH_ABANDON_REASON.staleTimeout, now);
    }
  }
}

function cloneTrace(t: HotpathTrace): HotpathTrace {
  return { ...t, marks: t.marks.map((m) => ({ ...m })) };
}

export interface HotpathSnapshot {
  generatedAt: number;
  completed: HotpathTrace[];
  open: HotpathTrace[];
  handlerLatenciesMs: number[];
  /** B4: press-less incidents (hook died / restarted / abandoned), oldest first. */
  events: HotpathEvent[];
  /** B6: named best-effort catches on the dictation hot path, tallied since
   * launch - see silentFailures.ts for the closed vocabulary of names and
   * exactly what each one counts (never dictated content, never a path). */
  silentFailureCounts: Record<SilentFailureName, number>;
}

// The process-wide instance every main-process module instruments against.
// Tests construct their own `new HotpathLog()` for isolation instead of
// reaching for this singleton.
export const hotpath = new HotpathLog();

// ---- pure interval / budget computation (shared by the Diagnostics panel
// and bench:hotpath, so the two can never disagree on the arithmetic) ----

function findMark(trace: HotpathTrace, step: HotpathStep): number | null {
  const m = trace.marks.find((x) => x.step === step);
  return m ? m.t : null;
}

export interface HotpathIntervals {
  /** menace §3.2.2: the matcher's OWN decision time (verdictRendered - keyEventReceived).
   * Excludes everything the hook callback does AFTER the verdict (onStart/onStop/onCancel's
   * synchronous side effects) - see handlerLatenciesMs for the FULL hook cost. */
  verdictLatencyMs: number | null;
  /** Proxy for "press -> cue audible" (§3.3): the overlay's start cue is the
   * FIRST synchronous statement of its start() handler, so this is a close
   * upper bound, not an exact measurement - see the B1 report. */
  keyToOverlayOrderMs: number | null;
  /** The model's own inference time - what "excluding model time" (§3.3) subtracts out. */
  transcriptionMs: number | null;
  /** release -> text landed, model time INCLUDED. */
  releaseToTextMs: number | null;
  /** release -> text landed, model time EXCLUDED - the §3.3 budget's own number. */
  releaseToTextExclModelMs: number | null;
  /** press -> text landed, the full user-perceived latency (informational; not itself a §3.3 budget). */
  totalPressToTextMs: number | null;
}

export function computeIntervals(trace: HotpathTrace): HotpathIntervals {
  const keyAt = findMark(trace, "keyEventReceived");
  const verdictAt = findMark(trace, "verdictRendered");
  const overlayStartAt = findMark(trace, "overlayStartSent");
  const releaseAt = findMark(trace, "releaseObserved");
  const transStartAt = findMark(trace, "transcriptionStarted");
  const transEndAt = findMark(trace, "transcriptionFinished");
  const textAt = findMark(trace, "textInserted");

  const verdictLatencyMs = keyAt !== null && verdictAt !== null ? verdictAt - keyAt : null;
  const keyToOverlayOrderMs = keyAt !== null && overlayStartAt !== null ? overlayStartAt - keyAt : null;
  const transcriptionMs = transStartAt !== null && transEndAt !== null ? transEndAt - transStartAt : null;
  const releaseToTextMs = releaseAt !== null && textAt !== null ? textAt - releaseAt : null;
  const releaseToTextExclModelMs =
    releaseToTextMs !== null && transcriptionMs !== null ? releaseToTextMs - transcriptionMs : releaseToTextMs;
  const totalPressToTextMs = keyAt !== null && textAt !== null ? textAt - keyAt : null;

  return {
    verdictLatencyMs,
    keyToOverlayOrderMs,
    transcriptionMs,
    releaseToTextMs,
    releaseToTextExclModelMs,
    totalPressToTextMs,
  };
}

export const HOTPATH_BUDGETS_MS = {
  cueAudible: 30,
  animationFirstFrame: 50,
  micCapturing: 80,
  releaseToTextExclModel: 60,
} as const;

export interface HotpathBudgetVerdict {
  metric: string;
  budgetMs: number;
  valueMs: number | null;
  withinBudget: boolean | null; // null when there is nothing to compare (no value)
  measurable: boolean; // false = cannot be produced from main-process instrumentation alone
}

/** One row per §3.3 budget. The two rows the overlay renderer alone can
 * answer (first painted frame, first captured sample) are always returned
 * with measurable:false rather than omitted, so a consumer never has to
 * special-case "missing" vs "known unmeasurable". */
export function evaluateBudgets(trace: HotpathTrace): HotpathBudgetVerdict[] {
  const iv = computeIntervals(trace);
  return [
    {
      metric: "press -> cue audible (proxy: press -> order sent to the overlay)",
      budgetMs: HOTPATH_BUDGETS_MS.cueAudible,
      valueMs: iv.keyToOverlayOrderMs,
      withinBudget: iv.keyToOverlayOrderMs === null ? null : iv.keyToOverlayOrderMs < HOTPATH_BUDGETS_MS.cueAudible,
      measurable: true,
    },
    {
      metric: "press -> first animation frame painted",
      budgetMs: HOTPATH_BUDGETS_MS.animationFirstFrame,
      valueMs: null,
      withinBudget: null,
      measurable: false,
    },
    {
      metric: "press -> microphone actually capturing",
      budgetMs: HOTPATH_BUDGETS_MS.micCapturing,
      valueMs: null,
      withinBudget: null,
      measurable: false,
    },
    {
      metric: "release -> text at cursor, excluding model time",
      budgetMs: HOTPATH_BUDGETS_MS.releaseToTextExclModel,
      valueMs: iv.releaseToTextExclModelMs,
      withinBudget:
        iv.releaseToTextExclModelMs === null
          ? null
          : iv.releaseToTextExclModelMs < HOTPATH_BUDGETS_MS.releaseToTextExclModel,
      measurable: true,
    },
  ];
}

// ---- statistics (median / p95 / worst case), shared by the panel and the CLI ----

export function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export interface HotpathSummary {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export function summarize(values: number[]): HotpathSummary {
  const clean = values.filter((v) => Number.isFinite(v));
  return {
    count: clean.length,
    medianMs: median(clean),
    p95Ms: percentile(clean, 95),
    maxMs: clean.length ? Math.max(...clean) : null,
  };
}
