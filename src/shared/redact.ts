// D11: removing a sensitive passage from a capture. This module is the PURE
// half - it decides what a removal means, and never touches a disk. The half
// that writes (and silences the audio) is src/main/redact.ts.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL, WHICH DECIDES EVERY DETAIL BELOW
// ---------------------------------------------------------------------------
// A meeting transcript carries the words of people who never installed Flow.
// One of them reads out a card number, states a diagnosis, or says a sentence
// they regret. This function is that person's ONLY recourse, and a removal that
// is not really a removal would be worse than no feature at all: it would hand
// out a false assurance. Every decision here therefore leans the same way -
// when in doubt, remove MORE, and say EXACTLY what happened.
//
// ---------------------------------------------------------------------------
// DECISION 1: THE AUDIO IS SILENCED, NOT LEFT ALONE
// ---------------------------------------------------------------------------
// A transcript scrubbed over an intact .wav protects nobody: the sentence is
// still one double-click from being heard, and the transcript's own timestamps
// say precisely where. So a removal silences the matching range of the audio
// too (main/redact.ts does the writing; this module computes the ranges).
// When the recording kept no audio, that is stated rather than left implied -
// see RedactionPlan.audioNote, which the confirmation renders verbatim.
//
// ---------------------------------------------------------------------------
// DECISION 2: THE DERIVED NOTES GO, WHOLE
// ---------------------------------------------------------------------------
// The document is one file: header, then an LLM-written "## Notes" (or
// "## Summary") block, then "## Transcript". Those notes are DERIVED from the
// transcript, so they can quote, paraphrase or summarize the very passage being
// removed - and a summary that repeats what was just erased cancels the
// erasure. Nothing in the document says which sentence of the summary came from
// which passage, so a partial scrub of the notes is unimplementable honestly:
// it would produce exactly the "half-cleaned document that looks clean" this
// campaign forbids. The whole block therefore goes, and is replaced by a line
// saying so. Regenerating notes from the now-clean transcript is a separate,
// existing gesture the user can make afterwards - and it belongs to the user,
// not to a removal that must be able to complete with no model available and no
// network (the campaign's independence rule).
//
// ---------------------------------------------------------------------------
// DECISION 3: THE TIMESTAMPS DO NOT MOVE
// ---------------------------------------------------------------------------
// Two options existed: shift every later timestamp back by the removed
// duration, or leave a hole. Shifting is the one that lies. The .wav keeps its
// full length (the range is zeroed IN PLACE, not cut out - see DECISION 4), so
// a shifted transcript would point at the wrong second of an audio file the
// user can still play and seek: every quotation after the removal would be
// misattributed to the wrong moment. Leaving the hole keeps transcript time and
// audio time the same clock, which is the only property that makes the rest of
// the document still usable. The hole is not silent either - a tombstone line
// names the range, so a reader who sees the jump learns what it is instead of
// guessing at a transcription failure.
//
// ---------------------------------------------------------------------------
// DECISION 4: THE REMOVAL IS IRREVERSIBLE, AND THE UI SAYS SO
// ---------------------------------------------------------------------------
// No copy is kept - not in a trash folder, not in an undo buffer, not in the
// log. A "delete" that quietly keeps the bytes is a lie, and this is the one
// feature whose entire value is that it is not one. The cost is that a misclick
// destroys real content, which is paid for on the other side: the caller
// confirms against a plan that NAMES the exact text and the exact time ranges
// about to disappear (RedactionPlan.removedText/ranges), never a bare "are you
// sure".
//
// The audio is zeroed rather than cut for the same reason as DECISION 3, plus
// one more: cutting would renumber every later sample, so the file's whole
// timeline would move under a transcript that did not - and the sample count
// itself would leak the removed passage's exact length to anyone comparing it
// against the transcript's own timestamps.

/** The timestamp line the long recorder writes for every transcribed segment
 * (shared/longform.ts's transcriptLine). A passage starts at one of these. */
const STAMP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] /;

/** The header line that closes every document's front matter
 * (shared/longform.ts's ENGINE_LINE). Duplicated as a plain string rather than
 * imported so this module stays free of the recorder's segmentation code; the
 * test suite pins the two together. */
const ENGINE_LINE = "- engine: AGR Flow (100% local)\n\n";

/** The marker that opens the transcript once notes have been spliced in
 * (shared/longform.ts's spliceNotes). */
const TRANSCRIPT_MARKER = "\n## Transcript\n";

