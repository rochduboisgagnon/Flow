import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSelfCheck,
  formatSelfCheckForLog,
  worstStatus,
  type SelfCheckFacts,
  type SelfCheckId,
  type SelfCheckLine,
  type SelfCheckStatus,
} from "../src/shared/selfCheck";
import type { HookHealth } from "../src/shared/hookWatchdog";

// B5: the module under test is the JUDGMENT, not the observation - it never
// opens a device, a port or a file. So these tests state facts and assert on
// the verdict, which is exactly the shape of the thing a user reads.

const ARMED: HookHealth = {
  state: "armed",
  deaths: 0,
  restarts: 0,
  lastIncidentAt: null,
  lastIncidentDetail: null,
};

/** A machine where everything works. Each test below breaks exactly one fact,
 * so a verdict can never be blamed on an unrelated one. */
function healthy(over: Partial<SelfCheckFacts> = {}): SelfCheckFacts {
  return {
    hook: ARMED,
    micCount: 2,
    engineWarm: true,
    backend: "whisper-server-win32-x64-vulkan.exe",
    modelFile: "ggml-large-v3-turbo-q5_0.bin",
    modelPresent: true,
    modelState: { status: "ready" },
    apiPort: 8176,
    dataDir: "C:\\Users\\test\\.flow",
    dataDirWritable: true,
    nowIso: "2026-07-27T21:00:00.000Z",
    ...over,
  };
}

function line(facts: SelfCheckFacts, id: SelfCheckId): SelfCheckLine {
  const found = evaluateSelfCheck(facts).lines.find((l) => l.id === id);
  assert.ok(found, `no line for ${id}`);
  return found;
}

// ---- shape ----

test("B5: the report always carries the same six checks, in the same order", () => {
  const report = evaluateSelfCheck(healthy());
  assert.deepEqual(
    report.lines.map((l) => l.id),
    ["keyboard-hook", "microphone", "speech-engine", "speech-model", "local-api", "data-folder"],
  );
  assert.equal(report.generatedAtIso, "2026-07-27T21:00:00.000Z");
});

test("B5: a healthy machine is all green", () => {
  const report = evaluateSelfCheck(healthy());
  assert.equal(report.worst, "ok");
  assert.ok(report.lines.every((l) => l.status === "ok"), JSON.stringify(report.lines, null, 2));
});

test("B5: every line that is not green says what to DO about it", () => {
  // A red line with no next step is just a nicer way of saying "it is broken".
  const broken = healthy({
    hook: { ...ARMED, state: "abandoned", deaths: 4, restarts: 1, lastIncidentAt: 1, lastIncidentDetail: "code 1" },
    micCount: 0,
    engineWarm: false,
    modelPresent: false,
    modelState: { status: "error", message: "no backend could start" },
    apiPort: 0,
    dataDirWritable: false,
  });
  for (const l of evaluateSelfCheck(broken).lines) {
    assert.notEqual(l.status, "ok", `${l.id} should not be green on a fully broken machine`);
    assert.ok(l.fix && l.fix.length > 10, `${l.id} has no actionable fix`);
  }
});

test("B5: a green line never carries a fix (there is nothing to do)", () => {
  for (const l of evaluateSelfCheck(healthy()).lines) assert.equal(l.fix, undefined);
});

// ---- the keyboard hook (B4's record, read by B5) ----

test("B5: an armed hook is green, and still reports the interruptions it recovered from", () => {
  const l = line(healthy({ hook: { ...ARMED, deaths: 2, restarts: 2 } }), "keyboard-hook");
  assert.equal(l.status, "ok");
  assert.match(l.detail, /interrupted 2 time\(s\)/);
  assert.match(l.detail, /recovered 2 time\(s\)/);
});

test("B5: a hook being restarted is amber, not red - Flow is already fixing it", () => {
  const l = line(healthy({ hook: { ...ARMED, state: "restarting", deaths: 1 } }), "keyboard-hook");
  assert.equal(l.status, "warn");
  assert.match(l.fix ?? "", /wait/i);
});

test("B5: an abandoned hook is red and names the one thing that fixes it", () => {
  const l = line(healthy({ hook: { ...ARMED, state: "abandoned", deaths: 4 } }), "keyboard-hook");
  assert.equal(l.status, "fail");
  assert.match(l.fix ?? "", /restart flow/i);
});

