import test from "node:test";
import assert from "node:assert/strict";
import {
  HotpathLog,
  Ring,
  computeIntervals,
  evaluateBudgets,
  percentile,
  median,
  summarize,
  summarizeLoopLag,
  HOTPATH_ABANDON_REASON,
  HOTPATH_BUDGETS_MS,
  LOOP_LAG_P99_THRESHOLD_MS,
  type HotpathTrace,
} from "../src/shared/hotpath";
import { SILENT_FAILURE, silentFailures } from "../src/shared/silentFailures";

// ---- Ring ----

test("Ring never grows past capacity and overwrites the oldest entry", () => {
  const r = new Ring<number>(3);
  r.push(1);
  r.push(2);
  r.push(3);
  assert.deepEqual(r.toArray(), [1, 2, 3]);
  r.push(4); // evicts 1
  assert.equal(r.size, 3);
  assert.deepEqual(r.toArray(), [2, 3, 4]);
  r.push(5);
  r.push(6);
  assert.deepEqual(r.toArray(), [4, 5, 6]);
});

test("Ring.clear empties it without changing capacity", () => {
  const r = new Ring<number>(2);
  r.push(1);
  r.push(2);
  r.clear();
  assert.equal(r.size, 0);
  assert.deepEqual(r.toArray(), []);
  r.push(9);
  assert.deepEqual(r.toArray(), [9]);
});

// ---- HotpathLog: basic lifecycle ----

test("a full completed trace records every step in order and closes as completed", () => {
  const log = new HotpathLog();
  let t = 1000;
  log.mark("keyEventReceived", t);
  log.mark("verdictRendered", (t += 0.2));
  log.mark("captureStartDecided", (t += 0.1));
  log.mark("overlayStartSent", (t += 0.3));
  log.mark("releaseObserved", (t += 250));
  log.mark("overlayStopSent", (t += 0.2));
  log.markWavReceived(250, (t += 5));
  log.mark("transcriptionStarted", (t += 1));
  log.mark("transcriptionFinished", (t += 180));
  log.mark("focusProbed", (t += 8));
  log.mark("routeDecided", (t += 0.1));
  log.complete("inserted", 42, (t += 6));

  const snap = log.snapshot();
  assert.equal(snap.completed.length, 1);
  assert.equal(snap.open.length, 0);
  const trace = snap.completed[0];
  assert.equal(trace.outcome, "completed");
  assert.equal(trace.result, "inserted");
  assert.equal(trace.textChars, 42);
  assert.equal(trace.utteranceMs, 250);
  assert.equal(trace.marks.at(-1)?.step, "textInserted");
  assert.equal(trace.marks.length, 12); // every named step above, once each
});

test("a short tap is recorded as an abandoned trace with the right reason", () => {
  const log = new HotpathLog();
  let t = 0;
  log.mark("keyEventReceived", t);
  log.mark("verdictRendered", (t += 0.1));
  log.mark("captureStartDecided", (t += 0.1));
  log.mark("overlayStartSent", (t += 0.2));
  log.mark("releaseObserved", (t += 120)); // < MIN_HOLD_MS
  log.mark("overlayCancelSent", (t += 0.1));
  log.abandon(HOTPATH_ABANDON_REASON.shortTap, (t += 0.1));

  const snap = log.snapshot();
  assert.equal(snap.completed.length, 1);
  const trace = snap.completed[0];
  assert.equal(trace.outcome, "abandoned");
  assert.equal(trace.reason, "short-tap");
  assert.equal(trace.result, undefined);
  // No textInserted mark exists for an abandoned trace.
  assert.ok(!trace.marks.some((m) => m.step === "textInserted"));
});

test("a refused press (busy) opens and is immediately abandoned, never lingering open", () => {
  const log = new HotpathLog();
  log.mark("keyEventReceived", 0);
  log.mark("verdictRendered", 0.1);
  // captureStartDecided never marked: index.ts's onStart bailed on longRec.isBusy.
  log.abandon(HOTPATH_ABANDON_REASON.busyLongRecording, 1);
  const snap = log.snapshot();
  assert.equal(snap.open.length, 0);
  assert.equal(snap.completed.length, 1);
  assert.equal(snap.completed[0].reason, "busy-long-recording");
});

