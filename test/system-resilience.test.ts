import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MIN_VOLUNTARY_REARM_INTERVAL_MS,
  reactToSystemTransition,
  type SystemContext,
  type SystemTransition,
} from "../src/shared/systemResilience";
import { SystemWatch, type SystemWatchDeps } from "../src/main/systemWatch";
import type { HookState } from "../src/shared/hookWatchdog";

// B9 (plan V2): what Flow does when the MACHINE moves under it. The policy is
// pure, so every transition can be driven here; the four powerMonitor
// subscriptions that feed it live in main/systemWatch.ts and are deliberately
// decision-free (same split as overlayVisibility.ts / overlay.ts).

function ctx(over: Partial<SystemContext> = {}): SystemContext {
  return { holdInFlight: false, hookState: "armed", msSinceLastRearm: null, ...over };
}

const ALL: SystemTransition[] = ["suspend", "resume", "lock", "unlock"];

// ---- the reason this policy exists at all ----

test("B9: a resume rebuilds the keyboard hook - the ONE case B4's watchdog cannot see", () => {
  const r = reactToSystemTransition("resume", ctx());
  assert.equal(r.rearmHook, true);
  // And it says WHY in the log, because "Flow restarted something" with no
  // reason is how a diagnostic becomes noise.
  assert.match(r.logLine, /Windows removes a low-level hook/);
});

test("B9: no other transition rebuilds the hook", () => {
  for (const t of ALL.filter((x) => x !== "resume")) {
    assert.equal(reactToSystemTransition(t, ctx()).rearmHook, false, `${t} must not rebuild the hook`);
  }
});

test("B9: unlocking rebuilds nothing - a desktop switch never removed the hook", () => {
  const r = reactToSystemTransition("unlock", ctx());
  assert.equal(r.rearmHook, false);
  assert.match(r.logLine, /never torn down/);
});

test("B9: unlocking still tears a hold down if one somehow survived the lock", () => {
  // Windows does not guarantee a lock event for every secure-desktop trip, and
  // this branch used to hard-code false. It cannot: unlock now forgets the key
  // state, and forgetting the keys under a live capture leaves a microphone that
  // no key release can ever close.
  const r = reactToSystemTransition("unlock", ctx({ holdInFlight: true }));
  assert.equal(r.interruptHold, true);
  assert.match(r.logLine, /the capture was ended/);
});

// ---- the guard rails on the rebuild ----

test("B9: a rebuild is refused unless the hook believes it is armed", () => {
  const refused: HookState[] = ["starting", "restarting", "abandoned", "stopped"];
  for (const hookState of refused) {
    const r = reactToSystemTransition("resume", ctx({ hookState }));
    assert.equal(r.rearmHook, false, `resume must not rebuild while the hook is ${hookState}`);
  }
  assert.equal(reactToSystemTransition("resume", ctx({ hookState: "armed" })).rearmHook, true);
});

test("B9: an abandoned hook is NOT resurrected by a wake - terminal means terminal", () => {
  const r = reactToSystemTransition("resume", ctx({ hookState: "abandoned" }));
  assert.equal(r.rearmHook, false);
  // The crash-loop guard gave up and every surface tells the user to restart
  // Flow. A wake that quietly retried would make that message a lie.
  assert.match(r.logLine, /restart Flow/);
});

test("B9: a restarting hook is left to its own watchdog - two arms mean two live listeners", () => {
  const r = reactToSystemTransition("resume", ctx({ hookState: "restarting" }));
  assert.equal(r.rearmHook, false);
  assert.match(r.logLine, /watchdog/);
});

test("B9: several resume events for one wake produce ONE rebuild", () => {
  // Windows reports resume more than once for a single modern-standby exit.
  assert.equal(reactToSystemTransition("resume", ctx({ msSinceLastRearm: null })).rearmHook, true);
  assert.equal(
    reactToSystemTransition("resume", ctx({ msSinceLastRearm: 1_000 })).rearmHook,
    false,
    "a second resume seconds later must not spawn a second key server",
  );
  assert.equal(
    reactToSystemTransition("resume", ctx({ msSinceLastRearm: MIN_VOLUNTARY_REARM_INTERVAL_MS - 1 })).rearmHook,
    false,
  );
  assert.equal(
    reactToSystemTransition("resume", ctx({ msSinceLastRearm: MIN_VOLUNTARY_REARM_INTERVAL_MS })).rearmHook,
    true,
    "but a genuine second wake, much later, is rebuilt again",
  );
});

