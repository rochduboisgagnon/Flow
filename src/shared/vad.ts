// Energy-based voice activity detection, run BEFORE the ASR (plan 5.9,
// robustness #1). Whisper's most damaging failure mode is inventing text on
// silence: an accidental shortcut press must never insert hallucinated
// garbage. Gate: if the utterance contains too little speech energy, it never
// even reaches the model. Bonus: trimming leading/trailing silence shortens
// what the model has to decode - the anti-hallucination gate is also a speed
// win.
//
// Pure math on Int16 PCM, no deps, unit-tested. The threshold adapts to the
// utterance's own noise floor so a laptop fan or street noise does not read
// as speech, while quiet speech over a quiet floor still passes.

export const FRAME_MS = 30;
export const MIN_VOICED_MS = 250; // shorter than one short word -> not speech

// Absolute minimum RMS (Int16 scale, full scale 32767) below which a frame can
// never count as speech, whatever the floor: ~0.4 % of full scale.
const ABS_MIN_RMS = 130;
// A speech frame must rise this far above the utterance's own noise floor.
const FLOOR_RATIO = 2.5;
// Silence kept around the detected speech when trimming, so the model still
// hears natural onsets/offsets and word edges are not clipped.
const PAD_MS = 150;

export interface SpeechAnalysis {
  voicedMs: number;
  /** Padded speech bounds, in samples ([0,0) when no speech). */
  start: number;
  end: number;
}

export function analyzeSpeech(pcm: Int16Array, sampleRate = 16_000): SpeechAnalysis {
  const frameLen = Math.round((sampleRate * FRAME_MS) / 1000);
  const frameCount = Math.floor(pcm.length / frameLen);
  if (frameCount === 0) return { voicedMs: 0, start: 0, end: 0 };

  const rms = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const s = pcm[base + i];
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / frameLen);
  }

  // Noise floor: the 20th percentile frame - robust to utterances that are
  // mostly speech, and to a couple of outlier-quiet frames.
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(frameCount * 0.2)];
  const threshold = Math.max(ABS_MIN_RMS, floor * FLOOR_RATIO);

  let voiced = 0;
  let first = -1;
  let last = -1;
  for (let f = 0; f < frameCount; f++) {
    if (rms[f] >= threshold) {
      voiced++;
      if (first === -1) first = f;
      last = f;
    }
  }
  if (first === -1) return { voicedMs: 0, start: 0, end: 0 };

  const pad = Math.round((sampleRate * PAD_MS) / 1000);
  const start = Math.max(0, first * frameLen - pad);
  const end = Math.min(pcm.length, (last + 1) * frameLen + pad);
  return { voicedMs: voiced * FRAME_MS, start, end };
}

export function hasSpeech(a: SpeechAnalysis): boolean {
  return a.voicedMs >= MIN_VOICED_MS;
}

/** Subarray view of the speech region (no copy; the WAV encoder copies). */
export function trimToSpeech(pcm: Int16Array, a: SpeechAnalysis): Int16Array {
  if (a.end <= a.start) return pcm.subarray(0, 0);
  return pcm.subarray(a.start, a.end);
}