test("mark() for a step with no correlated open trace is a silent no-op, never throws", () => {
  const log = new HotpathLog();
  assert.doesNotThrow(() => log.mark("focusProbed", 5));
  assert.doesNotThrow(() => log.markWavReceived(300, 6));
  assert.doesNotThrow(() => log.complete("inserted", 3, 7));
  assert.doesNotThrow(() => log.abandon(HOTPATH_ABANDON_REASON.pipelineError, 8));
  const snap = log.snapshot();
  assert.equal(snap.completed.length, 0);
  assert.equal(snap.open.length, 0);
});

// ---- overlap: a new press starts before the previous utterance's pipeline finished ----

test("two overlapping presses correlate FIFO-by-age: the older trace gets the next arriving mark", () => {
  const log = new HotpathLog();
  // Press A: full start sequence.
  log.mark("keyEventReceived", 0);
  log.mark("verdictRendered", 0.1);
  log.mark("captureStartDecided", 0.2);
  log.mark("overlayStartSent", 0.3);
  log.mark("releaseObserved", 100);
  log.mark("overlayStopSent", 100.1);
  // Press B starts (hands-free / a fast re-press) BEFORE A's WAV has arrived.
  log.mark("keyEventReceived", 100.2);
  log.mark("verdictRendered", 100.3);
  log.mark("captureStartDecided", 100.4);
  log.mark("overlayStartSent", 100.5);

  assert.equal(log.snapshot().open.length, 2);

  // A's WAV arrives: must attach to A (the oldest trace still missing wavReceived).
  // Both traces stay OPEN here - wavReceived only appends a mark, it does not
  // close anything; only complete()/abandon() do.
  log.markWavReceived(100, 105);
  const midSnap = log.snapshot();
  assert.equal(midSnap.open.length, 2, "wavReceived does not close a trace by itself");
  const withWav = midSnap.open.find((tr) => tr.marks.some((m) => m.step === "wavReceived"));
  const withoutWav = midSnap.open.find((tr) => !tr.marks.some((m) => m.step === "wavReceived"));
  assert.ok(withWav, "the older trace (A) must have received the WAV mark");
  assert.ok(withoutWav, "the newer trace (B) must not have");
  assert.equal(withWav?.utteranceMs, 100);

  // Finish A.
  log.mark("transcriptionStarted", 106);
  log.mark("transcriptionFinished", 200);
  log.mark("focusProbed", 205);
  log.mark("routeDecided", 205.1);
  log.complete("inserted", 10, 210);

  const snap = log.snapshot();
  assert.equal(snap.completed.length, 1);
  assert.equal(snap.open.length, 1, "B is still open, waiting on its own release");
  assert.equal(snap.completed[0].utteranceMs, 100);
});

// ---- constat 1 (adverse review V2): abandon() must close the RIGHT press ----

const KEYBOARD_REASONS = [
  HOTPATH_ABANDON_REASON.shortTap,
  HOTPATH_ABANDON_REASON.extraKey,
  HOTPATH_ABANDON_REASON.shortcutRecorder,
  HOTPATH_ABANDON_REASON.comboChanged,
  HOTPATH_ABANDON_REASON.paused,
  HOTPATH_ABANDON_REASON.busyLongRecording,
  HOTPATH_ABANDON_REASON.hookDied,
  HOTPATH_ABANDON_REASON.captureError,
] as const;

const WAV_REASONS = [
  HOTPATH_ABANDON_REASON.tooShortClip,
  HOTPATH_ABANDON_REASON.noSpeech,
  HOTPATH_ABANDON_REASON.hallucinationGate,
  HOTPATH_ABANDON_REASON.pipelineError,
] as const;

for (const reason of KEYBOARD_REASONS) {
  test(`constat 1: abandon("${reason}") closes the trace the keyboard just opened, not an older still-finishing one`, () => {
    const log = new HotpathLog();
    // Press A: opened earlier, already past capture, still finishing its OWN
    // async pipeline (transcribe/probe/insert) - a live, unrelated trace.
    log.mark("keyEventReceived", 0);
    log.mark("verdictRendered", 0.1);
    log.mark("captureStartDecided", 0.2);
    log.mark("overlayStartSent", 0.3);
    log.mark("releaseObserved", 50);
    log.markWavReceived(50, 55);
    log.mark("transcriptionStarted", 56);
    // Press B: opens WHILE A is still finishing, then earns `reason`.
    log.mark("keyEventReceived", 100);
    log.abandon(reason, 101);

    const snap = log.snapshot();
    assert.equal(snap.completed.length, 1, "exactly B closed");
    assert.equal(snap.completed[0].reason, reason);
    assert.equal(snap.completed[0].marks[0].t, 100, "B, not A, was closed");
    assert.equal(snap.open.length, 1, "A is still open, mid-pipeline");
    assert.equal(snap.open[0].marks[0].t, 0, "A is untouched");
  });
}

