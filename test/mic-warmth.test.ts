import test from "node:test";
import assert from "node:assert/strict";
import {
  PcmRing,
  preRollSamples,
  warmPolicy,
  isMicPrewarm,
  PRE_ROLL_MS,
  WARM_HOLD_MS,
} from "../src/shared/micWarmth";

// B2 (plan V2): the microphone pre-warm and pre-roll POLICY. The audio graph
// itself lives in the overlay renderer and needs a real microphone, a real
// AudioContext and a real window; every RULE that bounds it lives here, where
// it can be proven without any of the three.
//
// What these tests defend is not performance - it is the four promises the
// Settings text makes to the user: bounded in time, bounded in size, never
// written down, erased when unused.

// ---- PcmRing: bounded in size, BY CONSTRUCTION ----

function frame(n: number, fill = 1): Float32Array {
  return new Float32Array(n).fill(fill);
}

test("PcmRing never holds more samples than its capacity, however much is pushed", () => {
  const ring = new PcmRing(1000);
  for (let i = 0; i < 500; i++) {
    ring.push(frame(128));
    assert.ok(ring.size <= 1000, `overflowed at push ${i}: ${ring.size}`);
  }
  assert.equal(ring.size, 1000, "at steady state it is exactly full, never more");
});

test("PcmRing trims the OLDEST frame partially rather than overshooting the cap", () => {
  // 100-sample cap, 60-sample frames: after three pushes the ring must hold the
  // most recent 100 samples, which means cutting into the oldest frame.
  const ring = new PcmRing(100);
  ring.push(frame(60, 1));
  ring.push(frame(60, 2));
  assert.equal(ring.size, 100);
  ring.push(frame(60, 3));
  assert.equal(ring.size, 100);
  const kept = ring.drain();
  const total = kept.reduce((n, f) => n + f.length, 0);
  assert.equal(total, 100);
  // The newest audio is the audio that survives: the tail must be the 3s.
  assert.equal(kept[kept.length - 1][0], 3);
});

test("PcmRing with capacity 0 - what the 'off' setting compiles down to - never holds a sample", () => {
  const ring = new PcmRing(0);
  for (let i = 0; i < 100; i++) ring.push(frame(128));
  assert.equal(ring.size, 0);
  assert.deepEqual(ring.drain(), [], "nothing to hand over, because nothing was ever kept");
});

test("PcmRing.drain hands the audio over AND empties itself in one step", () => {
  const ring = new PcmRing(1000);
  ring.push(frame(128));
  ring.push(frame(128));
  const first = ring.drain();
  assert.equal(first.length, 2);
  assert.equal(ring.size, 0, "a drained ring keeps no copy: the pre-roll is consumed exactly once");
  assert.deepEqual(ring.drain(), [], "and a second drain finds nothing");
});

test("PcmRing.clear erases everything without changing what the ring can hold", () => {
  const ring = new PcmRing(500);
  ring.push(frame(400));
  ring.clear();
  assert.equal(ring.size, 0);
  ring.push(frame(400));
  assert.equal(ring.size, 400, "still usable, still capped at 500");
});

test("PcmRing ignores empty frames instead of accumulating them", () => {
  const ring = new PcmRing(100);
  ring.push(new Float32Array(0));
  assert.equal(ring.size, 0);
});

// ---- preRollSamples: never generous ----

test("preRollSamples converts milliseconds to samples and FLOORS", () => {
  assert.equal(preRollSamples(500, 16_000), 8000);
  assert.equal(preRollSamples(1, 16_000), 16);
  // 0.7 ms at 16 kHz is 11.2 samples: 11, never 12. The pre-roll must never be
  // longer than the duration the user was told about.
  assert.equal(preRollSamples(0.7, 16_000), 11);
});

test("preRollSamples answers 0 for anything that is not a positive duration", () => {
  assert.equal(preRollSamples(0, 16_000), 0);
  assert.equal(preRollSamples(-100, 16_000), 0);
  assert.equal(preRollSamples(NaN, 16_000), 0);
  assert.equal(preRollSamples(Infinity, 16_000), 0);
});

// ---- warmPolicy: the ONE translation from setting to behaviour ----

test("warmPolicy('off') is null - no warm microphone and no ring to hold anything", () => {
  assert.equal(warmPolicy("off", ""), null);
  assert.equal(warmPolicy("off", "some-device-id"), null);
});

test("warmPolicy('after') holds the microphone for a bounded time, with the plan's pre-roll", () => {
  const p = warmPolicy("after", "device-1");
  assert.deepEqual(p, { micDeviceId: "device-1", preRollMs: PRE_ROLL_MS, holdMs: WARM_HOLD_MS });
  assert.equal(PRE_ROLL_MS, 500, "the plan's §3.4 number");
  assert.ok(typeof p?.holdMs === "number" && p.holdMs > 0 && p.holdMs <= 10_000);
});

test("warmPolicy('always') expresses 'never release' as null, never as a huge number", () => {
  const p = warmPolicy("always", "");
  assert.equal(p?.holdMs, null, "a distinct value: no arithmetic can turn it into a finite delay");
  assert.equal(p?.preRollMs, PRE_ROLL_MS, "the pre-roll is the same size in every mode");
});

test("warmPolicy carries the chosen microphone through, so a device change can release the graph", () => {
  assert.equal(warmPolicy("after", "abc")?.micDeviceId, "abc");
  assert.equal(warmPolicy("always", "")?.micDeviceId, "", "'' means the system default, and is a real value");
});

test("isMicPrewarm accepts exactly the three modes and nothing else", () => {
  for (const ok of ["off", "after", "always"]) assert.equal(isMicPrewarm(ok), true, ok);
  for (const bad of ["", "on", "true", null, undefined, 1, {}]) assert.equal(isMicPrewarm(bad), false);
});
