import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// U4 (blocking review): quitting mid-recording. Two halves, and both live in
// files that import "electron" and therefore cannot be instantiated outside a
// real Electron process (same constraint, and the same technique, as
// test/ui-bridge.test.ts and test/long-ipc-parity.test.ts): what the rescue
// DOES is tested for real in test/longform-rescue.test.ts, against a temporary
// data folder; what is checked here is that the app actually calls it, in the
// right order, and that the tray no longer quits through a live recording
// without a word.
//
// What this file proves: the wiring. What it does not: the behaviour of the
// functions being wired - that is longform-rescue's job, deliberately.
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");
const TRAY_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "tray.ts"), "utf8");

function beforeQuitBlock(): string {
  const start = INDEX_SRC.indexOf('app.on("before-quit"');
  assert.ok(start >= 0, "index.ts must still have a before-quit handler");
  const rest = INDEX_SRC.slice(start);
  const end = rest.indexOf("\n});");
  assert.ok(end > 0, "could not find the end of the before-quit handler");
  return rest.slice(0, end);
}

test("U4-1: before-quit files the recording into the archive before tearing anything down", () => {
  const block = beforeQuitBlock();
  const rescue = block.indexOf("longRec.rescueOnQuit()");
  assert.ok(rescue > 0, "before-quit must rescue a recording in flight (stop() only LAUNCHES finalize)");

  // Order matters: the rescue reads the transcript path, the staging folder and
  // the audio stream. Destroying the capture window or the API first would not
  // corrupt it, but the sidecar and the api are what a future edit is most
  // likely to slip above it - assert the shape now, while it is intentional.
  for (const teardown of ["nativeCapture.destroy()", "sidecar?.stop()", "api?.stop()"]) {
    const at = block.indexOf(teardown);
    assert.ok(at > 0, `before-quit should still tear down ${teardown}`);
    assert.ok(at > rescue, `${teardown} must come AFTER the recording is filed, not before`);
  }

  // stop() from here would only start an async finalize the dying process never
  // finishes - the exact bug. It must not come back.
  assert.ok(
    !/longRec\.stop\(\)/.test(block),
    "before-quit must never call longRec.stop(): Electron awaits nothing a quit handler starts",
  );
});

test("B3b: la connexion sauve les reunions interrompues, et l'audio inachve reprend", () => {
  // U4-1 attendait un balayage du dossier `staging/` AVANT que quoi que ce soit
  // puisse demarrer un nouvel enregistrement par-dessus. Le dossier a disparu,
  // et avec lui la course qu'il fallait eviter : une reunion interrompue est
  // maintenant une LIGNE ouverte, et deux lignes ne se marchent pas dessus.
  //
  // Ce qui reste a exiger est donc l'endroit : les deux sauvetages partent du
  // chargement du compte, parce qu'avant la connexion il n'y a rien a lire.
  const at = INDEX_SRC.indexOf("async function loadAccountData()");
  assert.ok(at > 0, "loadAccountData a change de nom : verifier ou les sauvetages doivent vivre");
  const body = INDEX_SRC.slice(at, INDEX_SRC.indexOf("\n}\n", at));
  assert.match(body, /longRec\.rescueAbandoned\(\)/, "un plantage ne passe jamais par before-quit");
  assert.match(body, /audioUploads\.resumePending\(\)/, "et un televersement de 115 Mo coupe doit reprendre");
  // Aucun des deux ne retient la connexion : `void`, jamais `await`.
  assert.match(body, /void longRec\.rescueAbandoned\(\)/);
  assert.match(body, /void audioUploads\.resumePending\(\)/);
});

test("U4-1: Quit Flow consults the same isBusy the updater does, instead of quitting blind", () => {
  assert.match(TRAY_SRC, /label: "Quit Flow", click: \(\) => this\.quit\(\)/, "the menu item must go through the guard");
  const quit = TRAY_SRC.slice(TRAY_SRC.indexOf("private quit()"));
  const guarded = quit.slice(0, quit.indexOf("private confirmQuit"));
  assert.match(guarded, /this\.deps\.isRecording\(\)/, "the guard must ask whether a recording is running");
  assert.match(guarded, /app\.quit\(\)/, "and still quit when the answer is no (or the user confirms)");
  assert.ok(
    !/click: \(\) => app\.quit\(\)/.test(TRAY_SRC),
    "no menu item may call app.quit() straight through a live recording",
  );
});

test("U4-1: the confirmation is a real, parented, safe-by-default dialog", () => {
  const confirm = TRAY_SRC.slice(TRAY_SRC.indexOf("private confirmQuit()"));
  assert.match(confirm, /dialog\.showMessageBoxSync\(parent, opts\)/, "parented to the main window when there is one");
  assert.match(confirm, /cancelId: 0/, "Esc must be the safe answer");
  assert.match(confirm, /defaultId: 0/, "and so must the default button");
  assert.match(confirm, /buttons: \["Keep recording", "Quit anyway"\]/);
  // It has to say what quitting costs, not just ask a yes/no question.
  assert.match(confirm, /no summary/);
});

test("U4-1: index.ts hands the tray the engine's own busy flag, not a re-derived one", () => {
  const trayBlock = INDEX_SRC.slice(INDEX_SRC.indexOf("tray = new FlowTray({"));
  assert.match(
    trayBlock.slice(0, 1200),
    /isRecording: \(\) => longRec\.isBusy/,
    "the tray must read longRec.isBusy - the same value engineBusy() and the updater use",
  );
});
