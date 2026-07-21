// Pure pieces of the long-form mode (plan §6, the Plaud-style second mode):
// pause-aware segmentation, transcript/notes formatting, summary templates and
// the recent-recordings list. No Electron, no IO - unit-tested directly.
//
// The long mode is the ONLY part of AGR Flow that writes content to disk, and
// it writes into a folder the USER chose (plan §7.2b). Dictation stays
// zero-retention; these two rules never mix.

export const SAMPLE_RATE = 16_000;

// Segments aim for this length; a natural pause closes one earlier, a hard cap
// forces a cut at the quietest point of the tail. R5: shrunk so the transcript
// tumbles out by short phrases a few seconds after speech (first words in ~3-8 s
// instead of ~10-27 s). whisper runs far faster than real time (GPU especially),
// so decoding 3-4x more often is essentially free while feeling live.
export const SEGMENT_TARGET_MS = 7_000;
export const SEGMENT_MIN_MS = 2_500; // don't close before this unless a pause/stop
const PAUSE_MS = 1_100; // trailing silence that closes a segment naturally
const FRAME_MS = 30;
const ABS_MIN_RMS = 130; // same speech floor as the dictation VAD

/** Frame RMS values for the tail of a PCM buffer (last `tailMs`). */
function tailRms(pcm: Int16Array, tailMs: number): { rms: Float64Array; frameLen: number; start: number } {
  const frameLen = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
  const tailSamples = Math.min(pcm.length, Math.round((SAMPLE_RATE * tailMs) / 1000));
  const start = pcm.length - tailSamples;
  const frames = Math.floor(tailSamples / frameLen);
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = start + f * frameLen;
    for (let i = 0; i < frameLen; i++) sum += pcm[base + i] * pcm[base + i];
    rms[f] = Math.sqrt(sum / frameLen);
  }
  return { rms, frameLen, start };
}

/** True when the buffer ends in a natural pause (PAUSE_MS of sub-floor tail). */
export function endsInPause(pcm: Int16Array): boolean {
  const need = Math.ceil(PAUSE_MS / FRAME_MS);
  const { rms } = tailRms(pcm, PAUSE_MS + FRAME_MS);
  if (rms.length < need) return false;
  for (let i = rms.length - need; i < rms.length; i++) if (rms[i] >= ABS_MIN_RMS) return false;
  return true;
}

/** Best cut point in the last `windowMs`: the center of the quietest stretch.
 * Returns a sample index (always > 0, <= pcm.length). */
export function findCutPoint(pcm: Int16Array, windowMs = 8_000): number {
  const { rms, frameLen, start } = tailRms(pcm, windowMs);
  if (rms.length === 0) return pcm.length;
  // Quietest run of 10 frames (300 ms) in the window.
  const RUN = Math.min(10, rms.length);
  let best = 0;
  let bestSum = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < rms.length; i++) {
    sum += rms[i];
    if (i >= RUN) sum -= rms[i - RUN];
    if (i >= RUN - 1 && sum < bestSum) {
      bestSum = sum;
      best = i - RUN + 1;
    }
  }
  const cut = start + Math.round((best + RUN / 2) * frameLen);
  return Math.max(1, Math.min(pcm.length, cut));
}

// ---- formatting ----

export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return p(h) + ":" + p(m) + ":" + p(sec);
}

// v3 chantier 4: the recording produces ONE document (summary + transcript).
// This header opens it; the summary is spliced in at finalize.
export function transcriptHeader(title: string, startedIso: string): string {
  return `# ${title}\n\n- recorded: ${startedIso}\n- engine: AGR Flow (100% local)\n\n`;
}

export function transcriptLine(offsetMs: number, text: string): string {
  return `[${hms(offsetMs)}] ${text}\n\n`;
}

export function markLine(offsetMs: number): string {
  return `> [Moment marked at ${hms(offsetMs)}]\n\n`;
}

/** Honest hole in the capture (device locked, network loss): the audio file
 * simply skips it, the transcript says so. offsetMs is wall time since start;
 * seconds is the measured length of the hole. */
export function gapLine(offsetMs: number, seconds: number): string {
  const n = Math.max(1, Math.round(seconds));
  return `> [Recording paused ~${n}s (device locked or offline) around ${hms(offsetMs)}]\n\n`;
}

/** File-safe recording base name: kebab title + local timestamp. */
export function recordingBaseName(title: string, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "-" + pad(d.getHours()) + pad(d.getMinutes());
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return (slug || "recording") + "-" + stamp;
}

