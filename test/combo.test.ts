import test from "node:test";
import assert from "node:assert/strict";
import {
  createComboMatcher,
  normalizeCombo,
  comboLabel,
  genericOf,
  type ComboMatcher,
} from "../src/shared/combo";

const OPTS = { minHoldMs: 200, doubleTapMs: 400 };

function ctrlWin(): ComboMatcher {
  return createComboMatcher(["CTRL", "WIN"], OPTS);
}

test("Ctrl then Win completes the combo: start, Win-down swallowed", () => {
  const m = ctrlWin();
  assert.deepEqual(m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000), {
    action: "none",
    swallow: false,
  });
  assert.deepEqual(m.handle({ key: "LEFT META", state: "DOWN" }, 1010), {
    action: "start",
    swallow: true, // the OS must never see this Win press (Start-menu trap)
  });
  assert.equal(m.capturing(), true);
});

test("swallowed Win: auto-repeats and the final keyup are swallowed too", () => {
  const m = ctrlWin();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1010);
  // Hardware auto-repeat of the blocked Win key keeps arriving: keep hiding it.
  assert.deepEqual(m.handle({ key: "LEFT META", state: "DOWN" }, 1200), {
    action: "none",
    swallow: true,
  });
  // Releasing Win breaks the combo after a real hold: stop, and swallow the UP
  // (its DOWN was never seen by the OS).
  assert.deepEqual(m.handle({ key: "LEFT META", state: "UP" }, 1600), {
    action: "stop",
    swallow: true,
  });
  assert.deepEqual(m.handle({ key: "LEFT CTRL", state: "UP" }, 1650), {
    action: "none",
    swallow: false,
  });
  assert.equal(m.capturing(), false);
});

test("Win first, then Ctrl: nothing is swallowed (the OS saw the Win press)", () => {
  const m = ctrlWin();
  assert.deepEqual(m.handle({ key: "LEFT META", state: "DOWN" }, 1000), {
    action: "none",
    swallow: false,
  });
  assert.deepEqual(m.handle({ key: "RIGHT CTRL", state: "DOWN" }, 1020), {
    action: "start",
    swallow: false, // Ctrl is not a Win key; its down cancels the Start menu natively
  });
  assert.deepEqual(m.handle({ key: "RIGHT CTRL", state: "UP" }, 1700), {
    action: "stop",
    swallow: false,
  });
  // Win-up passes through: we never swallow an UP whose DOWN went through.
  assert.deepEqual(m.handle({ key: "LEFT META", state: "UP" }, 1750), {
    action: "none",
    swallow: false,
  });
});

test("either side works: RIGHT CTRL + RIGHT META", () => {
  const m = ctrlWin();
  m.handle({ key: "RIGHT CTRL", state: "DOWN" }, 1000);
  const d = m.handle({ key: "RIGHT META", state: "DOWN" }, 1010);
  assert.equal(d.action, "start");
  assert.equal(d.swallow, true);
});

test("quick tap cancels: nothing reaches the ASR", () => {
  const m = ctrlWin();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1010);
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 1100).action, "cancel");
  assert.equal(m.capturing(), false);
});

test("double-tap enters hands-free toggle; a new double-tap stops it", () => {
  const m = ctrlWin();
  // Tap 1: start then cancel.
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  assert.equal(m.handle({ key: "LEFT META", state: "DOWN" }, 1005).action, "start");
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 1080).action, "cancel");
  // Tap 2 within the window: start again, and the quick release KEEPS it running.
  assert.equal(m.handle({ key: "LEFT META", state: "DOWN" }, 1200).action, "start");
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 1280).action, "none");
  assert.equal(m.capturing(), true);
  // Ctrl can be released too: still hands-free.
  assert.equal(m.handle({ key: "LEFT CTRL", state: "UP" }, 1300).action, "none");
  assert.equal(m.capturing(), true);
  // Other keys do NOT cancel in toggle mode.
  assert.equal(m.handle({ key: "A", state: "DOWN" }, 2000).action, "none");
  assert.equal(m.handle({ key: "A", state: "UP" }, 2050).action, "none");
  // Stop double-tap: two quick full presses.
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 5000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 5005);
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 5080).action, "none");
  m.handle({ key: "LEFT META", state: "DOWN" }, 5200);
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 5280).action, "stop");
  assert.equal(m.capturing(), false);
});

test("two taps too far apart do not toggle", () => {
  const m = ctrlWin();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1005);
  m.handle({ key: "LEFT META", state: "UP" }, 1080); // cancel
  m.handle({ key: "LEFT META", state: "DOWN" }, 2000); // > 400 ms later
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 2080).action, "cancel");
});

test("extra key while holding cancels (Ctrl+Win+arrow is a desktop switch)", () => {
  const m = ctrlWin();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1010);
  assert.equal(m.handle({ key: "LEFT ARROW", state: "DOWN" }, 1300).action, "cancel");
  assert.equal(m.capturing(), false);
  // Releasing everything afterwards stays quiet.
  assert.equal(m.handle({ key: "LEFT ARROW", state: "UP" }, 1350).action, "none");
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 1400).action, "none");
  assert.equal(m.handle({ key: "LEFT CTRL", state: "UP" }, 1450).action, "none");
});

test("legacy single-key combo (RIGHT CTRL) behaves like the old PTT", () => {
  const m = createComboMatcher(["RIGHT CTRL"], OPTS);
  assert.equal(m.handle({ key: "RIGHT CTRL", state: "DOWN" }, 1000).action, "start");
  assert.equal(m.handle({ key: "RIGHT CTRL", state: "DOWN" }, 1030).action, "none");
  assert.equal(m.handle({ key: "RIGHT CTRL", state: "UP" }, 1600).action, "stop");
  // LEFT CTRL does not satisfy an exact RIGHT CTRL entry.
  assert.equal(m.handle({ key: "LEFT CTRL", state: "DOWN" }, 2000).action, "none");
  assert.equal(m.capturing(), false);
  m.handle({ key: "LEFT CTRL", state: "UP" }, 2100);
});

