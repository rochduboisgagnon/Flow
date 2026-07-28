import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SILENT_FAILURE } from "../src/shared/silentFailures";

// B6 (plan V2): every silent catch on the dictation hot path must increment a
// NAMED counter. The counters themselves are pure and tested for real in
// test/silent-failures.test.ts; what THIS file proves is that the catch sites
// in overlay.ts and index.ts actually call increment() with the right name -
// same source-as-text technique as test/overlay-cue-guarantee.test.ts and
// test/quit-guard.test.ts (both files import "electron").
// Normalized to LF: the repo checks out CRLF on Windows, and a raw "\n}\n"
// boundary search (see the marker-bounded tests below) must not depend on it.
function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}
const OVERLAY_SRC = readSrc("src", "main", "overlay.ts");
const INDEX_SRC = readSrc("src", "main", "index.ts");
const HOTPATH_SRC = readSrc("src", "shared", "hotpath.ts");

test("overlay.ts: listMics() names its catch instead of swallowing silently", () => {
  const at = OVERLAY_SRC.indexOf("async listMics(");
  assert.ok(at > 0);
  const body = OVERLAY_SRC.slice(at, at + 800);
  assert.match(body, /SILENT_FAILURE\.overlayListMicsFailed/);
  assert.match(body, /silentFailures\.increment\(/);
});

test("index.ts: loadProbeWav() names its catch instead of swallowing silently", () => {
  const at = INDEX_SRC.indexOf("function loadProbeWav()");
  assert.ok(at > 0);
  const end = INDEX_SRC.indexOf("\n}\n", at);
  const body = INDEX_SRC.slice(at, end);
  assert.match(body, /SILENT_FAILURE\.probeWavLoadFailed/);
  assert.match(body, /silentFailures\.increment\(/);
});

test("index.ts: flowLog() names BOTH of its own catches (rotate, and the write itself)", () => {
  const at = INDEX_SRC.indexOf("function flowLog(msg: string)");
  assert.ok(at > 0);
  const end = INDEX_SRC.indexOf("\n}\n", at);
  const body = INDEX_SRC.slice(at, end);
  assert.match(body, /SILENT_FAILURE\.flowLogRotateFailed/);
  assert.match(body, /SILENT_FAILURE\.flowLogWriteFailed/);
});

test("index.ts: flowLog's outer catch (the write itself failing) never calls flowLog to report it", () => {
  // By construction flowLog cannot log its own failure to write - the counter
  // is the ONLY signal. Assert the outer catch block has no flowLog(...) call.
  const at = INDEX_SRC.indexOf("function flowLog(msg: string)");
  const end = INDEX_SRC.indexOf("\n}\n", at);
  const body = INDEX_SRC.slice(at, end);
  const outerCatchAt = body.indexOf("flowLogWriteFailed");
  assert.ok(outerCatchAt > 0);
  const afterOuterCatch = body.slice(outerCatchAt);
  assert.doesNotMatch(afterOuterCatch, /flowLog\(/, "must not attempt to log its own logging failure");
});

test("overlay.ts's two new startCapture() catches defer their log write off the synchronous call stack", () => {
  // These two run inside the chain reachable from HotkeyAdapter's raw, un-guarded
  // key-event callback - a synchronous flowLog() there would put real disk I/O
  // (fs.appendFileSync) on the exact stack B1's hook-timeout budget protects.
  const at = OVERLAY_SRC.indexOf("startCapture(cfg: CaptureStartPayload) {");
  const end = OVERLAY_SRC.indexOf("startAndRefuse(cfg: CaptureStartPayload)");
  const body = OVERLAY_SRC.slice(at, end);
  const setImmediateCalls = body.match(/setImmediate\(\(\) => this\.log\?\.\(/g) ?? [];
  assert.equal(setImmediateCalls.length, 2, "both new catches (show, send) must defer their log line");
});

test("shared/hotpath.ts: HotpathSnapshot exposes silentFailureCounts, riding the EXISTING channel", () => {
  assert.match(HOTPATH_SRC, /silentFailureCounts:\s*Record<SilentFailureName, number>/);
  assert.match(HOTPATH_SRC, /silentFailureCounts:\s*silentFailures\.snapshot\(\)/);
});

test("the closed vocabulary documents the two catches this task could NOT wire (outside its touchable files)", () => {
  // insert.ts and focus/probe.ts are outside this task's file whitelist -
  // named here so a follow-up only has to import and call increment(), never
  // invent a new name.
  assert.equal(SILENT_FAILURE.clipboardImageReadFailed, "clipboard-image-read-failed");
  assert.equal(SILENT_FAILURE.focusProbeUnavailable, "focus-probe-unavailable");
});
