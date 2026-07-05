import test from "node:test";
import assert from "node:assert/strict";
import { floatTo16BitPcm, encodeWav, durationMs, SAMPLE_RATE } from "../src/shared/wav";

test("float chunks concatenate and convert with clamping", () => {
  const pcm = floatTo16BitPcm([
    new Float32Array([0, 0.5, -0.5]),
    new Float32Array([1, -1, 2, -2]), // 2/-2 = hot input, must clamp not wrap
  ]);
  assert.equal(pcm.length, 7);
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], Math.trunc(0.5 * 0x7fff)); // Int16Array truncates toward zero
  assert.equal(pcm[2], -0.5 * 0x8000);
  assert.equal(pcm[3], 0x7fff);
  assert.equal(pcm[4], -0x8000);
  assert.equal(pcm[5], 0x7fff); // clamped
  assert.equal(pcm[6], -0x8000); // clamped
});

test("wav header is a valid 16 kHz mono RIFF", () => {
  const pcm = new Int16Array(16_000); // exactly one second
  const wav = encodeWav(pcm);
  const v = new DataView(wav.buffer);
  const ascii = (off: number, n: number) =>
    String.fromCharCode(...wav.subarray(off, off + n));
  assert.equal(wav.length, 44 + 32_000);
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(v.getUint32(4, true), 36 + 32_000);
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), SAMPLE_RATE);
  assert.equal(v.getUint32(28, true), SAMPLE_RATE * 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 32_000);
});

test("samples land unchanged after the 44-byte header", () => {
  const pcm = new Int16Array([1, -1, 12345, -12345]);
  const wav = encodeWav(pcm);
  const back = new Int16Array(wav.buffer, 44);
  assert.deepEqual([...back], [1, -1, 12345, -12345]);
});

test("duration math", () => {
  assert.equal(durationMs(16_000), 1000);
  assert.equal(durationMs(8_000), 500);
  assert.equal(durationMs(0), 0);
});
