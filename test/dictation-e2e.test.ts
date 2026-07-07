import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WhisperSidecar } from "../src/main/asr/sidecar";
import { modelPath, DEFAULT_MODEL_FILE } from "../src/main/asr/modelStore";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../src/shared/vad";
import { gateTranscript } from "../src/shared/textGate";
import { encodeWav } from "../src/shared/wav";

// The full dictation pipeline exercised with REAL speech audio, no human in
// the loop: Windows TTS (SAPI) speaks a sentence into a 16 kHz mono WAV, which
// then runs the exact production path (VAD gate -> trim -> warm whisper-server
// -> hallucination gate). Skipped when the model is absent (CI); on the dev
// machine it proves the audio-to-text spine end to end and prints the latency.

const BIN = path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64.exe");
const MODEL = modelPath(DEFAULT_MODEL_FILE);
const available =
  process.platform === "win32" && fs.existsSync(BIN) && fs.existsSync(MODEL);

const SENTENCE = "Hello, this is a local dictation test for the flow application.";

function synthesizeTts(text: string): Uint8Array {
  const wavPath = path.join(os.tmpdir(), `agrflow-tts-${process.pid}.wav`);
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);",
    `$s.SetOutputToWaveFile('${wavPath}', $f);`,
    `$s.Speak('${text.replace(/'/g, "''")}');`,
    "$s.Dispose();",
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 30_000 });
  const bytes = fs.readFileSync(wavPath);
  fs.unlinkSync(wavPath); // synthetic input, still: leave nothing behind
  return new Uint8Array(bytes);
}

/** SAPI may write extra RIFF chunks; find the data chunk wherever it is. */
function pcmFromAnyWav(wav: Uint8Array): Int16Array {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let off = 12; // past RIFF....WAVE
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
  "TTS speech runs the whole pipeline: VAD passes, transcript matches",
  { skip: !available ? "model or binary not present on this machine" : false },
  async () => {
    const tts = synthesizeTts(SENTENCE);
    const pcm = pcmFromAnyWav(tts);
    const speech = analyzeSpeech(pcm);
    assert.ok(hasSpeech(speech), `VAD must hear TTS speech (voicedMs=${speech.voicedMs})`);

    const sc = new WhisperSidecar({ binaryPath: BIN, modelPath: MODEL });
    try {
      const { text, ms } = await sc.transcribe(encodeWav(trimToSpeech(pcm, speech)));
      const clean = gateTranscript(text);
      assert.ok(clean, `gate must keep real speech (raw=${JSON.stringify(text)})`);
      const norm = clean.toLowerCase();
      assert.ok(norm.includes("dictation"), `transcript should mention dictation: ${clean}`);
      assert.ok(norm.includes("test"), `transcript should mention test: ${clean}`);
      console.log(`[e2e] "${clean}" in ${ms} ms`);
    } finally {
      sc.stop();
    }
  },
);
