import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WhisperSidecar } from "../src/main/asr/sidecar";


// R1 (reliability): "the animation plays but nothing writes". A Vulkan build that
// loads but cannot decode must be skipped for CPU - at SELECTION (the decode probe)
// and at INFERENCE (empty/crash demotion). Proven here with fake whisper-servers,
// so it does NOT need a weak-GPU machine to verify.

const FAKE = path.join(__dirname, "fixtures", "fake-whisper-server.cjs");

function tmp(name: string, content = ""): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-r1-")), name);
  fs.writeFileSync(p, content);
  return p;
}

// A fake spawner: maps each "binary" (by basename) to a fake-server mode, and runs
// node on the fixture listening on the port the sidecar picked (--port in args).
function spawnerFor(map: Record<string, string>, counterFile = ""): (bin: string, args: string[]) => ChildProcess {
  return (bin, args) => {
    const port = args[args.indexOf("--port") + 1];
    const mode = map[path.basename(bin)] ?? "text";
    return spawn(process.execPath, [FAKE, port, mode, counterFile], { stdio: ["ignore", "ignore", "pipe"] });
  };
}

const model = tmp("model.bin", "x"); // start() only checks existence
const gpu = tmp("fake-vulkan.exe", "");
const cpu = tmp("fake-cpu.exe", "");
const probe = new Uint8Array(44 + 32000); // bytes are irrelevant; the fake ignores the body

test("R1: a GPU that decodes empty is skipped for CPU at selection (decode probe)", async () => {
  const sc = new WhisperSidecar({
    binaryPaths: [gpu, cpu],
    modelPath: model,
    probeWav: probe,

    spawnProc: spawnerFor({ "fake-vulkan.exe": "empty", "fake-cpu.exe": "text" }),
  });
  try {
    const r = await sc.transcribe(probe);
    assert.equal(r.text, "bonjour le monde", "the CPU backend produced the text");
    assert.equal(path.basename(sc.activeBackend()), "fake-cpu.exe", "CPU is the active backend");
  } finally {
    sc.stop();
  }
});

test("R1: a backend that passes the probe then returns empty demotes to CPU", async () => {
  const sc = new WhisperSidecar({
    binaryPaths: [gpu, cpu],
    modelPath: model,
    probeWav: probe,

    spawnProc: spawnerFor({ "fake-vulkan.exe": "probeok-empty", "fake-cpu.exe": "text" }),
  });
  try {
    // The GPU passes the decode probe (1st inference = text) so it is frozen; then
    // real utterances come back empty. After EMPTY_DEMOTE_STREAK (3) it must switch
    // to CPU (default allowEmptyDemote = dictation).
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) texts.push((await sc.transcribe(probe)).text);
    assert.equal(texts[texts.length - 1], "bonjour le monde", "ended up transcribing on CPU");
    assert.equal(path.basename(sc.activeBackend()), "fake-cpu.exe", "switched to CPU after empties");
  } finally {
    sc.stop();
  }
});

test("R1: long-form empties do NOT demote a healthy GPU (allowEmptyDemote:false)", async () => {
  const sc = new WhisperSidecar({
    binaryPaths: [gpu, cpu],
    modelPath: model,
    probeWav: probe,

    spawnProc: spawnerFor({ "fake-vulkan.exe": "probeok-empty", "fake-cpu.exe": "text" }),
  });
  try {
    // Ten empty long-form segments (music/applause) must keep the GPU: an empty here
    // is genuine non-speech, not a broken backend.
    for (let i = 0; i < 10; i++) await sc.transcribe(probe, { allowEmptyDemote: false });
    assert.equal(path.basename(sc.activeBackend()), "fake-vulkan.exe", "GPU stays selected for long-form empties");
  } finally {
    sc.stop();
  }
});

test("R1: a backend that fails at every inference demotes to CPU", async () => {
  const counter = tmp("counter.txt", "");
  const sc = new WhisperSidecar({
    binaryPaths: [gpu, cpu],
    modelPath: model,
    probeWav: probe,
    // stateful-fail: 1st inference EVER (the probe) returns text so the GPU is frozen;
    // every later inference (even after the same-backend respawn+retry) answers 500.

    spawnProc: spawnerFor({ "fake-vulkan.exe": "stateful-fail", "fake-cpu.exe": "text" }, counter),
  });
  try {
    const r = await sc.transcribe(probe);
    assert.equal(r.text, "bonjour le monde", "recovered onto CPU after the GPU kept failing");
    assert.equal(path.basename(sc.activeBackend()), "fake-cpu.exe", "CPU is active after the fail demotion");
  } finally {
    sc.stop();
  }
});

test("R1: the LAST candidate is trusted on readiness, never probe-bricked", async () => {
  // Both backends would fail the decode probe (empty). The GPU (has a fallback) is
  // probed and dropped; the CPU is the LAST candidate, so it is trusted on readiness
  // alone - never probed - and takes over. This is the fix that stops the probe from
  // bricking a slow-but-working sole backend on a machine "sans gros GPU".
  const sc = new WhisperSidecar({
    binaryPaths: [gpu, cpu],
    modelPath: model,
    probeWav: probe,

    spawnProc: spawnerFor({ "fake-vulkan.exe": "empty", "fake-cpu.exe": "empty" }),
  });
  try {
    const r = await sc.transcribe(probe);
    assert.equal(r.text, "", "the trusted CPU backend simply returns its (empty) decode, no brick");
    assert.equal(path.basename(sc.activeBackend()), "fake-cpu.exe", "CPU is trusted as the last candidate");
  } finally {
    sc.stop();
  }
});

test("R1: a sole backend is trusted without a probe (a slow CPU is never timed out into 'bad')", async () => {
  // Only one binary present: it must be trusted on readiness (no decode probe that a
  // slow machine could time out), even if that decode would be empty.
  const sc = new WhisperSidecar({
    binaryPaths: [cpu],
    modelPath: model,
    probeWav: probe,

    spawnProc: spawnerFor({ "fake-cpu.exe": "empty" }),
  });
  try {
    const r = await sc.transcribe(probe);
    assert.equal(r.text, "", "sole backend trusted (returns its decode), not bricked by a probe");
    assert.equal(path.basename(sc.activeBackend()), "fake-cpu.exe");
  } finally {
    sc.stop();
  }
});
