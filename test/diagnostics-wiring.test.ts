import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// B4b and B5, wired. Both policies are pure and tested for real
// (test/log-queue.test.ts, test/self-check.test.ts); what THIS file proves is
// that main/index.ts actually goes through them - the part no unit test of a
// pure module can ever see. Same source-as-text technique, for the same reason,
// as test/quit-guard.test.ts and test/silent-failures-wiring.test.ts: every one
// of these files imports "electron", which cannot be loaded under `node --test`.
//
// Normalized to LF: the repo checks out CRLF on Windows and the boundary
// searches below must not depend on it.
function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}
const INDEX_SRC = readSrc("src", "main", "index.ts");
const API_SRC = readSrc("src", "main", "api.ts");
const BRIDGE_SRC = readSrc("src", "main", "uiBridge.ts");

function bodyOf(src: string, anchor: string, terminator = "\n}\n"): string {
  const at = src.indexOf(anchor);
  assert.ok(at > 0, `could not find ${anchor}`);
  const end = src.indexOf(terminator, at);
  assert.ok(end > at, `could not find the end of ${anchor}`);
  return src.slice(at, end);
}

// ---- B4b: nothing on the hot path may wait behind a disk write ----

test("B4b: flowLog() does NO filesystem work on the caller's stack", () => {
  // The caller's stack is, very often, the keyboard hook's: HotkeyAdapter's
  // handler runs onStart/onStop/onCancel synchronously before returning its
  // swallow verdict, and Windows revokes a low-level hook that takes too long.
  // An fs.*Sync anywhere in this function would put a disk write there.
  const body = bodyOf(INDEX_SRC, "function flowLog(msg: string)");
  assert.doesNotMatch(body, /fs\.\w*Sync\(/, "flowLog must not do synchronous filesystem work");
  assert.doesNotMatch(body, /fs\.\w+\(/, "flowLog must not touch the filesystem at all");
  assert.match(body, /logQueue\.push\(/, "flowLog must hand the line to the buffered queue");
});

test("B4b: the timestamp is taken at PUSH time, not at write time", () => {
  // The queue can hold a line for a tick. Stamping at write time would reorder
  // cause and effect in the log under exactly the load that makes it worth
  // reading.
  const body = bodyOf(INDEX_SRC, "function flowLog(msg: string)");
  assert.match(body, /new Date\(\)\.toISOString\(\)/);
});

test("B4b: the log queue resolves its path lazily, never at construction", () => {
  // dataDir() caches its answer on the FIRST call, and that answer must be the
  // post-migration folder (see main/settings.ts). Passing dataDir() eagerly here
  // would pin the log - and every later write - to the pre-migration folder.
  const at = INDEX_SRC.indexOf("const logQueue = new LogQueue(");
  assert.ok(at > 0);
  const decl = INDEX_SRC.slice(at, INDEX_SRC.indexOf("\n});\n", at));
  assert.match(decl, /createFileLogSink\(\(\) =>/, "the path must be a closure, evaluated at write time");
});

test("B4b: before-quit flushes the log synchronously, and does it LAST", () => {
  // before-quit is synchronous and the process dies right after it, so no
  // scheduled drain would ever run. Flushing last also captures the lines the
  // rest of the shutdown just wrote (the recorder's rescue, the API's cleanup).
  const body = bodyOf(INDEX_SRC, 'app.on("before-quit"', "\n});\n");
  assert.match(body, /logQueue\.flushSync\(\)/);
  const flushAt = body.indexOf("logQueue.flushSync()");
  for (const earlier of ["longRec.rescueOnQuit()", "api?.stop()", "sidecar?.stop()"]) {
    assert.ok(
      body.indexOf(earlier) > 0 && body.indexOf(earlier) < flushAt,
      `${earlier} must run BEFORE the log is flushed, or its lines are lost`,
    );
  }
});

// ---- B5: the self-diagnostic ----

test("B5: the self-check runs at startup and its result goes to the log", () => {
  assert.match(INDEX_SRC, /runStartupSelfCheck\(\);/, "the startup run must be wired into whenReady");
  const body = bodyOf(INDEX_SRC, "function runStartupSelfCheck()");
  assert.match(body, /formatSelfCheckForLog\(report\)/);
  assert.match(body, /flowLog\(line\)/);
});

test("B5: the startup run is deferred and fire-and-forget - a boot never waits on a diagnostic", () => {
  const body = bodyOf(INDEX_SRC, "function runStartupSelfCheck()");
  assert.match(body, /setTimeout\(/);
  assert.match(body, /SELF_CHECK_STARTUP_DELAY_MS/);
  assert.match(body, /\.catch\(/, "a failed diagnostic must never become an unhandled rejection");
});

test("B5: the verdict is the pure module's, never re-decided in main", () => {
  // main only OBSERVES. If index.ts started deciding green/red itself, the
  // panel and the log lines could drift apart, which is the one thing a
  // diagnostic may not do.
  const body = bodyOf(INDEX_SRC, "async function gatherSelfCheck()");
  assert.match(body, /evaluateSelfCheck\(facts\)/);
  assert.doesNotMatch(body, /"fail"|"warn"/, "statuses are decided in shared/selfCheck.ts, not here");
});

test("B5: the data folder is tested by a real write, not by a permission bit", () => {
  const body = bodyOf(INDEX_SRC, "function probeDataDirWritable()");
  assert.match(body, /writeFileSync/);
  assert.match(body, /unlinkSync/, "the probe file must be cleaned up");
  assert.doesNotMatch(body, /fs\.access/, "access() reports the ACL, not what the disk will actually do");
});

test("B5: an empty microphone list is not reported as 'no microphone' when the page is not loaded", () => {
  // listMics() answers [] for two different facts; conflating them would tell
  // someone their microphone is missing three seconds after launch.
  const body = bodyOf(INDEX_SRC, "async function gatherSelfCheck()");
  assert.match(body, /overlay\.canListMics\(\)/);
  assert.match(body, /micCount: ready \? mics\.length : null/);
});

test("B5: the panel (IPC) and the loopback route share ONE closure", () => {
  // Same discipline as B1's hotpathSnapshotDep: two implementations of the same
  // diagnosis is how a support session ends up arguing with a screenshot.
  const declared = (INDEX_SRC.match(/const selfCheckDep = /g) ?? []).length;
  assert.equal(declared, 1, "selfCheckDep must be defined exactly once");
  const used = (INDEX_SRC.match(/selfCheck: selfCheckDep/g) ?? []).length;
  assert.equal(used, 2, "both LocalApi and UiBridge must receive the identical closure");
});

test("B5: the IPC channel is registered through the guarded() helper, like every other one", () => {
  // guarded() is what makes the sender check impossible to forget (the overlay
  // and capture windows share the same preload) - see uiBridge.ts.
  assert.match(BRIDGE_SRC, /this\.guarded<\[\], SelfCheckReport \| null>\(UI_SELF_CHECK, null,/);
});

test("B5: the HTTP route is GET, read-only, and under /diagnostics like B1's", () => {
  assert.match(API_SRC, /req\.method === "GET" && url\.pathname === "\/diagnostics\/selfcheck"/);
  assert.match(API_SRC, /await this\.deps\.selfCheck\(\)/);
});
