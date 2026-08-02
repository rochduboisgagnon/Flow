import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Security scan, LOW (2026-08-02). The three CAPTURE_* channels were the only
// ipcMain listeners in the app with no sender check: NATIVE_*, DECODE_* and
// every UI_* channel had one. All four windows share one preload, so any of
// them could have fabricated a finished dictation and had its text inserted at
// the user's cursor.
//
// The panel voted the finding down 0/3 and it was right to - no first stage
// exists today. But "unreachable" was a property of the CSP, the navigation
// block, the local-file windows and the absence of innerHTML, never of this
// code. This test is what keeps the line there once the reason for adding it
// has been forgotten.
//
// A source check rather than a runtime one, deliberately: wiring a real
// BrowserWindow into a unit test would test Electron, and the thing that can
// regress here is someone deleting a line.
// ---------------------------------------------------------------------------

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");

const GUARDED_CHANNELS = ["CAPTURE_DONE", "CAPTURE_TIMING", "CAPTURE_ERROR"];

test("every CAPTURE_* listener checks who sent the message", () => {
  for (const chan of GUARDED_CHANNELS) {
    const at = SRC.indexOf(`ipcMain.on(${chan},`);
    assert.notEqual(at, -1, `${chan} is no longer registered - update this test with the code`);
    // The guard must be the FIRST thing in the handler, before any work: a check
    // placed after the payload has been acted on is not a check.
    const body = SRC.slice(at, at + 400);
    assert.match(
      body,
      /\{\s*(\/\/[^\n]*\n\s*)*if \(!overlay\.isFrom\(ev\.sender\)\) return;/,
      `${chan} must refuse a message that did not come from the overlay, before doing anything else`,
    );
  }
});

test("EVERY ipcMain listener in index.ts checks its sender, named or not", () => {
  // Adverse review: the first version of this test looked for the literal `_ev`,
  // which is how all three read before the fix - the event named and then
  // deliberately ignored. Renaming it to `_e` would have walked straight past.
  // So this enumerates every listener in the file and demands a guard in each,
  // which is the property, rather than looking for the shape of the old bug.
  const offenders: string[] = [];
  for (const m of SRC.matchAll(/ipcMain\.on\(\s*([A-Za-z_]+)\s*,/g)) {
    const body = SRC.slice(m.index ?? 0, (m.index ?? 0) + 400);
    if (!/if \(!overlay\.isFrom\([a-zA-Z_$]+\.sender\)\) return;/.test(body)) offenders.push(m[1]);
  }
  assert.deepEqual(offenders, [], "these listeners act on a message without checking who sent it");
});
