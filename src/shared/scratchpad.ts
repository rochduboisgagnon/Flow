// F3 (plan-standalone §7): the scratchpad - where a dictation lands when no text
// field has the focus. The pure half; main/scratchpad.ts owns the file, on the
// discipline main/snippets.ts established and main/liveNotes.ts mirrors.
//
// ---------------------------------------------------------------------------
// THE PROBLEM, EXACTLY
// ---------------------------------------------------------------------------
// The focus probe answers "nothing editable has the focus" far more often than
// one would guess: a browser tab that is not in a field, a PDF, a video call, a
// terminal the probe cannot read, or simply doubt - decideRoute (shared/route.ts)
// deliberately treats a null probe as doubt and routes to the clipboard rather
// than typing blind into an unknown window. That fallback works, and it has one
// failure mode that costs the user real work: the clipboard holds ONE thing.
// Dictate two thoughts in a row without pasting, and the first is gone. Copy a
// link in between, and both are gone.
//
// ---------------------------------------------------------------------------
// DECISION 1: THIS IS THE ONE PLACE FLOW KEEPS WHAT YOU DICTATED, AND IT IS OFF
// ---------------------------------------------------------------------------
// Campaign invariant 2 is "zero retention in dictation: the audio and the text of
// a dictation live for the length of one utterance". A scratchpad is a file of
// dictated text on disk. There is no reading of that invariant under which this
// feature is free, and no wording that makes writing it silently acceptable.
//
// So the setting is OFF at install, it is the only setting in Flow whose whole
// subject is keeping dictation, Settings > Storage & Privacy changes what it says
// about retention when it is on, and so does the README. That last point is not
// housekeeping: wave V2 counted a README that promised no buffer while the code
// held one as a BLOCKING defect. A promise that has become false is a defect
// wherever it is written.
//
// ---------------------------------------------------------------------------
// DECISION 2: IT ADDS, IT DOES NOT REPLACE
// ---------------------------------------------------------------------------
// When the scratchpad is on, a no-field dictation goes to the clipboard AND to
// the scratchpad. Taking the clipboard away would be a regression for every user
// who already relies on dictate-then-paste, in exchange for nothing: the
// scratchpad's purpose is to stop the SECOND dictation from erasing the first,
// not to change where the first one goes.
//
// ---------------------------------------------------------------------------
// DECISION 3: ONE WRITE PER ENTRY, AFTER THE TEXT HAS ALREADY LANDED
// ---------------------------------------------------------------------------
// The write happens on the process that carries the low-level keyboard hook, so
// its cost has to be bounded and its position in the sequence has to be
// deliberate. Both are:
//
//   - Bounded: MAX_ENTRIES x MAX_TEXT_CHARS caps the file at roughly 200 KB, so
//     the whole-file serialize this makes is a couple of milliseconds at worst -
//     the same bound and the same argument as a live-note commit.
//   - Positioned: main/index.ts appends AFTER leaveOnClipboard() has run, so
//     nothing the user is waiting for is behind this write. If it fails, the
//     clipboard still holds the dictation.
//
// And it only ever happens on the CLIPBOARD route. A dictation that landed at the
// cursor is not at risk of being lost, and putting a disk write behind the
// ordinary insertion path to keep a copy nobody asked for would be both a
// slowdown and a retention breach.
//
// ---------------------------------------------------------------------------
// DECISION 4: OLDEST OUT, AND SAID SO
// ---------------------------------------------------------------------------
// A scratchpad that stops accepting entries at 100 would silently start losing
// dictations again - the exact failure it exists to fix. So it is a rolling
// window: the oldest entry is dropped to make room, and the page says the window
// is rolling rather than pretending to be an archive. The alternative (refuse the
// newest) loses the thing the user just said, which is always the worse trade.

/** One dictation kept because no field had the focus. */
export interface ScratchEntry {
  /** Minted by the STORE, never accepted from the renderer as a creation key -
   * the same rule as Snippet.id and LiveNote.id. */
  id: string;
  /** When it was dictated, ISO 8601. Wall-clock rather than an offset: unlike a
   * live note, a scratchpad entry belongs to no recording and has nothing to be
   * relative to. Taken by MAIN at the moment the entry arrives, so no two clocks
   * are ever compared. */
  atIso: string;
  text: string;
}

