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

// B4b moved the two log counters ONE CONSTRUCT UP. flowLog() no longer writes
// anything itself - it pushes into the buffered queue (src/shared/logQueue.ts),
// whose write is asynchronous - so a failure of that write can no longer be
// reported from inside flowLog(). It is reported by the queue's onFailure hook,
// declared where the queue is built. Same two names, same rule; the two tests
// below therefore anchor on the queue's construction rather than on flowLog's
// (now empty of I/O) body.
const LOG_FAILURE_HOOK = INDEX_SRC.slice(
  INDEX_SRC.indexOf("const logQueue = new LogQueue("),
  INDEX_SRC.indexOf("function flowLog(msg: string)"),
);

test("index.ts: the engine log names BOTH of its failures (rotate, and the write itself)", () => {
  assert.ok(LOG_FAILURE_HOOK.length > 0, "flowLog must go through the buffered queue (B4b)");
  assert.match(LOG_FAILURE_HOOK, /SILENT_FAILURE\.flowLogRotateFailed/);
  assert.match(LOG_FAILURE_HOOK, /SILENT_FAILURE\.flowLogWriteFailed/);
});

test("index.ts: the log's own write failure never calls flowLog to report it", () => {
  // By construction flowLog cannot log its own failure to write - the counter
  // is the ONLY signal. Assert the failure hook contains no flowLog(...) call.
  assert.match(LOG_FAILURE_HOOK, /flowLogWriteFailed/);
  assert.doesNotMatch(LOG_FAILURE_HOOK, /flowLog\(/, "must not attempt to log its own logging failure");
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

test("the closed vocabulary keeps its two names for insert.ts and focus/probe.ts", () => {
  // Named once, wired by the follow-up (see the two tests below) - never a
  // second, differently-spelled name for the same fact.
  assert.equal(SILENT_FAILURE.clipboardImageReadFailed, "clipboard-image-read-failed");
  assert.equal(SILENT_FAILURE.focusProbeUnavailable, "focus-probe-unavailable");
});

// B6 completion: the two names above were declared but left unwired. These are
// the catches they belong to.

test("insert.ts: the readImage catch is counted, and deliberately STAYS silent", () => {
  const src = readSrc("src", "main", "insert.ts");
  const at = src.indexOf("function snapshotClipboard()");
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /SILENT_FAILURE\.clipboardImageReadFailed/);
  // It runs once per pasted dictation, ON the hot path: a log line here would
  // put a write under every insertion. The counter is the whole signal.
  assert.doesNotMatch(body, /\blog\?\.\(|flowLog\(/, "this one must not gain a per-dictation log line");
});

test("focus/probe.ts: a probe that cannot start is counted, and logged ONCE", () => {
  const src = readSrc("src", "main", "focus", "probe.ts");
  assert.match(src, /SILENT_FAILURE\.focusProbeUnavailable/);
  // Counting every time but logging once: the cause is a single failed spawn,
  // and one line per dictation would bury the log without adding a fact.
  const at = src.indexOf("private noteUnavailable(");
  assert.ok(at > 0, "the count/log-once decision must live in one named place");
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  assert.match(body, /reportedUnavailable/);
  assert.match(body, /silentFailures\.increment\(/);
});
