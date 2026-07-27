import fsNode from "node:fs";

// U2c: what the app is allowed to SAY about the recordings folder this machine
// used before the folder became fixed.
//
// The rule this module exists for: Flow never lies about where data is. The
// first version of the note asserted "everything you recorded back then is
// still exactly where it was" without anyone having looked - and offered an
// Open button that, on a folder since moved or unplugged, silently did nothing
// (shell.openPath RETURNS an error string, it does not throw). So existence is
// established here, carried in the payload, and the UI adapts its wording and
// hides the button rather than pointing at a folder that is not there.

export interface LegacyHistoryInfo {
  dir: string;
  /** Checked on the real filesystem, never assumed. */
  exists: boolean;
}

/** Undefined when there is nothing to say (no legacy folder recorded). The
 * `exists` probe is injectable so the "the folder is gone" branch is testable
 * without unmounting a volume. Never throws: a path we may not stat (a network
 * share that is down, a permission quirk) reads as "not there", which is the
 * honest answer - Flow cannot find it. */
export function legacyHistoryInfo(
  dir: string,
  exists: (p: string) => boolean = (p) => fsNode.existsSync(p),
): LegacyHistoryInfo | undefined {
  const d = (dir || "").trim();
  if (!d) return undefined;
  let found = false;
  try {
    found = exists(d);
  } catch {
    found = false;
  }
  return { dir: d, exists: found };
}