test("Win-only combo: the Win key is fully owned by dictation", () => {
  const m = createComboMatcher(["WIN"], OPTS);
  const d = m.handle({ key: "LEFT META", state: "DOWN" }, 1000);
  assert.deepEqual(d, { action: "start", swallow: true });
  assert.deepEqual(m.handle({ key: "LEFT META", state: "UP" }, 1600), {
    action: "stop",
    swallow: true,
  });
});

test("stray UP with no tracked DOWN is a no-op", () => {
  const m = ctrlWin();
  assert.deepEqual(m.handle({ key: "LEFT META", state: "UP" }, 1000), {
    action: "none",
    swallow: false,
  });
});

test("setCombo resets state and applies the new combination", () => {
  const m = ctrlWin();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1010);
  assert.equal(m.capturing(), true);
  m.setCombo(["F9"]);
  assert.equal(m.capturing(), false);
  assert.equal(m.handle({ key: "F9", state: "DOWN" }, 2000).action, "start");
  assert.equal(m.handle({ key: "F9", state: "UP" }, 2600).action, "stop");
});

test("releasing one combo key then re-pressing restarts cleanly", () => {
  const m = ctrlWin();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1010);
  m.handle({ key: "LEFT META", state: "UP" }, 1700); // stop
  // Ctrl stays down; pressing Win again starts a new capture.
  const d = m.handle({ key: "LEFT META", state: "DOWN" }, 2500);
  assert.deepEqual(d, { action: "start", swallow: true });
  m.handle({ key: "LEFT META", state: "UP" }, 3200);
  assert.equal(m.capturing(), false);
});

test("normalizeCombo: generic modifiers sorted, one main key max", () => {
  assert.deepEqual(normalizeCombo(["RIGHT META", "LEFT CTRL"]), ["CTRL", "WIN"]);
  assert.deepEqual(normalizeCombo(["LEFT SHIFT", "F9", "G"]), ["SHIFT", "F9"]);
  assert.deepEqual(normalizeCombo(["LEFT CTRL", "RIGHT CTRL"]), ["CTRL"]);
  assert.deepEqual(normalizeCombo([]), []);
});

test("comboLabel and genericOf", () => {
  assert.equal(comboLabel(["CTRL", "WIN"]), "Ctrl + Win");
  assert.equal(comboLabel(["RIGHT CTRL"]), "Right Ctrl");
  assert.equal(genericOf("LEFT META"), "WIN");
  assert.equal(genericOf("F9"), "F9");
});

// ---- B2: pre-arm, the narrowed version of "open the mic on the first key" ----
//
// The whole point of these tests is the FIRST one: the plan proposed treating a
// lone Ctrl as intent to dictate, and the default shortcut is Ctrl+Win. If that
// ever starts returning true, Flow opens the microphone on every Ctrl+C on the
// machine - which is a privacy regression disguised as an optimisation.

test("pre-arm: the DEFAULT two-key shortcut never pre-arms, whatever is held", () => {
  const m = ctrlWin();
  assert.equal(m.preArmed(), false, "nothing held");
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  assert.equal(m.preArmed(), false, "Ctrl alone is not an intention to dictate");
  m.handle({ key: "LEFT META", state: "DOWN" }, 1010);
  assert.equal(m.preArmed(), false, "and a COMPLETE combo is a capture, not a pre-arm");
});

test("pre-arm: a single-key shortcut never pre-arms either (there is no partial state)", () => {
  const m = createComboMatcher(["F9"], OPTS);
  assert.equal(m.preArmed(), false);
  m.handle({ key: "F9", state: "DOWN" }, 1000);
  assert.equal(m.preArmed(), false);
});

test("pre-arm: a three-key shortcut arms once two of its three keys are held", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  assert.equal(m.preArmed(), false, "one key of three is not evidence");
  m.handle({ key: "LEFT SHIFT", state: "DOWN" }, 1010);
  assert.equal(m.preArmed(), true, "two of three: one key away, and a rare hand position");
  m.handle({ key: "F9", state: "DOWN" }, 1020);
  assert.equal(m.preArmed(), false, "complete: this is a capture now");
});

test("pre-arm: it falls back to false as soon as the hand comes off a key", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT SHIFT", state: "DOWN" }, 1010);
  assert.equal(m.preArmed(), true);
  m.handle({ key: "LEFT SHIFT", state: "UP" }, 1100);
  assert.equal(m.preArmed(), false);
});

test("pre-arm: keys outside the shortcut do not count toward it", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "A", state: "DOWN" }, 1010);
  m.handle({ key: "B", state: "DOWN" }, 1020);
  assert.equal(m.preArmed(), false, "three keys held, but only one of them is the shortcut's");
});

test("pre-arm: side-agnostic, like every other match in this matcher", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "RIGHT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "RIGHT SHIFT", state: "DOWN" }, 1010);
  assert.equal(m.preArmed(), true);
});

test("pre-arm: reset() and setCombo() clear it, so no stale hand position survives", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT SHIFT", state: "DOWN" }, 1010);
  assert.equal(m.preArmed(), true);
  m.reset();
  assert.equal(m.preArmed(), false);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 2000);
  m.handle({ key: "LEFT SHIFT", state: "DOWN" }, 2010);
  assert.equal(m.preArmed(), true);
  m.setCombo(["CTRL", "WIN"]);
  assert.equal(m.preArmed(), false, "the new shortcut is two keys: it can never pre-arm");
});