for (const reason of WAV_REASONS) {
  test(`constat 1: abandon("${reason}") still closes the OLDEST open trace (the one its WAV already attached to)`, () => {
    const log = new HotpathLog();
    // Press A: its WAV already arrived - this reason is a verdict about IT.
    log.mark("keyEventReceived", 0);
    log.markWavReceived(400, 10);
    // Press B: opened after A's WAV, still just a bare press.
    log.mark("keyEventReceived", 20);
    log.abandon(reason, 30);

    const snap = log.snapshot();
    assert.equal(snap.completed.length, 1);
    assert.equal(snap.completed[0].reason, reason);
    assert.equal(snap.completed[0].marks[0].t, 0, "A, the trace its WAV belongs to, was closed");
    assert.equal(snap.open.length, 1);
    assert.equal(snap.open[0].marks[0].t, 20, "B is untouched");
  });
}

test("constat 1 repro: a fast short tap while the previous dictation is still transcribing closes on the SHORT TAP, not the dictation", () => {
  const log = new HotpathLog();
  // The previous dictation: captured, transcribing...
  log.mark("keyEventReceived", 0);
  log.mark("verdictRendered", 0.1);
  log.mark("captureStartDecided", 0.2);
  log.mark("overlayStartSent", 0.3);
  log.mark("releaseObserved", 400);
  log.mark("overlayStopSent", 400.1);
  log.markWavReceived(400, 405);
  log.mark("transcriptionStarted", 406); // still running when B happens

  // A fast, accidental tap right after: opens and releases under MIN_HOLD_MS.
  log.mark("keyEventReceived", 410);
  log.mark("verdictRendered", 410.1);
  log.mark("overlayCancelSent", 415);
  log.abandon(HOTPATH_ABANDON_REASON.shortTap, 415.1);

  const snap = log.snapshot();
  assert.equal(snap.completed.length, 1);
  assert.equal(snap.completed[0].reason, "short-tap");
  assert.equal(snap.completed[0].marks[0].t, 410, "the short tap closed, not the dictation still transcribing");
  assert.equal(snap.open.length, 1, "the real dictation is still open, waiting on its own completion");
  assert.equal(snap.open[0].marks[0].t, 0);

  // The real dictation then finishes normally and closes on ITSELF.
  log.mark("transcriptionFinished", 600);
  log.mark("focusProbed", 605);
  log.mark("routeDecided", 605.1);
  log.complete("inserted", 12, 610);
  const finalSnap = log.snapshot();
  assert.equal(finalSnap.completed.length, 2);
  assert.equal(finalSnap.open.length, 0);
  const dictation = finalSnap.completed.find((t) => t.outcome === "completed");
  assert.equal(dictation?.marks[0].t, 0, "the completed trace is the ORIGINAL dictation, correctly correlated");
});

// ---- bounded growth ----

test("the completed ring never exceeds its capacity across many traces", () => {
  const log = new HotpathLog(5, 50);
  for (let i = 0; i < 20; i++) {
    const base = i * 10;
    log.mark("keyEventReceived", base);
    log.abandon(HOTPATH_ABANDON_REASON.shortTap, base + 1);
  }
  assert.equal(log.snapshot().completed.length, 5);
});

test("the open queue is capped: a run of never-resolving presses does not grow without bound", () => {
  const log = new HotpathLog(50, 50);
  for (let i = 0; i < 20; i++) {
    log.mark("keyEventReceived", i * 100); // never followed by a resolving call
  }
  const snap = log.snapshot();
  assert.ok(snap.open.length <= 8, "open queue must respect its defensive cap");
  // The evicted ones must have been filed as completed (abandoned), not lost silently.
  assert.ok(snap.completed.some((t) => t.reason === "open-queue-full"));
});

