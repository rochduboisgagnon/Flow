// Warm-server dictation latency bench: `npx tsx scripts/bench-latency.ts`.
// Speaks short/medium sentences through Windows TTS at 16 kHz, runs the
// production path (VAD trim -> warm whisper-server), prints per-utterance
// latency. The dial to watch while working on speed (plan 5.6).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WhisperSidecar } from "../src/main/asr/sidecar";
import { modelPath, DEFAULT_MODEL_FILE } from "../src/main/asr/modelStore";
import { analyzeSpeech, trimToSpeech } from "../src/shared/vad";
import { encodeWav } from "../src/shared/wav";

const BINS = [
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-vulkan.exe"),
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-cpu.exe"),
];
const MODEL_FILE = process.argv[2] ?? DEFAULT_MODEL_FILE;

function tts(text: string): Uint8Array {
  const wavPath = path.join(os.tmpdir(), `bench-${Math.floor(Math.random() * 1e9)}.wav`);
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);",
    `$s.SetOutputToWaveFile('${wavPath}', $f);`,
    `$s.Speak('${text.replace(/'/g, "''")}');`,
    "$s.Dispose();",
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 30_000 });
  const b = fs.readFileSync(wavPath);
  fs.unlinkSync(wavPath);
  return new Uint8Array(b);
}

function pcmFromAnyWav(wav: Uint8Array): Int16Array {
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

async function main() {
  const sc = new WhisperSidecar({ binaryPaths: BINS, modelPath: modelPath(MODEL_FILE) });
  const t0 = Date.now();
  await sc.ensureStarted();
  console.log(`model ${MODEL_FILE} warm in ${Date.now() - t0} ms`);
  const cases: Array<[string, string]> = [
    ["short-en", "Send me the report."],
    ["mid-en", "Can you send me the quarterly report before tomorrow morning please?"],
  ];
  for (const [name, text] of cases) {
    const pcm = pcmFromAnyWav(tts(text));
    const a = analyzeSpeech(pcm);
    const wav = encodeWav(trimToSpeech(pcm, a));
    for (let i = 0; i < 2; i++) {
      const { text: out, ms } = await sc.transcribe(wav);
      console.log(
        `${name} run${i + 1}: ${ms} ms | audio=${Math.round(pcm.length / 16)} ms | "${out}"`,
      );
    }
  }
  sc.stop();
}
void main();
