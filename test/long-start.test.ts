import test from "node:test";
import assert from "node:assert/strict";
import { decideLongStart } from "../src/shared/longStart";

// Pure decision behind UI_LONG_START (U4a): no Electron, no NativeCapture -
// `canLoopback` is passed in exactly as main/index.ts's canLoopbackDep would
// report it (NativeCapture.available(), i.e. process.platform === "win32").

test("mic-only starts with captureSystem false, when native capture is available", () => {
  const d = decideLongStart({ source: "mic" }, true);
  assert.deepEqual(d, { ok: true, captureSystem: false, title: undefined, keepAudio: false });
});

test("both starts with captureSystem true", () => {
  const d = decideLongStart({ source: "both", title: "Weekly sync", keepAudio: true }, true);
  assert.deepEqual(d, { ok: true, captureSystem: true, title: "Weekly sync", keepAudio: true });
});

test("system (PC sound, no microphone) is refused even when native capture is available - not implemented yet", () => {
  const d = decideLongStart({ source: "system" }, true);
  assert.equal(d.ok, false);
  if (!d.ok) assert.match(d.error, /microphone/i);
});

test("every source is refused, cleanly, when native capture is unavailable (off Windows)", () => {
  for (const source of ["mic", "system", "both"]) {
    const d = decideLongStart({ source }, false);
    assert.equal(d.ok, false, `source=${source} must refuse without native capture`);
    if (!d.ok) assert.match(d.error, /native capture|Windows/i);
  }
});

test("an invalid source string is refused, not silently defaulted", () => {
  const d = decideLongStart({ source: "speaker" }, true);
  assert.equal(d.ok, false);
  if (!d.ok) assert.match(d.error, /invalid audio source/i);
});

test("missing or malformed payloads never throw", () => {
  for (const input of [undefined, null, "mic", 42, [], {}]) {
    assert.doesNotThrow(() => decideLongStart(input, true));
    const d = decideLongStart(input, true);
    assert.equal(d.ok, false);
  }
});

test("title is dropped unless it is a real string; keepAudio only true on an exact boolean true", () => {
  const d1 = decideLongStart({ source: "mic", title: 42, keepAudio: "yes" }, true);
  assert.deepEqual(d1, { ok: true, captureSystem: false, title: undefined, keepAudio: false });

  const d2 = decideLongStart({ source: "mic", title: "  ", keepAudio: true }, true);
  assert.deepEqual(d2, { ok: true, captureSystem: false, title: "  ", keepAudio: true });
});

test("extra/unknown fields on the payload are ignored rather than rejected", () => {
  const d = decideLongStart({ source: "mic", extra: "whatever" }, true);
  assert.equal(d.ok, true);
});
