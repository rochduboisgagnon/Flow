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
//     origins, silently wrong.
//
// B2 CLOSES B1's TWO BLIND SPOTS WITHOUT BREAKING THAT RULE. The overlay
// renderer now reports the two budgets only it can see (first frame painted,
// first sample captured), and it reports them as DURATIONS measured on its own
// clock - never as instants. markOverlayTimings() turns each one into a mark by
// ADDING it to overlayStartSent, an instant this process timestamped itself.
// No renderer reading is ever compared to a main reading, so every mark on a
// trace still shares one origin. The cost of that discipline is stated where
// it is paid: the one-way IPC hop is not counted, so both derived marks are a
// LOWER bound (see markOverlayTimings).
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
  // B2: the two steps that happen INSIDE the overlay renderer. They are not
  // timestamped by that process - they are DERIVED here, by adding a duration
  // the renderer measured on its own clock to overlayStartSent, an instant
  // this process already owns. See markOverlayTimings.
  | "overlayFirstPaint" // the first animation frame drawn for this press
  | "overlayFirstSample" // this capture's buffer holds audio covering the press
  | "releaseObserved" // the physical event that ended the press: UP (stop) or an extra key (cancel)
  | "overlayStopSent" // CAPTURE_STOP dispatched (trace continues toward a completion)
  | "overlayCancelSent" // CAPTURE_CANCEL dispatched (trace is about to be abandoned)
  | "wavReceived" // CAPTURE_DONE received back from the overlay
  | "transcriptionStarted" // right before the ASR sidecar's /inference call
  | "transcriptionFinished" // right after it resolves
  // V5 E3: a voice function is running - the transcript is at a local language
  // model being transformed. These two exist for ONE reason: without them, a
  // transformation's seconds would land inside releaseToTextExclModelMs and the
  // Diagnostics panel would report a 3000 ms breach of a 60 ms budget that
  // nothing in the activation path had broken. A panel that accuses the wrong
  // subsystem is worse than one that says nothing.
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
  /** 2026-07-30: set when this trace was opened while ANOTHER was still open,
   * which makes every interval derived from it UNTRUSTWORTHY - and saying so is
   * the whole point of the flag.
   *
   * Why. Marks other than the first are attached by findOpenMissing(), i.e. to
   * the oldest open trace still missing that step. With one press at a time that
   * is exact. With two presses overlapping - which is precisely what a user does
   * when the app feels stuck and they press again - a later press's
   * `textInserted` attaches to an EARLIER press's trace, and the resulting
   * "release -> text" is not a duration of anything: it is the gap between two
   * different presses.
   *
   * This was found by reading a real Diagnostics panel that showed 2 301 ms in
   * red against a 60 ms budget, blaming Flow's own plumbing, on a press whose
   * model time was blank. The number was not a slow path; it was arithmetic
   * across two presses. A panel that exists to tell the truth about latency must
   * not publish that as a fact. */
  ambiguous?: boolean;
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
// B11: 3000 lag samples is one minute of the 20 ms active cadence, or about
// twenty-five minutes of the 500 ms idle one (see shared/loopLag.ts). Bounded
// by construction like every other ring here: 3000 doubles is ~24 KB that can
// never grow, for a sampler that runs for the whole life of the process.
const DEFAULT_LOOP_LAG_CAPACITY = 3000;
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

// Adverse review V2, constat 1: which abandon reasons describe the press the
// keyboard/hook layer is reacting to RIGHT NOW, as opposed to a verdict about
// a WAV that already arrived.
//
// The matcher allows exactly one live hold at a time (see mark()'s own
// comment), so while a hold is in progress nothing can have opened a trace
// AFTER it - the most recently opened trace IS the hold this reason is about.
// The oldest open trace, if there is a second one, is always something else:
// an EARLIER press whose capture already finished and whose pipeline
// (transcribe/probe/insert) is still resolving in the background. Closing
// THAT one on a reason about the current keypress would end a still-live,
// unrelated dictation on the wrong verdict, and leave the trace that actually
// earned the reason open until the 30 s stale sweep quietly relabels it
// "stale-timeout" instead of the true cause.
//
// Every reason here is fired from a hook/hotkey callback (onStart's refusal,
// onCancel's five reasons) or from a capture-layer report about the press
// still being captured (hookDied, captureError) - none of them are ever
// decided FROM a WAV, so none of them can ever be about an older, WAV-bearing
// trace.
const KEYBOARD_ABANDON_REASONS: ReadonlySet<HotpathAbandonReason> = new Set([
  HOTPATH_ABANDON_REASON.shortTap,
  HOTPATH_ABANDON_REASON.extraKey,
  HOTPATH_ABANDON_REASON.shortcutRecorder,
  HOTPATH_ABANDON_REASON.comboChanged,
  HOTPATH_ABANDON_REASON.paused,
  HOTPATH_ABANDON_REASON.busyLongRecording,
  HOTPATH_ABANDON_REASON.hookDied,
  HOTPATH_ABANDON_REASON.captureError,
]);

