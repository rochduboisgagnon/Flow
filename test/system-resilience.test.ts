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
  const r = reactToSystemTransition("unlock", ctx({ holdInFlight: true }));
  assert.equal(r.rearmHook, false);
  assert.equal(r.interruptHold, false, "and there is nothing to tear down: the hold ended at lock time");
  assert.match(r.logLine, /never torn down/);
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
      assert.equal(typeof r.interruptHold, "boolean");
      assert.equal(typeof r.rearmHook, "boolean");
    }
  }
});

// ---- the premise, asserted rather than trusted ----

test("B9-premise: the adapter tears the hold down BEFORE rebuilding the hook", () => {
  // A rebuild resets the combo matcher (HotkeyAdapter.arm), so doing it first
  // would erase the app's memory of the press while the renderer still held a
  // live microphone. The order is in main/systemWatch.ts, which imports
  // "electron" and so cannot be loaded here - assert it as source text, the
  // same technique as test/silent-failures-wiring.test.ts.
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
