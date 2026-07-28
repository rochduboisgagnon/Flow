import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// U4a: index.ts cannot be instantiated outside a real Electron process (it
// imports "electron" at module scope, same reason test/ui-bridge.test.ts and
// test/csp.test.ts read their targets as text instead). The founding rule of
// this whole IPC layer is that main/uiBridge.ts's long-form handlers call the
// EXACT SAME functions as the HTTP /long/* routes (main/api.ts) - never a
// parallel implementation. index.ts is where that parity is either upheld or
// silently broken: it is the only place that constructs BOTH LocalApi and
// UiBridge, so this test greps its source for one concrete, mechanical proof
// of parity - each of the six long-form deps is a single named const
// (longStateDep, longStartNativeDep, longStopDep, longMarkDep,
// longTranscriptDep, canLoopbackDep), and BOTH constructor calls reference
// the identical identifier for the identical property name. Two closures that
// happen to look alike would not pass this test; only the SAME function does.
//
// U4 (review, minor finding) - what this file proves, and what it does NOT:
//   PROVES: index.ts hands the same named const to both control surfaces; each
//   HTTP /long/* route in api.ts calls the dep of its own name; each UI_LONG_*
//   handler in uiBridge.ts calls the dep of its own name and no other one.
//   That last check is not theoretical - UI_LONG_MARK shipped calling
//   longStop(), so "Mark this moment" ended the recording, and the original
//   version of this file passed anyway because it only ever looked at which
//   deps were WIRED, never at which one each handler CALLED. It also never
//   opened api.ts at all, despite api.ts being one of the two sides it claims
//   parity between.
//   DOES NOT PROVE: that the handlers behave correctly when run. Nothing here
//   executes anything - main/index.ts and main/uiBridge.ts import "electron" at
//   module scope and cannot be instantiated outside a real Electron process.
//   The HTTP half IS exercised for real, over a socket, in test/api.test.ts
//   ("long-form routes reach their deps with parsed arguments"); the IPC half
//   has no equivalent, and this reading of the source is the floor under it.
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");

