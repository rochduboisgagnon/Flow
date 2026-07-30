import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_ENGINE_IDLE_MS,
  BATCH_MODEL_SHARED,
  needsSeparateBatchEngine,
  resolveBatchModel,
} from "../src/shared/asrRole";

// F1 (plan-standalone §7): the pure half of the two-model split. Everything here
// runs without a process, a port or a model file, which is the point - the answer
// to "does this machine need a second whisper-server" must be checkable before
// anything is paid for.

const TURBO = "ggml-large-v3-turbo-q5_0.bin";
const LARGE = "ggml-large-v3-q5_0.bin";

test("the default resolves to sharing the dictation engine", () => {
  assert.equal(resolveBatchModel(TURBO, BATCH_MODEL_SHARED), BATCH_MODEL_SHARED);
  assert.equal(needsSeparateBatchEngine(TURBO, BATCH_MODEL_SHARED), false);
});

test("a DIFFERENT batch model is the one case that needs a second engine", () => {
  assert.equal(resolveBatchModel(TURBO, LARGE), LARGE);
  assert.equal(needsSeparateBatchEngine(TURBO, LARGE), true);
});

test("the SAME file on both roles collapses to sharing: never two copies of one model", () => {
  // The reason this rule lives in the policy and not at the call site: a user who
  // sets the batch model to the file the dictation engine already runs has asked
  // for accuracy, not for a second gigabyte of the same weights.
  assert.equal(resolveBatchModel(LARGE, LARGE), BATCH_MODEL_SHARED);
  assert.equal(needsSeparateBatchEngine(LARGE, LARGE), false);
});

test("whitespace around either value is not a difference", () => {
  // settings.json is a file a human can edit. A trailing space must not be the
  // reason a second 1.1 GB model gets loaded.
  assert.equal(resolveBatchModel(LARGE, " " + LARGE + " "), BATCH_MODEL_SHARED);
  assert.equal(resolveBatchModel(" " + TURBO, LARGE), LARGE);
  assert.equal(resolveBatchModel(TURBO, "   "), BATCH_MODEL_SHARED);
});

test("the idle unload window is minutes, not seconds", () => {
  // Guards the reasoning in asrRole.ts rather than the number: anything under a
  // minute would unload a model during an ordinary quiet stretch of a meeting and
  // charge the next segment a full reload, which the transcript would report as a
  // gap nobody could explain.
  assert.ok(BATCH_ENGINE_IDLE_MS >= 60_000, "an idle window under a minute would thrash a meeting");
  assert.ok(BATCH_ENGINE_IDLE_MS <= 15 * 60_000, "an idle window over a quarter hour is just a leak");
});