// ---- the hold that can never be released ----

test("B9: sleeping, locking or waking mid-hold tears the capture down", () => {
  for (const t of ["suspend", "lock", "resume"] as SystemTransition[]) {
    const r = reactToSystemTransition(t, ctx({ holdInFlight: true }));
    assert.equal(r.interruptHold, true, `${t} must not leave a hot microphone behind a key nobody can lift`);
  }
});

test("B9: with no hold in flight, nothing is torn down", () => {
  for (const t of ALL) {
    assert.equal(reactToSystemTransition(t, ctx({ holdInFlight: false })).interruptHold, false);
  }
});

// ---- the PHANTOM dictation: the key state, which is a wider question ----
//
// The bug these pin: the policy only ever asked "was a capture running?", so a
// shortcut held only PARTWAY - Ctrl down, Win not yet - was never forgotten. Its
// key-up went to the secure desktop or into a frozen process, Flow came back
// believing Ctrl was still held, and the next lone Win press completed the combo
// and started a dictation nobody asked for. Two of those arm hands-free mode,
// which keeps the microphone open with no key down at all.

test("B9-blocking: EVERY transition forgets the key state, hold or no hold", () => {
  for (const t of ALL) {
    for (const holdInFlight of [false, true]) {
      assert.equal(
        reactToSystemTransition(t, ctx({ holdInFlight })).forgetKeys,
        true,
        `${t} with holdInFlight=${holdInFlight}: a half-pressed shortcut must not survive it`,
      );
    }
  }
});

test("B9-blocking: forgetting the keys is BROADER than tearing a capture down", () => {
  // The whole bug in one assertion: with nothing capturing, the old policy did
  // nothing at all on these transitions - and "nothing capturing" is exactly the
  // state a half-pressed shortcut is in.
  for (const t of ALL) {
    const r = reactToSystemTransition(t, ctx({ holdInFlight: false }));
    assert.equal(r.interruptHold, false);
    assert.equal(r.forgetKeys, true, `${t} must still act, even though there is no capture to end`);
  }
});

test("B9: a hold is never torn down without the keys being forgotten with it", () => {
  // The other direction of the same invariant: forgetting the keys is what makes
  // the user's release unusable, so it must never happen alone under a capture.
  for (const t of ALL) {
    for (const hookState of ["armed", "starting", "restarting", "abandoned", "stopped"] as HookState[]) {
      const r = reactToSystemTransition(t, ctx({ hookState, holdInFlight: true }));
      assert.equal(r.interruptHold && !r.forgetKeys, false, `${t}/${hookState}`);
    }
  }
});

test("B9: the log says the keys were dropped - the line a 'Flow recorded by itself' report needs", () => {
  for (const t of ALL) {
    assert.match(reactToSystemTransition(t, ctx()).logLine, /every key believed held was forgotten/);
  }
});

test("B9: the log line names the dictation when one was interrupted", () => {
  assert.match(reactToSystemTransition("suspend", ctx({ holdInFlight: true })).logLine, /during a dictation/);
  assert.match(reactToSystemTransition("lock", ctx({ holdInFlight: true })).logLine, /secure desktop/);
  assert.doesNotMatch(reactToSystemTransition("suspend", ctx()).logLine, /during a dictation/);
});

// ---- shape ----

test("B9: every transition produces a log line - a transition that changes nothing still says so", () => {
  for (const t of ALL) {
    for (const hookState of ["armed", "starting", "restarting", "abandoned", "stopped"] as HookState[]) {
      const r = reactToSystemTransition(t, ctx({ hookState, holdInFlight: true }));
      assert.ok(r.logLine.length > 0, `${t}/${hookState} must journal something`);
      assert.match(r.logLine, /^\[system\] /, "one prefix, so a support read can grep for it");
      assert.equal(typeof r.forgetKeys, "boolean");
      assert.equal(typeof r.interruptHold, "boolean");
      assert.equal(typeof r.rearmHook, "boolean");
    }
  }
});

// ---- the premise, asserted rather than trusted ----