test("B5: a hook still arming is 'unknown', never a false alarm", () => {
  const l = line(healthy({ hook: { ...ARMED, state: "starting" } }), "keyboard-hook");
  assert.equal(l.status, "unknown");
});

// ---- microphone ----

test("B5: zero devices is red, but a failed enumeration is only 'unknown'", () => {
  assert.equal(line(healthy({ micCount: 0 }), "microphone").status, "fail");
  // Not established is NOT the same fact as "there is none": the window that
  // enumerates devices may simply not have loaded yet.
  const unknown = line(healthy({ micCount: null }), "microphone");
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.fix ?? "", /again/i);
});

test("B5: a failed enumeration carries the reason when there is one", () => {
  const l = line(healthy({ micCount: null, micError: "renderer gone" }), "microphone");
  assert.match(l.detail, /renderer gone/);
});

// ---- speech engine and model ----

test("B5: a model still downloading is amber, never red - nothing is broken yet", () => {
  const facts = healthy({ engineWarm: false, modelPresent: false, modelState: { status: "downloading", pct: 43 } });
  const engine = line(facts, "speech-engine");
  const model = line(facts, "speech-model");
  assert.equal(engine.status, "warn");
  assert.match(engine.detail, /43%/);
  assert.equal(model.status, "warn");
  assert.equal(evaluateSelfCheck(facts).worst, "warn");
});

test("B5: a cold engine with the model on disk is red and points at the log", () => {
  const l = line(healthy({ engineWarm: false }), "speech-engine");
  assert.equal(l.status, "fail");
  assert.match(l.detail, /nothing to transcribe it/);
  assert.match(l.fix ?? "", /flow\.log|force CPU/i);
});

test("B5: an engine error is reported with the engine's own message", () => {
  const l = line(
    healthy({ engineWarm: false, modelState: { status: "error", message: "every backend failed" } }),
    "speech-engine",
  );
  assert.equal(l.status, "fail");
  assert.match(l.detail, /every backend failed/);
});

// ---- constat 2 (adverse review V2): engineWarm must be judged on its own,
// never inferred from anything that could survive a failed startup ----

test("constat 2: engineWarm=false is never 'ok', even if a previous attempt already named a backend", () => {
  // Mirrors the exact shape of a correctly-wired failed warm-up: the sidecar
  // object can have frozen a backend CHOICE before its own startup failed
  // (see main/asr/sidecar.ts's binPath), but the verdict must key off
  // engineWarm alone, never treat a non-empty backend name as proof of life.
  const l = line(healthy({ engineWarm: false, backend: "whisper-server-win32-x64-vulkan.exe" }), "speech-engine");
  assert.notEqual(l.status, "ok");
  assert.equal(l.status, "fail");
});

// ---- constat 3 (adverse review V2): a first launch downloading the model
// must read as amber, never as a failure ----

test("constat 3: a first-launch download in progress is amber, matching the SELF_CHECK_STARTUP_DELAY_MS comment in main/index.ts", () => {
  // The facts of a fresh install ~5 s after boot (see
  // SELF_CHECK_STARTUP_DELAY_MS): nothing has ever been warm, no model file
  // exists on disk yet, and the fetch is in flight.
  const facts = healthy({
    engineWarm: false,
    backend: "",
    modelPresent: false,
    modelState: { status: "downloading", pct: 12 },
  });
  const report = evaluateSelfCheck(facts);
  assert.notEqual(report.worst, "fail", "a first run doing exactly what it should must not read as broken");
  assert.equal(report.worst, "warn");
  assert.equal(line(facts, "speech-engine").status, "warn");
  assert.equal(line(facts, "speech-model").status, "warn");
});

test("constat 3 (characterizes the bug): the SAME first-launch facts read as FAIL if modelState is left at 'idle' during the download - proof the defect is in what feeds this module, not in the judgment itself", () => {
  const facts = healthy({
    engineWarm: false,
    backend: "",
    modelPresent: false,
    modelState: { status: "idle" }, // main/index.ts's warmAsr() never touched this before the fix
  });
  const report = evaluateSelfCheck(facts);
  assert.equal(
    report.worst,
    "fail",
    "this is the false failure constat 3 reports - main/index.ts must set modelState to 'downloading' during warmAsr(), same as swapModel() already does",
  );
});

