import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WhisperSidecar } from "../src/main/asr/sidecar";
import { modelPath, DEFAULT_MODEL_FILE } from "../src/main/asr/modelStore";
import { encodeWav } from "../src/shared/wav";

// Integration against the REAL pinned whisper-server + the locally downloaded
// model. Skipped where either is missing (CI has no 190 MB model): its job is
// to prove on the dev machine that the pinned binary accepts our protocol -
// in particular verbose_json - before anything ships.

const BINS = [
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-vulkan.exe"),
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-cpu.exe"),
];
const MODEL = modelPath(DEFAULT_MODEL_FILE);
const available =
  process.platform === "win32" && BINS.some((b) => fs.existsSync(b)) && fs.existsSync(MODEL);

function tonePcm(ms: number, amp: number, freq = 220): Int16Array {
  const out = new Int16Array(Math.round((16_000 * ms) / 1000));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / 16_000) * amp);
  }
  return out;
}

test(
  "pinned whisper-server accepts verbose_json and answers parseably",
  { skip: !available ? "model or binary not present on this machine" : false },
  async () => {
    const sc = new WhisperSidecar({ binaryPaths: BINS, modelPath: MODEL });
    try {
      // A pure tone is not speech: whatever the model mumbles, the point is
      // that the request round-trips and our parser accepts the response
      // (a server rejecting verbose_json would 4xx or return raw text).
      const { text, ms } = await sc.transcribe(encodeWav(tonePcm(1200, 5000)));
      assert.equal(typeof text, "string");
      assert.ok(ms > 0);
    } finally {
      sc.stop();
    }
  },
);
