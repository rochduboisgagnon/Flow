// Pure model of the clipboard snapshot/restore around a paste. The DEFAULT
// insertion path (plan 5.3) writes the dictation to the clipboard, sends a
// paste, then restores whatever was there before - so dictating never steals
// the user's clipboard. The timing (restore only AFTER the target app has read
// the paste) is the subtle part, isolated here to be unit-tested.
//
// This is NOT retention of the dictation (5.4): the dictated text is on the
// clipboard only for the paste, then overwritten by the restore. What we keep
// briefly is the USER's PRIOR clipboard, to give it back.

export type ClipKind = "text" | "image" | "empty";

export interface ClipSnapshot {
  kind: ClipKind;
  text?: string;
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
