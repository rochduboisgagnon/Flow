import { test } from "node:test";
import assert from "node:assert/strict";
import { OverlayVisibility } from "../src/main/overlayVisibility";

// Bug (Roch): re-pressing PTT while the previous utterance is still finalizing made the OLD
// flowDone() hide the NEW capture, so "sometimes the animation does not show on press".

test("re-press during finalize keeps the overlay up (the reported bug)", () => {
  const v = new OverlayVisibility();
  v.onStart(); // A: press, overlay shown
  v.onStop(); //  A: release, A now transcribing (pending)
  v.onStart(); // B: press again before A's pipeline finished, overlay shown for B
  assert.equal(v.onDone(), false, "A's flowDone must NOT hide while B is actively capturing");
  v.onStop(); //  B: release
  assert.equal(v.onDone(), true, "B's flowDone hides once nothing is live");
});

test("two quick utterances finishing out of order: hide only after BOTH are done", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop(); // A pending
  v.onStart();
  v.onStop(); // B pending (two in flight)
  assert.equal(v.onDone(), false, "first flowDone: the other utterance is still in flight");
  assert.equal(v.onDone(), true, "second flowDone: nothing left, hide");
});

test("a simple dictation still hides normally", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop();
  assert.equal(v.onDone(), true);
});

test("a tap/cancel while a previous utterance transcribes does not yank the overlay", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop(); // A transcribing
  v.onStart(); // B: quick tap...
  assert.equal(v.onCancel(), false, "cancel must not hide while A is still in flight");
  assert.equal(v.onDone(), true, "A's flowDone then hides");
});

test("a lone tap/cancel hides", () => {
  const v = new OverlayVisibility();
  v.onStart();
  assert.equal(v.onCancel(), true);
});

test("safety timeout hides a stuck pipeline, but yields to an active press", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop(); // A pending, then its pipeline hangs (no onDone)
  assert.equal(v.onSafetyTimeout(), true, "stuck A: force hide");

  const v2 = new OverlayVisibility();
  v2.onStart();
  v2.onStop();
  v2.onStart(); // B is actively capturing when the (A) safety timer fires
  assert.equal(v2.onSafetyTimeout(), false, "must not hide from under an active press");
});