test("B5: a warm engine names the backend it actually chose", () => {
  const l = line(healthy({ backend: "whisper-server-win32-x64-cpu.exe" }), "speech-engine");
  assert.equal(l.status, "ok");
  assert.match(l.detail, /cpu\.exe/);
});

test("B5: a missing model file is red and names the file", () => {
  const l = line(healthy({ modelPresent: false }), "speech-model");
  assert.equal(l.status, "fail");
  assert.match(l.detail, /ggml-large-v3-turbo-q5_0\.bin/);
});

test("B5: a model that could not be checked is 'unknown', never a false 'missing'", () => {
  assert.equal(line(healthy({ modelPresent: null }), "speech-model").status, "unknown");
});

// ---- local API: the one line that must NOT be red ----

test("B5: a silent local API is amber - dictation does not go through it", () => {
  // Marking it red would send someone hunting a port while their real problem
  // was a microphone. It costs companion apps (AGR Pilot), nothing else.
  const l = line(healthy({ apiPort: 0 }), "local-api");
  assert.equal(l.status, "warn");
  assert.match(l.detail, /dictation still works/i);
  assert.equal(evaluateSelfCheck(healthy({ apiPort: 0 })).worst, "warn");
});

test("B5: a listening API states the loopback address in full", () => {
  const l = line(healthy({ apiPort: 8296 }), "local-api");
  assert.match(l.detail, /127\.0\.0\.1:8296/);
  assert.match(l.detail, /loopback/i);
});

// ---- data folder ----

test("B5: an unwritable data folder is red and carries the reason and the path", () => {
  const l = line(healthy({ dataDirWritable: false, dataDirError: "EACCES" }), "data-folder");
  assert.equal(l.status, "fail");
  assert.match(l.detail, /EACCES/);
  assert.match(l.detail, /\.flow/);
});

test("B5: a data folder that could not be tested is 'unknown'", () => {
  assert.equal(line(healthy({ dataDirWritable: null }), "data-folder").status, "unknown");
});

// ---- worst ----

test("B5: worst() ranks fail over warn over unknown over ok", () => {
  const mk = (status: SelfCheckStatus): SelfCheckLine => ({
    id: "local-api",
    label: "x",
    status,
    detail: "d",
  });
  assert.equal(worstStatus([mk("ok"), mk("ok")]), "ok");
  assert.equal(worstStatus([mk("ok"), mk("unknown")]), "unknown");
  assert.equal(worstStatus([mk("unknown"), mk("warn")]), "warn");
  assert.equal(worstStatus([mk("warn"), mk("fail")]), "fail");
  assert.equal(worstStatus([]), "ok");
});

test("B5: one red line makes the whole report red", () => {
  assert.equal(evaluateSelfCheck(healthy({ micCount: 0 })).worst, "fail");
});

test("B5: a single unknown keeps the report from claiming it is all green", () => {
  assert.equal(evaluateSelfCheck(healthy({ micCount: null })).worst, "unknown");
});

// ---- the log rendering (what runs at startup) ----

test("B5: the log rendering carries every line, its verdict and its fix", () => {
  const report = evaluateSelfCheck(healthy({ micCount: 0 }));
  const out = formatSelfCheckForLog(report);
  assert.equal(out.length, report.lines.length + 1, "a header line plus one line per check");
  assert.match(out[0], /worst: FAIL/);
  assert.ok(out.every((l) => l.startsWith("[selfcheck] ")));
  const micLine = out.find((l) => l.includes("Microphone"));
  assert.ok(micLine?.includes("FAIL"));
  assert.match(micLine ?? "", / -> /, "the fix must be in the log line, not only in the UI");
});

test("B5: a green report's log lines carry no arrow (there is nothing to do)", () => {
  const out = formatSelfCheckForLog(evaluateSelfCheck(healthy()));
  assert.ok(out.slice(1).every((l) => !l.includes(" -> ")));
});

// ---- zero retention (plan §5.4) ----

test("B5: the report carries no dictated content, only states, counts and paths", () => {
  const report = evaluateSelfCheck(healthy());
  const blob = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["transcript", "utterance", "dictation text", "clipboard"]) {
    assert.ok(!blob.includes(forbidden), `the report must not carry "${forbidden}"`);
  }
});
