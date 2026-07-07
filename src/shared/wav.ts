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

/** Reads back the Int16 samples of a 16 kHz mono 16-bit PCM WAV. Walks the
 * RIFF chunks (writers like SAPI add LIST/fact chunks before data, so a
 * fixed-44-byte assumption breaks on anything but our own encoder - learned
 * when /transcribe 500'd on perfectly valid external WAVs). Throws with a
 * clear message on any other format: the API contract is explicit. */
export function pcmFromWav(wav: Uint8Array): Int16Array {
  if (wav.length < 44) throw new Error("WAV too short");
  const tag = (off: number, s: string) =>
    Array.from(s).every((c, i) => wav[off + i] === c.charCodeAt(0));
  if (!tag(0, "RIFF") || !tag(8, "WAVE")) throw new Error("not a WAV file");
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= wav.length) {
    const id = String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      const format = v.getUint16(off + 8, true);
      const channels = v.getUint16(off + 10, true);
      const rate = v.getUint32(off + 12, true);
      const bits = v.getUint16(off + 22, true);
      if (format !== 1 || channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        throw new Error(`expected 16 kHz mono 16-bit PCM WAV (got fmt=${format} ch=${channels} rate=${rate} bits=${bits})`);
      }
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) throw new Error("WAV data chunk before fmt");
      const dataBytes = Math.min(size, wav.length - off - 8);
      const out = new Int16Array(Math.floor(dataBytes / 2));
      for (let i = 0; i < out.length; i++) out[i] = v.getInt16(off + 8 + i * 2, true);
      return out;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}
