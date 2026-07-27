import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LongRecorder } from "../src/main/longform";
import { WhisperSidecar } from "../src/main/asr/sidecar";
import { modelPath, DEFAULT_MODEL_FILE } from "../src/main/asr/modelStore";

// The long-form pipeline with REAL speech and the REAL engine: two TTS
// sentences separated by a long pause stream through the recorder like live
// microphone slices; the transcript must carry both, in order, with correct
// summary-free (raw) finalization. Skipped where the model is absent (CI).

const BINS = [
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-vulkan.exe"),
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-cpu.exe"),
];
const MODEL = modelPath(DEFAULT_MODEL_FILE);
const available =
  process.platform === "win32" && BINS.some((b) => fs.existsSync(b)) && fs.existsSync(MODEL);

function tts(text: string): Int16Array {
  const wavPath = path.join(os.tmpdir(), `agrflow-lt-${Math.floor(Math.random() * 1e9)}.wav`);
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);",
    `$s.SetOutputToWaveFile('${wavPath}', $f);`,
    `$s.Speak('${text.replace(/'/g, "''")}');`,
    "$s.Dispose();",
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 30_000 });
  const wav = new Uint8Array(fs.readFileSync(wavPath));
  fs.unlinkSync(wavPath);
  // Locate the data chunk (SAPI writes extra chunks).
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]);
    const size = v.getUint32(off + 4, true);
    if (id === "data") {
      const out = new Int16Array(Math.floor(size / 2));
      for (let i = 0; i < out.length; i++) out[i] = v.getInt16(off + 8 + i * 2, true);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

test(
  "long-form: two spoken sentences stream through the real engine into the transcript",
  { skip: !available ? "model or binary not present on this machine" : false },
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-lt-"));
    const sc = new WhisperSidecar({ binaryPaths: BINS, modelPath: MODEL });
    const rec = new LongRecorder({
      getSidecar: () => sc,
      recentPathOverride: path.join(work, "recent.json"),
      // C10: start() now runs a retention purge; keep it off the real ~/.agr-flow.
      historyRootOverride: path.join(work, "history"),
    });
    try {
      const started = rec.start({ dir: work, title: "Sprint Review" });
      assert.equal(started.ok, true, started.error ?? "expected ok");
      const a = tts("The first topic today is the quarterly budget review.");
      const b = tts("The second topic is the hiring plan for the new team.");
      const gap = new Int16Array(16_000 * 2); // 2 s pause between speakers
      // Stream like the overlay does: ~5 s slices.
      const all = new Int16Array(a.length + gap.length + b.length);
      all.set(a, 0);
      all.set(gap, a.length);
      all.set(b, a.length + gap.length);
      const SLICE = 16_000 * 5;
      for (let o = 0; o < all.length; o += SLICE) {
        rec.onChunk(all.slice(o, Math.min(all.length, o + SLICE)));
      }
      const stopped = rec.stop();
      assert.equal(stopped.ok, true);
      for (let i = 0; i < 600 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(rec.isBusy, false, "finalize must complete");
      const transcript = fs.readFileSync(stopped.docPath, "utf8").toLowerCase();
      assert.ok(transcript.includes("budget"), transcript);
      assert.ok(transcript.includes("hiring"), transcript);
      assert.ok(
        transcript.indexOf("budget") < transcript.indexOf("hiring"),
        "order must be preserved",
      );
    } finally {
      sc.stop();
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
);
