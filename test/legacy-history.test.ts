import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { legacyHistoryInfo } from "../src/main/legacyHistory";
import { decideLaunchAtLogin } from "../src/shared/launchAtLogin";
import { sanitizeSettings, SETTINGS_DEFAULTS } from "../src/main/settings";

// U2c. Two rules the adversarial review of U2 turned into code:
//   - Flow never claims to know where data is without having looked.
//   - a dev checkout never spends the packaged app's one-time decisions.

test("U2c: nothing recorded = nothing to say", () => {
  assert.equal(legacyHistoryInfo(""), undefined);
  assert.equal(legacyHistoryInfo("   "), undefined, "a blank path is not a claim");
});

test("U2c: a folder that is really there is reported as existing", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-legacy-info-"));
  const info = legacyHistoryInfo(work);
  assert.deepEqual(info, { dir: work, exists: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test("U2c: a folder that is gone says so - the UI must never promise it is still there", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-legacy-gone-"));
  const gone = path.join(work, "moved-away");
  const info = legacyHistoryInfo(gone);
  assert.ok(info, "the path is still remembered");
  assert.equal(info.dir, gone, "and still shown, so the user knows where to look");
  assert.equal(info.exists, false, "but Flow does not pretend to find it");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U2c: an unreachable path (a share that is down) reads as not found, never as an exception", () => {
  const info = legacyHistoryInfo("D:\\Reunions", () => {
    throw new Error("EPERM"); // existsSync itself can fail on a path we may not stat
  });
  assert.deepEqual(info, { dir: "D:\\Reunions", exists: false });
});

// ---- the one-time launch-at-login decision ----

test("U2c: a DEV build writes nothing at all - it must not burn the packaged app's registration", () => {
  const d = decideLaunchAtLogin({ alreadyInitialized: false, packaged: false });
  assert.equal(d.register, false, "a checkout never writes itself into the startup entries");
  assert.equal(d.recordFlag, false, "and never records the flag: dev and prod share one settings.json");
});

test("U2c: a packaged first run registers and records, exactly once", () => {
  assert.deepEqual(decideLaunchAtLogin({ alreadyInitialized: false, packaged: true }), {
    register: true,
    recordFlag: true,
  });
  // Second boot: the flag stands, so a user who turned the toggle off stays off.
  assert.deepEqual(decideLaunchAtLogin({ alreadyInitialized: true, packaged: true }), {
    register: false,
    recordFlag: false,
  });
  assert.deepEqual(decideLaunchAtLogin({ alreadyInitialized: true, packaged: false }), {
    register: false,
    recordFlag: false,
  });
});

// ---- the two persisted facts ----

test("U2c: legacyHistoryDir and historyPurgeSuspended default to 'no special case'", () => {
  assert.equal(SETTINGS_DEFAULTS.legacyHistoryDir, "");
  assert.equal(SETTINGS_DEFAULTS.historyPurgeSuspended, false);
  assert.equal(sanitizeSettings({}).legacyHistoryDir, "");
  assert.equal(sanitizeSettings({}).historyPurgeSuspended, false);
});

test("U2c: both survive a reload, and junk falls back to the safe direction", () => {
  const s = sanitizeSettings({ legacyHistoryDir: "  D:\\Reunions  ", historyPurgeSuspended: true });
  assert.equal(s.legacyHistoryDir, "D:\\Reunions", "trimmed, otherwise kept verbatim");
  assert.equal(s.historyPurgeSuspended, true, "the suspension must not evaporate on the next boot");
  // A wrong-typed value falls back to the default like every other boolean.
  // Not a hole Flow can open on its own: the pair is written together by the
  // migration capture and cleared together by the Settings button, so
  // "suspended but no folder" is never a state this app produces.
  assert.equal(sanitizeSettings({ historyPurgeSuspended: "yes" }).historyPurgeSuspended, false);
  assert.equal(sanitizeSettings({ legacyHistoryDir: 42 }).legacyHistoryDir, "");
  // Resuming cleanup clears both, and that survives too.
  const resumed = sanitizeSettings({ legacyHistoryDir: "", historyPurgeSuspended: false });
  assert.equal(resumed.legacyHistoryDir, "");
  assert.equal(resumed.historyPurgeSuspended, false);
});
