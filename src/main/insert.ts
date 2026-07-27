import { clipboard, type NativeImage } from "electron";
import { keyboard, Key } from "@nut-tree-fork/nut-js";
import {
  RESTORE_DELAY_MS,
  planRestore,
  restoreFlavours,
  snapshotIsRestorable,
  type ClipSnapshot,
} from "../shared/clipboardSnapshot";

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
  html: string | null;
  image: NativeImage | null;
}

function snapshotClipboard(): PriorClip {
  const text = clipboard.readText();
  // U3e: the HTML flavour is part of what the user owned. Without it, anyone who
  // had copied from Word, a browser or a mail composer got PLAIN TEXT back after
  // every single dictation - a formatting loss we caused and never reported.
  const html = clipboard.readHTML();
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
  return { text: text || null, html: html || null, image };
}

/** Adapter -> pure model, so the restorable rule lives in one tested place.
 *
 * U3g: EVERY captured flavour is carried across, not just the first one that
 * matched. `kind` still names the richest flavour present - it is what
 * snapshotIsRestorable reads - but it no longer DECIDES what comes back, which
 * is what silently dropped the bitmap of an html+image clipboard. */
function describeClip(prior: PriorClip): ClipSnapshot {
  const kind =
    prior.html !== null ? "rich" : prior.text !== null ? "text" : prior.image !== null ? "image" : "empty";
  const snap: ClipSnapshot = { kind };
  if (prior.text !== null) snap.text = prior.text;
  if (prior.html !== null) snap.html = prior.html;
  if (prior.image !== null) snap.hasImage = true;
  return snap;
}

function restoreClipboard(prior: PriorClip) {
  // Known and accepted round-trip loss: clipboard.readHTML() returns the CF_HTML
  // FRAGMENT without its header, and write({ html }) rebuilds a header with
  // about:blank as SourceURL. So the original SourceURL is gone, and Word's
  // conditional comments that key off it can degrade. Do NOT "fix" this by
  // dropping the html: giving back styled content minus its SourceURL is
  // strictly better than what we did before, which was losing the styling
  // entirely on every dictation.
  //
  // U3g: ONE write carrying every flavour that was captured (Electron's
  // clipboard.write takes text, html and image together), instead of an
  // exclusive if/else that gave back whichever flavour it tested for first.
  // What to write is decided by the pure model; this only performs it.
  const flavours = restoreFlavours(describeClip(prior));
  // Prior clipboard was empty: leave the dictation there (better a leftover
  // dictation than clearing something the user might still want).
  if (flavours === null) return;
  const data: Electron.Data = {};
  if (flavours.text !== undefined) data.text = flavours.text;
  if (flavours.html !== undefined) data.html = flavours.html;
  if (flavours.image && prior.image !== null) data.image = prior.image;
  clipboard.write(data);
}

// MODULE-level pending restore, not one per call. Per-call state was the bug:
// two insertions inside RESTORE_DELAY_MS each armed their own timer, and the
// second one had snapshotted the FIRST one's dictation as "the user's
// clipboard" - so the burst ended with our text installed permanently.
let pending: { prior: PriorClip; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Take the clipboard the user owned before this burst, disarming any restore
 * still in flight. Called BEFORE the dictation is written, for two reasons: the
 * fresh capture must not see our own text, and an armed timer must not fire
 * between our write and the paste keystroke (it would restore over the
 * dictation before the target app ever read it).
 */
function takePrior(): PriorClip {
  const fresh = snapshotClipboard();
  const plan = planRestore(pending?.prior ?? null, fresh);
  if (plan.cancelPrevious && pending) clearTimeout(pending.timer);
  pending = null;
  return plan.prior;
}

/** Arm the single restore that closes the burst. */
function armRestore(prior: PriorClip): void {
  const restorable = snapshotIsRestorable(describeClip(prior));
  // Restore only AFTER the target app has consumed the paste, else we clobber
  // the dictation before it lands.
  const timer = setTimeout(() => {
    pending = null;
    if (restorable) restoreClipboard(prior);
  }, RESTORE_DELAY_MS);
  // Tracked even when there is nothing to give back: "the clipboard was empty"
  // is a real state that the next insertion of the burst must inherit, instead
  // of snapshotting the dictation we just wrote and adopting it as the user's.
  pending = { prior, timer };
}

async function pasteKeystroke(): Promise<void> {
  await keyboard.pressKey(Key.LeftControl, Key.V);
  await keyboard.releaseKey(Key.LeftControl, Key.V);
}

/** Insert at the cursor via clipboard paste, restoring the old clipboard. */
export async function insertViaPaste(text: string): Promise<void> {
  const prior = takePrior();
  clipboard.writeText(text);
  await pasteKeystroke();
  armRestore(prior);
}

/**
 * Rich-text sibling of insertViaPaste: pastes text + HTML in one go.
 *
 * Deliberately a SEPARATE ENTRY POINT. The dictation path (index.ts wireCapture
 * -> decideRoute -> insertViaPaste) is the most-reviewed code in the app and it
 * has no rich content to insert; adding a branch there would be a new failure
 * mode on the hot path for zero benefit. Callers that genuinely have HTML call
 * this instead. Same paste keystroke, same single-restore discipline, so a mix
 * of rich and plain insertions inside one burst still gives back one prior.
 */
export async function insertRichViaPaste(text: string, html: string): Promise<void> {
  const prior = takePrior();
  clipboard.write({ text, html });
  await pasteKeystroke();
  armRestore(prior);
}

/**
 * Give the clipboard back NOW instead of losing it (before-quit).
 *
 * A pending restore is a timer on a process that is about to die: if we quit
 * inside the ~250 ms window, the callback never runs and the user's clipboard
 * stays replaced by dictation FOREVER, with no app left to fix it. Restoring
 * slightly early is the far smaller cost - the paste keystroke is already in
 * the OS input queue by then.
 */
export function flushPendingRestore(): void {
  if (!pending) return;
  const { prior, timer } = pending;
  clearTimeout(timer);
  pending = null;
  if (snapshotIsRestorable(describeClip(prior))) restoreClipboard(prior);
}

/**
 * Drop a restore still in flight WITHOUT writing anything back.
 *
 * U3g (review, major): the restore timer is armed for ~250 ms after a
 * dictation, and it does not know that the user may have put something on the
 * clipboard IN THE MEANTIME on purpose. Clicking "Copy to clipboard" on a
 * snippet right after dictating (a completely ordinary sequence - say a
 * sentence, then grab your signature) wrote the snippet, then watched the timer
 * overwrite it a quarter second later with the pre-dictation clipboard. The
 * copy vanished under the user's fingers, and the app looked broken for a
 * reason nobody could see.
 *
 * The rule this encodes: an EXPLICIT user copy outranks the restore. The
 * restore exists to undo a side effect the user never asked for; the copy is
 * the thing they did ask for, and it is more recent. So the pending value is
 * simply dropped - not restored early (flushPendingRestore's job, for quit),
 * because writing it would be the very clobbering we are avoiding.
 *
 * Returns whether a restore was actually cancelled, so a caller can log it.
 */
export function cancelPendingRestore(): boolean {
  if (!pending) return false;
  clearTimeout(pending.timer);
  pending = null;
  return true;
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
