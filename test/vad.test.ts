import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSpeech, hasSpeech, trimToSpeech, MIN_VOICED_MS } from "../src/shared/vad";

const SR = 16_000;

/** Synth helpers: silence, low noise floor, and a loud "voiced" tone. */
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}
function noise(ms: number, amp: number): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  let seed = 42;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // deterministic PRNG
    out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amp);
  }
  return out;
}
function tone(ms: number, amp: number, freq = 220): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp);
  }
  return out;
}
function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("pure digital silence has no speech", () => {
  const a = analyzeSpeech(silence(1500));
  assert.equal(a.voicedMs, 0);
  assert.equal(hasSpeech(a), false);
});

test("quiet room noise (fan, hiss) is not speech", () => {
  const a = analyzeSpeech(noise(1500, 80)); // well under the absolute floor
  assert.equal(hasSpeech(a), false);
});

test("a real utterance passes and is trimmed to its bounds", () => {
  const pcm = concat(noise(600, 60), tone(800, 6000), noise(700, 60));
  const a = analyzeSpeech(pcm);
  assert.ok(hasSpeech(a), `voicedMs=${a.voicedMs}`);
  const trimmed = trimToSpeech(pcm, a);
  // Trimmed length = speech + the two 150 ms pads (some frame rounding).
  assert.ok(trimmed.length < pcm.length, "must actually trim");
  assert.ok(trimmed.length >= Math.round((SR * 800) / 1000), "must keep all the speech");
  assert.ok(trimmed.length <= Math.round((SR * (800 + 2 * 150 + 2 * 30)) / 1000));
});

test("a too-short blip is rejected even if loud", () => {
  const pcm = concat(silence(500), tone(120, 8000), silence(500));
  const a = analyzeSpeech(pcm);
  assert.ok(a.voicedMs < MIN_VOICED_MS);
  assert.equal(hasSpeech(a), false);
});

test("speech over a noisy floor still passes (adaptive threshold)", () => {
  const floor = 400; // loud fan
  const pcm = concat(noise(500, floor), tone(700, 7000), noise(500, floor));
  const a = analyzeSpeech(pcm);
  assert.ok(hasSpeech(a), `voicedMs=${a.voicedMs}`);
});

test("loud steady noise alone does not read as speech", () => {
  // Constant-amplitude noise: the floor rises with it, so nothing stands out.
  const a = analyzeSpeech(noise(1500, 900));
  assert.equal(hasSpeech(a), false);
});

test("input shorter than one frame is silent", () => {
  const a = analyzeSpeech(new Int16Array(100));
  assert.equal(a.voicedMs, 0);
  assert.equal(trimToSpeech(new Int16Array(100), a).length, 0);
});