function block(src: string, startMarker: string, endMarker: RegExp): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find "${startMarker}" in index.ts`);
  const rest = src.slice(start);
  const end = rest.search(endMarker);
  assert.ok(end >= 0, `could not find the closing marker for "${startMarker}" in index.ts`);
  return rest.slice(0, end);
}

const LOCAL_API_BLOCK = block(INDEX_SRC, "api = new LocalApi({", /\n {4}\}\);/);
const UI_BRIDGE_BLOCK = block(INDEX_SRC, "uiBridge = new UiBridge(", /\n {4}\);/);

const LONG_DEPS: Array<[prop: string, dep: string]> = [
  ["longState", "longStateDep"],
  ["longStartNative", "longStartNativeDep"],
  ["longStop", "longStopDep"],
  ["longMark", "longMarkDep"],
  ["longTranscript", "longTranscriptDep"],
  ["canLoopback", "canLoopbackDep"],
];

test("index.ts defines each long-form dep exactly once, as a named const built on longRec/NativeCapture", () => {
  for (const [, dep] of LONG_DEPS) {
    const count = (INDEX_SRC.match(new RegExp(`const ${dep} = `, "g")) ?? []).length;
    assert.equal(count, 1, `${dep} must be declared exactly once (a second declaration is a parallel implementation)`);
  }
});

test("LocalApi (the HTTP /long/* routes) wires all six long-form deps", () => {
  for (const [prop, dep] of LONG_DEPS) {
    assert.match(
      LOCAL_API_BLOCK,
      new RegExp(`\\b${prop}: ${dep}\\b`),
      `LocalApi must receive ${prop}: ${dep}`,
    );
  }
});

test("UiBridge (the UI_LONG_* IPC channels) wires the SAME six named consts - not a re-derived equivalent", () => {
  for (const [prop, dep] of LONG_DEPS) {
    assert.match(
      UI_BRIDGE_BLOCK,
      new RegExp(`\\b${prop}: ${dep}\\b`),
      `UiBridge must receive ${prop}: ${dep}, the IDENTICAL const LocalApi receives`,
    );
  }
});

// The other half of the contract: main/uiBridge.ts must not re-implement the
// UI_LONG_START decision (source validity, native-capture availability,
// "system" being unsupported) inline - it has to defer to the pure, tested
// shared/longStart.ts, the same discipline test/csp.test.ts checks for the
// CSP hook (shouldApplyCsp) so the decision is never duplicated somewhere a
// reviewer six months from now would not think to look.
const UI_BRIDGE_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "uiBridge.ts"), "utf8");

test("uiBridge.ts decides UI_LONG_START through shared/longStart.ts, not an inline platform check", () => {
  assert.match(UI_BRIDGE_SRC, /decideLongStart\(/, "the UI_LONG_START handler must consult the tested decision");
  assert.ok(
    !/process\.platform/.test(UI_BRIDGE_SRC),
    "a platform check re-inlined in uiBridge.ts is a second source of truth shared/longStart.ts's tests cannot see",
  );
});

// U5a: the same parity discipline, extended to the archive browser - listHistory
// and readHistoryDoc must be the identical named consts LocalApi's HTTP
// /long/history* routes and UiBridge's UI_HISTORY_* channels both receive.
const HISTORY_DEPS: Array<[prop: string, dep: string]> = [
  ["listHistory", "listHistoryDep"],
  ["readHistoryDoc", "readHistoryDocDep"],
];

test("index.ts defines each archive dep exactly once, as a named const built on listHistory/readHistoryDoc", () => {
  for (const [, dep] of HISTORY_DEPS) {
    const count = (INDEX_SRC.match(new RegExp(`const ${dep} = `, "g")) ?? []).length;
    assert.equal(count, 1, `${dep} must be declared exactly once (a second declaration is a parallel implementation)`);
  }
});

test("LocalApi (the HTTP /long/history* routes) wires both archive deps", () => {
  for (const [prop, dep] of HISTORY_DEPS) {
    assert.match(LOCAL_API_BLOCK, new RegExp(`\\b${prop}: ${dep}\\b`), `LocalApi must receive ${prop}: ${dep}`);
  }
});

test("UiBridge (the UI_HISTORY_* IPC channels) wires the SAME two named consts - not a re-derived equivalent", () => {
  for (const [prop, dep] of HISTORY_DEPS) {
    assert.match(UI_BRIDGE_BLOCK, new RegExp(`\\b${prop}: ${dep}\\b`), `UiBridge must receive ${prop}: ${dep}, the IDENTICAL const LocalApi receives`);
  }
});

// ---- U4 (review, minor finding): make the parity test bite ----
//
// Wiring parity says the two surfaces were HANDED the same functions. It says
// nothing about which one each handler then calls - and that is where the bug
// actually was. Both halves are checked below, per route and per channel, on
// the one rule that makes a name meaningful: the handler for X calls the dep
// named X, and calls no OTHER long-form dep on the way.
const API_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "api.ts"), "utf8");

/** The text of one HTTP route: from its pathname test to the next route's. */
function routeBody(pathname: string): string {
  const at = API_SRC.indexOf(`url.pathname === "${pathname}"`);
  assert.ok(at >= 0, `api.ts no longer serves ${pathname}`);
  const rest = API_SRC.slice(at + pathname.length);
  const next = rest.indexOf("url.pathname ===");
  return next > 0 ? rest.slice(0, next) : rest;
}

/** The text of one IPC handler: guarded() calls are separated by a blank line,
 * so this stops before the next one's comments and cannot borrow their words. */
function channelHandler(channel: string): string {
  const at = UI_BRIDGE_SRC.indexOf(`(${channel},`);
  assert.ok(at >= 0, `uiBridge.ts no longer registers ${channel}`);
  const rest = UI_BRIDGE_SRC.slice(at);
  const end = rest.search(/\r?\n[ \t]*\r?\n/); // blank line, CRLF or LF
  assert.ok(end > 0, `could not delimit the ${channel} handler`);
  return rest.slice(0, end);
}

/** Every long-form dep actually CALLED in a chunk of source. */
function longDepsCalled(src: string): string[] {
  return [...src.matchAll(/this\.deps\.(long[A-Za-z]*)\(/g)].map((m) => m[1]);
}

const LONG_ROUTES: Array<[route: string, dep: string]> = [
  ["/long/state", "longState"],
  ["/long/start", "longStart"],
  ["/long/start-native", "longStartNative"],
  ["/long/stop", "longStop"],
  ["/long/mark", "longMark"],
  ["/long/save", "longSave"],
  ["/long/notes-splice", "longNotesSplice"],
  ["/long/transcript", "longTranscript"],
  ["/long/chunk", "longChunk"],
  ["/long/gap", "longGap"],
];

test("api.ts: each HTTP /long/* route calls the dep of its own name, and only that one", () => {
  for (const [route, dep] of LONG_ROUTES) {
    const called = longDepsCalled(routeBody(route));
    assert.deepEqual(
      called,
      [dep],
      `POST/GET ${route} must call this.deps.${dep} (it calls: ${called.join(", ") || "nothing"})`,
    );
  }
});

const LONG_CHANNELS: Array<[channel: string, dep: string]> = [
  ["UI_LONG_STATE", "longState"],
  ["UI_LONG_START", "longStartNative"],
  ["UI_LONG_STOP", "longStop"],
  ["UI_LONG_MARK", "longMark"],
  ["UI_LONG_TRANSCRIPT", "longTranscript"],
];

test("uiBridge.ts: each UI_LONG_* handler calls the dep of its own name, and only that one", () => {
  for (const [channel, dep] of LONG_CHANNELS) {
    const called = longDepsCalled(channelHandler(channel));
    assert.deepEqual(
      called,
      [dep],
      `${channel} must call this.deps.${dep} (it calls: ${called.join(", ") || "nothing"}). ` +
        `UI_LONG_MARK shipped calling longStop: "Mark this moment" ended the recording.`,
    );
  }
});

test("the two surfaces expose the same long-form vocabulary (no channel without a route)", () => {
  const routeDeps = new Set(LONG_ROUTES.map(([, dep]) => dep));
  for (const [channel, dep] of LONG_CHANNELS) {
    assert.ok(routeDeps.has(dep), `${channel} calls ${dep}, which no HTTP route reaches: the surfaces have drifted`);
  }
});
