// Pure combo matcher for the push-to-talk shortcut. Replaces the single-key
// ptt.ts: the default shortcut is Ctrl+Win, a MODIFIERS-ONLY combination that
// no OS-level hotkey API accepts (plan 5.8) - so we monitor raw keydown/keyup
// from the low-level hook and do all matching here, in plain testable JS.
//
// Hard-won rules encoded below:
// - Key state is tracked FROM THE EVENTS ONLY. Inside a low-level hook the OS
//   key-state APIs are not yet updated for the key being processed; asking the
//   OS mid-callback gives stale answers.
// - THE START-MENU TRAP: Windows opens the Start menu when the Win key is
//   released "alone". When a Win keydown COMPLETES the combo (Ctrl already
//   held), we SWALLOW it - the OS never sees the Win press at all, so there is
//   no menu to suppress and no Win+X shortcut can fire while dictating. Its
//   auto-repeats and its final keyup are swallowed too, so the OS keyboard
//   state stays consistent (never "seen down, never released").
//   When Win is pressed FIRST (before Ctrl), the OS already saw it; we let it
//   through: the Ctrl keydown that lands during the Win hold is what cancels
//   the Start menu natively. We never swallow an UP whose DOWN went through -
//   that would leave the OS with a stuck modifier, worse than any menu.
// - Windows auto-repeats DOWN events while a key is held: only a rising edge
//   may (re)evaluate the combo.
// - A press shorter than minHoldMs is an accidental tap -> cancel, nothing
//   reaches the ASR. But TWO quick taps within doubleTapMs = hands-free
//   toggle (plan 5.8): capture keeps running after the second tap's release,
//   and a new double-tap stops it.
// - While holding to talk, any keydown OUTSIDE the combo cancels the capture:
//   the user is invoking an OS shortcut (Ctrl+Win+arrow switches virtual
//   desktops), not dictating. In toggle mode other keys are ignored - being
//   hands-free is the point.

export type PttAction = "start" | "stop" | "cancel" | "none";

export interface ComboEvent {
  key: string; // keyspy physical name, e.g. "LEFT CTRL", "RIGHT META", "F9"
  state: "DOWN" | "UP";
}

export interface ComboDecision {
  action: PttAction;
  swallow: boolean; // true -> block the event from reaching the OS/other apps
}

// Generic (side-agnostic) names used in stored combos and in the UI.
const GENERIC: Record<string, string> = {
  "LEFT CTRL": "CTRL",
  "RIGHT CTRL": "CTRL",
  "LEFT SHIFT": "SHIFT",
  "RIGHT SHIFT": "SHIFT",
  "LEFT ALT": "ALT",
  "RIGHT ALT": "ALT",
  "LEFT META": "WIN", // keyspy calls the Windows/Cmd key META
  "RIGHT META": "WIN",
};

/** "LEFT META" -> "WIN"; non-modifiers map to themselves. */
export function genericOf(key: string): string {
  return GENERIC[key] ?? key;
}

/** Does a physical key satisfy one stored combo entry? Entries may be generic
 * ("CTRL", "WIN") or exact physical names ("RIGHT CTRL", "F9"). */
function satisfies(entry: string, physicalKey: string): boolean {
  return entry === physicalKey || entry === genericOf(physicalKey);
}

/** Human label for a stored combo: ["CTRL","WIN"] -> "Ctrl + Win". */
export function comboLabel(combo: string[]): string {
  const pretty = (k: string) =>
    k
      .toLowerCase()
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  return combo.map(pretty).join(" + ");
}

/** Normalize a recorded set of physical keys into a stored combo: modifiers
 * become generic and sort first, at most one non-modifier key is kept. */
export function normalizeCombo(physicalKeys: string[]): string[] {
  const mods: string[] = [];
  const others: string[] = [];
  for (const k of physicalKeys) {
    const g = genericOf(k);
    if (g !== k) {
      if (!mods.includes(g)) mods.push(g);
    } else if (!others.includes(k)) {
      others.push(k);
    }
  }
  const ORDER = ["CTRL", "SHIFT", "ALT", "WIN"];
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return [...mods, ...others.slice(0, 1)];
}

