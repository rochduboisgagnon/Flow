import test from "node:test";
import assert from "node:assert/strict";
import { LogQueue, LOG_QUEUE_FAILURE, type LogQueueFailure, type LogSink } from "../src/shared/logQueue";

// B4b: the property under test is not "it writes a log". It is that the write
// NEVER happens on the caller's stack (that stack is the keyboard hook's), that
// no line is lost or reordered on the way, and that quitting hands back whatever
// is still buffered. So the sink below is fully manual: nothing it is asked to
// do happens until the test says so, which is the only way to observe ordering.

interface Recorded {
  writes: string[]; // one entry per append, in the order the sink received them
  sync: string[]; // appendSync only
}

class FakeSink implements LogSink {
  readonly rec: Recorded = { writes: [], sync: [] };
  /** Pending schedule() callbacks: the test decides when a "later tick" happens. */
  scheduled: Array<() => void> = [];
  /** Pending append completions, in arrival order. */
  private completions: Array<(err?: unknown) => void> = [];
  fileSize: number | null = null;
  rotations = 0;
  failNextAppend = false;
  throwOnRotate = false;
  throwOnSize = false;
  throwOnAppendSync = false;
  /** Set by append(): proves nothing blocked the caller. */
  appendCalls = 0;

  append(text: string, done: (err?: unknown) => void): void {
    this.appendCalls++;
    this.rec.writes.push(text);
    const fail = this.failNextAppend;
    this.failNextAppend = false;
    this.completions.push(() => done(fail ? new Error("disk full") : undefined));
  }
  appendSync(text: string): void {
    if (this.throwOnAppendSync) throw new Error("disk full");
    this.rec.writes.push(text);
    this.rec.sync.push(text);
  }
  size(): number | null {
    if (this.throwOnSize) throw new Error("no such file");
    return this.fileSize;
  }
  rotate(): void {
    if (this.throwOnRotate) throw new Error("locked by another process");
    this.rotations++;
    this.fileSize = 0;
  }
  schedule(fn: () => void): void {
    this.scheduled.push(fn);
  }

  /** Run every scheduled tick that exists right now (not the ones they create). */
  runScheduled(): void {
    const due = this.scheduled;
    this.scheduled = [];
    for (const fn of due) fn();
  }
  /** Complete the oldest outstanding append. */
  completeOne(): void {
    const next = this.completions.shift();
    assert.ok(next, "expected an append to be in flight");
    next();
  }
  completeAll(): void {
    while (this.completions.length) this.completeOne();
  }
  get inFlightCount(): number {
    return this.completions.length;
  }
  /** Everything the sink has been asked to write, as individual lines. */
  lines(): string[] {
    return this.rec.writes
      .join("")
      .split("\n")
      .filter((l) => l.length > 0);
  }
}

function drainFully(sink: FakeSink): void {
  // A drain schedules the next one only after its append completes, so the two
  // have to be pumped together until nothing is left.
  for (let i = 0; i < 100; i++) {
    if (!sink.scheduled.length && !sink.inFlightCount) return;
    sink.runScheduled();
    sink.completeAll();
  }
  throw new Error("the queue never settled");
}

// ---- the whole point: push() does no I/O ----

test("B4b: push() never touches the sink - the hot path pays for an array push, nothing else", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  for (let i = 0; i < 500; i++) q.push(`line ${i}\n`);
  assert.equal(sink.appendCalls, 0, "no write may happen on the caller's stack");
  assert.equal(sink.rec.writes.length, 0);
  assert.equal(sink.rotations, 0);
  assert.equal(q.pendingCount(), 500);
  // And one single scheduled drain for the whole burst, not 500 of them.
  assert.equal(sink.scheduled.length, 1);
});

test("B4b: the write happens on a LATER tick, and only then", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  q.push("a\n");
  assert.equal(sink.appendCalls, 0);
  sink.runScheduled();
  assert.equal(sink.appendCalls, 1);
  assert.deepEqual(sink.lines(), ["a"]);
});

// ---- no loss, no reordering ----

test("B4b: every pushed line reaches the sink exactly once, in push order", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  const expected: string[] = [];
  for (let i = 0; i < 200; i++) {
    const line = `line ${i}`;
    expected.push(line);
    q.push(line + "\n");
  }
  drainFully(sink);
  assert.deepEqual(sink.lines(), expected);
});