test("a trace stuck open past the staleness ceiling is swept the next time any mark() runs", () => {
  const log = new HotpathLog();
  log.mark("keyEventReceived", 0);
  // 40 s later, unrelated activity runs sweepStale() as a side effect.
  log.mark("keyEventReceived", 40_000);
  const snap = log.snapshot();
  assert.equal(snap.open.length, 1, "only the second (fresh) press should still be open");
  assert.equal(snap.completed.length, 1);
  assert.equal(snap.completed[0].reason, "stale-timeout");
});

// ---- snapshot() returns a defensive copy ----

test("mutating a snapshot never corrupts the log's internal state", () => {
  const log = new HotpathLog();
  log.mark("keyEventReceived", 0);
  log.abandon(HOTPATH_ABANDON_REASON.shortTap, 1);
  const snap1 = log.snapshot();
  snap1.completed[0].marks.push({ step: "textInserted", t: 999 });
  (snap1.completed[0] as { reason?: string }).reason = "tampered";
  const snap2 = log.snapshot();
  assert.equal(snap2.completed[0].marks.length, 1);
  assert.equal(snap2.completed[0].reason, "short-tap");
});

// ---- B6: silent-failure counters ride the SAME snapshot/channel ----

test("snapshot() carries silentFailureCounts with every closed-vocabulary name present", () => {
  silentFailures.clear();
  const log = new HotpathLog();
  const snap = log.snapshot();
  for (const name of Object.values(SILENT_FAILURE)) {
    assert.equal(snap.silentFailureCounts[name], 0, `${name} must be present, even at 0`);
  }
});

test("snapshot() reflects increments made through the shared silentFailures singleton", () => {
  silentFailures.clear();
  silentFailures.increment(SILENT_FAILURE.overlaySendFailed);
  silentFailures.increment(SILENT_FAILURE.overlaySendFailed);
  const log = new HotpathLog();
  const snap = log.snapshot();
  assert.equal(snap.silentFailureCounts[SILENT_FAILURE.overlaySendFailed], 2);
  silentFailures.clear();
});

// ---- zero-retention shape check ----

test("a trace object never carries a dictated-text field, only counts", () => {
  const log = new HotpathLog();
  log.mark("keyEventReceived", 0);
  log.complete("inserted", 12, 1);
  const trace = log.snapshot().completed[0];
  const keys = Object.keys(trace);
  for (const k of keys) {
    assert.doesNotMatch(k.toLowerCase(), /^text$|content|transcript|utterancetext/);
  }
  assert.equal(typeof trace.textChars, "number");
});

// ---- computeIntervals / evaluateBudgets ----

function traceWithMarks(pairs: Array<[HotpathTrace["marks"][number]["step"], number]>): HotpathTrace {
  return {
    id: 1,
    outcome: "completed",
    result: "inserted",
    marks: pairs.map(([step, t]) => ({ step, t })),
  };
}

test("computeIntervals derives every named interval from marks by simple subtraction", () => {
  const trace = traceWithMarks([
    ["keyEventReceived", 0],
    ["verdictRendered", 0.5],
    ["overlayStartSent", 1],
    ["releaseObserved", 300],
    ["transcriptionStarted", 305],
    ["transcriptionFinished", 480],
    ["textInserted", 486],
  ]);
  const iv = computeIntervals(trace);
  assert.equal(iv.verdictLatencyMs, 0.5);
  assert.equal(iv.keyToOverlayOrderMs, 1);
  assert.equal(iv.transcriptionMs, 175);
  assert.equal(iv.releaseToTextMs, 186);
  assert.equal(iv.releaseToTextExclModelMs, 11); // 186 - 175
  assert.equal(iv.totalPressToTextMs, 486);
});

test("computeIntervals returns null for any interval whose marks are missing", () => {
  const trace = traceWithMarks([["keyEventReceived", 0]]);
  const iv = computeIntervals(trace);
  assert.equal(iv.verdictLatencyMs, null);
  assert.equal(iv.keyToOverlayOrderMs, null);
  assert.equal(iv.transcriptionMs, null);
  assert.equal(iv.releaseToTextMs, null);
  assert.equal(iv.totalPressToTextMs, null);
});

