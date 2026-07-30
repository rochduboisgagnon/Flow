// Remembering the window's size and position across launches.
//
// 2026-07-30, asked for directly: no imposed size any more. You set the window
// once with the mouse and it stays where you put it.
//
// The whole difficulty is in ONE case, and it is not rare: the bounds that were
// perfect yesterday can point at a screen that no longer exists. Undock a
// laptop, unplug a projector, change a resolution - and a window restored to
// its stored position opens somewhere nobody can see, with no way to drag it
// back because there is nothing to grab. An app that vanishes on launch is
// indistinguishable from an app that crashed on launch.
//
// So restoring is not "write the numbers back". It is "write them back IF they
// still land on a screen that exists", and the fallback has to be a window the
// user can actually see.

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle of screen space, as Electron's screen module reports one. */
export interface DisplayArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The size a machine that has never run Flow gets. */
export const DEFAULT_BOUNDS = { width: 1100, height: 740 } as const;

/** Below these, the app's own layout stops working - the rail and the content
 * column start overlapping - so a stored value under them is not honoured. */
export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 600;

/** How much of the window must remain on a real display for the bounds to count
 * as usable. Not 100%: a window deliberately hanging off the right edge is a
 * normal thing to do, and forcing it back would be its own annoyance. But a
 * window whose visible sliver is smaller than this cannot be grabbed by anyone. */
export const MIN_VISIBLE_PX = 120;

export function sanitizeBounds(raw: unknown): WindowBounds | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
  const x = num(r.x);
  const y = num(r.y);
  const width = num(r.width);
  const height = num(r.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  // An absurd size is a corrupt file, not a preference. 20000 is past any real
  // desktop and well short of anything that could exhaust memory.
  if (width > 20_000 || height > 20_000) return null;
  return { x, y, width, height };
}

/** Does this rectangle overlap the given display by at least MIN_VISIBLE_PX in
 * BOTH directions? Both matters: a window overlapping by 300px horizontally and
 * 2px vertically is, in practice, off-screen. */
export function intersectsEnough(b: WindowBounds, d: DisplayArea): boolean {
  const overlapX = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
  const overlapY = Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y);
  return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
}

/**
 * What to open with. Returns the stored bounds when they still land somewhere
 * visible, and a plain size otherwise - never a position that cannot be seen.
 *
 * Handing back a size WITHOUT x/y on the fallback is deliberate: Electron then
 * centres the window on the primary display, which is the one place a user is
 * guaranteed to be looking.
 */
export function restoreBounds(
  stored: unknown,
  displays: readonly DisplayArea[],
): WindowBounds | { width: number; height: number } {
  const b = sanitizeBounds(stored);
  if (!b) return { ...DEFAULT_BOUNDS };
  if (displays.length === 0) return { width: b.width, height: b.height };
  if (displays.some((d) => intersectsEnough(b, d))) return b;
  // The screen it lived on is gone. Keep the SIZE the user chose - that part of
  // their preference is still meaningful - and let the position be re-decided.
  return { width: b.width, height: b.height };
}
