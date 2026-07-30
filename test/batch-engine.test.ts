import test from "node:test";
import assert from "node:assert/strict";
import { BatchEngine, type BatchEngineTimer } from "../src/main/asr/batchEngine";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

// F1 (plan-standalone §7): the batch engine, and above all THE GUARANTEE.
//
// The claim this file has to earn is the one the campaign asked for in writing: a
// press on the dictation shortcut never waits for a model to load. The weak way
// to test that is to assert on a status string; the strong way - the one a future
// refactor cannot quietly pass while breaking - is to assert on OBJECT IDENTITY
// and on a stop() spy that must never fire. Both are below.
//
// Everything runs with an injected timer, so the five-minute idle unload is
// exercised in zero real time, and with fake sidecars, so no whisper-server, no
// port and no model file is ever involved.

const DICT_MODEL = "ggml-large-v3-turbo-q5_0.bin";
const BATCH_MODEL = "ggml-large-v3-q5_0.bin";

/** A fake sidecar that records what was asked of it. `stops` is the one that
 * matters: the dictation engine's must stay at zero forever. */
function fakeSidecar(text = "ok") {
  const calls: Array<{ wav: number; allowEmptyDemote: boolean | undefined }> = [];
  let stops = 0;
  let starts = 0;
  let failStart: Error | null = null;
  const sc = {
    transcribe: (wav: Uint8Array, opts: { allowEmptyDemote?: boolean } = {}) => {
      calls.push({ wav: wav.length, allowEmptyDemote: opts.allowEmptyDemote });
      return Promise.resolve({ text, ms: 7 });
    },
    ensureStarted: () => {
      starts++;
      return failStart ? Promise.reject(failStart) : Promise.resolve();
    },
    stop: () => {
      stops++;
    },
  };
  return {
    sc: sc as unknown as WhisperSidecar,
    get calls() { return calls; },
    get stops() { return stops; },
    get starts() { return starts; },
    failWith(e: Error) { failStart = e; },
  };
}

/** A timer harness: nothing fires until the test says so. */
function fakeTimers() {
  const armed = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer(fn: () => void): BatchEngineTimer {
      const id = next++;
      armed.set(id, fn);
      return { id };
    },
    clearTimer(t: BatchEngineTimer) {
      armed.delete(t.id as number);
    },
    get armedCount() { return armed.size; },
    /** Fire every armed timer, as the event loop eventually would. */
    fireAll() {
      const fns = [...armed.values()];
      armed.clear();
      for (const fn of fns) fn();
    },
  };
}

interface Harness {
  engine: BatchEngine;
  dictation: ReturnType<typeof fakeSidecar>;
  built: Array<{ modelPath: string; fake: ReturnType<typeof fakeSidecar> }>;
  timers: ReturnType<typeof fakeTimers>;
  fallbacks: string[];
  logs: string[];
  ensured: string[];
  settings: { model: string; batchModel: string };
  /** Set on the NEXT sidecar this harness builds. */
  failNextStart: Error | null;
}

function harness(batchModel: string): Harness {
  const dictation = fakeSidecar("dictation engine");
  const timers = fakeTimers();
  const h: Harness = {
    engine: null as unknown as BatchEngine,
    dictation,
    built: [],
    timers,
    fallbacks: [],
    logs: [],
    ensured: [],
    settings: { model: DICT_MODEL, batchModel },
    failNextStart: null,
  };
  h.engine = new BatchEngine({
    dictationEngine: () => dictation.sc,
    dictationModel: () => h.settings.model,
    batchModel: () => h.settings.batchModel,
    ensureModel: (file) => {
      h.ensured.push(file);
      return Promise.resolve("C:/models/" + file);
    },
    makeSidecar: (modelPath) => {
      const fake = fakeSidecar("batch engine");
      if (h.failNextStart) {
        fake.failWith(h.failNextStart);
        h.failNextStart = null;
      }
      h.built.push({ modelPath, fake });
      return fake.sc;
    },
    setTimer: (fn) => timers.setTimer(fn),
    clearTimer: (t) => timers.clearTimer(t),
    log: (m) => h.logs.push(m),
    onFallback: (r) => h.fallbacks.push(r),
    idleMs: 1,
  });
  return h;
}