// B2 replaced B1's "these two can never be answered" with "the overlay answers
// them". The row shape is unchanged on purpose - a consumer must still be able
// to tell "no press has produced this yet" (valueMs === null) apart from "Flow
// cannot produce this at all" (measurable === false).
test("evaluateBudgets: the two overlay rows are measurable but valueless until a press reports them", () => {
  const trace = traceWithMarks([["keyEventReceived", 0]]);
  const rows = evaluateBudgets(trace);
  const paintRow = rows.find((r) => r.metric.includes("animation frame"));
  const micRow = rows.find((r) => r.metric.includes("microphone actually"));
  assert.ok(paintRow && paintRow.measurable && paintRow.valueMs === null && paintRow.withinBudget === null);
  assert.ok(micRow && micRow.measurable && micRow.valueMs === null && micRow.withinBudget === null);
});

test("evaluateBudgets judges the two overlay rows against their §3.3 budgets once reported", () => {
  const rows = evaluateBudgets(
    traceWithMarks([
      ["keyEventReceived", 0],
      ["overlayFirstPaint", 20], // under 50 ms
      ["overlayFirstSample", 300], // way over 80 ms: a cold microphone
    ]),
  );
  assert.equal(rows.find((r) => r.metric.includes("animation frame"))?.withinBudget, true);
  assert.equal(rows.find((r) => r.metric.includes("microphone actually"))?.withinBudget, false);
});

// ---- B2: folding the overlay renderer's two durations into a trace ----

function openTraceWithOverlaySend(log: HotpathLog, sentAt = 5): void {
  log.mark("keyEventReceived", 0);
  log.mark("verdictRendered", 0.2);
  log.mark("captureStartDecided", 0.3);
  log.mark("overlayStartSent", sentAt);
}

test("markOverlayTimings derives both marks by ADDING durations to overlayStartSent", () => {
  const log = new HotpathLog();
  openTraceWithOverlaySend(log, 5);
  // The renderer's own clock said: 12 ms to the first painted frame, 0 ms to
  // having audio that covers the keypress (a warm microphone with a pre-roll).
  log.markOverlayTimings(12, 0);
  const iv = computeIntervals(log.snapshot().open[0]);
  assert.equal(iv.pressToFirstPaintMs, 17, "5 (main's own instant) + 12 (the renderer's duration)");
  assert.equal(iv.pressToFirstSampleMs, 5, "a warm mic: nothing was lost, the press instant is covered");
});

test("markOverlayTimings shows a COLD press for what it is", () => {
  const log = new HotpathLog();
  openTraceWithOverlaySend(log, 4);
  log.markOverlayTimings(18, 260); // getUserMedia + AudioContext + worklet compile
  const iv = computeIntervals(log.snapshot().open[0]);
  assert.equal(iv.pressToFirstSampleMs, 264);
  const micRow = evaluateBudgets(log.snapshot().open[0]).find((r) => r.metric.includes("microphone actually"));
  assert.equal(micRow?.withinBudget, false, "264 ms is where the lost first words live");
});

test("markOverlayTimings refuses values that are not plain, sane durations", () => {
  for (const [paint, sample] of [
    [NaN, 5],
    [5, NaN],
    [-1, 5],
    [5, -1],
    [Infinity, 5],
    [5, 10 * 60_000], // ten minutes: not a slow machine, a corrupt number
  ]) {
    const log = new HotpathLog();
    openTraceWithOverlaySend(log);
    log.markOverlayTimings(paint, sample);
    const iv = computeIntervals(log.snapshot().open[0]);
    assert.equal(iv.pressToFirstPaintMs, null, `accepted paint=${paint} sample=${sample}`);
    assert.equal(iv.pressToFirstSampleMs, null, `accepted paint=${paint} sample=${sample}`);
  }
});

test("markOverlayTimings is a no-op when the press never reached the overlay", () => {
  const log = new HotpathLog();
  log.mark("keyEventReceived", 0);
  log.mark("verdictRendered", 0.2); // no overlayStartSent: nothing to add the durations to
  assert.doesNotThrow(() => log.markOverlayTimings(10, 10));
  const iv = computeIntervals(log.snapshot().open[0]);
  assert.equal(iv.pressToFirstPaintMs, null);
});

