import test from "node:test";
import assert from "node:assert/strict";
import {
  createComboMatcher,
  normalizeCombo,
  comboLabel,
  genericOf,
  STALE_HOLD_MS,
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

// ---- B2: pre-arm, and why it is OFF ----
//
// The plan proposed treating a lone Ctrl as intent to dictate, on a default
// shortcut of Ctrl+Win: that would open the microphone on every Ctrl+C on the
// machine, a privacy regression disguised as an optimisation. The first
// narrowing - "every key of the shortcut but one is held, minimum three keys" -
// looked like it answered that and did not, because normalizeCombo keeps AT
// MOST ONE non-modifier: a three-key shortcut is MOD+MOD+key, so "one key away"
// is reached by the two modifiers alone and Ctrl+Shift opened the microphone.
//
// These tests pin the conclusion (nothing pre-arms) AND the premise it rests on
// (a combo can never hold two non-modifiers), because if that premise ever
// changes the decision deserves to be re-made rather than silently inherited.

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

// THE regression test: this is the exact hand position the old rule armed on.
test("pre-arm: two modifiers held together NEVER arm it - Ctrl+Shift is a prefix, not an intention", () => {
  for (const combo of [
    ["CTRL", "SHIFT", "F9"],
    ["CTRL", "ALT", "F9"],
    ["CTRL", "SHIFT", "ALT"],
    ["CTRL", "WIN", "SPACE"],
  ]) {
    const m = createComboMatcher(combo, OPTS);
    m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
    m.handle({ key: genericDownKey(combo[1]), state: "DOWN" }, 1010);
    assert.equal(
      m.preArmed(),
      false,
      `${combo.join("+")}: the two modifiers of a three-key shortcut are one key away, and that is not evidence`,
    );
  }
});

/** Physical key that satisfies a generic combo entry, for the loop above. */
function genericDownKey(entry: string): string {
  return { CTRL: "LEFT CTRL", SHIFT: "LEFT SHIFT", ALT: "LEFT ALT", WIN: "LEFT META" }[entry] ?? entry;
}

test("pre-arm: no reachable hand position arms any three-key shortcut", () => {
  // Exhaustive over the subsets of the shortcut's own keys: the old rule was
  // false for two of these four and true for the other two, so an exhaustive
  // sweep is what turns "we fixed the Ctrl+Shift case" into "no case remains".
  const keys = ["LEFT CTRL", "LEFT SHIFT", "F9"];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
    const held = keys.filter((_, i) => mask & (1 << i));
    held.forEach((k, i) => m.handle({ key: k, state: "DOWN" }, 1000 + i));
    assert.equal(m.preArmed(), false, `held: [${held.join(", ")}]`);
  }
});

test("pre-arm: keys outside the shortcut do not arm it either", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "A", state: "DOWN" }, 1010);
  m.handle({ key: "B", state: "DOWN" }, 1020);
  assert.equal(m.preArmed(), false);
});

test("pre-arm: still false after reset(), setCombo() and a completed dictation", () => {
  const m = createComboMatcher(["CTRL", "SHIFT", "F9"], OPTS);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1000);
  m.handle({ key: "LEFT SHIFT", state: "DOWN" }, 1010);
  m.handle({ key: "F9", state: "DOWN" }, 1020);
  assert.equal(m.capturing(), true, "the dictation itself is unaffected by pre-arming being off");
  assert.equal(m.preArmed(), false);
  m.reset();
  assert.equal(m.preArmed(), false);
  m.setCombo(["CTRL", "WIN"]);
  assert.equal(m.preArmed(), false);
});

test("pre-arm premise: a stored combo can never hold two non-modifiers", () => {
  // This is what makes every three-key shortcut MOD+MOD+key, and therefore what
  // makes "one key away" reachable by modifiers alone. If this ever stops
  // holding, re-open ComboMatcher.preArmed: a partial press would then be able
  // to contain a key that means something on its own.
  // A stored combo holds generic modifier names ("CTRL"), so genericOf() is a
  // fixed point on them and cannot tell them apart: use the vocabulary itself.
  const MODS = new Set(["CTRL", "SHIFT", "ALT", "WIN"]);
  const nonMods = (combo: string[]) => combo.filter((k) => !MODS.has(k));
  assert.equal(nonMods(normalizeCombo(["LEFT CTRL", "LEFT SHIFT", "F9", "G"])).length, 1);
  assert.equal(nonMods(normalizeCombo(["F9", "G", "H"])).length, 1);
  assert.equal(nonMods(normalizeCombo(["LEFT CTRL", "LEFT SHIFT", "LEFT ALT"])).length, 0);
});