/** The derived-notes block spliceNotes writes, in either of the two names it
 * has worn. Non-greedy up to the transcript marker, exactly like spliceNotes'
 * own idempotence regex - the two must agree on what "the notes block" is. */
const NOTES_BLOCK_RE = /^## (?:Summary|Notes)\n[\s\S]*?\n## Transcript\n+/;

/** A removal a user can ask for: one transcribed segment of the document, with
 * the audio range it owns. `index` is its position in the document's passage
 * list, and is the only handle that crosses IPC - never a character offset,
 * which would be a way to aim a write at an arbitrary part of the file. */
export interface TranscriptPassage {
  index: number;
  /** Milliseconds from the start of the recording, from the segment's own
   * timestamp line. */
  startMs: number;
  /** Exclusive end: the NEXT passage's startMs. `null` on the last passage,
   * which the document gives no end for - see RedactionRange. */
  endMs: number | null;
  /** Everything this passage owns in the document, timestamp line included:
   * what the user reads in the confirmation, and what disappears. */
  text: string;
  /** Character range in the document, [from, to). Stays inside this module and
   * main/redact.ts; it never crosses IPC. */
  from: number;
  to: number;
}

/** One contiguous run of removed passages, as an audio range to silence.
 * `endMs === null` means "to the end of the recording": the transcript names no
 * end for its last segment, and guessing one would risk leaving the tail of the
 * passage audible. Silencing to the end can therefore silence audio that was
 * never transcribed - over-removal, in the only direction that is safe here -
 * and the confirmation says so in those words rather than hiding it. */
export interface RedactionRange {
  startMs: number;
  endMs: number | null;
}

export interface RedactionPlan {
  /** The rewritten document, ready to be written whole. */
  doc: string;
  /** Audio ranges to silence, ascending and non-overlapping. */
  ranges: RedactionRange[];
  /** Exactly what is about to be destroyed, in document order - the
   * confirmation shows this instead of a count. */
  removedText: string[];
  /** True when a derived "## Notes"/"## Summary" block was found and dropped
   * (DECISION 2). The confirmation must name this: losing the meeting notes is
   * a bigger surprise than losing the passage the user aimed at. */
  notesDropped: boolean;
}

/** Milliseconds for an "HH:MM:SS" stamp. */
function stampMs(h: string, m: string, s: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

/** "HH:MM:SS", the same shape shared/longform.ts's hms writes, so a tombstone
 * reads like the timestamps around it. */
export function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return p(Math.floor(total / 3600)) + ":" + p(Math.floor((total % 3600) / 60)) + ":" + p(total % 60);
}

/** Where the timestamped transcript begins in `doc`.
 *
 * Deliberately NOT "anywhere a [HH:MM:SS] line appears": the notes block above
 * is model-written prose that can perfectly well quote a timestamp at the start
 * of a line, and a parser that took the bait would offer the user a "passage"
 * that is really a line of summary - removing it would edit the notes and
 * silence an audio range nobody pointed at. So the region is bounded first, by
 * the same two landmarks spliceNotes uses, and only then scanned. */
export function transcriptStart(doc: string): number {
  const marker = doc.indexOf(TRANSCRIPT_MARKER);
  if (marker >= 0) return marker + TRANSCRIPT_MARKER.length;
  const engine = doc.indexOf(ENGINE_LINE);
  if (engine >= 0) return engine + ENGINE_LINE.length;
  return 0;
}

/**
 * Every removable passage of `doc`, in document order.
 *
 * A passage runs from its own timestamp line to the next one (or to the end of
 * the document), so the "> [Moment marked ...]" and "> [Recording paused ...]"
 * annotations the recorder interleaves travel with the segment they follow
 * rather than being orphaned by a removal. The interruption note, which
 * noteInterruption() places directly under the header, sits BEFORE the first
 * timestamp and is therefore never removable - correct: it describes the
 * recording, not what was said in it.
 *
 * Parsing is strictly forward and prefix-stable: passage N depends only on the
 * document up to passage N+1. That is what makes an index computed on the
 * TRUNCATED text the Notes page displays (readHistoryDoc caps its read) still
 * name the same passage when main re-parses the whole file.
 */