/** Meeting-notes splice (2026-07-21): rebuild the ONE document as
 * <header>## Notes ... ## Transcript <raw transcript>, whatever state it is
 * in. Three input shapes exist: (a) header + "## Summary ... ## Transcript ..."
 * (an Ollama summary was spliced at finalize), (b) header + bare timestamped
 * lines with NO section marker at all (no local LLM - the common case), and
 * (c) header + "## Notes ... ## Transcript ..." (a regenerate). Idempotent:
 * an earlier Summary/Notes block is replaced, never stacked, and shape (b)
 * gains its "## Transcript" marker. The header is passed in (rebuilt from
 * recent.json by the caller) so this works after an engine restart, when the
 * in-memory header of the live recorder is long gone. */
export function spliceNotes(doc: string, header: string, notes: string): string {
  let body = doc.startsWith(header) ? doc.slice(header.length) : doc;
  if (body === doc) {
    // Header drifted (e.g. hand-edited title): fall back to the engine line,
    // the one part of the header no user has a reason to touch.
    const engineLine = "- engine: AGR Flow (100% local)\n\n";
    const at = doc.indexOf(engineLine);
    if (at >= 0) {
      header = doc.slice(0, at + engineLine.length);
      body = doc.slice(at + engineLine.length);
    }
  }
  // Strip any previous scaffolding down to the raw timestamped transcript.
  const prior = body.match(/^## (?:Summary|Notes)\n[\s\S]*?\n## Transcript\n+/);
  if (prior) body = body.slice(prior[0].length);
  return header + "## Notes\n\n" + notes.trim() + "\n\n## Transcript\n\n" + body.replace(/^\s+/, "");
}

// ---- summary templates (plan §6: gabarits de resume) ----

export const SUMMARY_TEMPLATES = [
  { id: "meeting", label: "Meeting notes" },
  { id: "client", label: "Client interaction" },
  { id: "raw", label: "Raw transcript only (no summary)" },
] as const;

export type TemplateId = (typeof SUMMARY_TEMPLATES)[number]["id"];

export function summaryPrompt(template: TemplateId, transcript: string, marks: number[]): string {
  const marked = marks.length
    ? `\nMoments the user MARKED as important during the recording (offsets): ${marks.map(hms).join(", ")}. Give these passages extra attention in the summary.\n`
    : "";
  const shape =
    template === "client"
      ? "Write, in the LANGUAGE of the transcript: ## Resume (one paragraph), ## Besoins exprimes (bullets), ## Engagements pris (bullets: who commits to what, deadlines), ## Prochaines etapes (bullets), ## Points de vigilance (bullets, only if any)."
      : "Write, in the LANGUAGE of the transcript: ## Resume (one paragraph), ## Points cles (bullets), ## Decisions (bullets), ## Actions (bullets: owner and deadline when stated), ## Suivis (bullets, only if any).";
  return [
    "You summarize a meeting transcript. Base EVERYTHING on the transcript below; never invent facts, names or numbers. Output ONLY the requested markdown sections, no preamble.",
    marked,
    shape,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/** Two-level map-reduce guard for long transcripts: the caller summarizes each
 * chunk, then summarizes the joined chunk-summaries. */
export function chunkTranscript(transcript: string, maxChars = 24_000): string[] {
  if (transcript.length <= maxChars) return [transcript];
  const out: string[] = [];
  let rest = transcript;
  while (rest.length > maxChars) {
    // Cut on a paragraph boundary near the limit so no utterance is split.
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim().length > 0) out.push(rest);
  return out;
}

// ---- recent recordings (v6 c8: only the LAST one is remembered) ----
// v6 c8 (Roch): the setup no longer lists past recordings, so we keep exactly
// ONE entry - the last capture. pushRecent therefore REPLACES the previous
// reference. This only forgets the entry in this list; it deletes NOTHING on
// disk (a document the user already saved into their own folder stays intact).
export const RECENT_MAX = 1;

export interface RecentEntry {
  title: string;
  startedIso: string;
  dir: string;
  docPath: string; // the ONE document (summary + transcript), v3 chantier 4
  audioPath: string; // "" unless the user chose to keep the full audio
  durationMs: number;
  // v6 c7: true while the document still lives in the app-owned staging folder
  // (no destination chosen yet). Cleared once the user saves it into their own
  // folder (/long/save). Optional so older recent.json files still parse.
  staged?: boolean;
}

export function pushRecent(list: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list].slice(0, RECENT_MAX);
}