test("markOverlayTimings on a closed/absent trace is dropped, never mis-attributed", () => {
  const log = new HotpathLog();
  openTraceWithOverlaySend(log);
  log.abandon(HOTPATH_ABANDON_REASON.busyLongRecording, 6); // a refused press, closed at once
  assert.doesNotThrow(() => log.markOverlayTimings(10, 10));
  const trace = log.snapshot().completed[0];
  assert.ok(!trace.marks.some((m) => m.step === "overlayFirstPaint"));
});

test("markOverlayTimings lands on the OLDEST trace still missing it, like every other mark", () => {
  const log = new HotpathLog();
  openTraceWithOverlaySend(log, 5); // press A
  log.mark("keyEventReceived", 100);
  log.mark("overlayStartSent", 105); // press B
  log.markOverlayTimings(10, 0); // A's
  log.markOverlayTimings(20, 0); // B's
  const [a, b] = log.snapshot().open;
  assert.equal(computeIntervals(a).pressToFirstPaintMs, 15, "5 + 10, measured from A's own press");
  assert.equal(computeIntervals(b).pressToFirstPaintMs, 25, "(105 + 20) - 100");
});

test("evaluateBudgets flags a within-budget and an over-budget trace correctly", () => {
  const fast = traceWithMarks([
    ["keyEventReceived", 0],
    ["overlayStartSent", 5], // well under 30 ms
    ["releaseObserved", 100],
    ["transcriptionStarted", 105],
    ["transcriptionFinished", 200],
    ["textInserted", 210], // release->text excl model = (210-100) - 95 = 15 ms, under 60
  ]);
  const fastRows = evaluateBudgets(fast);
  assert.equal(fastRows.find((r) => r.metric.startsWith("press -> cue"))?.withinBudget, true);
  assert.equal(fastRows.find((r) => r.metric.startsWith("release"))?.withinBudget, true);

  const slow = traceWithMarks([
    ["keyEventReceived", 0],
    ["overlayStartSent", 45], // over 30 ms
    ["releaseObserved", 100],
    ["transcriptionStarted", 105],
    ["transcriptionFinished", 200],
    ["textInserted", 300], // release->text excl model = (300-100) - 95 = 105 ms, over 60
  ]);
  const slowRows = evaluateBudgets(slow);
  assert.equal(slowRows.find((r) => r.metric.startsWith("press -> cue"))?.withinBudget, false);
  assert.equal(slowRows.find((r) => r.metric.startsWith("release"))?.withinBudget, false);
});

test("HOTPATH_BUDGETS_MS matches the plan's §3.3 numbers", () => {
  assert.equal(HOTPATH_BUDGETS_MS.cueAudible, 30);
  assert.equal(HOTPATH_BUDGETS_MS.animationFirstFrame, 50);
  assert.equal(HOTPATH_BUDGETS_MS.micCapturing, 80);
  assert.equal(HOTPATH_BUDGETS_MS.releaseToTextExclModel, 60);
});

// ---- statistics ----

test("percentile: median of an odd-length array is the middle element", () => {
  assert.equal(median([1, 2, 3]), 2);
});

test("percentile: interpolates between the two nearest ranks", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  const p95 = percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95);
  assert.ok(p95 !== null && Math.abs(p95 - 9.55) < 1e-9, `expected ~9.55, got ${p95}`);
});

test("percentile and summarize ignore non-finite values and handle an empty array", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(median([NaN, Infinity]), null);
  const s = summarize([5, NaN, 1, 3]);
  assert.equal(s.count, 3);
  assert.equal(s.medianMs, 3);
  assert.equal(s.maxMs, 5);
});

// ---- B11: event-loop lag storage and the T1 threshold ----

test("the loop-lag ring is bounded like every other ring here", () => {
  const log = new HotpathLog(5, 5, 5, 3);
  for (let i = 1; i <= 10; i++) log.sampleLoopLag(i);
  const stats = log.snapshot().loopLag;
  assert.equal(stats.count, 3, "only the last 3 samples may survive");
  assert.equal(stats.maxMs, 10);
});

test("snapshot() carries loop-lag STATISTICS, never the raw ring", () => {
  // The ring fills at up to 50 samples/s; shipping it raw would push tens of
  // kilobytes of JSON through the IPC channel every two seconds, on the very
  // event loop these numbers exist to prove is free.
  const log = new HotpathLog();
  for (let i = 0; i < 100; i++) log.sampleLoopLag(i % 10);
  const snap = log.snapshot() as unknown as Record<string, unknown>;
  assert.equal(Array.isArray(snap.loopLag), false);
  assert.equal(typeof (snap.loopLag as { count: number }).count, "number");
  for (const key of Object.keys(snap)) {
    assert.notEqual(key, "loopLagMs", "the raw lag array must not ride the snapshot");
  }
});

