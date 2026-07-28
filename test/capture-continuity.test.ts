import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SHORTFALL_MIN_HELD_MS,
  SHORTFALL_MIN_MISSING_MS,
  judgeCaptureShortfall,
  preRollCreditMs,
  shortfallLogLine,
} from "../src/shared/captureContinuity";
import { PRE_ROLL_MS } from "../src/shared/micWarmth";
import { SILENT_FAILURE } from "../src/shared/silentFailures";

// B9 (plan V2): the microphone that stops producing audio in the middle of a
// press - a USB headset unplugged mid-sentence being the case that started
// this. Nothing throws, so nothing in the app used to notice: the capture
// "succeeds", the WAV is well formed, and it just stops where the device did.

function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}

// ---- the case it exists for ----

test("B9: a headset unplugged two seconds into a six-second press is caught", () => {
  const v = judgeCaptureShortfall(6_000, 2_000);
  assert.equal(v.dropped, true);
  assert.equal(v.missingMs, 4_000);
});

test("B9: a device that died almost immediately comes back as a near-empty clip, and is still caught", () => {
  // This is the version that used to leave the FAINTEST trace: the clip is
  // dropped as sub-300 ms "release noise" before anything else looks at it.
  const v = judgeCaptureShortfall(5_000, 120);
  assert.equal(v.dropped, true);
});

// ---- and above all, what it must NOT do ----

test("B9: a normal press is never flagged - getUserMedia latency alone must not accuse a healthy mic", () => {
  // Every capture starts late by construction (menace §3.2.3): the first
  // getUserMedia of a session costs hundreds of milliseconds.
  assert.equal(judgeCaptureShortfall(3_000, 2_600).dropped, false, "400 ms of startup is normal");
  assert.equal(judgeCaptureShortfall(4_000, 3_200).dropped, false, "800 ms of startup is still normal");
  assert.equal(judgeCaptureShortfall(10_000, 9_000).dropped, false, "a full second of startup is tolerated");
});

test("B9: a short tap is never judged at all - its startup cost is too large a share of it", () => {
  // A 600 ms tap where getUserMedia took 500 ms is 83% "missing" and perfectly
  // healthy. A ratio test would fire on every one of them.
  assert.equal(judgeCaptureShortfall(600, 100).dropped, false);
  assert.equal(judgeCaptureShortfall(SHORTFALL_MIN_HELD_MS - 1, 0).dropped, false);
});

test("B9: the two thresholds are the whole rule, and they are both required", () => {
  const justUnderHold = judgeCaptureShortfall(SHORTFALL_MIN_HELD_MS - 1, 0);
  assert.equal(justUnderHold.dropped, false, "long enough press is required");
  const justUnderMissing = judgeCaptureShortfall(10_000, 10_000 - (SHORTFALL_MIN_MISSING_MS - 1));
  assert.equal(justUnderMissing.dropped, false, "enough missing audio is required");
  const both = judgeCaptureShortfall(SHORTFALL_MIN_HELD_MS, SHORTFALL_MIN_HELD_MS - SHORTFALL_MIN_MISSING_MS);
  assert.equal(both.dropped, true, "exactly at both thresholds, it fires");
});

// ---- defensive about its inputs ----

test("B9: a clip longer than its own press is clamped, never reported as negative", () => {
  // Legitimate: the release travels to the renderer, which flushes whatever the
  // worklet already handed it.
  const v = judgeCaptureShortfall(3_000, 3_120);
  assert.equal(v.missingMs, 0);
  assert.equal(v.dropped, false);
});

test("B9: NaN, Infinity and negatives produce a verdict, never an accusation or a crash", () => {
  for (const [held, captured] of [
    [NaN, 1_000],
    [5_000, NaN],
    [Infinity, 0],
    [-5_000, -1],
    [0, 0],
  ]) {
    const v = judgeCaptureShortfall(held, captured);
    assert.equal(typeof v.dropped, "boolean");
    assert.ok(Number.isFinite(v.heldMs) && v.heldMs >= 0);
    assert.ok(Number.isFinite(v.capturedMs) && v.capturedMs >= 0);
    assert.ok(Number.isFinite(v.missingMs) && v.missingMs >= 0);
  }
  // Unusable numbers accuse NOBODY: a non-finite duration is treated as "no
  // measurement", never as an infinitely long silent press.
  assert.equal(judgeCaptureShortfall(NaN, NaN).dropped, false);
  assert.equal(judgeCaptureShortfall(Infinity, 0).dropped, false);
  assert.equal(judgeCaptureShortfall(-5_000, -1).dropped, false);
});

// ---- constat 4 (adverse review V2): pre-roll must not mask a real drop ----

test("constat 4: judgeCaptureShortfall defaults preRollMs to 0 - the original arithmetic, unchanged, for a caller that omits it", () => {
  const withDefault = judgeCaptureShortfall(6_000, 2_000);
  const withExplicitZero = judgeCaptureShortfall(6_000, 2_000, 0);
  assert.deepEqual(withDefault, withExplicitZero);
  assert.equal(withDefault.dropped, true);
  assert.equal(withDefault.missingMs, 4_000);
});

