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

// The last line of every document's header. Exported because three different
// places have to agree on it byte for byte: transcriptHeader writes it,
// spliceNotes falls back to it when the user edited the title, and the
// interruption note (U4) is inserted straight after it.
export const ENGINE_LINE = "- engine: AGR Flow (100% local)\n\n";

// v3 chantier 4: the recording produces ONE document (summary + transcript).
// This header opens it; the summary is spliced in at finalize.
export function transcriptHeader(title: string, startedIso: string): string {
  return `# ${title}\n\n- recorded: ${startedIso}\n` + ENGINE_LINE;
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

/** U4: the honest note a recording carries when it did NOT end through a normal
 * Stop. Two ways that happens, and the document must not pretend otherwise:
 *  - "quit": the user closed Flow while the recording was still running. The
 *    engine files the document synchronously on its way out, which leaves room
 *    for neither a summary nor the drain of the transcription queue.
 *  - "recovered": the app never got to run any shutdown code at all (crash,
 *    power loss, forced kill) and the folder was found orphaned at the next
 *    boot, so nobody was there to count what was still in flight.
 * `pending` is how many audio segments were still queued for transcription;
 * a negative value means "unknown", the normal case for a recovery. */
export function interruptedNote(kind: "quit" | "recovered", pending: number): string {
  const how =
    kind === "quit"
      ? "Flow was closed while this recording was still running."
      : "Flow stopped unexpectedly while this recording was running (crash, power loss or forced quit), and the recording was recovered at the next startup.";
  const lost =
    pending > 0
      ? `the last ${pending} audio segment${pending > 1 ? "s were" : " was"} still queued for transcription and never transcribed`
      : pending === 0
        ? "nothing was left waiting for transcription"
        : "anything still waiting for transcription at that moment was lost";
  return `> [Interrupted recording: ${how} It was filed as it stood: no summary was generated, and ${lost}.]\n\n`;
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

// ---- D7: where the user's OWN notes sit in the finished document ----
//
// The two sub-headings of the "## Notes" block. The human's notes come FIRST,
// and that order is an argument rather than a layout preference:
//
//  1. It is the whole premise of the feature. Six words typed at the moment
//     something mattered outrank a paragraph a model inferred afterwards
//     (shared/liveNotes.ts's module note). Document order is the cheapest and
//     most durable way to say so: it still says it in five years, in Notepad,
//     with no app around to explain the hierarchy.
//  2. The generated part is DERIVED and disposable. A regenerate replaces it, a
//     passage removal deletes it outright (shared/redact.ts DECISION 2), and any
//     model can produce it again from the transcript. The human's notes are the
//     only part of this document nothing can reproduce. What cannot be
//     regenerated goes on top.
//  3. A reader who opens the file and reads the first thing in it should meet
//     something a person wrote and vouches for, not model output.
//
// WHY THE BLOCK AS A WHOLE STAYS WHERE IT IS, which is the harder question.
// shared/redact.ts finds the derived-notes block with a pattern ANCHORED at the
// start of the body (NOTES_BLOCK_RE, "^## (?:Summary|Notes)"), and that module
// is closed to this task. So anything inserted ABOVE the "## Notes" heading -
// a "## My notes" section of its own, however tidy - would stop that pattern
// matching, and a passage removal would then quietly leave the model-written
// notes in place, free to repeat the sentence the user just erased. That is the
// exact silent half-clean the redaction feature exists to prevent. Putting the
// human's notes INSIDE the block is therefore not a compromise for neatness, it
// is what keeps the removal complete.
//
// The price is real and is not hidden: a passage removal drops the whole block,
// the user's own verbatim notes with it. The Notes page names that in the
// confirmation before the click, in those words - see renderer/ui/pages/Notes.tsx.
export const MY_NOTES_HEADING = "### Your own notes";
export const GENERATED_NOTES_HEADING = "### Written from the transcript";

/** One rendered line of the human's notes: its offset, then its own words,
 * untouched. Same "[hh:mm:ss] " shape as transcriptLine, deliberately - a
 * reader should not have to learn a second timestamp format inside one file -
 * and it is also what guarantees a note can never begin a line with "#", ">"
 * or "-" (shared/liveNotes.ts DECISION 3). */
export function myNoteLine(atMs: number, text: string): string {
  return `[${hms(atMs)}] ${text}\n`;
}

/** The verbatim block, or "" when the user typed nothing.
 *
 * The notes are NOT rewritten, corrected or reordered here. Granola's pitch is
 * that it fixes your typos; Flow fixes them in the GENERATED text (the model is
 * told to) and leaves this block exactly as the user typed it. A document that
 * silently improved the human's own words would be lying about which of the two
 * authors wrote what, which is the one thing this whole document may never do. */
export function renderMyNotes(notes: ReadonlyArray<{ atMs: number; text: string }>): string {
  if (notes.length === 0) return "";
  return MY_NOTES_HEADING + "\n\n" + notes.map((n) => myNoteLine(n.atMs, n.text)).join("") + "\n";
}

/** Assemble the inside of the "## Notes" block from its two authors.
 *
 * With no human notes the output is the generated text ALONE, byte for byte
 * what this app has always written - so a document produced on a recording
 * where nobody typed anything is unchanged by this feature, and neither is any
 * consumer that reads one. */
export function composeNotesBlock(mine: string, generated: string): string {
  const m = mine.trim();
  const g = generated.trim();
  if (!m) return g;
  if (!g) return m;
  return m + "\n\n" + GENERATED_NOTES_HEADING + "\n\n" + g;
}

/** Split a "## Notes" block back into its two authors. Used to carry the human's
 * verbatim notes across a REGENERATE: the caller that regenerates (AGR Pilot,
 * or a future in-app button) hands over model text only, and it has no way to
 * know the user's notes were ever there. Without this, the first regenerate
 * after a meeting would silently destroy them. */
export function splitNotesBlock(content: string): { mine: string; generated: string } {
  const at = content.indexOf(MY_NOTES_HEADING);
  if (at < 0) return { mine: "", generated: content };
  const after = at + MY_NOTES_HEADING.length;
  // The human's block runs to the next "### " heading, or to the end.
  const next = content.indexOf("\n### ", after);
  const mine = content.slice(at, next < 0 ? content.length : next + 1);
  let generated = (content.slice(0, at) + (next < 0 ? "" : content.slice(next + 1))).trim();
  if (generated.startsWith(GENERATED_NOTES_HEADING)) {
    generated = generated.slice(GENERATED_NOTES_HEADING.length).trim();
  }
  return { mine: mine.trim(), generated };
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
 * in-memory header of the live recorder is long gone.
 *
 * D7: the block being replaced may carry the user's OWN verbatim notes, which
 * are not derived from anything and cannot be regenerated. So the rule is: the
 * caller's content WINS, and the document's existing verbatim block is carried
 * over only when the caller supplied none. That single rule serves both callers
 * correctly - finalize() passes the notes in (they live in the store, not yet in
 * the document), while a regenerate passes model text only and gets the human's
 * notes preserved for free. */
export function spliceNotes(doc: string, header: string, notes: string): string {
  let body = doc.startsWith(header) ? doc.slice(header.length) : doc;
  if (body === doc) {
    // Header drifted (e.g. hand-edited title): fall back to the engine line,
    // the one part of the header no user has a reason to touch.
    const at = doc.indexOf(ENGINE_LINE);
    if (at >= 0) {
      header = doc.slice(0, at + ENGINE_LINE.length);
      body = doc.slice(at + ENGINE_LINE.length);
    }
  }
  // Strip any previous scaffolding down to the raw timestamped transcript.
  let content = notes.trim();
  const prior = body.match(/^## (?:Summary|Notes)\n[\s\S]*?\n## Transcript\n+/);
  if (prior) {
    if (!content.includes(MY_NOTES_HEADING)) {
      const kept = splitNotesBlock(prior[0].replace(/^## (?:Summary|Notes)\n+/, "").replace(/\n## Transcript\n+$/, "")).mine;
      if (kept) content = composeNotesBlock(kept, content);
    }
    body = body.slice(prior[0].length);
  }
  return header + "## Notes\n\n" + content + "\n\n## Transcript\n\n" + body.replace(/^\s+/, "");
}

// ---- summary prompt (plan §6: gabarits de resume) ----
//
// One shape only. The template chooser was removed in v3 (one document, no
// picker), so finalize always asks for meeting-style notes; the earlier
// "client"/"raw" templates were never reachable from finalize and are gone.
//
// Two shape rules keep the on-disk document clean (finalize wraps the whole
// summary under a single "## Summary" heading):
//   - the lead summary is a PLAIN paragraph with NO heading of its own; a
//     "## Resume" heading here would stack a redundant empty title under the
//     "## Summary" wrapper (the doublon bug).
//   - section titles carry no "(one paragraph)"/"(bullets)" parentheticals,
//     which the model used to echo literally into the headings.
export function summaryPrompt(
  transcript: string,
  marks: number[],
  /** D7: the notes the user typed DURING the recording, already rendered as
   * "[hh:mm:ss] text" lines. They are handed to the model as the OUTLINE, not as
   * extra context - see the instruction below. */
  myNotes = "",
): string {
  // Review of ranks 9-10 (MAJOR): an ASYMMETRY that let a suggestion become
  // speech. `speechBlocks` in shared/liveAssist.ts deliberately drops the
  // "> [Flow suggestion ... NOT spoken by anyone" lines before feeding the live
  // assistant, with its own comment explaining why: an assistant that read the
  // whole document back "would feed itself its own output as if someone had said
  // it". This prompt received the very same document with no equivalent
  // instruction, and the review proved the consequence: a summary bullet
  // repeating the model's own suggestion, citing a real neighbouring timestamp,
  // survived citation checking and rendered as a clickable jump to a passage
  // that never contained the claim. The notes block is what a human reads and
  // what a connector will consume, so the lie landed exactly where it hurts.
  const suggestionRule = transcript.includes("> [Flow suggestion kept at ")
    ? "Some transcript lines are blockquotes beginning '> [Flow suggestion kept at'. Those were WRITTEN BY A MODEL and spoken by NOBODY. Never treat one as something a participant said, never attribute it to a person, and never state its content as a fact of the meeting. Use one only as a pointer to the spoken lines around it, which are the evidence."
    : "";
  const marked = marks.length
    ? `\nMoments the user MARKED as important during the recording (offsets): ${marks.map(hms).join(", ")}. Give these passages extra attention.\n`
    : "";
  // D7: the inversion the whole feature exists for. The model is not asked to
  // decide what mattered; it is told what mattered and asked to develop it. The
  // "may be misspelled" clause is deliberate: the user must be free to type fast
  // and badly, which only works if the model is told not to trip on it.
  const steer = myNotes.trim()
    ? [
        "",
        "The user typed these notes DURING the meeting, each stamped with the moment it was written. They are the OUTLINE: they say what actually mattered, and you must not decide that for yourself when they already have.",
        "Rules for them, in this order of priority: cover every one of them; follow their order and their emphasis; expand each with what the transcript says around its timestamp; fix their spelling, casing and abbreviations in YOUR text; never contradict one; and never turn one into a fact the transcript does not support - if a note points at something the transcript does not cover, say plainly that the recording does not cover it.",
        "",
        "The user's notes:",
        myNotes.trim(),
      ].join("\n")
    : "";
  // D8: provenance, asked for in the ONE form that can be checked afterwards.
  // The model is told to COPY a timestamp, never to compose one, and to write
  // nothing when it is unsure - because verifyCitations() below deletes every
  // stamp that is not a real transcript line anyway, and a model that guesses
  // just produces bullets that lose their citation for no reason.
  const cite =
    'PROVENANCE: end each bullet with the timestamp of the transcript line it is based on, in square brackets, exactly as that line begins - for example "[00:12:30]". COPY the timestamp from the transcript; never compose, round or adjust one. When a bullet draws on several lines, cite the FIRST. When you are not certain which line a bullet comes from, write NO timestamp for it: a missing timestamp is correct, an approximate one is a lie that will send the reader to the wrong place.';
  const shape =
    'Write in the LANGUAGE of the transcript. Start with a one-paragraph summary as plain text, with NO heading. Then add these sections, each introduced by its exact heading alone on its line with bullet points beneath it: "## Points cles", "## Decisions", "## Actions" (name the owner and any stated deadline), and "## Suivis" (include this section only if there are open follow-ups).';
  return [
    "You summarize a meeting transcript. Base EVERYTHING on the transcript below; never invent facts, names or numbers. Output ONLY markdown, no preamble.",
    suggestionRule,
    marked,
    steer,
    "",
    cite,
    shape,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

// ---- D8: provenance that is CHECKED, never trusted ----
//
// The central problem, stated plainly: the notes are written by a language
// model, and a language model does not naturally know where its own sentences
// came from. Asked for a citation it will produce one that LOOKS right. Three
// ways out existed:
//
//  (a) ask for it in the prompt and VERIFY what comes back;
//  (b) recover it afterwards by searching the transcript for the bullet's words;
//  (c) accept that some bullets have no known provenance and show none.
//
// This module does (a), and falls back to (c) for anything that fails the check.
// It deliberately does NOT do (b), and that refusal is the important decision:
// the notes are a PARAPHRASE, so an exact search finds nothing and a fuzzy one
// returns its best guess for every bullet, always, with no way to tell a right
// guess from a wrong one. That manufactures confident-looking wrong answers at
// scale - and an invented provenance is strictly worse than an absent one,
// because it sends the reader to the wrong minute of the recording while wearing
// the appearance of a fact. A bullet whose origin is unknown simply carries no
// timestamp; nothing anywhere fills the gap with a plausible number.
//
// The check itself is exact, and exactness is what makes it a check at all. The
// only timestamps in the transcript are segment starts (transcriptLine writes
// them), so a stamp the model genuinely COPIED is one of them. A stamp that is
// not one was not copied - it was composed - whether it lands between two real
// lines or nowhere near any. Snapping it to the nearest passage would be
// option (b) in miniature: a guess, dressed as a verification.

/** Every timestamp that really BEGINS a line of `transcriptBody` - the set a
 * citation has to be a member of to survive. Reading it off the text (rather
 * than off a passage parser) keeps the knowledge in the module that WRITES those
 * lines, so the two can never drift. */
export function transcriptStamps(transcriptBody: string): Set<string> {
  const out = new Set<string>();
  for (const m of transcriptBody.matchAll(/^\[(\d{2}:\d{2}:\d{2})\] /gm)) out.add(m[1]);
  return out;
}

export interface VerifiedCitations {
  /** The notes with every unverifiable citation REMOVED. */
  text: string;
  kept: number;
  /** How many the model made up. Worth counting rather than discarding: it is
   * the only measurement anyone has of how well a given local model handles
   * being asked for provenance, and it belongs in the log where a bad model can
   * be recognized instead of silently trusted. */
  dropped: number;
}

/** Strip every "[hh:mm:ss]" from `notes` that is not in `stamps`.
 *
 * Nothing else about the text is touched, beyond tidying the whitespace the
 * removal leaves behind: a bullet that loses its citation keeps every word it
 * had. That is the whole behaviour a bullet "without certain provenance" gets -
 * it reads exactly like a bullet from a model that never cited anything, which
 * is what it now is. */
export function verifyCitations(notes: string, stamps: ReadonlySet<string>): VerifiedCitations {
  let kept = 0;
  let dropped = 0;
  const text = notes
    .replace(/[ \t]*\[(\d{2}:\d{2}:\d{2})\]/g, (whole, stamp: string) => {
      if (stamps.has(stamp)) {
        kept++;
        return whole;
      }
      dropped++;
      return "";
    })
    // The removal can leave a trailing space, or a space before a final period.
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ");
  return { text, kept, dropped };
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

// ---- result shapes shared by the HTTP /long/* routes AND the U4a IPC surface ----
// Defined here (pure, Electron-free) rather than in main/longform.ts so that
// shared/ipcContracts.ts - which the renderer/preload build also compiles -
// can reuse them without pulling src/main into that build (tsconfig.json's
// "include" never lists src/main; main/longform.ts imports these back FROM
// here, the same direction it already imports RecentEntry and friends).

/** One coherent snapshot of the long-form recorder: GET /long/state and
 * UI_LONG_STATE render the SAME shape, produced by the SAME LongRecorder.state(). */
export interface LongStateSnapshot {
  active: boolean;
  finalizing: boolean;
  startedIso: string;
  durationMs: number;
  segments: number; // transcribed so far
  pending: number; // queued behind the ASR
  marks: number;
  title: string;
  dir: string;
  docPath: string;
  audioPath: string;
  lastError: string;
  recent: RecentEntry[];
}

/** The result of starting (or refusing to start) a long-form recording -
 * shared by /long/start, /long/start-native and UI_LONG_START. */
export interface LongStartResult {
  ok: boolean;
  error?: string;
  docPath?: string;
  audioPath?: string;
}

/** The result of stopping a long-form recording - shared by /long/stop and
 * UI_LONG_STOP. */
export interface LongStopResult {
  ok: boolean;
  docPath: string;
}

/** A transcript increment from byte `since` onward, plus the offset to poll
 * from next - shared by /long/transcript and UI_LONG_TRANSCRIPT (the 1 Hz
 * poll that lets the page never re-transfer the whole document). */
export interface LongTranscriptResult {
  text: string;
  nextSince: number;
}

// ---- U5a/U5c: the archive browser (history list + doc), shared by the HTTP
// /long/history* routes and the UI_HISTORY_* IPC channels. Defined here for
// the same reason as the shapes above: ipcContracts.ts (compiled into the
// renderer/preload build too) needs the type without pulling src/main in -
// main/longform.ts imports these back FROM here and does the actual disk I/O.

/** A runaway history (years of unattended recordings piling up on the fixed
 * folder) must never make the archive view stall the engine's single-threaded
 * API, so the listing is BOUNDED - newest first, so the cap keeps the recent
 * ones. Bounded like the ASR queue.
 *
 * The number lives here, pure, rather than in main/longform.ts where the walk
 * is (U5 review, MAJEUR 4): the Notes page has to be able to SAY it. A page
 * that promises "every capture Flow has produced" over a list the engine
 * silently truncated is exactly the quiet lie this app does not tell, and the
 * page can only avoid it if it can see the same number the walk enforces. */
export const MAX_HISTORY_ITEMS = 2000;

/** One recording as the archive browser lists it. `hasAudio`/`audioBytes` let
 * the UI show a download's size BEFORE the click (U5c: a long WAV is ~115 MB/h,
 * the user must learn that up front, not after starting a multi-minute copy). */
export interface HistoryItem {
  id: string;
  date: string;
  title: string;
  hasAudio: boolean;
  audioBytes: number;
  docBytes: number;
  savedMs: number;
}

/** A history entry's transcript, read for display - shared by the HTTP
 * /long/history/doc route and the UI_HISTORY_DOC IPC channel (main/longform.ts's
 * readHistoryDoc is the ONE implementation behind both). */
export interface HistoryDocPayload {
  title: string;
  date: string;
  text: string;
}
