// Filesystem-safe, browser-style naming for a downloaded history recording
// (U5c). PURE: no fs, no path, no Electron - every rule here is exactly the
// kind that breaks silently on a machine with an odd title (a trailing dot, a
// name that happens to collide with a Windows device name, a title that is
// pure emoji), so it lives where a unit test can hit every edge case without
// spinning up Electron or touching a real disk. Also compiled into the
// renderer build (tsconfig.json has no Node lib), so it must stay pure.

// Windows forbids these in a path SEGMENT (never a separator itself - the
// caller supplies the directory, this only ever produces a file NAME), plus
// C0 control characters. Being this strict on macOS too costs nothing (it
// only forbids "/" and NUL) and keeps one rule set for both platforms.
// Matching control characters IS the job here; the lint rule below exists to
// catch the ones nobody meant to type (same discipline as htmlSanitize.ts).
// eslint-disable-next-line no-control-regex -- deliberate, see above.
const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// A bare reserved DOS device name, with or without an extension - "CON",
// "con.txt", "COM1.md"... Checked against the WHOLE sanitized stem: a longer
// name that merely contains "con" (e.g. "Contract Review") is not affected.
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i;

// Generous but bounded: the full download name is "<date> <title>.<ext>",
// and a caller may still append " (123)" for a collision - leaving headroom
// keeps the total comfortably under Windows' 260-char MAX_PATH even inside a
// deeply nested Downloads folder.
const MAX_TITLE_LENGTH = 100;

/** Truncate to at most `max` Unicode CODE POINTS (not UTF-16 code units): a
 * plain .slice(0, max) can cut a surrogate pair in half (an emoji or a rare
 * CJK character becomes a stray replacement character) - Array.from splits on
 * code points instead, so a title made of emoji or accented text truncates
 * cleanly like everything else. */
function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

/** Makes `raw` safe as a single Windows/macOS filename SEGMENT:
 *  - strips characters Windows forbids in a filename, plus control chars,
 *    replacing each with a space (so "Q&A: Sales / Marketing" degrades to
 *    readable words, not a run-together blob);
 *  - collapses the whitespace that strip can introduce, then trims;
 *  - trims trailing dots and spaces (Windows silently strips these itself on
 *    a real filesystem, which would make "Client Update..." on disk silently
 *    diverge from what the user typed - done explicitly here instead of
 *    relying on that undocumented OS behavior);
 *  - renames a bare Windows reserved device name (CON, PRN, NUL, COM1...) so
 *    it can never collide with a real device path;
 *  - bounds the length (by code point, see truncateCodePoints) so the full
 *    "<date> <title>.<ext>" name stays sane;
 *  - falls back to "recording" if nothing printable survives (an all-emoji
 *    title is untouched by any rule above and needs no fallback; a title of
 *    pure forbidden characters, e.g. "///", does). */
export function sanitizeTitleForFilename(raw: string): string {
  let s = (raw ?? "").replace(FORBIDDEN_CHARS, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.\s]+$/g, "");
  s = truncateCodePoints(s, MAX_TITLE_LENGTH);
  // Truncation can re-expose trailing whitespace/dots the length cut landed on.
  s = s.replace(/[.\s]+$/g, "");
  if (RESERVED_NAME.test(s)) s = "_" + s;
  return s || "recording";
}

/** "YYYY-MM-DD Titre" (no extension - numberedFilename appends it): readable
 * and sorts chronologically by filename, matching the archive's own
 * <date>/<title> layout. `date` is trusted as already YYYY-MM-DD (it comes
 * from the history entry's own folder name, see main/longform.ts's
 * DATE_DIR_RE) - not re-validated here. */
export function historyDownloadStem(date: string, title: string): string {
  return `${date} ${sanitizeTitleForFilename(title)}`;
}

/** Browser-style de-duplication: variant 0 is the plain name, variant N>=1
 * inserts " (N)" right before the extension - "note.md", "note (1).md",
 * "note (2).md"... `stem` and `ext` are kept separate by the caller (never
 * re-derived by splitting on the last dot here) so a title that legally
 * contains its own dots after sanitization can never be mistaken for the
 * extension. */
export function numberedFilename(stem: string, ext: string, variant: number): string {
  return variant <= 0 ? `${stem}.${ext}` : `${stem} (${variant}).${ext}`;
}
