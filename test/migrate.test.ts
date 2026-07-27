import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DATA_DIR_NEW,
  DATA_DIR_OLD,
  FLOW_REMOVED_MARKER,
  MANAGED_APP_EXE,
  MANAGER_DIR,
  MODELS_ROOT_NEW,
  MODELS_ROOT_OLD,
  nodeFs,
  resolveDataDir,
  resolveModelsRoot,
  runMigration,
  type MigrationFs,
} from "../src/main/migrate";

// A5. This suite NEVER touches the real ~/ or %LOCALAPPDATA%: every case builds
// a throwaway "machine" under os.tmpdir() with its own home + local-app-data,
// so a bug here can only ever destroy a temp folder. The one thing the tests
// must prove is the safety property: user data is either moved atomically or
// left exactly where it was, and Flow keeps booting either way.

interface Machine {
  root: string;
  home: string;
  local: string;
}

function machine(tag: string): Machine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flow-migrate-${tag}-`));
  const home = path.join(root, "home");
  const local = path.join(root, "local");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  return { root, home, local };
}

function cleanup(m: Machine): void {
  fs.rmSync(m.root, { recursive: true, force: true });
}

/** A machine that still carries the 0.22.0 layout: old data folder with a real
 * settings file, old model store with a (fake) model, managed AGR Manager
 * install. Nothing is running: no api.json unless a test writes one. */
function seedOldLayout(m: Machine): { oldData: string; oldModels: string; managedDir: string } {
  const oldData = path.join(m.home, DATA_DIR_OLD);
  fs.mkdirSync(oldData, { recursive: true });
  fs.writeFileSync(path.join(oldData, "settings.json"), JSON.stringify({ language: "fr", micDeviceId: "abc" }));
  const oldModels = path.join(m.local, MODELS_ROOT_OLD, "models");
  fs.mkdirSync(oldModels, { recursive: true });
  fs.writeFileSync(path.join(oldModels, "ggml-large-v3-turbo-q5_0.bin"), "not really 547 MB");
  const managedDir = path.join(m.local, MANAGER_DIR, "AGR Flow");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(path.join(managedDir, MANAGED_APP_EXE), "MZ");
  fs.writeFileSync(path.join(managedDir, "installed-version.txt"), "0.22.0");
  return { oldData, oldModels, managedDir };
}

/** Deterministic defaults: nothing is alive, nothing answers, no real waiting. */
function quietOpts(m: Machine) {
  return {
    home: m.home,
    localAppData: m.local,
    selfVersion: "1.0.0",
    selfPid: process.pid,
    isAlive: () => false,
    requestQuit: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    graceMs: 0,
  };
}

// ---- resolution (pure, no side effects) ----

test("A5: resolveDataDir prefers ~/.flow, falls back to ~/.agr-flow, defaults to ~/.flow", () => {
  const m = machine("resolve");
  // Fresh install: nothing on disk yet -> the new name.
  assert.equal(resolveDataDir(m.home), path.join(m.home, DATA_DIR_NEW));
  // Not migrated yet (or a rename that failed): keep using the old folder.
  fs.mkdirSync(path.join(m.home, DATA_DIR_OLD));
  assert.equal(resolveDataDir(m.home), path.join(m.home, DATA_DIR_OLD));
  // Both present: the new one always wins.
  fs.mkdirSync(path.join(m.home, DATA_DIR_NEW));
  assert.equal(resolveDataDir(m.home), path.join(m.home, DATA_DIR_NEW));
  cleanup(m);
});

test("A5: resolveModelsRoot follows the same rule (a wrong answer = 1.6 GB re-downloaded)", () => {
  const m = machine("resolve-models");
  assert.equal(resolveModelsRoot(m.local), path.join(m.local, MODELS_ROOT_NEW));
  fs.mkdirSync(path.join(m.local, MODELS_ROOT_OLD));
  assert.equal(resolveModelsRoot(m.local), path.join(m.local, MODELS_ROOT_OLD));
  fs.mkdirSync(path.join(m.local, MODELS_ROOT_NEW));
  assert.equal(resolveModelsRoot(m.local), path.join(m.local, MODELS_ROOT_NEW));
  cleanup(m);
});

test("A5: resolution never creates anything on disk (settings.ts imports it from pure tests)", () => {
  const m = machine("readonly");
  resolveDataDir(m.home);
  resolveModelsRoot(m.local);
  assert.deepEqual(fs.readdirSync(m.home), []);
  assert.deepEqual(fs.readdirSync(m.local), []);
  cleanup(m);
});

// ---- fresh install ----

test("A5: a fresh install does nothing at all and points at the new folders", async () => {
  const m = machine("fresh");
  const out = await runMigration(quietOpts(m));
  assert.deepEqual(out.logs, [], "a clean machine must not write a single migration log line");
  assert.equal(out.dataDir, path.join(m.home, DATA_DIR_NEW));
  assert.equal(out.modelsRoot, path.join(m.local, MODELS_ROOT_NEW));
  assert.equal(out.dataMoved, false);
  assert.equal(out.modelsMoved, false);
  assert.equal(out.managedInstallRemoved, false);
  // And it stayed read-only: nothing was created just by asking.
  assert.deepEqual(fs.readdirSync(m.home), []);
  cleanup(m);
});

// ---- the real migration ----

test("A5: a managed 0.22.0 machine migrates data + models and loses the managed install", async () => {
  const m = machine("full");
  const { oldData, oldModels, managedDir } = seedOldLayout(m);

  const out = await runMigration(quietOpts(m));

  const newData = path.join(m.home, DATA_DIR_NEW);
  const newModels = path.join(m.local, MODELS_ROOT_NEW);
  assert.equal(out.dataMoved, true);
  assert.equal(out.modelsMoved, true);
  assert.equal(out.managedInstallRemoved, true);
  assert.equal(out.dataDir, newData);
  assert.equal(out.modelsRoot, newModels);

  // The settings survived the move byte for byte, and the old names are gone.
  const moved = JSON.parse(fs.readFileSync(path.join(newData, "settings.json"), "utf8")) as { micDeviceId: string };
  assert.equal(moved.micDeviceId, "abc");
  assert.equal(fs.existsSync(oldData), false);
  assert.equal(fs.existsSync(oldModels), false);
  assert.ok(fs.existsSync(path.join(newModels, "models", "ggml-large-v3-turbo-q5_0.bin")), "the model came along");
  assert.equal(fs.existsSync(managedDir), false);

  // The watchdog marker is written BEFORE anything is torn down, otherwise AGR
  // Manager reinstalls Flow within ~30 s.
  const marker = path.join(m.local, MANAGER_DIR, FLOW_REMOVED_MARKER);
  assert.ok(fs.existsSync(marker), "flow-removed.txt neutralizes the old Manager watchdog");
  assert.match(fs.readFileSync(marker, "utf8").trim(), /^\d{4}-\d{2}-\d{2}T.*Z$/, "an ISO timestamp");
  cleanup(m);
});

test("A5: the still-running old engine is asked to quit before anything moves", async () => {
  const m = machine("quit");
  const { oldData } = seedOldLayout(m);
  fs.writeFileSync(
    path.join(oldData, "api.json"),
    JSON.stringify({ app: "agr-flow", port: 8176, pid: 4242, version: "0.22.0" }),
  );

  const order: string[] = [];
  let alive = true;
  const out = await runMigration({
    ...quietOpts(m),
    isAlive: (pid) => {
      assert.equal(pid, 4242);
      return alive;
    },
    requestQuit: (port) => {
      order.push(`quit:${port}`);
      alive = false; // it obeys, like the real /quit handler does
      return Promise.resolve(true);
    },
  });

  assert.deepEqual(order, ["quit:8176"], "POST /quit went to the port advertised in api.json");
  assert.equal(out.dataMoved, true, "the move only happens once the old engine is gone");
  assert.ok(out.logs.some((l) => l.includes("asking the previous engine to quit")));
  cleanup(m);
});

test("A5: an old engine that refuses to die freezes the migration instead of moving its folders", async () => {
  const m = machine("stubborn");
  const { oldData, oldModels, managedDir } = seedOldLayout(m);
  fs.writeFileSync(
    path.join(oldData, "api.json"),
    JSON.stringify({ app: "agr-flow", port: 8176, pid: 4242, version: "0.22.0" }),
  );

  const out = await runMigration({
    ...quietOpts(m),
    isAlive: () => true, // never dies
    requestQuit: () => Promise.resolve(true),
    quitTimeoutMs: 300,
  });

  assert.equal(out.dataMoved, false);
  assert.equal(out.modelsMoved, false);
  assert.equal(out.managedInstallRemoved, false, "nothing is deleted while it may still be running");
  assert.ok(fs.existsSync(path.join(oldData, "settings.json")), "the user's settings are untouched");
  assert.ok(fs.existsSync(oldModels));
  assert.ok(fs.existsSync(managedDir));
  assert.equal(out.dataDir, oldData, "the app keeps using the old folder this boot");
  assert.ok(out.logs.some((l) => l.includes("still running")));
  cleanup(m);
});

test("A5: api.json from our own version is never sent /quit (that would kill this very boot)", async () => {
  const m = machine("self");
  const { oldData } = seedOldLayout(m);
  fs.writeFileSync(
    path.join(oldData, "api.json"),
    JSON.stringify({ app: "flow", port: 8176, pid: 999_999, version: "1.0.0" }),
  );

  let quits = 0;
  const out = await runMigration({
    ...quietOpts(m),
    isAlive: () => true,
    requestQuit: () => {
      quits++;
      return Promise.resolve(true);
    },
  });

  assert.equal(quits, 0, "we do not shut ourselves down");
  assert.equal(out.dataMoved, true);
  cleanup(m);
});

test("A10: our own api.json in one folder does NOT end the search - the live old engine in the next folder is still found and stopped", async () => {
  // The exact hole the adversarial review confirmed: a previous 1.0.0 boot left
  // OUR file in ~/.flow while the 0.22.0 engine is alive and advertised in
  // ~/.agr-flow. The original code returned "nothing runs" at the first
  // self-file and renamed the data folder under the living engine.
  const m = machine("self-then-old");
  const { oldData } = seedOldLayout(m);
  const newData = path.join(m.home, DATA_DIR_NEW);
  fs.mkdirSync(newData, { recursive: true });
  fs.writeFileSync(
    path.join(newData, "api.json"),
    JSON.stringify({ app: "flow", port: 8296, pid: process.pid, version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(oldData, "api.json"),
    JSON.stringify({ app: "agr-flow", port: 8176, pid: 4242, version: "0.22.0" }),
  );

  const quits: number[] = [];
  let alive = true;
  const out = await runMigration({
    ...quietOpts(m),
    isAlive: (pid) => (pid === 4242 ? alive : false),
    requestQuit: (port) => {
      quits.push(port);
      alive = false;
      return Promise.resolve(true);
    },
  });

  assert.deepEqual(quits, [8176], "the search continued past our own file and reached the old engine");
  // Both layouts exist on this machine, so the data move itself is refused
  // (new wins, old untouched) - the point of THIS test is only that the old
  // engine was found and stopped before any move decision.
  assert.ok(out.logs.some((l) => l.includes("asking the previous engine to quit")));
  cleanup(m);
});

test("A10: a locked managed exe freezes the migration even when no api.json exists at all", async () => {
  // Second belt: discovery files can be overwritten or not yet written (a
  // 0.22.0 mid-boot). The managed exe being execution-locked is evidence no
  // file can fake - nothing moves, nothing is deleted.
  const m = machine("exe-locked");
  const { oldData, oldModels, managedDir } = seedOldLayout(m);

  const out = await runMigration({
    ...quietOpts(m),
    isExeLocked: (p) => p.endsWith(MANAGED_APP_EXE),
  });

  assert.equal(out.dataMoved, false);
  assert.equal(out.modelsMoved, false);
  assert.equal(out.managedInstallRemoved, false);
  assert.ok(fs.existsSync(path.join(oldData, "settings.json")));
  assert.ok(fs.existsSync(oldModels));
  assert.ok(fs.existsSync(managedDir));
  assert.ok(out.logs.some((l) => l.includes("still locked")));
  cleanup(m);
});

// ---- failure paths: the folders must survive ----

test("A5: destination already present -> both layouts exist, the new one wins, the old is untouched", async () => {
  const m = machine("collision");
  const { oldData, oldModels } = seedOldLayout(m);
  // A half-finished earlier attempt (or a hand-made folder) already occupies the
  // new names. Renaming into them would fail; merging them is not our call.
  const newData = path.join(m.home, DATA_DIR_NEW);
  fs.mkdirSync(newData, { recursive: true });
  fs.writeFileSync(path.join(newData, "settings.json"), JSON.stringify({ micDeviceId: "already-here" }));
  const newModels = path.join(m.local, MODELS_ROOT_NEW);
  fs.mkdirSync(newModels, { recursive: true });

  const out = await runMigration(quietOpts(m));

  assert.equal(out.dataMoved, false);
  assert.equal(out.modelsMoved, false);
  assert.equal(out.dataDir, newData, "~/.flow wins");
  assert.equal(out.modelsRoot, newModels);
  assert.ok(fs.existsSync(path.join(oldData, "settings.json")), "the old folder is NEVER deleted");
  assert.ok(fs.existsSync(oldModels));
  const kept = JSON.parse(fs.readFileSync(path.join(newData, "settings.json"), "utf8")) as { micDeviceId: string };
  assert.equal(kept.micDeviceId, "already-here", "the new folder was not overwritten either");
  assert.ok(out.logs.some((l) => l.includes("both exist")), "the leftover is journalled");
  cleanup(m);
});

test("A5: a rename that throws (EBUSY/EPERM) keeps the old folder in service and retries next boot", async () => {
  const m = machine("ebusy");
  const { oldData, oldModels } = seedOldLayout(m);

  // Real disk, but every rename fails the way a locked flow.log or a live
  // whisper-server mmap makes it fail on Windows.
  const busy: MigrationFs = {
    ...nodeFs,
    renameSync: () => {
      const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    },
  };

  const out = await runMigration({ ...quietOpts(m), io: busy });

  assert.equal(out.dataMoved, false);
  assert.equal(out.modelsMoved, false);
  assert.equal(out.dataDir, oldData, "the app keeps running on the old data folder");
  assert.equal(out.modelsRoot, path.join(m.local, MODELS_ROOT_OLD), "and on the old model store: no re-download");
  assert.ok(fs.existsSync(path.join(oldData, "settings.json")));
  assert.ok(fs.existsSync(path.join(oldModels, "ggml-large-v3-turbo-q5_0.bin")));
  assert.ok(out.logs.some((l) => l.includes("EBUSY") && l.includes("will retry on the next start")));
  cleanup(m);
});

test("A5: a managed install that cannot be deleted is logged, never fatal", async () => {
  const m = machine("rm-fails");
  const { managedDir } = seedOldLayout(m);
  const stubborn: MigrationFs = {
    ...nodeFs,
    rmSync: () => {
      const err = new Error("access denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    },
  };

  const out = await runMigration({ ...quietOpts(m), io: stubborn });

  assert.equal(out.managedInstallRemoved, false);
  assert.equal(out.dataMoved, true, "the data still migrated: the two steps are independent");
  assert.ok(fs.existsSync(managedDir));
  assert.ok(out.logs.some((l) => l.includes("no longer used")));
  cleanup(m);
});

// ---- idempotence ----

test("A5: running the migration twice is a no-op the second time", async () => {
  const m = machine("idempotent");
  seedOldLayout(m);

  const first = await runMigration(quietOpts(m));
  assert.equal(first.dataMoved, true);
  assert.ok(first.logs.length > 0);

  const before = snapshot(m.root);
  const second = await runMigration(quietOpts(m));

  assert.deepEqual(second.logs, [], "a migrated machine does no work and says nothing");
  assert.equal(second.dataMoved, false);
  assert.equal(second.modelsMoved, false);
  assert.equal(second.managedInstallRemoved, false);
  assert.equal(second.dataDir, first.dataDir);
  assert.equal(second.modelsRoot, first.modelsRoot);
  assert.deepEqual(snapshot(m.root), before, "not one byte moved on the second run");
  cleanup(m);
});

test("A5: a partially migrated machine (data done, models stuck) finishes on the next boot", async () => {
  const m = machine("resume");
  const { oldModels } = seedOldLayout(m);
  // First boot: the models were locked, the data folder made it across.
  let failModels = true;
  const flaky: MigrationFs = {
    ...nodeFs,
    renameSync: (from, to) => {
      if (failModels && from === path.join(m.local, MODELS_ROOT_OLD)) {
        const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      nodeFs.renameSync(from, to);
    },
  };

  const first = await runMigration({ ...quietOpts(m), io: flaky });
  assert.equal(first.dataMoved, true);
  assert.equal(first.modelsMoved, false);
  assert.equal(first.modelsRoot, path.join(m.local, MODELS_ROOT_OLD));
  assert.ok(fs.existsSync(oldModels), "the 1.6 GB store is exactly where it was");

  // Second boot: the lock is gone. The leftover half finishes on its own, with
  // no managed install left to detect - the stale OLD folder is enough.
  failModels = false;
  const second = await runMigration(quietOpts(m));
  assert.equal(second.modelsMoved, true);
  assert.equal(second.modelsRoot, path.join(m.local, MODELS_ROOT_NEW));
  assert.ok(fs.existsSync(path.join(m.local, MODELS_ROOT_NEW, "models", "ggml-large-v3-turbo-q5_0.bin")));
  cleanup(m);
});

/** Sorted relative paths of everything under root - a cheap "did anything move?" */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, "");
  return out;
}
