// D7: the notes the USER types while a recording runs - the pure half. This
// module decides what a live note IS, what it may contain, and how it reads in
// the finished document. It never touches a disk; main/liveNotes.ts owns the
// file, on exactly the discipline main/snippets.ts established.
//
// ---------------------------------------------------------------------------
// WHY THIS FEATURE INVERTS WHO IS AUTHORITATIVE
// ---------------------------------------------------------------------------
// A transcript summarizer has to GUESS what mattered in two hours of talk. Six
// words the user typed at the moment it mattered are not a guess: they ARE the
// signal. So the human's notes are not a garnish on the machine's notes, they
// outrank them - and that ranking has to be visible in the document itself, not
// only in the app that produced it.
//
// ---------------------------------------------------------------------------
// DECISION 1: A NOTE IS COMMITTED, NOT AUTOSAVED
// ---------------------------------------------------------------------------
// The obvious design is a free textarea that saves itself. It was rejected, for
// two reasons that both point the same way.
//
// The first is the campaign's invariant number one: the process that carries the
// low-level keyboard hook is the process that would do the saving, and the whole
// of wave V2 was spent taking synchronous work OFF that loop. A panel that wrote
// to disk on every keystroke is exactly the fault V2 removed from flowLog. A
// debounce would soften it, not remove it: it would still put an unbounded
// number of whole-file rewrites on the hook's loop for as long as the user keeps
// typing.
//
// The second is the timestamp (DECISION 2). A textarea cannot honestly say when
// a given line was written: lines shift when the user presses Enter in the
// middle, an edit two minutes later is indistinguishable from the original
// typing, and a debounced save would stamp a note at the moment the debounce
// fired rather than at the moment the thought happened. A note that is COMMITTED
// (one gesture, one note) has one unambiguous moment, and main sees it
// milliseconds later.
//
// So: one note, one small atomic write. Nothing at all is written while the user
// types. The cost is honest and stated in the UI - the half-typed line still in
// the box is the only thing a power cut can take.
//
// ---------------------------------------------------------------------------
// DECISION 2: A NOTE CARRIES THE OFFSET IT WAS WRITTEN AT
// ---------------------------------------------------------------------------
// "check the numbers" is useless six months later; "[00:41:12] check the
// numbers" points at the thirty seconds of conversation it is about. The stamp
// is what makes the human's notes navigable at all, and it is what lets D8 treat
// them as first-class provenance rather than as loose prose.
//
// It is taken by MAIN, from the recorder's own start instant, at the moment the
// note arrives - never by the renderer, so no two clocks are ever compared (the
// discipline CaptureTimingPayload spells out for the overlay). It is rounded to
// the second, like every other timestamp in the document, because that is the
// resolution the transcript itself has.
//
// An EDIT does not move the stamp. The moment being recorded is when the user
// decided the thing was worth writing down, and fixing a typo afterwards does
// not change that moment. A note added later gets its own, later stamp.
//
// ---------------------------------------------------------------------------
// DECISION 3: A NOTE IS ONE LINE, AND THAT IS LOAD-BEARING
// ---------------------------------------------------------------------------
// Newlines are collapsed to spaces on the way in. That looks cosmetic and is
// not: the document these notes land in is parsed by line-anchored patterns that
// decide what is a heading, where the derived-notes block ends, and where the
// timestamped transcript begins (shared/longform.ts's spliceNotes,
// shared/redact.ts's transcriptStart and NOTES_BLOCK_RE). A note containing a
// newline followed by "## Transcript" would forge that boundary, and every
// consumer downstream - the passage parser, the redactor, the notes splice -
// would then be reading a document whose structure the user's own typing had
// rewritten. Because a note can hold no newline, and because every rendered note
// line begins with its "[hh:mm:ss] " stamp, no note can start a line, let alone
// start one with "##", "- engine:" or ">".

/** One note the user typed during a recording.
 *
 * `id` is minted by the STORE (main/liveNotes.ts), never accepted from the
 * renderer as a creation key - same rule, and the same reasons, as Snippet.id. */
export interface LiveNote {
  id: string;
  /** Milliseconds from the start of the recording, when the note was COMMITTED
   * (see DECISION 2 on why an edit never moves it). */
  atMs: number;
  /** One line, always. See DECISION 3 on why that is a structural guarantee and
   * not a style choice. */
  text: string;
}

