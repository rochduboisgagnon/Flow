import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CaptureSession,
  captureDeadMessage,
  CAPTURE_START_DEADLINE_MS,
  CAPTURE_TAIL_MS,
  type CaptureTimers,
} from "../src/main/captureSession";

// U4 (review): two findings about the native capture, both of which used to end
// with the app displaying something untrue.
//
//  - BLOCKING: NativeCapture.start() is a fire-and-forget IPC send. A capture
//    window that never loaded, a renderer that crashed, a getDisplayMedia that
//    never resolved - none of them produced a single chunk, and none of them
//    produced a single word anywhere either. The engine reported an active
//    recording with a timer counting up while it captured nothing. native:ready
//    was received and deliberately ignored.
//  - MAJOR: nothing on the main side carried a session token, so a stop() tail
//    timer (or a late native:done) that fired after a NEW recording began cut
//    THAT recording short.
//
// The policy lives in the pure CaptureSession precisely so it can be tested
// here; NativeCapture owns the BrowserWindow and cannot be instantiated outside
// a real Electron process (same reason as test/ui-bridge.test.ts).

/** A hand-cranked clock: no test ever waits eight real seconds. */
class FakeTimers implements CaptureTimers {
  private queue = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  now = 0;

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.queue.delete(handle as number);
  }

  /** Move time forward, firing whatever comes due (in scheduling order). */
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.queue]) {
      if (t.at <= this.now) {
        this.queue.delete(id);
        t.fn();
      }
    }
  }

  get pending(): number {
    return this.queue.size;
  }
}

test("U4-2: a capture that never delivers audio is declared dead, with a readable reason", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  const dead: string[] = [];
  const gen = sess.start((msg) => dead.push(msg));

  timers.advance(CAPTURE_START_DEADLINE_MS - 1);
  assert.deepEqual(dead, [], "not declared dead one millisecond early");

  timers.advance(1);
  assert.equal(dead.length, 1, "the watchdog fires once the deadline passes");
  assert.equal(dead[0], captureDeadMessage(CAPTURE_START_DEADLINE_MS));
  assert.match(dead[0], /never started/, "the message says what happened, in words a user can read");
  assert.match(dead[0], /8 seconds/, "and how long Flow waited");

  // The session is closed BEFORE the callback runs, so the caller only has to
  // report: nothing late can act on it any more.
  assert.equal(sess.current(gen), false, "a dead session accepts nothing further");
  assert.equal(sess.live, false);
  assert.equal(timers.pending, 0, "and it leaves no timer behind");
});

test("U4-2: native:ready disarms the watchdog - that message is the whole point of it", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  const dead: string[] = [];
  const gen = sess.start((msg) => dead.push(msg));

  sess.prove(gen); // what ipcMain.on(NATIVE_READY) now does
  assert.equal(sess.live, true, "the session is armed: audio really is coming");
  timers.advance(CAPTURE_START_DEADLINE_MS * 10);
  assert.deepEqual(dead, [], "a proven capture is never declared dead by the clock");
  assert.equal(sess.current(gen), true, "and it is still the running session");
});

test("U4-2: the first chunk also proves the capture, even if native:ready was missed", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  const dead: string[] = [];
  const gen = sess.start((msg) => dead.push(msg));

  // A chunk handler calls prove() on every chunk; only the first one matters
  // and the rest must be free (and must not re-arm anything).
  for (let i = 0; i < 5; i++) sess.prove(gen);
  timers.advance(CAPTURE_START_DEADLINE_MS + 1);
  assert.deepEqual(dead, []);
  assert.equal(timers.pending, 0, "the watchdog was cancelled, not just ignored");
});

test("U4-2: a watchdog belongs to ITS recording - a new start cancels the previous one", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  const dead: string[] = [];
  sess.start(() => dead.push("first"));
  timers.advance(CAPTURE_START_DEADLINE_MS - 100); // nearly out of time...

  const second = sess.start(() => dead.push("second")); // ...and the user restarts
  timers.advance(200);
  assert.deepEqual(dead, [], "the first session's watchdog must not kill the second recording");

  sess.prove(second);
  timers.advance(CAPTURE_START_DEADLINE_MS * 2);
  assert.deepEqual(dead, [], "and the second one is alive and well");
});