test("constat 4: a real mid-hold drop hidden under a warm capture's pre-roll cushion is caught once the credit is passed in", () => {
  const heldMs = 3_500;
  // 1700 ms of real audio during the hold (1800 ms genuinely missing out of
  // 3500 ms held) plus a 500 ms pre-roll cushion prepended by a warm capture.
  const apparentCapturedMs = 2_200;
  // Pre-roll-blind: 3500 - 2200 = 1300 ms "missing", under the 1500 ms bar -
  // this is exactly the false negative constat 4 describes.
  assert.equal(
    judgeCaptureShortfall(heldMs, apparentCapturedMs).dropped,
    false,
    "the old, pre-roll-blind reading misses the drop",
  );
  // Net of the credited cushion, it is 1800 ms missing - over the bar.
  const v = judgeCaptureShortfall(heldMs, apparentCapturedMs, PRE_ROLL_MS);
  assert.equal(v.dropped, true);
  assert.equal(v.missingMs, 1_800);
  assert.equal(v.capturedMs, apparentCapturedMs, "the raw captured figure for logging is left untouched");
});

test("constat 4: a healthy warm capture (capturedMs > heldMs, pre-roll only) is never flagged, whatever the credit", () => {
  // capturedMs = heldMs + up to PRE_ROLL_MS of legitimate pre-roll: exactly
  // the case the constat names ("capturedMs peut dépasser heldMs").
  const v = judgeCaptureShortfall(3_000, 3_000 + PRE_ROLL_MS, PRE_ROLL_MS);
  assert.equal(v.missingMs, 0);
  assert.equal(v.dropped, false);
});

test("constat 4 safety margin: crediting the ring's worst case can never manufacture a false positive on a healthy capture", () => {
  // A "healthy" capture's capturedMs is always heldMs + SOME non-negative
  // pre-roll contribution actually buffered (0..PRE_ROLL_MS - main cannot see
  // which). Crediting the full PRE_ROLL_MS regardless of how little was
  // really buffered can drive missingMs no higher than PRE_ROLL_MS itself,
  // which must stay well under SHORTFALL_MIN_MISSING_MS.
  assert.ok(PRE_ROLL_MS < SHORTFALL_MIN_MISSING_MS, "the credit's own ceiling must be under the trigger bar");
  for (const actualPreRollBuffered of [0, 1, 137, 499, PRE_ROLL_MS]) {
    const heldMs = SHORTFALL_MIN_HELD_MS + 500; // long enough to be judged at all
    const capturedMs = heldMs + actualPreRollBuffered; // zero real loss
    const v = judgeCaptureShortfall(heldMs, capturedMs, PRE_ROLL_MS);
    assert.equal(v.dropped, false, `actual pre-roll buffered=${actualPreRollBuffered} must never trip the guard`);
    assert.ok(v.missingMs <= PRE_ROLL_MS);
  }
});

test("constat 4: a negative or non-finite preRollMs is treated as zero credit, not a crash or a negative", () => {
  for (const bad of [NaN, -500, Infinity, -Infinity]) {
    assert.doesNotThrow(() => judgeCaptureShortfall(3_000, 2_000, bad));
  }
  const v = judgeCaptureShortfall(6_000, 2_000, NaN);
  assert.equal(v.missingMs, 4_000, "NaN credit behaves exactly like 0 credit");
});

// ---- preRollCreditMs: the worst-case credit for a prewarm mode ----

test("preRollCreditMs: 'off' credits nothing, 'after' and 'always' credit the ring's full capacity", () => {
  assert.equal(preRollCreditMs("off"), 0);
  assert.equal(preRollCreditMs("after"), PRE_ROLL_MS);
  assert.equal(preRollCreditMs("always"), PRE_ROLL_MS);
});

// ---- zero retention (plan §5.4) ----

test("B9: the verdict and its log line carry durations only, never a word of the dictation", () => {
  const v = judgeCaptureShortfall(6_000, 1_000);
  for (const value of Object.values(v)) {
    assert.ok(typeof value === "number" || typeof value === "boolean");
  }
  const line = shortfallLogLine(v);
  assert.match(line, /6000 ms/);
  assert.match(line, /1000 ms/);
  // It says what to check, not just that something happened.
  assert.match(line, /headset|audio service|exclusive/i);
});

// ---- the wiring, asserted as source text (index.ts imports "electron") ----

test("B9-wiring: index.ts judges the press BEFORE the 300 ms release-noise return", () => {
  const src = readSrc("src", "main", "index.ts");
  // The shape moved with the pre-roll fix (both the judge and the guard now
  // reason on the hold's own audio, net of the warm buffer), so this anchors on
  // the CALL and the GUARD rather than on their exact arguments. The invariant
  // is the ORDER, and that is what the assertion below still checks.
  const judgeAt = src.indexOf("noteCaptureContinuity(payload.durationMs,");
  const noiseAt = src.indexOf("if (payload.durationMs - preRoll < 300)");
  assert.ok(judgeAt > 0, "the CAPTURE_DONE handler must judge the press");
  assert.ok(noiseAt > 0);
  assert.ok(judgeAt < noiseAt, "a mic that died early comes back as a tiny clip: judge it before dropping it");
});

test("B9-wiring: the press window is read once and cleared, so a WAV without a press is never judged", () => {
  const src = readSrc("src", "main", "index.ts");
  const at = src.indexOf("function noteCaptureContinuity(");
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /pressStartedAt = 0;/);
  assert.match(body, /pressEndedAt = 0;/);
  assert.match(body, /if \(startedAt === 0 \|\| endedAt <= startedAt\) return;/);
  assert.match(body, new RegExp(`SILENT_FAILURE\\.micDroppedMidDictation`));
});

test("B9-wiring: the counter name is in the closed vocabulary and reaches Diagnostics", () => {
  assert.equal(SILENT_FAILURE.micDroppedMidDictation, "mic-dropped-mid-dictation");
  // It rides the EXISTING snapshot, so no new channel had to be opened.
  assert.match(readSrc("src", "shared", "hotpath.ts"), /silentFailureCounts:\s*silentFailures\.snapshot\(\)/);
});