export const CURRENT_VERSION = 1 as const;

/** A note is a jotting, not a paragraph: 500 characters is already several
 * sentences of "what I must not forget about this moment". Bounds what a
 * single line of the finished document can grow to. */
export const MAX_NOTE_CHARS = 500;
/** A very long meeting with a very busy note-taker. Bounds a file that is read
 * and re-serialized WHOLE on every commit, on the process that carries the
 * keyboard hook. */
export const MAX_NOTES = 500;
/** A minted id is a 36-char UUID; this only clamps a hand-edited file so one
 * absurd string cannot bloat the slot on its own. */
export const MAX_ID_CHARS = 100;
/** How many individual losses a read-only message names before it just counts
 * the rest - the string is read by a human (mirror of snippets.ts). */
export const MAX_REPORTED_LOSSES = 5;

/** The live slot on disk: the notes for ONE recording, named by the recording.
 *
 * `startedIso` is the recorder's own start instant - the same identity the
 * Record page already uses to tell one capture from another (it does not change
 * when finalize files the document, unlike docPath). It is what makes it
 * impossible to splice notes typed during meeting A into meeting B: every
 * operation names the recording it believes it is writing for, and a mismatch is
 * refused rather than reconciled. */
export interface LiveNotesFile {
  version: typeof CURRENT_VERSION;
  startedIso: string;
  notes: LiveNote[];
}

export interface ParsedLiveNotes {
  file: LiveNotesFile;
  /** Set when the input could not be fully trusted - at the file level (wrong
   * shape or version: `notes` is then EMPTY, never a partial guess) or at the
   * item level (an entry dropped or truncated: `notes` holds what was
   * understood). Either way it is the one predicate the overwrite guard reads:
   * a slot that did not load intact is never written back over, because that
   * would make the loss permanent (snippets.ts's module note, same hazard). */
  error?: string;
}

export function emptyLiveNotes(startedIso = ""): LiveNotesFile {
  return { version: CURRENT_VERSION, startedIso, notes: [] };
}

/** One line, bounded, and free of anything that could forge document structure
 * (DECISION 3). Every newline, carriage return, tab and other C0 control
 * character becomes a single space; runs of whitespace collapse; the result is
 * trimmed and clamped. Returns "" for anything unusable, which callers treat as
 * "nothing to commit" rather than as an error. */
export function sanitizeNoteText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Control characters and both Unicode line separators, written as escapes so
  // the source file itself never carries a raw control byte.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
}

interface StoredNoteRead {
  note?: LiveNote;
  losses: string[];
}

function readStoredNote(raw: unknown, at: number): StoredNoteRead {
  const where = `note #${at + 1}`;
  if (typeof raw !== "object" || raw === null) return { losses: [`${where} is not an object`] };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) return { losses: [`${where} has no usable id`] };
  const id = r.id.trim();
  if (typeof r.text !== "string") return { losses: [`${where} (id ${id}) has no text string`] };
  // A note with no usable offset is a note whose whole navigational value is
  // gone, and inventing one (0, or "now") would point the reader at a moment
  // the note has nothing to do with. Dropping it is the honest reading, and it
  // sets the read-only flag so the drop can never be written back.
  if (typeof r.atMs !== "number" || !Number.isFinite(r.atMs) || r.atMs < 0) {
    return { losses: [`${where} (id ${id}) has no usable recording offset`] };
  }
  const losses: string[] = [];
  if (id.length > MAX_ID_CHARS) losses.push(`${where} has an id over ${MAX_ID_CHARS} chars`);
  const text = sanitizeNoteText(r.text);
  // Compared against the RAW string: a hand-edited file whose note carried a
  // newline, a control character or 900 characters is a file this build did not
  // read intact, and saying so is what stops the next commit from persisting
  // the cleaned-up version over it.
  if (text !== r.text) losses.push(`${where} (id ${id}) had text this build had to clean up or shorten`);
  return { note: { id: id.slice(0, MAX_ID_CHARS), atMs: Math.round(r.atMs), text }, losses };
}

/**
 * Pure: turn an already-JSON.parsed value into a trustworthy LiveNotesFile, or a
 * documented refusal. Tolerant at the ITEM level, NOT at the version level - and
 * "tolerant" means the load succeeds, never that the loss goes unreported.
 */