// ---- the stale-hold net: the door powerMonitor cannot close ----
//
// shared/systemResilience.ts drops the key state on sleep, wake, lock and
// unlock. It cannot help with a UAC prompt, a Ctrl+Alt+Del the user backs out
// of, or some fast user switches: Electron never reports those, and they switch
// to the secure desktop and swallow key-ups just the same. So the matcher
// carries its own net, keyed on silence and on nothing anyone has to volunteer.
//
// Every test below is really one of two questions. Does the net close the
// phantom door? And - the one that decides its shape - can it ever cut a real
// dictation? The answer to the second must stay "no" at every reading.

function netMatcher(combo: string[] = ["CTRL", "WIN"]): { m: ComboMatcher; drops: string[][] } {
  const drops: string[][] = [];
  // Deliberately the REAL threshold: the number is part of what is under test.
  const m = createComboMatcher(combo, { ...OPTS, onStaleDrop: (keys) => drops.push(keys) });
  return { m, drops };
}

test("stale-hold net: the threshold clears the slowest Windows key repeat with room to spare", () => {
  // A key that is really down auto-repeats; the slowest Windows can be set to is
  // a 1 s initial delay, then roughly two a second. Anything at or below that is
  // not silence, it is a slow keyboard.
  const WORST_TYPEMATIC_GAP_MS = 1_000;
  assert.ok(STALE_HOLD_MS >= 3 * WORST_TYPEMATIC_GAP_MS, "a slow repeat setting must never read as a lost key");
  assert.ok(STALE_HOLD_MS <= 5_000, "and a trip to the secure desktop must be over the line before the user returns");
});

test("stale-hold net: it stays OFF until it has watched that key repeat with its own eyes", () => {
  // Silence only means "the key is up" on a keyboard where held keys repeat.
  // Until that is observed, the net refuses to guess - Flow behaves exactly as
  // it did before, which is the right way to be wrong.
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  const d = m.handle({ key: "LEFT META", state: "DOWN" }, 60_000);
  assert.equal(d.action, "start", "no evidence, no verdict");
  assert.deepEqual(drops, []);
});

test("stale-hold net: once armed, a silent held key is dropped and completes nothing", () => {
  // THE phantom, end to end: Ctrl held when Windows switched to the secure
  // desktop, its release delivered there, and a plain Win press on the way back.
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_500); // auto-repeat: the net may now read this key
  const d = m.handle({ key: "LEFT META", state: "DOWN" }, 5_000);
  assert.equal(d.action, "none", "a dictation nobody asked for would show up as 'start'");
  assert.equal(d.swallow, false, "and the Win press belongs to the user, not to us");
  assert.deepEqual(drops, [["LEFT CTRL"]]);
  assert.equal(m.capturing(), false);
});

test("stale-hold net: a key that keeps repeating is never dropped, however long it is held", () => {
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  for (let t = 1_500; t <= 61_000; t += 500) m.handle({ key: "LEFT CTRL", state: "DOWN" }, t);
  assert.equal(m.handle({ key: "LEFT META", state: "DOWN" }, 61_200).action, "start", "a minute of real holding");
  assert.deepEqual(drops, []);
});

test("stale-hold net: the boundary is the threshold itself, and it is judged per key", () => {
  const arm = (m: ComboMatcher) => {
    m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
    m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_100);
  };
  const a = netMatcher();
  arm(a.m);
  assert.equal(
    a.m.handle({ key: "LEFT META", state: "DOWN" }, 1_100 + STALE_HOLD_MS - 1).action,
    "start",
    "one millisecond inside the window is still a held key",
  );

  const b = netMatcher();
  arm(b.m);
  assert.equal(b.m.handle({ key: "LEFT META", state: "DOWN" }, 1_100 + STALE_HOLD_MS).action, "none");
});