test("B9-premise: the adapter tears the hold down BEFORE rebuilding the hook", () => {
  // A rebuild resets the combo matcher (HotkeyAdapter.arm), so doing it first
  // would erase the app's memory of the press while the renderer still held a
  // live microphone. Asserted as source text because the ORDER is what matters
  // here and reading it is more direct than inferring it from a call log; the
  // adapter's behaviour itself is driven for real further down.
  const src = fs
    .readFileSync(path.join(__dirname, "..", "src", "main", "systemWatch.ts"), "utf8")
    .replace(/\r\n/g, "\n");
  const interruptAt = src.indexOf("if (reaction.interruptHold)");
  const rearmAt = src.indexOf("if (reaction.rearmHook)");
  assert.ok(interruptAt > 0 && rearmAt > 0, "both actions must be performed");
  assert.ok(interruptAt < rearmAt, "the teardown must come first");
});

test("B9-premise: systemWatch subscribes to exactly the four transitions the policy knows", () => {
  const src = fs
    .readFileSync(path.join(__dirname, "..", "src", "main", "systemWatch.ts"), "utf8")
    .replace(/\r\n/g, "\n");
  for (const [event, transition] of [
    ["suspend", "suspend"],
    ["resume", "resume"],
    ["lock-screen", "lock"],
    ["unlock-screen", "unlock"],
  ]) {
    assert.match(src, new RegExp(`this\\.subscribe\\("${event}", "${transition}"\\)`));
  }
  // And it releases them: a powerMonitor listener left behind on quit would
  // reach into a torn-down app.
  assert.match(src, /powerMonitor\.removeListener/);
});

// ---- the adapter, driven for real ----
//
// main/systemWatch.ts imports "electron", but only start()/stop() touch
// powerMonitor: handle() is the transition path and it can be driven directly.
// That is worth the import, because the blocking bug lived in what the adapter
// CALLS, and a source-text grep can only ever check what it is written to call.

interface Calls {
  order: string[];
  logs: string[];
}

function makeWatch(over: Partial<SystemWatchDeps> = {}): { watch: SystemWatch; calls: Calls } {
  const calls: Calls = { order: [], logs: [] };
  const watch = new SystemWatch({
    holdInFlight: () => false,
    hookState: () => "armed",
    forgetKeys: () => calls.order.push("forgetKeys"),
    interruptHold: () => calls.order.push("interruptHold"),
    rearmHook: () => calls.order.push("rearmHook"),
    log: (m) => calls.logs.push(m),
    ...over,
  });
  return { watch, calls };
}

test("B9-blocking: a lock with NOTHING captured still drops the key state", () => {
  // The test that would have caught it. Before the fix this produced an empty
  // call log: no capture was running, so the adapter did nothing, and the Ctrl
  // the user was holding when Windows switched desktops stayed "down" forever.
  const { watch, calls } = makeWatch({ holdInFlight: () => false });
  watch.handle("lock");
  assert.deepEqual(calls.order, ["forgetKeys"]);
});

test("B9-blocking: every transition drops the key state, with or without a capture", () => {
  for (const t of ALL) {
    for (const holdInFlight of [false, true]) {
      const { watch, calls } = makeWatch({ holdInFlight: () => holdInFlight });
      watch.handle(t);
      assert.ok(calls.order.includes("forgetKeys"), `${t} with holdInFlight=${holdInFlight}`);
    }
  }
});

test("B9: the capture is torn down BEFORE the keys are forgotten and before the rebuild", () => {
  // Both later steps clear the matcher; either one running first would erase the
  // press while the renderer still held a live microphone.
  const { watch, calls } = makeWatch({ holdInFlight: () => true });
  watch.handle("resume");
  assert.deepEqual(calls.order, ["interruptHold", "forgetKeys", "rearmHook"]);
});


test("B9: the hold in flight is read once per transition, from the dep the wiring supplies", () => {
  let reads = 0;
  const { watch } = makeWatch({
    holdInFlight: () => {
      reads++;
      return true;
    },
  });
  watch.handle("suspend");
  assert.equal(reads, 1, "one snapshot per transition: the keys are dropped underneath it");
});

test("B9: several resume events for one wake rebuild once - the clock is the adapter's", () => {
  let now = 0;
  const { watch, calls } = makeWatch({ now: () => now });
  watch.handle("resume");
  now += 1_000;
  watch.handle("resume");
  assert.equal(calls.order.filter((c) => c === "rearmHook").length, 1);
  now += MIN_VOLUNTARY_REARM_INTERVAL_MS;
  watch.handle("resume");
  assert.equal(calls.order.filter((c) => c === "rearmHook").length, 2, "a genuine second wake is rebuilt");
  // ...and every one of those transitions still dropped the key state.
  assert.equal(calls.order.filter((c) => c === "forgetKeys").length, 3);
});
