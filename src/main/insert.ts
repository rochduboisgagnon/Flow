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
  const image = clipboard.readImage();
  return { text: text || null, image: image.isEmpty() ? null : image };
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

// A typed-keys fallback (keyboard.type) for paste-hostile apps is planned for
// phase 2 (streamed insertion); paste + restore covers phase 1's targets.