test("U4-4: a stop tail from the previous recording cannot finalize the next one", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  const finished: number[] = [];

  const first = sess.start(() => {});
  sess.prove(first);
  // Stop it: the renderer owes us a tail slice, with a safety timer behind it.
  assert.equal(
    sess.stop(first, () => {
      if (sess.finish(first)) finished.push(first);
    }),
    true,
  );

  // The renderer never answers, and the user starts a NEW recording first.
  const second = sess.start(() => {});
  sess.prove(second);
  timers.advance(CAPTURE_TAIL_MS * 3);
  assert.deepEqual(finished, [], "the stale tail timer must not stop the recording now running");
  assert.equal(sess.current(second), true, "which is still running");

  // A late native:done from the old renderer is refused for the same reason.
  assert.equal(sess.finish(first), false, "a tail that belongs to a finished session is ignored");
  assert.equal(sess.finish(second), true, "the CURRENT session still finalizes normally");
  assert.equal(sess.current(second), false);
});

test("U4-4: the token gates chunks, failures and the tail alike", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });

  const first = sess.start(() => {});
  sess.prove(first);
  assert.equal(sess.current(first), true, "chunks are delivered while the session runs");

  // A tail flush still counts: stop() does not close the session, finish() does.
  sess.stop(first, () => {});
  assert.equal(sess.current(first), true, "the final tail slice must still reach the recorder");
  assert.equal(sess.finish(first), true);
  assert.equal(sess.current(first), false, "after which a late chunk is dropped");
  assert.equal(sess.finish(first), false, "and the session finishes exactly once");
  assert.equal(sess.fail(first), false, "a failure reported by a session that is over is not news");

  const second = sess.start(() => {});
  assert.equal(sess.current(first), false, "the old token never comes back to life");
  assert.equal(sess.fail(second), true, "a live session's failure IS reported");
  assert.equal(sess.current(second), false, "and closes it");
});

test("U4-2: an idle arbiter refuses everything (nothing is running before the first start)", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  assert.equal(sess.current(sess.token), false);
  assert.equal(sess.live, false);
  assert.equal(sess.fail(sess.token), false);
  assert.equal(sess.finish(sess.token), false);
  assert.equal(
    sess.stop(sess.token, () => {
      throw new Error("nothing to stop");
    }),
    false,
  );
  assert.equal(timers.pending, 0);
});

test("U4-2: cancel() (the capture window going away) leaves nothing pending", () => {
  const timers = new FakeTimers();
  const sess = new CaptureSession({ timers });
  const dead: string[] = [];
  const gen = sess.start((msg) => dead.push(msg));
  sess.cancel();
  timers.advance(CAPTURE_START_DEADLINE_MS * 2);
  assert.deepEqual(dead, [], "a destroyed capture window is not a failed recording to report");
  assert.equal(sess.current(gen), false);
  assert.equal(timers.pending, 0);
});

// The other half of the blocking finding is the WIRING: the arbiter above is
// only worth something if capture.ts actually consults it. main/capture.ts
// imports "electron" and cannot be instantiated here (same constraint as
// test/ui-bridge.test.ts), so the structural facts are read from the source.
const CAPTURE_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "capture.ts"), "utf8");

test("U4-2: capture.ts arms the session, and no longer throws native:ready away", () => {
  assert.match(CAPTURE_SRC, /this\.sess\.start\(/, "start() must open a watched session");
  // The old code was literally an empty handler with a comment saying there was
  // nothing to do; a regression would most likely look like that again.
  const ready = CAPTURE_SRC.slice(CAPTURE_SRC.indexOf("ipcMain.on(NATIVE_READY"));
  assert.match(ready.slice(0, 400), /this\.sess\.prove\(/, "native:ready must disarm the watchdog");
  const chunk = CAPTURE_SRC.slice(CAPTURE_SRC.indexOf("ipcMain.on(NATIVE_CHUNK"));
  assert.match(chunk.slice(0, 600), /this\.sess\.prove\(/, "the first chunk proves the capture too");
  assert.match(chunk.slice(0, 600), /this\.sess\.current\(/, "and a chunk from a finished session is dropped");
});

test("U4-2: capture.ts watches the capture window itself for death", () => {
  assert.match(CAPTURE_SRC, /"render-process-gone"/, "a crashed capture renderer must end the recording");
  assert.match(CAPTURE_SRC, /"did-fail-load"/, "a capture window that never loads must too");
});

test("U4-4: capture.ts checks the token before finalizing a stop", () => {
  const finish = CAPTURE_SRC.slice(CAPTURE_SRC.indexOf("private finishStop("));
  assert.match(finish.slice(0, 500), /this\.sess\.finish\(gen\)/, "finishStop must be gated on the session token");
  // The safety timer must be the session's (cancelled by the next start), never
  // a raw setTimeout living outside its reach - that was the original bug.
  assert.ok(
    !/setTimeout\(/.test(CAPTURE_SRC),
    "a timer outside the session cannot be cancelled by the next recording",
  );
});
