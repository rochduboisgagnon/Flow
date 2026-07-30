// The dictation history: what Flow has transcribed, kept so you can find it
// again.
//
// ---------------------------------------------------------------------------
// THIS FILE CHANGES WHAT FLOW PROMISES, AND THAT IS THE POINT
//
// Until 2026-07-30 the README said, in these words: "Dictation is never written
// down. No history, no database, no transcript on disk." That sentence was true,
// it was the product's central claim, and it is now GONE - removed on purpose,
// by Roch's decision, because a dictation that vanished the moment the clipboard
// was overwritten was losing work that mattered more than the promise did.
//
// So this module writes down what you dictate. Saying that plainly here, at the
// top of the file that does it, is the least it owes anyone reading the code -
// and the README now says the same thing rather than the opposite.
//
// What still bounds it, and what the interface must be able to back up:
//
//  1. A ROLLING MONTH. Anything older than RETENTION_DAYS is dropped, and the
//     drop happens at WRITE time, not as a filter at read time. A file that
//     merely LOOKS purged is not purged.
//  2. TEXT ONLY, never audio. The audio of a dictation still exists for exactly
//     one utterance and is never written anywhere.
//  3. ERASABLE IN ONE CLICK, and the erase deletes the file rather than
//     emptying it (see main/dictationHistory.ts).
//  4. NEVER on the hot path. Entries accumulate in memory and are flushed
//     periodically, for the same reason the statistics are: the process that
//     writes this file is the one carrying the keyboard hook.
// ---------------------------------------------------------------------------

export const HISTORY_VERSION = 1 as const;

/** A rolling window rather than a calendar reset, and the difference matters on
 * one day a month: a calendar reset on the 1st would delete everything you
 * dictated on the 31st, hours earlier. "Resets monthly" is what a user means;
 * losing yesterday's work at midnight is not. */
export const RETENTION_DAYS = 31;

/** Hard cap on entries, independent of the time window. A very heavy month
 * cannot turn this file into something that costs a visible pause to load. The
 * OLDEST go first, which is the only direction that keeps "recent" meaningful. */
export const MAX_ENTRIES = 5_000;

/** Bound on a single entry. A dictation longer than this is stored truncated,
 * with `truncated` set, because the alternative - refusing it - would make the
 * history quietly incomplete exactly when someone dictated something long. */
export const MAX_TEXT_CHARS = 4_000;

export interface HistoryEntry {
  /** Millisecond timestamp, the one the list is ordered and purged by. */
  at: number;
  /** What was transcribed, after every filter, exactly as it was inserted. */
  text: string;
  /** True when `text` was cut at MAX_TEXT_CHARS - so the page can say so rather
   * than presenting a fragment as the whole thing. */
  truncated?: boolean;
}

export interface HistoryFile {
  version: typeof HISTORY_VERSION;
  /** Newest FIRST. The page reads it in that order and so does a human. */
  entries: HistoryEntry[];
}

export interface ParsedHistory {
  file: HistoryFile;
  /** Set when the input could not be fully trusted. Same contract as the live
   * notes: it is the predicate an overwrite guard reads, because writing a
   * cleaned-up copy back over a file we failed to understand would make the
   * loss permanent. */
  error?: string;
}

export function emptyHistory(): HistoryFile {
  return { version: HISTORY_VERSION, entries: [] };
}

export function sanitizeHistoryText(raw: unknown): { text: string; truncated: boolean } {
  if (typeof raw !== "string") return { text: "", truncated: false };
  // Control characters collapse to a space so a stored entry can never carry a
  // raw control byte or split itself across lines in the page.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TEXT_CHARS) return { text: clean, truncated: false };
  return { text: clean.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/** The oldest instant the file may keep. */
export function retentionCutoff(now: number): number {
  return now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The write-time gate: order, purge, cap. Every path that produces entries goes
 * through here, so "what the file may contain" has exactly one implementation.
 */
export function mergeEntries(
  existing: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
  now: number,
): HistoryEntry[] {
  const cutoff = retentionCutoff(now);
  const all = [...incoming, ...existing]
    .filter((e) => Number.isFinite(e.at) && e.at >= cutoff && e.text.length > 0)
    // Newest first. A stable sort keeps two entries from the same millisecond in
    // the order they were spoken, which is the order the user remembers.
    .sort((a, b) => b.at - a.at);
  return all.slice(0, MAX_ENTRIES);
}

export function parseHistoryFile(raw: unknown): ParsedHistory {
  if (typeof raw !== "object" || raw === null) {
    return { file: emptyHistory(), error: "the history file was not an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== HISTORY_VERSION) {
    // Version-level refusals are NOT tolerant: entries stay empty rather than
    // being guessed at, and the error is what stops the empty copy being
    // written back over a file a future build may understand.
    return { file: emptyHistory(), error: `unknown history version ${JSON.stringify(r.version)}` };
  }
  if (!Array.isArray(r.entries)) {
    return { file: emptyHistory(), error: "the history file had no entry list" };
  }
  const entries: HistoryEntry[] = [];
  let lost = 0;
  for (const row of r.entries) {
    if (typeof row !== "object" || row === null) {
      lost++;
      continue;
    }
    const e = row as Record<string, unknown>;
    const at = typeof e.at === "number" && Number.isFinite(e.at) && e.at > 0 ? e.at : 0;
    const { text, truncated } = sanitizeHistoryText(e.text);
    if (at === 0 || !text) {
      lost++;
      continue;
    }
    entries.push(truncated ? { at, text, truncated } : { at, text });
  }
  return {
    file: { version: HISTORY_VERSION, entries },
    error: lost > 0 ? `${lost} history ${lost === 1 ? "entry" : "entries"} could not be read` : undefined,
  };
}