test("stale-hold net: typing does NOT keep a stale key alive - the case a global clock would miss", () => {
  // Deliberate: if any keystroke anywhere refreshed the clock, someone who comes
  // back from a UAC prompt and writes an email would carry the stale Ctrl for as
  // long as they type, which is exactly the window the phantom fires in.
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_500); // armed
  for (let t = 2_000; t <= 12_000; t += 250) {
    m.handle({ key: "A", state: "DOWN" }, t);
    m.handle({ key: "A", state: "UP" }, t + 50);
  }
  assert.deepEqual(drops, [["LEFT CTRL"]], "busy keyboard, silent Ctrl: the silence is what counts");
  assert.equal(m.handle({ key: "LEFT META", state: "DOWN" }, 13_000).action, "none");
});

// ---- and now the half that must never happen ----

test("stale-hold net: it NEVER runs while a capture is live", () => {
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_100); // armed
  m.handle({ key: "LEFT META", state: "DOWN" }, 1_200); // dictating
  // Half a minute of total silence: a real push-to-talk hold, thinking.
  const d = m.handle({ key: "A", state: "DOWN" }, 31_000);
  assert.equal(d.action, "cancel", "the capture was intact - an emptied matcher could not have cancelled it");
  assert.deepEqual(drops, [], "nothing may be second-guessed under a live microphone");
});

test("stale-hold net: a long silent hold still STOPS on its own release, text and all", () => {
  // The false positive that would matter: judging staleness on the release would
  // turn a real, patient dictation into a press nobody heard.
  const { m } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_100); // armed
  m.handle({ key: "LEFT META", state: "DOWN" }, 1_200);
  const d = m.handle({ key: "LEFT META", state: "UP" }, 46_000); // 45 seconds later
  assert.equal(d.action, "stop", "an UP is the event that ends things; it is never distrusted");
  assert.equal(d.swallow, true, "and the swallowed Win press is still balanced by a swallowed release");
});

test("stale-hold net: hands-free is out of reach twice over - no capture to touch, no key to drop", () => {
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  m.handle({ key: "LEFT META", state: "DOWN" }, 1_010);
  m.handle({ key: "LEFT META", state: "UP" }, 1_050); // tap
  m.handle({ key: "LEFT META", state: "DOWN" }, 1_100);
  m.handle({ key: "LEFT META", state: "UP" }, 1_150); // second tap: hands-free on
  m.handle({ key: "LEFT CTRL", state: "UP" }, 1_200); // and the hand comes off entirely
  m.handle({ key: "A", state: "DOWN" }, 61_000); // a minute of hands-free dictation later
  assert.equal(m.capturing(), true, "a hands-free dictation holds no key at all: the net cannot see it");
  assert.deepEqual(drops, []);
});

test("stale-hold net: a dropped WIN cannot leave Windows with a modifier stuck down", () => {
  // The Start-menu trap runs both ways. Forgetting a key while keeping its
  // swallow record would make the NEXT real press pass through to the OS and its
  // release be swallowed - a Win key Windows believes is held forever. A
  // released press the OS never saw can at worst open a menu; this cannot.
  const { m, drops } = netMatcher();
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_000);
  m.handle({ key: "LEFT CTRL", state: "DOWN" }, 1_100); // armed
  m.handle({ key: "LEFT META", state: "DOWN" }, 1_200); // start; this DOWN is swallowed
  m.handle({ key: "LEFT META", state: "DOWN" }, 1_300); // armed too
  m.handle({ key: "A", state: "DOWN" }, 1_400); // an OS shortcut: the capture is cancelled
  assert.equal(m.capturing(), false);

  m.handle({ key: "B", state: "DOWN" }, 5_200); // both combo keys have now gone silent
  assert.deepEqual(drops, [["LEFT CTRL", "LEFT META"]]);

  // Their real releases were lost with the desktop and never arrive. A LATER
  // genuine Win press must behave like any first press.
  assert.equal(m.handle({ key: "LEFT META", state: "DOWN" }, 6_000).swallow, false, "this DOWN reaches the OS");
  assert.equal(m.handle({ key: "LEFT META", state: "UP" }, 6_100).swallow, false, "so its UP must reach it too");
});
