// Pure model of the clipboard snapshot/restore around a paste. The DEFAULT
// insertion path (plan 5.3) writes the dictation to the clipboard, sends a
// paste, then restores whatever was there before - so dictating never steals
// the user's clipboard. The timing (restore only AFTER the target app has read
// the paste) is the subtle part, isolated here to be unit-tested.
//
// This is NOT retention of the dictation (5.4): the dictated text is on the
// clipboard only for the paste, then overwritten by the restore. What we keep
// briefly is the USER's PRIOR clipboard, to give it back.

export type ClipKind = "text" | "rich" | "image" | "empty";

export interface ClipSnapshot {
  kind: ClipKind;
  text?: string;
  // "rich" = the clipboard also carried an HTML flavour (Word, a browser
  // selection, a mail composer). Restoring text-only there silently ate the
  // user's formatting on EVERY dictation, so the kind has to be distinguished.
  html?: string;
  // Images are handled by reference in the real adapter; the model only needs
  // to know something non-text was there so it restores the right kind.
  hasImage?: boolean;
}

// How long to wait after the paste keystroke before restoring the old
// clipboard. Too short = we clobber the dictation before the app pastes it;
// too long = a visible window where the user's clipboard is our text.
export const RESTORE_DELAY_MS = 250;

export function snapshotIsRestorable(s: ClipSnapshot): boolean {
  // Nothing meaningful to give back for an empty clipboard: skip the restore
  // (writing "" would still count as clobbering with an empty value).
  return s.kind !== "empty";
}

/** Every flavour a restore has to put back, together. */
export interface RestoreFlavours {
  /** Present when the clipboard carried plain text. */
  text?: string;
  /** Present when it carried an HTML flavour (Word, a browser, a composer). */
  html?: string;
  /** True when it also carried a bitmap the adapter must write back. */
  image: boolean;
}

/**
 * What a restore must write, or null when there is nothing to give back.
 *
 * U3g (review, major - a regression introduced with the HTML flavour): the
 * adapter used to restore the FIRST flavour it found, in an exclusive if/else
 * chain that tested html before image. A clipboard holding html + a bitmap and
 * no text - copy an image out of a web page, which is the ordinary way to get
 * one - therefore came back as html alone, and the bitmap the snapshot had
 * carefully captured was thrown away by every single dictation. Before the HTML
 * flavour existed, that same clipboard fell through to the image branch and the
 * bitmap survived.
 *
 * So the model returns EVERY flavour that was captured, and the adapter hands
 * the whole set to one clipboard.write() call (Electron's write accepts text,
 * html and image together). "Restore what was there" is one rule; "restore the
 * richest thing that was there" was a ranking, and a ranking is a thing to get
 * wrong again the next time a flavour is added.
 */
export function restoreFlavours(s: ClipSnapshot): RestoreFlavours | null {
  if (!snapshotIsRestorable(s)) return null;
  const out: RestoreFlavours = { image: s.hasImage === true };
  // Distinguish "absent" from "empty string": a clipboard that held html and no
  // text must not be given a text flavour it never had.
  if (s.text !== undefined) out.text = s.text;
  if (s.html !== undefined) out.html = s.html;
  return out;
}

/** What an insertion must do about the restore that may already be in flight. */
export interface RestorePlan<T> {
  /** The clipboard value the eventual restore has to give back. */
  prior: T;
  /** True when a restore was already armed and its timer must be cancelled. */
  cancelPrevious: boolean;
}

/**
 * Which prior clipboard survives a BURST of insertions?
 *
 * Each insertion writes the dictation to the clipboard, so an insertion that
 * starts while a previous restore is still pending would snapshot the PREVIOUS
 * DICTATION and hand that back as "the user's clipboard". Two dictations less
 * than RESTORE_DELAY_MS apart (trivial in hands-free mode) therefore destroyed
 * the real clipboard permanently: both timers fired, the last one won, and what
 * it wrote was our own text.
 *
 * The rule: a pending prior always wins over a fresh capture. The pending value
 * is the only one taken before ANY dictation touched the clipboard, so folding
 * this over a burst of any length keeps the pre-burst value, and cancelling the
 * previous timer each time leaves exactly ONE restore at the end of the burst.
 *
 * `fresh` is still read by the caller in every case: it is what makes the first
 * insertion of a burst (pending === null) capture the real clipboard.
 */
export function planRestore<T>(pending: T | null, fresh: T): RestorePlan<T> {
  return pending === null
    ? { prior: fresh, cancelPrevious: false }
    : { prior: pending, cancelPrevious: true };
}