test("summarizeLoopLag reports floor/p50/p95/p99/max over the samples it was given", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const s = summarizeLoopLag(values);
  assert.equal(s.count, 100);
  assert.equal(s.minMs, 1);
  assert.equal(s.p50Ms, 50.5);
  assert.equal(s.p95Ms, 95.05);
  assert.equal(s.p99Ms, 99.01);
  assert.equal(s.maxMs, 100);
});

test("the floor is reported so the instrument can be subtracted from the measurement", () => {
  // Windows serves a 20 ms interval on its 15.625 ms grid, so every sample of a
  // perfectly idle loop carries ~11.25 ms that is granularity, not blocking.
  // Measured on this machine at a p50 of 11.0-11.2 ms with no load at all. A
  // panel that showed only p50 would report a permanently late loop.
  const quantized = [11.2, 11.3, 11.2, 11.4, 11.2];
  const s = summarizeLoopLag(quantized);
  assert.equal(s.minMs, 11.2);
  assert.equal(s.overThreshold, false, "a granularity floor must never trip the trigger");
});

test("summarizeLoopLag tells 'nothing measured yet' apart from 'measured, and fine'", () => {
  const empty = summarizeLoopLag([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.p99Ms, null);
  assert.equal(empty.overThreshold, null, "no data is not the same sentence as no problem");

  const quiet = summarizeLoopLag([0, 0.2, 1, 2]);
  assert.equal(quiet.overThreshold, false);
});

test("the T1 trigger fires strictly above the threshold, not at it", () => {
  // 100 ms is a third of the tightest LowLevelHooksTimeout (plan §3.6.6). A
  // reading exactly at the threshold is not yet the event that reopens B7.
  const at = summarizeLoopLag(new Array(100).fill(LOOP_LAG_P99_THRESHOLD_MS));
  assert.equal(at.p99Ms, LOOP_LAG_P99_THRESHOLD_MS);
  assert.equal(at.overThreshold, false);

  const over = summarizeLoopLag(new Array(100).fill(LOOP_LAG_P99_THRESHOLD_MS + 1));
  assert.equal(over.overThreshold, true);
});

test("ONE stall does not trip the trigger, but it is never hidden either", () => {
  // Worth pinning down, because it is the difference between a trigger and an
  // alarm. percentile() interpolates, so a single 450 ms stall among 99 quiet
  // samples lands the p99 between the two neighbouring ranks and stays low. A
  // trigger that reopens a months-long architecture decision SHOULD need more
  // than one hiccup - and the hiccup is still there in plain sight, as maxMs.
  const s = summarizeLoopLag([...new Array(99).fill(0.3), 450]);
  assert.equal(s.p50Ms, 0.3);
  assert.equal(s.maxMs, 450, "the worst case is always reported, whatever the percentiles say");
  assert.equal(s.overThreshold, false);
});

test("a loop that stalls REPEATEDLY trips the trigger, which is the point", () => {
  const s = summarizeLoopLag([...new Array(98).fill(0.3), 450, 450]);
  assert.equal(s.p99Ms, 450);
  assert.equal(s.overThreshold, true);
});

test("LOOP_LAG_P99_THRESHOLD_MS matches the plan's §3.6.6 number", () => {
  assert.equal(LOOP_LAG_P99_THRESHOLD_MS, 100);
});

test("loop-lag statistics carry numbers only, never anything dictated", () => {
  const log = new HotpathLog();
  log.sampleLoopLag(12.5);
  const stats = log.snapshot().loopLag;
  for (const [key, value] of Object.entries(stats)) {
    assert.ok(
      value === null || typeof value === "number" || typeof value === "boolean",
      `${key} must be a number, a boolean or null`,
    );
  }
});

test("summarize reports count/median/p95/max together", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const s = summarize(values);
  assert.equal(s.count, 100);
  assert.equal(s.medianMs, 50.5);
  assert.equal(s.p95Ms, 95.05);
  assert.equal(s.maxMs, 100);
});