function nowMs(): number {
  return performance.now();
}

// B2: a duration that crossed a process boundary is input, not data. The
// ceiling is deliberately loose (a minute) - its job is to reject a corrupt or
// hostile value, not to second-guess a genuinely slow machine.
const MAX_REPORTED_DURATION_MS = 60_000;
function isSaneDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_REPORTED_DURATION_MS;
}

export class HotpathLog {
  private nextId = 1;
  private open: HotpathTrace[] = [];
  private readonly completed: Ring<HotpathTrace>;
  private readonly handlerLatencies: Ring<number>;
  private readonly events: Ring<HotpathEvent>;
  private readonly loopLags: Ring<number>;

  constructor(
    traceCapacity = DEFAULT_TRACE_CAPACITY,
    latencyCapacity = DEFAULT_LATENCY_CAPACITY,
    eventCapacity = DEFAULT_EVENT_CAPACITY,
    loopLagCapacity = DEFAULT_LOOP_LAG_CAPACITY,
  ) {
    this.completed = new Ring(traceCapacity);
    this.handlerLatencies = new Ring(latencyCapacity);
    this.events = new Ring(eventCapacity);
    this.loopLags = new Ring(loopLagCapacity);
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

  /** B11: one event-loop lag observation (see shared/loopLag.ts for what the
   * number means and why it is not a raw inter-tick delta). This is segment 2
   * of the four the Windows hook budget covers - the wait in Node's timer/IO
   * queue BEFORE our handler runs - and it is the only one B1 never saw. */
  sampleLoopLag(ms: number): void {
    this.loopLags.push(ms);
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
      this.open.push({
        id: this.nextId++,
        outcome: "in-progress",
        marks: [{ step, t }],
        // Ambiguous the moment it is not alone: see the field's own note.
        ...(this.open.length > 0 ? { ambiguous: true } : {}),
      });
      // The trace ALREADY open is now ambiguous too - its later marks can be
      // stolen by, or stolen from, the one just opened. Marking only the newcomer
      // would leave the more misleading of the two looking trustworthy.
      if (this.open.length > 1) {
        for (const t2 of this.open) t2.ambiguous = true;
      }
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

  /**
   * B2: fold the overlay renderer's two self-measured durations into the trace
   * they belong to.
   *
   * The arithmetic is the whole design: `overlayStartSent` is an instant THIS
   * process recorded, on THIS clock; the two arguments are durations the
   * renderer measured on ITS clock, both starting from the arrival of that same
   * message. Adding one to the other gives a mark on the main clock without
   * ever comparing two origins. What the sum leaves out is the one-way IPC hop
   * between the send and the receive - unmeasurable without exactly the
   * cross-clock comparison this avoids - so both marks land slightly EARLY and
   * the budgets read from them are lower bounds. Stated here rather than
   * discovered later: a number that is honest about which way it is wrong is
   * worth more than one that pretends not to be.
   *
   * Refuses anything that is not a plain, sane duration. The values cross a
   * process boundary, and a NaN or a negative would not fail loudly - it would
   * produce a mark BEFORE the keypress and a cheerfully within-budget verdict.
   */
  markOverlayTimings(firstPaintMs: number, firstSampleMs: number, t: number = nowMs()): void {
    this.sweepStale(t);
    if (!isSaneDuration(firstPaintMs) || !isSaneDuration(firstSampleMs)) return;
    const trace = this.findOpenMissing("overlayFirstPaint");
    if (!trace) return;
    const sentAt = trace.marks.find((m) => m.step === "overlayStartSent");
    if (!sentAt) return; // nothing to add to: this press never reached the overlay
    trace.marks.push({ step: "overlayFirstPaint", t: sentAt.t + firstPaintMs });
    trace.marks.push({ step: "overlayFirstSample", t: sentAt.t + firstSampleMs });
  }

  /** Close the oldest open trace as a success: appends `textInserted` itself
   * (never a separate mark() call) so the timestamp of "done" and the
   * timestamp of "closed" can never drift apart.
   *
   * Always the OLDEST, unconditionally - and that is correct, not merely
   * convenient: `complete()` only ever fires at the end of a pipeline that
   * already has `wavReceived` (see wireCapture in index.ts), and that mark
   * was itself attached FIFO-oldest (mark()'s own rule). A trace that reached
   * `complete()` is therefore always the one closest to the front of the
   * queue among traces past that point - the same invariant mark() documents
   * for `wavReceived` onward. Reasons decided BEFORE any WAV exists are a
   * different case entirely; see abandon() and KEYBOARD_ABANDON_REASONS. */
  complete(result: HotpathResult, textChars: number, t: number = nowMs()): void {
    this.sweepStale(t);
    const trace = this.open.shift();
    if (!trace) return;
    trace.marks.push({ step: "textInserted", t });
    trace.result = result;
    trace.textChars = textChars;
    this.close(trace, "completed", undefined, t);
  }

  /** Close a trace as abandoned (no text ever reached the cursor or the
   * clipboard for it): a short tap, a cancel, a VAD/hallucination gate, or a
   * pipeline failure.
   *
   * WHICH trace depends on WHAT the reason describes (constat 1, adverse
   * review V2): a keyboard/hook-layer reason (see KEYBOARD_ABANDON_REASONS)
   * is a verdict about the press just produced, so it must close the MOST
   * RECENTLY opened trace - closing the oldest instead would end an older,
   * still-live dictation on a verdict that was never about it, and leave the
   * press that actually earned the reason open until the 30 s stale sweep.
   * Every other reason is decided FROM a WAV that already arrived and
   * already attached FIFO-oldest (mark()'s rule, same as complete() above),
   * so the oldest open trace remains the correct - and unconditional -
   * target for those. */
  abandon(reason: HotpathAbandonReason, t: number = nowMs()): void {
    this.sweepStale(t);
    const trace = KEYBOARD_ABANDON_REASONS.has(reason) ? this.open.pop() : this.open.shift();
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
      // B11: STATISTICS, not the raw ring - the one field of this snapshot that
      // is summarized before it ships. The lag ring fills at up to 50 samples
      // per second, so shipping it raw would put ~50 KB of JSON through the IPC
      // channel and the loopback route every two seconds while the Diagnostics
      // panel is open. Serializing that costs main-thread time, on the very
      // event loop this number exists to prove is free: a measurement that
      // degrades what it measures is worse than no measurement. The arithmetic
      // is shared (summarizeLoopLag below), so the panel and bench:hotpath still
      // cannot disagree about the same data - which was the point of shipping
      // raw values elsewhere in the first place.
      loopLag: summarizeLoopLag(this.loopLags.toArray()),
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
  /** B11: event-loop lag, already summarized (see the note in snapshot()). */
  loopLag: LoopLagStats;
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
  /** §3.3: press -> the first animation frame drawn. B2 derived, lower bound
   * (the IPC hop is not counted) - see markOverlayTimings. */
  pressToFirstPaintMs: number | null;
  /** §3.3: press -> the microphone is genuinely capturing, i.e. this press's
   * buffer holds audio covering the keypress. B2 derived, same lower bound.
   * A warm microphone answers 0 through the pre-roll: the audio from before
   * the key went down was already in hand. */
  pressToFirstSampleMs: number | null;
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
  const paintAt = findMark(trace, "overlayFirstPaint");
  const sampleAt = findMark(trace, "overlayFirstSample");

  const verdictLatencyMs = keyAt !== null && verdictAt !== null ? verdictAt - keyAt : null;
  const keyToOverlayOrderMs = keyAt !== null && overlayStartAt !== null ? overlayStartAt - keyAt : null;
  const pressToFirstPaintMs = keyAt !== null && paintAt !== null ? paintAt - keyAt : null;
  const pressToFirstSampleMs = keyAt !== null && sampleAt !== null ? sampleAt - keyAt : null;
  const transcriptionMs = transStartAt !== null && transEndAt !== null ? transEndAt - transStartAt : null;
  const releaseToTextMs = releaseAt !== null && textAt !== null ? textAt - releaseAt : null;
  // 2026-07-30: there used to be TWO model times to deduct here - the
  // transcription, and a voice function that could rewrite the transcript. Voice
  // functions are gone, so only one remains. Kept as a named `modelMs` rather
  // than inlining `transcriptionMs`, because the distinction this line draws is
  // the point of the budget: it measures FLOW's plumbing, never how long
  // somebody else's model thought.
  const modelMs = transcriptionMs ?? 0;
  const releaseToTextExclModelMs = releaseToTextMs !== null ? releaseToTextMs - modelMs : null;
  const totalPressToTextMs = keyAt !== null && textAt !== null ? textAt - keyAt : null;

  return {
    verdictLatencyMs,
    keyToOverlayOrderMs,
    pressToFirstPaintMs,
    pressToFirstSampleMs,
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
  measurable: boolean; // false = this app cannot produce this number at all
}

/** One row per §3.3 budget.
 *
 * All four rows are measurable since B2: the two the main process cannot see
 * on its own (first painted frame, first captured sample) are answered by the
 * overlay renderer and folded in by markOverlayTimings. `measurable` stays in
 * the shape rather than being deleted, because it is the field that lets a
 * consumer tell "Flow cannot answer this" apart from "no press has produced
 * this number yet" (valueMs === null) - two different sentences to show a
 * user, and the panel shows both. */
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
      valueMs: iv.pressToFirstPaintMs,
      withinBudget:
        iv.pressToFirstPaintMs === null ? null : iv.pressToFirstPaintMs < HOTPATH_BUDGETS_MS.animationFirstFrame,
      measurable: true,
    },
    {
      metric: "press -> microphone actually capturing",
      budgetMs: HOTPATH_BUDGETS_MS.micCapturing,
      valueMs: iv.pressToFirstSampleMs,
      withinBudget:
        iv.pressToFirstSampleMs === null ? null : iv.pressToFirstSampleMs < HOTPATH_BUDGETS_MS.micCapturing,
      measurable: true,
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

// ---- B11: event-loop lag statistics and the T1 trigger ----

/** The threshold that reopens B7 (plan §3.6.6, trigger T1), written in code so
 * the panel, the CLI and any future automated check read ONE number.
 *
 * 100 ms is a third of the tightest `LowLevelHooksTimeout` in practical use
 * (the registry default is 300 ms in older setups; Windows 10 1709 and later
 * cap the effective value at 1000 ms). A loop that is a third of the budget
 * behind BEFORE our handler is even called is a loop that gives Windows a real
 * reason to remove the hook - and Microsoft documents that it removes it
 * silently, with no way for the application to find out. This is therefore a
 * TRIGGER, not a budget: crossing it does not mean dictation broke, it means
 * the no-go of §3.6.5 has to be re-argued on new numbers. */
export const LOOP_LAG_P99_THRESHOLD_MS = 100;

export interface LoopLagStats {
  count: number;
  /** The SMALLEST lag observed, which on Windows is not zero and is not a
   * defect: the system timer's default granularity is 15.625 ms, so a 20 ms
   * interval is served at the next grid point, 31.25 ms later, and every single
   * sample carries 11.25 ms of quantization that has nothing to do with a
   * blocked loop. Measured on this machine at exactly that: a p50 of 11.0 to
   * 11.2 ms on a completely idle process. Reported so a reader can subtract the
   * instrument from the measurement instead of reading its floor as lag - and
   * so the day the floor changes (Chromium raises the process timer resolution
   * to 1 ms when it has work) that shows up as a fact rather than as a mystery.
   * It is far below the 100 ms trigger either way. */
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** p99 strictly over LOOP_LAG_P99_THRESHOLD_MS. Null when there is nothing to
   * judge, which a consumer must show differently from "false" - "no data yet"
   * and "measured, and fine" are two very different sentences. */
  overThreshold: boolean | null;
}

export function summarizeLoopLag(values: number[]): LoopLagStats {
  const clean = values.filter((v) => Number.isFinite(v));
  const p99 = percentile(clean, 99);
  return {
    count: clean.length,
    minMs: clean.length ? Math.min(...clean) : null,
    p50Ms: percentile(clean, 50),
    p95Ms: percentile(clean, 95),
    p99Ms: p99,
    maxMs: clean.length ? Math.max(...clean) : null,
    overThreshold: p99 === null ? null : p99 > LOOP_LAG_P99_THRESHOLD_MS,
  };
}
