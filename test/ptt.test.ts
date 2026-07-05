import test from "node:test";
import assert from "node:assert/strict";
import { createPtt } from "../src/shared/ptt";

const MIN = 200;

test("hold then release: start then stop", () => {
  const p = createPtt(MIN);
  assert.equal(p.down(1000), "start");
  assert.equal(p.recording(), true);
  assert.equal(p.up(1600), "stop");
  assert.equal(p.recording(), false);
});

test("Windows auto-repeat DOWNs while held are ignored", () => {
  const p = createPtt(MIN);
  assert.equal(p.down(1000), "start");
  assert.equal(p.down(1030), "none");
  assert.equal(p.down(1060), "none");
  assert.equal(p.up(1500), "stop");
});

test("accidental tap under the threshold cancels, never stops", () => {
  const p = createPtt(MIN);
  assert.equal(p.down(1000), "start");
  assert.equal(p.up(1100), "cancel"); // 100 ms < 200 ms
  assert.equal(p.recording(), false);
});

test("exact threshold counts as a real hold", () => {
  const p = createPtt(MIN);
  p.down(1000);
  assert.equal(p.up(1200), "stop");
});

test("stray release with no press is a no-op", () => {
  const p = createPtt(MIN);
  assert.equal(p.up(1000), "none");
});

test("full cycle works repeatedly", () => {
  const p = createPtt(MIN);
  for (let i = 0; i < 3; i++) {
    const t = i * 10_000;
    assert.equal(p.down(t), "start");
    assert.equal(p.up(t + 500), "stop");
  }
});
