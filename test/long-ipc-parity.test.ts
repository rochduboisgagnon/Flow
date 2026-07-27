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