export function parseLiveNotesFile(raw: unknown): ParsedLiveNotes {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      file: emptyLiveNotes(),
      error: "live-notes.json is not a JSON object; left untouched, starting with no notes",
    };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== CURRENT_VERSION) {
    return {
      file: emptyLiveNotes(),
      error: `live-notes.json has version ${JSON.stringify(r.version)}, which this build does not understand; left untouched, starting with no notes`,
    };
  }
  // No recording identity means there is no way to know WHICH capture these
  // notes belong to, and a guess would splice one meeting's notes into another.
  if (typeof r.startedIso !== "string" || r.startedIso.trim().length === 0) {
    return {
      file: emptyLiveNotes(),
      error: "live-notes.json names no recording, so its notes cannot be attributed; left untouched",
    };
  }
  const losses: string[] = [];
  if (r.notes !== undefined && !Array.isArray(r.notes)) losses.push("the notes field is not an array");
  const rawNotes = Array.isArray(r.notes) ? r.notes : [];
  const notes: LiveNote[] = [];
  for (const [at, it] of rawNotes.entries()) {
    if (notes.length >= MAX_NOTES) {
      losses.push(`the file holds ${rawNotes.length} notes, over the ${MAX_NOTES} cap`);
      break;
    }
    const read = readStoredNote(it, at);
    losses.push(...read.losses);
    if (read.note) notes.push(read.note);
  }
  const file: LiveNotesFile = { version: CURRENT_VERSION, startedIso: r.startedIso.trim(), notes };
  if (losses.length > 0) {
    const shown = losses.slice(0, MAX_REPORTED_LOSSES).join("; ");
    const rest = losses.length - MAX_REPORTED_LOSSES;
    return {
      file,
      error: `live-notes.json did not load intact, so the panel is READ-ONLY until it is fixed (committing now would make the loss permanent): ${shown}${rest > 0 ? `; and ${rest} more` : ""}`,
    };
  }
  return { file };
}

/** Pure: what a commit does to a notes array. The id is minted by the caller
 * (the store) and passed in, so this stays free of node:crypto and testable. */
export function applyNoteAdd(
  notes: readonly LiveNote[],
  rawText: unknown,
  atMs: number,
  id: string,
): { notes: LiveNote[] } | { error: string } {
  const text = sanitizeNoteText(rawText);
  if (!text) return { error: "an empty note has nothing to record" };
  if (notes.length >= MAX_NOTES) return { error: `this recording already holds ${MAX_NOTES} notes` };
  // Kept in commit order rather than sorted by atMs: they are already
  // chronological by construction (the offset only ever grows during a
  // recording), and sorting would silently reorder a hand-edited file instead of
  // showing the user what is actually stored.
  return { notes: [...notes, { id, atMs: Math.max(0, Math.round(atMs)), text }] };
}

/** Pure: an edit changes the TEXT and nothing else - the stamp stays where it
 * was (DECISION 2). An id that matches nothing is refused, never treated as a
 * creation key (snippets.ts's rule, same reason). */
export function applyNoteEdit(
  notes: readonly LiveNote[],
  rawId: unknown,
  rawText: unknown,
): { notes: LiveNote[] } | { error: string } {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id) return { error: "no note was named" };
  const at = notes.findIndex((n) => n.id === id);
  if (at < 0) return { error: `note ${id} was not found` };
  const text = sanitizeNoteText(rawText);
  if (!text) return { error: "an empty note has nothing to record; delete it instead" };
  const next = notes.slice();
  next[at] = { ...next[at], text };
  return { notes: next };
}

/** Pure: deleting an id that is already gone is a no-op, not an error -
 * idempotent, matching what a page holding a possibly stale list expects. */
export function applyNoteDelete(notes: readonly LiveNote[], rawId: unknown): LiveNote[] {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  return notes.filter((n) => n.id !== id);
}

/** What every live-notes channel answers with: the WHOLE list, plus WHICH
 * recording it belongs to.
 *
 * `startedIso` is not decoration. Without it a page that reloaded, or that came
 * back after the window was hidden through the end of one meeting and the start
 * of another, could render one capture's notes over another's - and the user
 * would have no way to tell. The page compares it against the recorder snapshot
 * it is already polling and shows nothing when they disagree. */
export interface LiveNotesResult {
  ok: boolean;
  startedIso: string;
  notes: LiveNote[];
  error?: string; // human-readable, shown as-is by the page
}