export const CURRENT_VERSION = 1 as const;

/** A dictation, not an essay. Long enough for a paragraph said in one breath -
 * a hands-free dictation can legitimately run a few hundred words - and short
 * enough that a hundred of them stay a file this process can rewrite without
 * thinking about it. */
export const MAX_TEXT_CHARS = 2000;
/** The rolling window (DECISION 4). A hundred unpasted dictations is already far
 * past "I forgot to paste"; past that the oldest goes. */
export const MAX_ENTRIES = 100;
/** Clamps a hand-edited file so one absurd id cannot bloat the store. */
export const MAX_ID_CHARS = 100;
/** How many individual losses a read-only message names before it just counts the
 * rest - the string is read by a human (mirror of snippets.ts). */
export const MAX_REPORTED_LOSSES = 5;

export interface ScratchpadFile {
  version: typeof CURRENT_VERSION;
  entries: ScratchEntry[];
}

export interface ParsedScratchpad {
  file: ScratchpadFile;
  /** Set when the input could not be fully trusted. It is the one predicate the
   * overwrite guard reads: a file that did not load intact is never written back
   * over, because that would make the loss permanent (snippets.ts, same hazard).
   *
   * It matters MORE here than anywhere else in Flow: this file is the only copy
   * of text the user dictated. Everywhere else a bad file costs a setting or a
   * snippet the user can retype from what they see on screen. */
  error?: string;
}

export function emptyScratchpad(): ScratchpadFile {
  return { version: CURRENT_VERSION, entries: [] };
}

/** Bounded, free of control characters, and collapsed to single spaces.
 *
 * Collapsing is not cosmetic even though this file is not parsed by line-anchored
 * patterns the way a recording's document is (shared/liveNotes.ts DECISION 3):
 * whisper returns one paragraph, so a newline in a scratchpad entry can only ever
 * come from a hand-edited file - and an entry that renders as several lines in a
 * list built for one-line rows is a page that lies about how much it is showing.
 *
 * Returns "" for anything unusable, which callers treat as "nothing to keep". */
export function sanitizeScratchText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // \p{C} is Unicode's "other" category: control, format and unassigned code
  // points. Written as a property escape rather than as explicit \u ranges so this
  // source file never has to carry a raw control byte, and so the class cannot
  // silently miss one. \s on the next line covers U+2028/U+2029, which are line
  // separators rather than controls.
  return raw
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

interface StoredEntryRead {
  entry?: ScratchEntry;
  losses: string[];
}

function readStoredEntry(raw: unknown, at: number): StoredEntryRead {
  const where = `entry #${at + 1}`;
  if (typeof raw !== "object" || raw === null) return { losses: [`${where} is not an object`] };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) return { losses: [`${where} has no usable id`] };
  const id = r.id.trim();
  if (typeof r.text !== "string") return { losses: [`${where} (id ${id}) has no text string`] };
  const text = sanitizeScratchText(r.text);
  // An entry with no text left is an entry with nothing in it. Unlike a live note
  // with no offset, there is no navigational value to weigh: it is simply empty.
  if (!text) return { losses: [`${where} (id ${id}) holds no usable text`] };
  const losses: string[] = [];
  if (id.length > MAX_ID_CHARS) losses.push(`${where} has an id over ${MAX_ID_CHARS} chars`);
  // Compared against the RAW string, exactly like a live note: a file whose entry
  // carried a control character or 3000 characters is a file this build did not
  // read intact, and saying so is what stops the next append from persisting the
  // cleaned-up version over the original.
  if (text !== r.text) losses.push(`${where} (id ${id}) had text this build had to clean up or shorten`);
  // A missing or unreadable timestamp does NOT cost the entry: the text is the
  // thing worth keeping, and the honest reading of "I do not know when this was
  // said" is an empty stamp the page renders as unknown - not a deleted
  // dictation. It still sets the read-only flag, so nothing overwrites the file
  // that had it.
  const atIso = typeof r.atIso === "string" && r.atIso.trim().length > 0 ? r.atIso.trim().slice(0, 40) : "";
  if (!atIso) losses.push(`${where} (id ${id}) has no usable timestamp; its text was kept`);
  return { entry: { id: id.slice(0, MAX_ID_CHARS), atIso, text }, losses };
}