test("B4b: lines pushed WHILE a write is in flight keep their place in the file", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  q.push("1\n");
  q.push("2\n");
  sink.runScheduled(); // chunk A = "1\n2\n" is now in flight
  assert.equal(sink.inFlightCount, 1);

  // These arrive mid-write. They must not start a second, racing append.
  q.push("3\n");
  q.push("4\n");
  sink.runScheduled();
  assert.equal(sink.appendCalls, 1, "a second concurrent append would interleave the file");

  sink.completeOne(); // A lands; the queue schedules B
  sink.runScheduled();
  assert.equal(sink.appendCalls, 2);
  sink.completeAll();
  assert.deepEqual(sink.lines(), ["1", "2", "3", "4"]);
});

test("B4b: interleaving pushes and ticks in every order still yields one ordered file", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  const expected: string[] = [];
  let n = 0;
  const pushSome = (count: number) => {
    for (let i = 0; i < count; i++) {
      const line = `l${n++}`;
      expected.push(line);
      q.push(line + "\n");
    }
  };
  pushSome(3);
  sink.runScheduled();
  pushSome(2);
  sink.completeOne();
  pushSome(4);
  sink.runScheduled();
  pushSome(1);
  drainFully(sink);
  assert.deepEqual(sink.lines(), expected);
  assert.equal(q.pendingCount(), 0);
});

// ---- quitting ----

test("B4b: flushSync writes everything still buffered, synchronously, with no tick", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  q.push("before quit 1\n");
  q.push("before quit 2\n");
  assert.equal(sink.rec.writes.length, 0);
  q.flushSync();
  assert.deepEqual(sink.rec.sync.length, 1, "one synchronous append, not one per line");
  assert.deepEqual(sink.lines(), ["before quit 1", "before quit 2"]);
  assert.equal(q.pendingCount(), 0);
});

test("B4b: flushSync on an empty queue writes nothing at all", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  q.flushSync();
  assert.equal(sink.rec.writes.length, 0);
});

test("B4b: flushSync does NOT rewrite a chunk already handed to the async sink", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  q.push("in flight\n");
  sink.runScheduled(); // handed to the sink, not completed
  q.push("still buffered\n");
  q.flushSync();
  // "in flight" appears once (from append), "still buffered" once (from
  // appendSync). Duplicating the in-flight chunk would be worse than the
  // theoretical loss it protects against - see flushSync's own note.
  assert.deepEqual(sink.lines(), ["in flight", "still buffered"]);
});

test("B4b: a failed synchronous flush is counted, never thrown at the quit handler", () => {
  const seen: LogQueueFailure[] = [];
  const sink = new FakeSink();
  sink.throwOnAppendSync = true;
  const q = new LogQueue(sink, { onFailure: (k) => seen.push(k) });
  q.push("x\n");
  assert.doesNotThrow(() => q.flushSync());
  assert.deepEqual(seen, [LOG_QUEUE_FAILURE.append]);
});

// ---- rotation ----

test("B4b: rotation happens once per DRAIN, not once per line, and keeps its old meaning", () => {
  const sink = new FakeSink();
  sink.fileSize = 2_000_000; // already past the ceiling
  const q = new LogQueue(sink, { rotateAtBytes: 1_000_000 });
  for (let i = 0; i < 50; i++) q.push(`l${i}\n`);
  sink.runScheduled();
  assert.equal(sink.rotations, 1, "50 lines, one rotation");
  sink.completeAll();
  // Size is 0 again after the rotation: no second rotation for the next batch.
  q.push("after\n");
  drainFully(sink);
  assert.equal(sink.rotations, 1);
});

test("B4b: a file under the ceiling is never rotated", () => {
  const sink = new FakeSink();
  sink.fileSize = 10;
  const q = new LogQueue(sink, { rotateAtBytes: 1_000_000 });
  q.push("a\n");
  drainFully(sink);
  assert.equal(sink.rotations, 0);
});

