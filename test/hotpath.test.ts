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
  HOTPATH_ABANDON_REASON,
  HOTPATH_BUDGETS_MS,
  type HotpathTrace,
} from "../src/shared/hotpath";

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

test("evaluateBudgets: the two overlay-only rows are always measurable:false, never omitted", () => {
  const trace = traceWithMarks([["keyEventReceived", 0]]);
  const rows = evaluateBudgets(trace);
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
  const paintRow = rows.find((r) => r.metric.includes("animation frame"));
  const micRow = rows.find((r) => r.metric.includes("microphone actually"));
  assert.ok(paintRow && !paintRow.measurable && paintRow.valueMs === null && paintRow.withinBudget === null);
  assert.ok(micRow && !micRow.measurable && micRow.valueMs === null && micRow.withinBudget === null);
  void byMetric;
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

test("summarize reports count/median/p95/max together", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const s = summarize(values);
  assert.equal(s.count, 100);
  assert.equal(s.medianMs, 50.5);
  assert.equal(s.p95Ms, 95.05);
  assert.equal(s.maxMs, 100);
});