const WAV = new Uint8Array(64);

// ---------------------------------------------------------------------------
// THE GUARANTEE
// ---------------------------------------------------------------------------

test("GUARANTEE: batch work on a separate model never touches the dictation engine", async () => {
  const h = harness(BATCH_MODEL);
  const before = h.engine; // the object under test, not the assertion
  void before;

  const r = await h.engine.transcribe(WAV);
  assert.equal(r.text, "batch engine", "the batch model should have served this");

  // Fact 2 of batchEngine.ts's module note, asserted the only way that survives a
  // refactor: the dictation engine was never started, never stopped, and never
  // asked to transcribe anything.
  assert.equal(h.dictation.stops, 0, "the dictation engine must never be stopped by batch work");
  assert.equal(h.dictation.starts, 0, "the dictation engine must never be (re)started by batch work");
  assert.equal(h.dictation.calls.length, 0, "batch work must not run on the dictation engine here");

  // And a SECOND process really was built - i.e. the guarantee is not being met
  // by simply never using a batch model.
  assert.equal(h.built.length, 1);
  assert.equal(h.built[0].modelPath, "C:/models/" + BATCH_MODEL);
});

test("GUARANTEE: the dictation engine handed back on a fallback is the SAME OBJECT, unswapped", async () => {
  const h = harness(BATCH_MODEL);
  h.failNextStart = new Error("out of video memory");

  const r = await h.engine.transcribe(WAV);

  // The job succeeded on the dictation engine...
  assert.equal(r.text, "dictation engine");
  assert.equal(h.dictation.calls.length, 1);
  // ...and that engine was handed over untouched. This is the assertion that
  // matters: a "fallback" that restarted or reloaded the dictation engine would
  // be exactly the stall F1 exists to make impossible.
  assert.equal(h.dictation.stops, 0);
  assert.equal(h.dictation.starts, 0);
  // The half-started batch sidecar was cleaned up rather than left holding a port.
  assert.equal(h.built.length, 1);
  assert.equal(h.built[0].fake.stops, 1, "a sidecar that failed its start must be stopped");
  assert.equal(h.fallbacks.length, 1);
  assert.match(h.fallbacks[0], /out of video memory/);
});

test("GUARANTEE: the batch engine reads the dictation engine LAZILY, so a swap is never stale", async () => {
  // The dep is a getter, not a captured object (batchEngine.ts's `dictationEngine`
  // doc comment). Prove it: replace what the getter answers between two calls and
  // the second call must reach the NEW engine.
  const first = fakeSidecar("first");
  const second = fakeSidecar("second");
  let current = first;
  const timers = fakeTimers();
  const engine = new BatchEngine({
    dictationEngine: () => current.sc,
    dictationModel: () => DICT_MODEL,
    batchModel: () => "", // shared: every call goes to the dictation engine
    ensureModel: (f) => Promise.resolve(f),
    makeSidecar: () => {
      throw new Error("must not build a batch engine when sharing");
    },
    setTimer: (fn) => timers.setTimer(fn),
    clearTimer: (t) => timers.clearTimer(t),
  });

  assert.equal((await engine.transcribe(WAV)).text, "first");
  current = second;
  assert.equal((await engine.transcribe(WAV)).text, "second");
  assert.equal(first.stops, 0);
  assert.equal(second.stops, 0);
});

// ---------------------------------------------------------------------------
// The default path: nothing is paid for
// ---------------------------------------------------------------------------

test("the DEFAULT builds no second process at all", async () => {
  const h = harness(""); // "" = share the dictation engine
  const r = await h.engine.transcribe(WAV);
  assert.equal(r.text, "dictation engine");
  assert.equal(h.built.length, 0, "no sidecar may be constructed");
  assert.equal(h.ensured.length, 0, "no model may be downloaded");
  assert.equal(h.fallbacks.length, 0, "sharing is the default, not a degradation to count");
  assert.deepEqual(h.engine.state(), { model: "", status: "shared" });
});