/** Pure: an already-JSON.parsed value in, a trustworthy ScratchpadFile or a
 * documented refusal out. Tolerant at the ITEM level, NOT at the version level,
 * and "tolerant" means the load succeeds - never that a loss goes unreported. */
export function parseScratchpadFile(raw: unknown): ParsedScratchpad {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      file: emptyScratchpad(),
      error: "scratchpad.json is not a JSON object; left untouched, starting with nothing",
    };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== CURRENT_VERSION) {
    return {
      file: emptyScratchpad(),
      error: `scratchpad.json has version ${JSON.stringify(r.version)}, which this build does not understand; left untouched, starting with nothing`,
    };
  }
  const losses: string[] = [];
  if (r.entries !== undefined && !Array.isArray(r.entries)) losses.push("the entries field is not an array");
  const rawEntries = Array.isArray(r.entries) ? r.entries : [];
  const entries: ScratchEntry[] = [];
  for (const [at, it] of rawEntries.entries()) {
    if (entries.length >= MAX_ENTRIES) {
      losses.push(`the file holds ${rawEntries.length} entries, over the ${MAX_ENTRIES} cap`);
      break;
    }
    const read = readStoredEntry(it, at);
    losses.push(...read.losses);
    if (read.entry) entries.push(read.entry);
  }
  const file: ScratchpadFile = { version: CURRENT_VERSION, entries };
  if (losses.length > 0) {
    const shown = losses.slice(0, MAX_REPORTED_LOSSES).join("; ");
    const rest = losses.length - MAX_REPORTED_LOSSES;
    return {
      file,
      error: `scratchpad.json did not load intact, so it is READ-ONLY until it is fixed (writing now would make the loss permanent): ${shown}${rest > 0 ? `; and ${rest} more` : ""}`,
    };
  }
  return { file };
}

/** Pure: what an append does. Newest LAST, and the oldest is dropped when the
 * window is full (DECISION 4) - never the new one, which is the dictation the
 * user just made.
 *
 * The id and the timestamp are minted by the caller (the store) and passed in, so
 * this stays free of node:crypto and of the clock. */
export function applyScratchAppend(
  entries: readonly ScratchEntry[],
  rawText: unknown,
  atIso: string,
  id: string,
): { entries: ScratchEntry[]; dropped: number } | { error: string } {
  const text = sanitizeScratchText(rawText);
  if (!text) return { error: "an empty dictation has nothing to keep" };
  const next = [...entries, { id, atIso, text }];
  const dropped = Math.max(0, next.length - MAX_ENTRIES);
  return { entries: dropped > 0 ? next.slice(dropped) : next, dropped };
}

/** Pure: deleting an id that is already gone is a no-op, not an error -
 * idempotent, matching what a page holding a possibly stale list expects
 * (shared/liveNotes.ts's applyNoteDelete, same rule). */
export function applyScratchDelete(entries: readonly ScratchEntry[], rawId: unknown): ScratchEntry[] {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  return entries.filter((e) => e.id !== id);
}

/** What every scratchpad channel answers with: the WHOLE list, so a page can
 * never hold a stale one after a write it did not itself make (the contract
 * SnippetsResult and LiveNotesResult both follow).
 *
 * `enabled` rides along because the page has to be able to explain an EMPTY list,
 * and "empty because Flow is not keeping anything" and "empty because you have
 * pasted everything" are opposite facts that look identical in a length check. */
export interface ScratchpadResult {
  ok: boolean;
  enabled: boolean;
  entries: ScratchEntry[];
  error?: string; // human-readable, shown as-is by the page
}