export function parseTranscriptPassages(doc: string): TranscriptPassage[] {
  const begin = transcriptStart(doc);
  const out: TranscriptPassage[] = [];
  let lineStart = begin;
  while (lineStart <= doc.length) {
    const nl = doc.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? doc.length : nl;
    const m = STAMP_RE.exec(doc.slice(lineStart, lineEnd));
    if (m) {
      if (out.length > 0) out[out.length - 1].to = lineStart;
      out.push({
        index: out.length,
        startMs: stampMs(m[1], m[2], m[3]),
        endMs: null,
        text: "",
        from: lineStart,
        to: doc.length,
      });
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  for (const p of out) {
    p.text = doc.slice(p.from, p.to);
    const next = out[p.index + 1];
    p.endMs = next ? next.startMs : null;
  }
  return out;
}

/** The line left where a passage was. It names the range and the fate of the
 * audio, because a reader who meets an unexplained jump in a transcript will
 * assume the engine failed - and because the person who asked for the removal
 * needs the document itself to confirm what was done, months later, without
 * this app. It deliberately says NOTHING about what the passage contained. */
export function redactionMark(range: RedactionRange, audioNote: string, dateIso: string): string {
  const until = range.endMs === null ? "the end of the recording" : hms(range.endMs);
  return `> [Passage removed from ${hms(range.startMs)} to ${until}, on ${dateIso}. ${audioNote}]\n\n`;
}

/** The line left where the derived notes were (DECISION 2). */
export function notesDroppedMark(dateIso: string): string {
  return "> [The meeting notes were removed on " +
    dateIso +
    ", because they were written from a transcript that has since had a passage removed and could have repeated it. The transcript below is authoritative.]\n\n";
}

/** What the tombstone says happened to the audio. Built by the caller, which is
 * the only side that knows whether this recording kept a .wav at all - the
 * document cannot tell. */
export function audioNoteFor(hasAudio: boolean): string {
  return hasAudio
    ? "The audio for that range was silenced."
    : "No audio was kept for this recording, so there was none to silence.";
}

/** Merge an ascending, de-duplicated index list into contiguous runs. Two
 * passages the user picked side by side become ONE silenced range and ONE
 * tombstone: a wall of tombstones would be noise, and a range per passage would
 * leave the (inaudible, but real) boundary samples of the join untouched. */
function runsOf(indices: readonly number[]): number[][] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

/**
 * Turn a set of passage indices into everything a removal needs: the rewritten
 * document, the audio ranges, and the exact text about to be destroyed.
 *
 * Refuses (never guesses) when an index names no passage: an index that has
 * drifted is a request to delete something other than what the user was
 * looking at, and this is the one operation where deleting the wrong thing
 * cannot be walked back.
 */
export function planRedaction(
  doc: string,
  indices: readonly number[],
  opts: { hasAudio: boolean; dateIso: string },
): RedactionPlan | { error: string } {
  const passages = parseTranscriptPassages(doc);
  if (passages.length === 0) return { error: "this transcript has no timestamped passages to remove" };
  const runs = runsOf(indices);
  if (runs.length === 0) return { error: "no passage was selected" };
  for (const run of runs) {
    for (const i of run) {
      if (!Number.isInteger(i) || i < 0 || i >= passages.length) {
        return { error: "that passage is no longer in this transcript; reopen the capture and try again" };
      }
    }
  }

  const audioNote = audioNoteFor(opts.hasAudio);
  const ranges: RedactionRange[] = [];
  const removedText: string[] = [];
  // Rebuilt front to back so no offset computed on the ORIGINAL string is ever
  // applied to a string this loop has already changed.
  let out = "";
  let cursor = 0;
  for (const run of runs) {
    const first = passages[run[0]];
    const last = passages[run[run.length - 1]];
    const range: RedactionRange = { startMs: first.startMs, endMs: last.endMs };
    ranges.push(range);
    removedText.push(doc.slice(first.from, last.to));
    out += doc.slice(cursor, first.from);
    out += redactionMark(range, audioNote, opts.dateIso);
    cursor = last.to;
  }
  out += doc.slice(cursor);

  // The notes block last, on the already-rewritten document: it lives ABOVE the
  // transcript region, so removing it here cannot disturb offsets that were
  // already consumed.
  let notesDropped = false;
  const engine = out.indexOf(ENGINE_LINE);
  if (engine >= 0) {
    const bodyAt = engine + ENGINE_LINE.length;
    const block = NOTES_BLOCK_RE.exec(out.slice(bodyAt));
    if (block) {
      notesDropped = true;
      out =
        out.slice(0, bodyAt) +
        notesDroppedMark(opts.dateIso) +
        "## Transcript\n\n" +
        out.slice(bodyAt + block[0].length);
    }
  }

  return { doc: out, ranges, removedText, notesDropped };
}

// ---------------------------------------------------------------------------
// The audio side: locating the samples a range owns, without reading the file
// ---------------------------------------------------------------------------
// A kept .wav is routinely hundreds of megabytes (~115 MB/h), so nothing here
// may take the whole file. These functions work on the first few kilobytes -
// enough to walk the RIFF chunk list - and answer in BYTE OFFSETS the writer
// then streams past. Same reasoning as main/downloads.ts: the main process
// carries the keyboard hook, and a synchronous read of a 500 MB file would
// freeze dictation for exactly as long as it takes.

/** The one audio format Flow itself writes and the only one it will silence:
 * 16 kHz mono 16-bit PCM (shared/wav.ts). Anything else is refused OUT LOUD
 * rather than half-handled - see locateWavData. */
export const REDACT_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/** How far into the file the `data` chunk header is allowed to be. Our own
 * encoder puts it at byte 36; other writers add LIST/fact chunks first. A
 * `data` chunk that has not appeared within this much header is a file we do
 * not understand, and this module refuses what it does not understand. */
export const MAX_WAV_HEADER_BYTES = 64 * 1024;

export interface WavData {
  /** Byte offset of the first PCM sample. */
  dataOffset: number;
  /** Length of the PCM payload in bytes, already clamped to the real file. */
  dataBytes: number;
}

/** Walk the RIFF chunks in `head` (the first bytes of the file) and return
 * where the PCM lives. Returns an error string - never throws, and never a
 * partial answer - for anything that is not the format above: a stereo, 44.1
 * kHz or compressed file would have a completely different byte-to-time
 * mapping, and silencing "the range" in it would zero the wrong seconds while
 * reporting success. */
export function locateWavData(head: Uint8Array, fileBytes: number): WavData | { error: string } {
  if (head.length < 12) return { error: "this audio file is too short to be a WAV" };
  const tag = (off: number, s: string) => Array.from(s).every((c, i) => head[off + i] === c.charCodeAt(0));
  if (!tag(0, "RIFF") || !tag(8, "WAVE")) return { error: "this recording's audio is not a WAV file" };
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= head.length && off < MAX_WAV_HEADER_BYTES) {
    const id = String.fromCharCode(head[off], head[off + 1], head[off + 2], head[off + 3]);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      if (off + 8 + 16 > head.length) return { error: "this recording's audio has a truncated format header" };
      const format = v.getUint16(off + 8, true);
      const channels = v.getUint16(off + 10, true);
      const rate = v.getUint32(off + 12, true);
      const bits = v.getUint16(off + 22, true);
      if (format !== 1 || channels !== 1 || rate !== REDACT_SAMPLE_RATE || bits !== 16) {
        return {
          error: `Flow can only silence its own 16 kHz mono 16-bit audio (this file is ${channels}-channel ${rate} Hz ${bits}-bit)`,
        };
      }
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) return { error: "this recording's audio has its samples before its format header" };
      const dataOffset = off + 8;
      // The declared size is a claim; the file on disk is the fact. A recorder
      // killed mid-write leaves a placeholder or an overstated size (the long
      // recorder patches it at close), and trusting the claim would make every
      // byte offset past the real end.
      const dataBytes = Math.max(0, Math.min(size, fileBytes - dataOffset));
      return { dataOffset, dataBytes };
    }
    // Chunks are word-aligned. A zero-size chunk would spin this loop forever
    // on a malformed file, so the walk always advances.
    off += 8 + size + (size % 2);
    if (size === 0) off += 2;
  }
  return { error: "this recording's audio has no readable sample data" };
}

/** The byte range `[from, to)` of the PCM payload that a time range owns.
 * Clamped to the payload, so a range that runs past the end of a shorter-
 * than-expected file silences to its end instead of aiming past it. An
 * `endMs` of null means "to the end", which is the deliberate over-removal
 * described on RedactionRange. */
export function byteRangeFor(range: RedactionRange, data: WavData): { from: number; to: number } {
  const at = (ms: number) => {
    const sample = Math.floor((Math.max(0, ms) / 1000) * REDACT_SAMPLE_RATE);
    return Math.min(data.dataBytes, sample * BYTES_PER_SAMPLE);
  };
  const from = at(range.startMs);
  const to = range.endMs === null ? data.dataBytes : Math.max(from, at(range.endMs));
  return { from: data.dataOffset + from, to: data.dataOffset + to };
}