test("a batch model equal to the dictation model is treated as the default", async () => {
  const h = harness(DICT_MODEL);
  await h.engine.transcribe(WAV);
  assert.equal(h.built.length, 0);
  assert.equal(h.engine.state().status, "shared");
});

test("allowEmptyDemote:false is baked in, for both callers, on every call", async () => {
  // A meeting segment and an imported file legitimately contain music and
  // ambience. Demoting a healthy GPU over a genuinely silent stretch would be a
  // silent app-wide slowdown - the reason both call sites used to pass this by
  // hand, and the reason it now cannot be forgotten by either.
  const shared = harness("");
  await shared.engine.transcribe(WAV);
  assert.equal(shared.dictation.calls[0].allowEmptyDemote, false);

  const separate = harness(BATCH_MODEL);
  await separate.engine.transcribe(WAV);
  assert.equal(separate.built[0].fake.calls[0].allowEmptyDemote, false);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("the batch engine is built ONCE and reused across segments", async () => {
  const h = harness(BATCH_MODEL);
  await h.engine.transcribe(WAV);
  await h.engine.transcribe(WAV);
  await h.engine.transcribe(WAV);
  assert.equal(h.built.length, 1, "one process for the whole job");
  assert.equal(h.ensured.length, 1, "one model resolution, not one per segment");
  assert.equal(h.built[0].fake.calls.length, 3);
});

test("concurrent first segments share ONE start instead of racing three processes", async () => {
  // A meeting pushes segments faster than a 1.1 GB model loads: without the
  // in-flight join, the first minute of a recording would spawn one
  // whisper-server per segment.
  const h = harness(BATCH_MODEL);
  await Promise.all([h.engine.transcribe(WAV), h.engine.transcribe(WAV), h.engine.transcribe(WAV)]);
  assert.equal(h.built.length, 1);
  assert.equal(h.ensured.length, 1);
});

test("the idle timer is only armed when nothing is in flight, and unloads the model", async () => {
  const h = harness(BATCH_MODEL);
  await h.engine.transcribe(WAV);
  assert.equal(h.timers.armedCount, 1, "idle after the last call");
  assert.equal(h.engine.state().status, "ready");

  h.timers.fireAll();
  assert.equal(h.built[0].fake.stops, 1, "the batch model is unloaded when idle");
  assert.equal(h.dictation.stops, 0, "and the dictation engine is still untouched");
  // A later segment builds a fresh one rather than answering on a dead process.
  await h.engine.transcribe(WAV);
  assert.equal(h.built.length, 2);
});

test("a transcription in flight cannot be killed by the idle timer", async () => {
  // The realistic version of this failure: a 30 s segment on large-v3 takes
  // twenty seconds, and a timer armed before it started would kill the
  // whisper-server mid-decode.
  const timers = fakeTimers();
  let release: (() => void) | null = null;
  const batch = {
    transcribe: () => new Promise<{ text: string; ms: number }>((r) => {
      release = () => r({ text: "slow", ms: 20_000 });
    }),
    ensureStarted: () => Promise.resolve(),
    stop: () => {
      throw new Error("stopped while a decode was in flight");
    },
  };
  const engine = new BatchEngine({
    dictationEngine: () => fakeSidecar().sc,
    dictationModel: () => DICT_MODEL,
    batchModel: () => BATCH_MODEL,
    ensureModel: (f) => Promise.resolve(f),
    makeSidecar: () => batch as unknown as WhisperSidecar,
    setTimer: (fn) => timers.setTimer(fn),
    clearTimer: (t) => timers.clearTimer(t),
    idleMs: 1,
  });

  const inFlight = engine.transcribe(WAV);
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.armedCount, 0, "no idle timer may be armed while work is in flight");
  timers.fireAll(); // nothing armed: this is a no-op, and stop() would have thrown
  release!();
  assert.equal((await inFlight).text, "slow");
});

test("changing the batch model mid-session swaps the batch engine and nothing else", async () => {
  const h = harness(BATCH_MODEL);
  await h.engine.transcribe(WAV);
  assert.equal(h.built.length, 1);

  const other = "ggml-medium-q5_0.bin";
  h.settings.batchModel = other;
  h.engine.settingsChanged();
  assert.equal(h.built[0].fake.stops, 1, "the engine for the abandoned model is dropped");

  await h.engine.transcribe(WAV);
  assert.equal(h.built.length, 2);
  assert.equal(h.built[1].modelPath, "C:/models/" + other);
  assert.equal(h.dictation.stops, 0);
  assert.equal(h.dictation.starts, 0);
});

test("going back to the default unloads the batch engine on the next batch call", async () => {
  const h = harness(BATCH_MODEL);
  await h.engine.transcribe(WAV);
  h.settings.batchModel = "";
  const r = await h.engine.transcribe(WAV);
  assert.equal(r.text, "dictation engine");
  assert.equal(h.built[0].fake.stops, 1);
  assert.equal(h.engine.state().status, "shared");
});

test("stop() releases only what the batch engine started", () => {
  const h = harness(BATCH_MODEL);
  h.engine.stop();
  assert.equal(h.dictation.stops, 0);
});

// ---------------------------------------------------------------------------
// Failure: honest, counted, and NOT retried per segment
// ---------------------------------------------------------------------------

test("a failed load is not re-attempted for every segment of a meeting", async () => {
  const h = harness(BATCH_MODEL);
  h.failNextStart = new Error("out of video memory");
  await h.engine.transcribe(WAV);
  await h.engine.transcribe(WAV);
  await h.engine.transcribe(WAV);
  // One attempt, three successful jobs on the dictation engine. Retrying a 1.1 GB
  // download (or a GPU with no room) once per segment would flood the log while
  // the recording fell behind.
  assert.equal(h.built.length, 1, "exactly one attempt");
  assert.equal(h.dictation.calls.length, 3, "and every segment still got transcribed");
  assert.equal(h.fallbacks.length, 3, "each degraded segment is counted");
});

test("state() reports the failure in a form the Settings row can print", async () => {
  const h = harness(BATCH_MODEL);
  h.failNextStart = new Error("out of video memory");
  await h.engine.transcribe(WAV);
  const st = h.engine.state();
  assert.equal(st.status, "failed");
  assert.equal(st.model, BATCH_MODEL);
  assert.match(st.message ?? "", /out of video memory/);
});

test("a settings change clears a stale failure: the gesture most likely to fix it", async () => {
  const h = harness(BATCH_MODEL);
  h.failNextStart = new Error("out of video memory");
  await h.engine.transcribe(WAV);
  assert.equal(h.engine.state().status, "failed");

  // Picking a smaller model - or turning Force CPU on - must be allowed to work
  // without restarting the app.
  h.settings.batchModel = "ggml-small-q5_1.bin";
  h.engine.settingsChanged();
  assert.equal(h.engine.state().status, "loading");
  const r = await h.engine.transcribe(WAV);
  assert.equal(r.text, "batch engine");
});

test("no speech engine at all is still the same error both callers already handled", async () => {
  const timers = fakeTimers();
  const engine = new BatchEngine({
    dictationEngine: () => null,
    dictationModel: () => DICT_MODEL,
    batchModel: () => "",
    ensureModel: (f) => Promise.resolve(f),
    makeSidecar: () => {
      throw new Error("unreachable");
    },
    setTimer: (fn) => timers.setTimer(fn),
    clearTimer: (t) => timers.clearTimer(t),
  });
  await assert.rejects(() => engine.transcribe(WAV), /speech engine is not ready/);
});

test("state() before any batch work says the model loads on demand, not that it is loaded", () => {
  const h = harness(BATCH_MODEL);
  assert.deepEqual(h.engine.state(), { model: BATCH_MODEL, status: "loading" });
  assert.equal(h.built.length, 0, "and nothing was actually built by asking");
});
