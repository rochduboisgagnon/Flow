import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// B3 (plan V2): "a press, and the sound + the animation + a microphone already
// capturing always arrive together" - see overlay.ts's startCapture/startAndRefuse
// and index.ts's onStart. Both files import "electron" (BrowserWindow, screen,
// ipcMain, ...), which outside a real Electron process resolves to a path string
// rather than an object - instantiating OverlayWindow or running whenReady()'s
// callback would throw immediately. Same constraint, same technique as
// test/quit-guard.test.ts and test/ui-bridge.test.ts: read the SOURCE as text.
//
// What this file proves: the WIRING - that the guarantee's shape is actually in
// the code (startAndRefuse reuses the real startCapture and never reaches a
// WAV-producing stop(); the busy-long-recording trap now fires it; the send is
// attempted even if cosmetic positioning throws). What it does NOT prove: that
// Electron itself behaves as documented (showInactive/hide/send) - that is
// exercised by hand against the packaged app, the same way the rest of
// OverlayWindow already is (it has no other test file).
// Normalized to LF: the repo checks out CRLF on Windows, and the marker-bounded
// slice() helper below must not depend on it.
function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}
const OVERLAY_SRC = readSrc("src", "main", "overlay.ts");
const INDEX_SRC = readSrc("src", "main", "index.ts");

function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not find "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

// ---- overlay.ts: startCapture() is guarded end to end ----

const START_CAPTURE = slice(
  OVERLAY_SRC,
  "startCapture(cfg: CaptureStartPayload) {",
  "startAndRefuse(cfg: CaptureStartPayload)",
);

test("startCapture() clears any pending refusal timer before doing anything else", () => {
  assert.match(
    START_CAPTURE,
    /clearTimeout\(this\.refusalTimer\)/,
    "a stale refusal auto-cancel must not be able to cancel a later REAL press",
  );
});

test("startCapture()'s cosmetic positioning (setAlwaysOnTop/reposition/showInactive) is wrapped in its own try/catch", () => {
  assert.match(START_CAPTURE, /try\s*{\s*\n\s*this\.win\.setAlwaysOnTop/);
  assert.match(START_CAPTURE, /this\.reposition\(\)/);
  assert.match(START_CAPTURE, /this\.win\.showInactive\(\)/);
  assert.match(START_CAPTURE, /overlayShowFailed/, "the catch must be named, not silent");
});

test("startCapture() sends CAPTURE_START in its OWN try/catch, separate from the cosmetic block", () => {
  const positioningCatchAt = START_CAPTURE.indexOf("overlayShowFailed");
  const sendAt = START_CAPTURE.indexOf("webContents.send(CAPTURE_START, cfg)");
  assert.ok(positioningCatchAt > 0 && sendAt > positioningCatchAt, "the send must come AFTER the cosmetic try/catch closes");
  const sendTryAt = START_CAPTURE.lastIndexOf("try {", sendAt);
  assert.ok(sendTryAt > positioningCatchAt, "the send must open its OWN try, not share the cosmetic block's");
  const sendCatch = START_CAPTURE.slice(sendAt);
  assert.match(sendCatch, /overlaySendFailed/, "the send's catch must be named, not silent");
});

test("startCapture() never lets a cosmetic-step throw skip the CAPTURE_START send", () => {
  // The send lives in ITS OWN try block (asserted above) rather than a shared one
  // with the cosmetic calls - which is exactly what makes it unreachable-proof: a
  // throw inside the first try is fully caught before the second try ever runs.
  const catches = START_CAPTURE.match(/} catch \(err\) {/g) ?? [];
  assert.equal(catches.length, 2, "expected exactly two independent catches: positioning, then send");
});

// ---- overlay.ts: startAndRefuse() ----

const START_AND_REFUSE = slice(OVERLAY_SRC, "startAndRefuse(cfg: CaptureStartPayload) {", "stopCapture()");

test("startAndRefuse() reuses the REAL startCapture - never a parallel cue implementation", () => {
  assert.match(START_AND_REFUSE, /this\.startCapture\(cfg\)/);
});

test("startAndRefuse() self-cancels on a DEFERRED timer, not in the same tick", () => {
  // A same-tick showInactive()+hide() can paint NOTHING at all (the compositor
  // never gets a turn between the two native calls) - only a deferred cancel
  // guarantees the flash is actually visible, matching the sound (which IS
  // synchronous in the renderer, per overlay.tsx's start()).
  assert.match(START_AND_REFUSE, /setTimeout\(/);
});

test("startAndRefuse() tears down via cancelCapture(), never stopCapture() - no WAV, no engine call", () => {
  assert.match(START_AND_REFUSE, /this\.cancelCapture\(\)/);
  assert.doesNotMatch(
    START_AND_REFUSE,
    /this\.stopCapture\(\)/,
    "stopCapture() produces a WAV that reaches the ASR sidecar - a busy long recording must never trigger that",
  );
});

// ---- index.ts: the busy-long-recording trap now fires the guarantee ----

const ON_START = slice(INDEX_SRC, "onStart() {", "onStop() {");

test("onStart(): a busy long recording still fires overlay.startAndRefuse() before returning", () => {
  const busyAt = ON_START.indexOf("longRec.isBusy");
  assert.ok(busyAt > 0, "onStart must still special-case a busy long recording");
  const refuseAt = ON_START.indexOf("overlay.startAndRefuse(", busyAt);
  assert.ok(refuseAt > busyAt, "startAndRefuse must be called INSIDE the busy branch");
  const returnAt = ON_START.indexOf("return;", refuseAt);
  assert.ok(returnAt > refuseAt, "the branch must still return afterwards (no fall-through into a real capture)");
});

test("onStart(): startAndRefuse runs BEFORE the trace is abandoned, so overlayStartSent lands on the same trace", () => {
  const refuseAt = ON_START.indexOf("overlay.startAndRefuse(");
  const abandonAt = ON_START.indexOf("hotpath.abandon(HOTPATH_ABANDON_REASON.busyLongRecording)");
  assert.ok(refuseAt > 0 && abandonAt > refuseAt);
});

test("onStart(): the real (non-busy) path is untouched - still marks captureStartDecided and calls startCapture", () => {
  assert.match(ON_START, /listening = true;/);
  assert.match(ON_START, /hotpath\.mark\("captureStartDecided"\)/);
  assert.match(ON_START, /overlay\.startCapture\(\{ sounds: settings\.sounds, micDeviceId: settings\.micDeviceId \}\)/);
});

// ---- index.ts: OverlayWindow gets a logger, matching the rest of the app ----

test("index.ts constructs OverlayWindow with flowLog, matching FocusProbe/NativeCapture's own convention", () => {
  assert.match(INDEX_SRC, /new OverlayWindow\(flowLog\)/);
});
