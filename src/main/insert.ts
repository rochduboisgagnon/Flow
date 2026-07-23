import { clipboard, type NativeImage } from "electron";
import { keyboard, Key } from "@nut-tree-fork/nut-js";
import { RESTORE_DELAY_MS, snapshotIsRestorable } from "../shared/clipboardSnapshot";

// TextInjector: puts the dictated text where it belongs.
//   route "insert"    -> clipboard paste + restore (default), or typed keys
//   route "clipboard" -> just leave it on the clipboard for a manual Ctrl+V
//
// Zero retention (5.4): the dictated text lives on the clipboard only for the
// paste, then the user's PRIOR clipboard is restored over it. We keep the
// user's old clipboard for ~250 ms only to hand it back.

keyboard.config.autoDelayMs = 0; // no artificial per-key delay: speed is #1

interface PriorClip {
  text: string | null;
  image: NativeImage | null;
}

function snapshotClipboard(): PriorClip {
  const text = clipboard.readText();
  // Audit 2026-07-11 (P2): guard readImage. A malformed image on the clipboard can throw here (and on
  // older Electron trigger the readImage crash CVE). The snapshot is best-effort, so degrade to
  // text-only rather than take the engine down mid-dictation. (Full CVE fix = a major Electron bump.)
  let image: NativeImage | null = null;
  try {
    const img = clipboard.readImage();
    image = img.isEmpty() ? null : img;
  } catch {
    image = null;
  }
  return { text: text || null, image };
}

function restoreClipboard(prior: PriorClip) {
  if (prior.text !== null) clipboard.writeText(prior.text);
  else if (prior.image !== null) clipboard.writeImage(prior.image);
  // Prior clipboard was empty: leave the dictation there (better a leftover
  // dictation than clearing something the user might still want).
}

/** Insert at the cursor via clipboard paste, restoring the old clipboard. */
export async function insertViaPaste(text: string): Promise<void> {
  const prior = snapshotClipboard();
  clipboard.writeText(text);
  await keyboard.pressKey(Key.LeftControl, Key.V);
  await keyboard.releaseKey(Key.LeftControl, Key.V);
  const restorable =
    prior.text !== null
      ? snapshotIsRestorable({ kind: "text", text: prior.text })
      : prior.image !== null
        ? snapshotIsRestorable({ kind: "image", hasImage: true })
        : snapshotIsRestorable({ kind: "empty" });
  if (restorable) {
    // Restore only AFTER the target app has consumed the paste, else we clobber
    // the dictation before it lands.
    setTimeout(() => restoreClipboard(prior), RESTORE_DELAY_MS);
  }
}

/** The "no editable field" path: just leave the text on the clipboard. */
export function leaveOnClipboard(text: string): void {
  clipboard.writeText(text);
}

/** The paste-hostile path (opt-in via settings.insertMode = "type"): type the
 * text as keystrokes instead of pasting. Slower and unicode/IME-sensitive, but
 * it works where an app swallows a programmatic Ctrl+V, and it NEVER puts the
 * dictation on the clipboard - so it is even stricter on the zero-retention rule
 * (§5.4) than the paste path (no snapshot/restore dance at all). */
export async function insertTyped(text: string): Promise<void> {
  await keyboard.type(text);
}
