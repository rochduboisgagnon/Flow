import test from "node:test";
import assert from "node:assert/strict";
import {
  HookWatchdog,
  HOOK_WATCHDOG_POLICY,
  hookIsArmed,
  hookStatusLine,
} from "../src/shared/hookWatchdog";

// B4: the restart policy for the global keyboard hook.
//
// The defect it answers is in the dependency, not in Flow: keyspy's Windows
// backend only installs a process "close" handler when it is given an onError
// (node_modules/keyspy/dist/platforms/windows/index.js), and Flow built its
// listener with no configuration at all. So when WinKeyServer.exe died there
// was no handler, no alert and no restart - push-to-talk was over for the rest
// of the session while every surface still said "ready". The Windows backend
// also has no restart logic of its own, unlike the Linux and macOS ones.
//
// The policy lives in a pure module for the same reason overlayVisibility.ts and
// captureSession.ts do: the class that talks to keyspy spawns a real binary, so
// "when do we restart, when do we give up, how long do we wait" could not
// otherwise be tested at all.

const P = HOOK_WATCHDOG_POLICY;

test("B4: a lone death restarts quickly - the shortcut must come back in seconds, not minutes", () => {
  const w = new HookWatchdog();
  w.armed();
  assert.equal(w.state, "armed");

  const d = w.died(1000, "the key server exited (code 1)");
  assert.deepEqual(d, { action: "restart", delayMs: P.baseDelayMs, attempt: 1 });
  assert.equal(w.state, "restarting");
  assert.equal(hookIsArmed(w.health()), false, "a hook being restarted is NOT armed, however brief the gap");

  w.armed();
  assert.equal(w.state, "armed");
  const h = w.health();
  assert.equal(h.deaths, 1);
  assert.equal(h.restarts, 1, "a recovery is counted only once the replacement is really live");
  assert.equal(h.lastIncidentAt, 1000);
  assert.equal(h.lastIncidentDetail, "the key server exited (code 1)");
});

test("B4: the backoff doubles per attempt inside the window, and is capped", () => {
  const w = new HookWatchdog();
  w.armed();
  const delays: number[] = [];
  for (let i = 0; i < P.maxRestarts; i++) {
    const d = w.died(1000 + i, `death ${i}`);
    assert.equal(d.action, "restart");
    if (d.action === "restart") {
      delays.push(d.delayMs);
      assert.equal(d.attempt, i + 1);
    }
    w.armed(); // the restart worked; the next death is still inside the window
  }
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.ok(
    delays.every((ms) => ms <= P.maxDelayMs),
    "the cap exists so a system-wide cause cannot be hammered at, but a bounded wait is still a wait",
  );
});

test("B4: a crash loop ends in a TERMINAL state, not an infinite respawn", () => {
  const w = new HookWatchdog();
  w.armed();
  for (let i = 0; i < P.maxRestarts; i++) {
    assert.equal(w.died(1000 + i, "boom").action, "restart");
    w.armed();
  }
  const giveUp = w.died(1000 + P.maxRestarts, "boom");
  assert.deepEqual(giveUp, { action: "give-up", deathsInWindow: P.maxRestarts + 1 });
  assert.equal(w.state, "abandoned");

  // Terminal means terminal: a further close event neither restarts nor even
  // counts, so the numbers the user reads stay the numbers that happened.
  const before = w.health();
  assert.deepEqual(w.died(2_000_000, "boom again"), { action: "ignore" });
  assert.deepEqual(w.health(), before, "an abandoned hook records nothing further");
  assert.equal(w.state, "abandoned");
});

test("B4: the crash-loop guard is a WINDOW, not a lifetime budget", () => {
  const w = new HookWatchdog();
  w.armed();
  for (let i = 0; i < P.maxRestarts; i++) {
    assert.equal(w.died(1000 + i, "boom").action, "restart");
    w.armed();
  }
  // One death an hour later is not a crash loop, and a machine that hiccuped
  // three times this morning must not be left without a shortcut all afternoon.
  // Past the window measured from the LAST of them, so all three have aged out.
  const later = w.died(1000 + P.maxRestarts + P.windowMs, "much later");
  assert.deepEqual(later, { action: "restart", delayMs: P.baseDelayMs, attempt: 1 });
  assert.equal(w.health().deaths, P.maxRestarts + 1, "but every death is still counted for the record");
});

test("B4: a deliberate stop is not an incident - keyspy's own kill() closes the process too", () => {
  const w = new HookWatchdog();
  w.armed();
  w.stopped();
  assert.deepEqual(w.died(5000, "the key server exited (code 0)"), { action: "ignore" });
  const h = w.health();
  assert.equal(h.deaths, 0, "quitting Flow must never look like a crash");
  assert.equal(h.lastIncidentAt, null);
  // And a late success (an arm that resolves after stop()) cannot resurrect it.
  w.armed();
  assert.equal(w.state, "stopped");
});

test("B4: the very first arm is not a 'recovery' - the counter means something", () => {
  const w = new HookWatchdog();
  assert.equal(w.state, "starting");
  w.armed();
  assert.equal(w.health().restarts, 0);
  assert.equal(w.health().deaths, 0);
});

test("B4: a start that never succeeds goes through the SAME policy as a death", () => {
  // A binary that cannot spawn and a binary that spawns then dies are one
  // outage seen at two moments; one path handles both.
  const w = new HookWatchdog();
  assert.equal(w.state, "starting");
  const d = w.died(10, "start failed: ENOENT");
  assert.deepEqual(d, { action: "restart", delayMs: P.baseDelayMs, attempt: 1 });
  assert.equal(w.health().deaths, 1);
  assert.equal(w.health().lastIncidentDetail, "start failed: ENOENT");
});

test("B4: hookIsArmed is true for exactly one state", () => {
  const w = new HookWatchdog();
  assert.equal(hookIsArmed(w.health()), false, "starting");
  w.armed();
  assert.equal(hookIsArmed(w.health()), true);
  w.died(1, "x");
  assert.equal(hookIsArmed(w.health()), false, "restarting is an outage, not a detail");
  w.stopped();
  assert.equal(hookIsArmed(w.health()), false);
});

test("B4: the status line outranks the engine's own only for real outages", () => {
  const w = new HookWatchdog();
  // Boot: the engine may be downloading a 1.1 GB model, and THAT is what the
  // user needs to read - not a hook that is 200 ms from being armed.
  assert.equal(hookStatusLine(w.health()), null, "starting says nothing");
  w.armed();
  assert.equal(hookStatusLine(w.health()), null);
  w.died(1, "x");
  assert.match(hookStatusLine(w.health()) ?? "", /restarting/);
  for (let i = 0; i < P.maxRestarts; i++) {
    w.armed();
    w.died(2 + i, "x");
  }
  assert.match(hookStatusLine(w.health()) ?? "", /unavailable/);
  assert.match(hookStatusLine(w.health()) ?? "", /restart Flow/, "a terminal state must say what to DO");
});

test("B4: a custom policy is honoured (the tests' own fast clock depends on it)", () => {
  const w = new HookWatchdog({ maxRestarts: 1, windowMs: 100, baseDelayMs: 5, maxDelayMs: 5 });
  w.armed();
  assert.deepEqual(w.died(0, "x"), { action: "restart", delayMs: 5, attempt: 1 });
  w.armed();
  assert.deepEqual(w.died(10, "x"), { action: "give-up", deathsInWindow: 2 });
});
