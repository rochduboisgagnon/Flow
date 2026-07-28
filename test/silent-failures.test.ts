import test from "node:test";
import assert from "node:assert/strict";
import { SILENT_FAILURE, SilentFailureCounters } from "../src/shared/silentFailures";

test("increment() starts every name at 0 and counts only what was incremented", () => {
  const c = new SilentFailureCounters();
  const snap = c.snapshot();
  for (const name of Object.values(SILENT_FAILURE)) {
    assert.equal(snap[name], 0, `${name} must start at 0`);
  }
});

test("increment() is a plain per-name tally, independent across names", () => {
  const c = new SilentFailureCounters();
  c.increment(SILENT_FAILURE.overlaySendFailed);
  c.increment(SILENT_FAILURE.overlaySendFailed);
  c.increment(SILENT_FAILURE.flowLogWriteFailed);
  const snap = c.snapshot();
  assert.equal(snap[SILENT_FAILURE.overlaySendFailed], 2);
  assert.equal(snap[SILENT_FAILURE.flowLogWriteFailed], 1);
  assert.equal(snap[SILENT_FAILURE.overlayShowFailed], 0, "an unrelated name must not move");
});

test("snapshot() is a defensive copy: mutating it never corrupts internal state", () => {
  const c = new SilentFailureCounters();
  c.increment(SILENT_FAILURE.probeWavLoadFailed);
  const snap1 = c.snapshot();
  (snap1 as Record<string, number>)[SILENT_FAILURE.probeWavLoadFailed] = 999;
  const snap2 = c.snapshot();
  assert.equal(snap2[SILENT_FAILURE.probeWavLoadFailed], 1);
});

test("every closed-vocabulary name is a stable, human-readable kebab-case string", () => {
  for (const name of Object.values(SILENT_FAILURE)) {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/, `${name} must be kebab-case, not a free-form message`);
  }
  // No two entries may collide on the same wire value.
  const values = Object.values(SILENT_FAILURE);
  assert.equal(new Set(values).size, values.length, "every counter name must be unique");
});

test("clear() resets every name back to 0 (tests only - production never calls it)", () => {
  const c = new SilentFailureCounters();
  c.increment(SILENT_FAILURE.overlayListMicsFailed);
  c.clear();
  const snap = c.snapshot();
  for (const name of Object.values(SILENT_FAILURE)) {
    assert.equal(snap[name], 0);
  }
});

test("zero retention: snapshot() never carries anything beyond a name and a count", () => {
  const c = new SilentFailureCounters();
  c.increment(SILENT_FAILURE.clipboardImageReadFailed);
  const snap = c.snapshot();
  for (const [name, value] of Object.entries(snap)) {
    assert.equal(typeof name, "string");
    assert.equal(typeof value, "number");
    // A count can never be negative or fractional - if it were, something
    // other than increment() must have touched the map.
    assert.ok(Number.isInteger(value) && value >= 0);
  }
});
