// Minimal WAV writer: Float32 PCM chunks -> 16-bit mono WAV, entirely in RAM.
// Capturing raw PCM ourselves (AudioWorklet at 16 kHz) is what lets AGR Flow
// skip ffmpeg altogether: the ASR sidecar eats this WAV as-is.

export const SAMPLE_RATE = 16_000;

export function floatTo16BitPcm(chunks: Float32Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      // Clamp: worklet samples can exceed [-1, 1] on hot input; wrapping would
      // turn clipping into loud garbage instead of a flat ceiling.
      const s = Math.max(-1, Math.min(1, c[i]));
      out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out;
}

export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export function durationMs(sampleCount: number, sampleRate = SAMPLE_RATE): number {
  return Math.round((sampleCount / sampleRate) * 1000);
}

/** Reads back the Int16 samples of a WAV produced by encodeWav (canonical
 * 44-byte header). Used by the VAD gate in the main process. Throws on
 * anything that is not our own format: the overlay is the only producer. */
export function pcmFromWav(wav: Uint8Array): Int16Array {
  if (wav.length < 44) throw new Error("WAV too short");
  const tag = (off: number, s: string) =>
    Array.from(s).every((c, i) => wav[off + i] === c.charCodeAt(0));
  if (!tag(0, "RIFF") || !tag(8, "WAVE") || !tag(36, "data")) {
    throw new Error("not a canonical AGR Flow WAV");
  }
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const dataBytes = Math.min(v.getUint32(40, true), wav.length - 44);
  const out = new Int16Array(Math.floor(dataBytes / 2));
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(44 + i * 2, true);
  return out;
}