export interface ComboMatcher {
  handle(e: ComboEvent, now: number): ComboDecision;
  capturing(): boolean;
  toggled(): boolean;
  setCombo(combo: string[]): void;
  reset(): void;
}

export function createComboMatcher(
  initialCombo: string[],
  opts?: { minHoldMs?: number; doubleTapMs?: number },
): ComboMatcher {
  const minHoldMs = opts?.minHoldMs ?? 200;
  const doubleTapMs = opts?.doubleTapMs ?? 400;

  let combo = [...initialCombo];
  const down = new Set<string>(); // physical keys currently held (event-tracked)
  const swallowed = new Set<string>(); // WIN keys whose DOWN we blocked
  let pressedAt: number | null = null; // combo fully down since (null = not pressed)
  let capturing = false;
  let toggledOn = false;
  let lastTapUpAt: number | null = null; // end of the previous quick tap

  function comboFullyDown(): boolean {
    return combo.every((entry) => [...down].some((k) => satisfies(entry, k)));
  }

  function isComboKey(key: string): boolean {
    return combo.some((entry) => satisfies(entry, key));
  }

  function reset() {
    down.clear();
    swallowed.clear();
    pressedAt = null;
    capturing = false;
    toggledOn = false;
    lastTapUpAt = null;
  }

  function handleDown(key: string, now: number): ComboDecision {
    if (down.has(key)) {
      // Auto-repeat while held: no state change; keep hiding a swallowed Win.
      return { action: "none", swallow: swallowed.has(key) };
    }
    const wasFull = comboFullyDown();
    down.add(key);
    const nowFull = comboFullyDown();

    if (!wasFull && nowFull) {
      // The combo just became fully pressed.
      pressedAt = now;
      // Swallow a WIN keydown that COMPLETES the combo (see Start-menu trap).
      const swallow = genericOf(key) === "WIN" && isComboKey(key);
      if (swallow) swallowed.add(key);
      if (!capturing) {
        capturing = true;
        return { action: "start", swallow };
      }
      // Already capturing hands-free: this press is a potential stop-tap;
      // the decision happens at its release.
      return { action: "none", swallow };
    }

    if (capturing && !toggledOn && !isComboKey(key)) {
      // Extra key while holding to talk = an OS shortcut, not dictation.
      capturing = false;
      pressedAt = null;
      lastTapUpAt = null;
      return { action: "cancel", swallow: false };
    }
    return { action: "none", swallow: false };
  }

  function handleUp(key: string, now: number): ComboDecision {
    const swallow = swallowed.delete(key);
    if (!down.has(key)) return { action: "none", swallow }; // stray release
    const wasFull = comboFullyDown();
    down.delete(key);
    if (!wasFull || comboFullyDown() || pressedAt === null) {
      return { action: "none", swallow };
    }
    // The combo just broke: one press ended.
    const heldMs = now - pressedAt;
    pressedAt = null;

    if (capturing && !toggledOn) {
      if (heldMs < minHoldMs) {
        if (lastTapUpAt !== null && now - lastTapUpAt <= doubleTapMs) {
          // Double-tap: keep the capture from this second tap running.
          toggledOn = true;
          lastTapUpAt = null;
          return { action: "none", swallow };
        }
        capturing = false;
        lastTapUpAt = now;
        return { action: "cancel", swallow };
      }
      capturing = false;
      lastTapUpAt = null;
      return { action: "stop", swallow };
    }

    if (capturing && toggledOn) {
      // Hands-free: only a new double-tap stops (plan 5.8).
      if (heldMs < minHoldMs) {
        if (lastTapUpAt !== null && now - lastTapUpAt <= doubleTapMs) {
          capturing = false;
          toggledOn = false;
          lastTapUpAt = null;
          return { action: "stop", swallow };
        }
        lastTapUpAt = now;
      } else {
        lastTapUpAt = null; // a long press is not part of a tap chain
      }
      return { action: "none", swallow };
    }
    return { action: "none", swallow };
  }

  return {
    handle(e, now) {
      return e.state === "DOWN" ? handleDown(e.key, now) : handleUp(e.key, now);
    },
    capturing: () => capturing,
    toggled: () => toggledOn,
    setCombo(next) {
      combo = [...next];
      reset();
    },
    reset,
  };
}