test("B4b: a rotation failure is counted and never costs the append that follows it", () => {
  const seen: LogQueueFailure[] = [];
  const sink = new FakeSink();
  sink.fileSize = 2_000_000;
  sink.throwOnRotate = true;
  const q = new LogQueue(sink, { rotateAtBytes: 1_000_000, onFailure: (k) => seen.push(k) });
  q.push("kept anyway\n");
  drainFully(sink);
  assert.deepEqual(seen, [LOG_QUEUE_FAILURE.rotate]);
  assert.deepEqual(sink.lines(), ["kept anyway"]);
});

test("B4b: no log file yet (size() throws) is not a failure, and the line is still written", () => {
  const seen: LogQueueFailure[] = [];
  const sink = new FakeSink();
  sink.throwOnSize = true;
  const q = new LogQueue(sink, { onFailure: (k) => seen.push(k) });
  q.push("first line of a fresh install\n");
  drainFully(sink);
  assert.deepEqual(seen, [], "a missing file is the normal first-run case");
  assert.deepEqual(sink.lines(), ["first line of a fresh install"]);
});

// ---- failure of the write itself ----

test("B4b: a refused append is counted - the one trace a logger's own failure can leave", () => {
  const seen: LogQueueFailure[] = [];
  const sink = new FakeSink();
  const q = new LogQueue(sink, { onFailure: (k) => seen.push(k) });
  q.push("doomed\n");
  sink.failNextAppend = true;
  drainFully(sink);
  assert.deepEqual(seen, [LOG_QUEUE_FAILURE.append]);
  assert.equal(q.pendingCount(), 0, "a refused chunk is not retried forever");
});

test("B4b: a write failure does not wedge the queue - later lines still go out", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink);
  q.push("doomed\n");
  sink.failNextAppend = true;
  drainFully(sink);
  q.push("recovered\n");
  drainFully(sink);
  assert.ok(sink.lines().includes("recovered"));
});

test("B4b: a sink that calls back twice cannot start two concurrent writes", () => {
  const callbacks: Array<(err?: unknown) => void> = [];
  const writes: string[] = [];
  const sink: LogSink = {
    append(text, done) {
      writes.push(text);
      callbacks.push(done);
    },
    appendSync() {},
    size: () => null,
    rotate() {},
    schedule(fn) {
      fn(); // immediate: the worst case for re-entrancy
    },
  };
  const q = new LogQueue(sink);
  q.push("a\n");
  assert.equal(writes.length, 1);
  const done = callbacks[0];
  done();
  done(); // a buggy sink completing twice
  q.push("b\n");
  assert.deepEqual(writes, ["a\n", "b\n"], "no duplicated or interleaved write");
});

// ---- bounded memory ----

test("B4b: an unresponsive disk cannot turn the log into an unbounded memory leak", () => {
  const seen: LogQueueFailure[] = [];
  const sink = new FakeSink();
  const q = new LogQueue(sink, { maxPendingLines: 10, onFailure: (k) => seen.push(k) });
  for (let i = 0; i < 100; i++) q.push(`l${i}\n`);
  assert.equal(q.pendingCount(), 10, "the queue is capped by construction");
  assert.equal(q.droppedCount(), 90);
  assert.ok(seen.every((k) => k === LOG_QUEUE_FAILURE.overflow));
});

test("B4b: an overflow announces itself IN the log, and keeps the lines that explain it", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink, { maxPendingLines: 3 });
  q.push("cause 1\n");
  q.push("cause 2\n");
  q.push("cause 3\n");
  q.push("consequence 1\n"); // dropped
  q.push("consequence 2\n"); // dropped
  drainFully(sink);
  const lines = sink.lines();
  assert.ok(lines[0].includes("2 log line(s) were dropped"), `expected a marker first, got ${lines[0]}`);
  assert.deepEqual(lines.slice(1), ["cause 1", "cause 2", "cause 3"]);
  // The marker is emitted ONCE, not on every later drain.
  q.push("later\n");
  drainFully(sink);
  assert.deepEqual(sink.lines().slice(-1), ["later"]);
});

test("B4b: an overflow with nothing else buffered still gets its marker out", () => {
  const sink = new FakeSink();
  const q = new LogQueue(sink, { maxPendingLines: 1 });
  q.push("kept\n");
  q.push("dropped\n");
  drainFully(sink);
  assert.ok(sink.lines().some((l) => l.includes("1 log line(s) were dropped")));
});
