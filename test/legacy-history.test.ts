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

// ---- le fait persiste, apres B3d : il n'en reste qu'UN ----
//
// `historyPurgeSuspended` est parti avec la purge qu'il suspendait. Il etait
// ecrit et effacé EN PAIRE avec `legacyHistoryDir`, ce qui rendait l'etat
// « suspendu sans dossier » impossible a produire ; sans purge, la moitie qui
// reste n'a plus de paire a tenir et le dossier se suffit a lui-meme.

test("B3d: legacyHistoryDir - le seul fait qui reste, et il survit a un rechargement", () => {
  assert.equal(SETTINGS_DEFAULTS.legacyHistoryDir, "");
  assert.equal(sanitizeSettings({}).legacyHistoryDir, "");
  const s = sanitizeSettings({ legacyHistoryDir: "  D:\\Reunions  " });
  assert.equal(s.legacyHistoryDir, "D:\\Reunions", "trimmed, otherwise kept verbatim");
  // Une valeur mal typee retombe sur le defaut, comme partout ailleurs.
  assert.equal(sanitizeSettings({ legacyHistoryDir: 42 }).legacyHistoryDir, "");
  // Et le vider est une valeur en soi : « cette machine n'est plus un cas
  // particulier ».
  assert.equal(sanitizeSettings({ legacyHistoryDir: "" }).legacyHistoryDir, "");
});

test("B3d: le reglage de purge n'existe plus - la purge non plus", () => {
  // Un reglage qui ne fait plus rien serait pire que pas de reglage : ce serait
  // une interface qui ment. Ce test refuse son retour par distraction.
  assert.equal("historyPurgeSuspended" in SETTINGS_DEFAULTS, false);
  assert.equal("historyPurgeSuspended" in sanitizeSettings({ historyPurgeSuspended: true }), false);
});
