import { GlobalKeyboardListener } from "keyspy";
import type { IGlobalKeyEvent } from "keyspy";
import { createComboMatcher, normalizeCombo, type ComboMatcher } from "../shared/combo";
import { MIN_HOLD_MS, DOUBLE_TAP_MS } from "../shared/constants";

// HotkeyAdapter: the only place that touches keyspy. The rest of the app sees
// three callbacks (start / stop / cancel), so the listener library can be
// swapped (uiohook-napi is the documented fallback) without touching the loop.
//
// All matching lives in the pure combo matcher (src/shared/combo.ts): keyspy
// only reports raw keydown/keyup and applies our swallow verdicts. The verdict
// (return value) is what blocks a Win keypress from reaching the OS - the
// Start-menu trap of the default Ctrl+Win shortcut (plan 5.8).
export interface PttCallbacks {
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}

interface RecorderState {
  down: Set<string>;
  keys: Set<string>;
  timer: NodeJS.Timeout;
  done: (combo: string[] | null) => void;
}

// The recorder auto-cancels after this long: while it runs, EVERY key is
// swallowed system-wide, so it must never be able to linger.
const RECORD_TIMEOUT_MS = 10_000;

export class HotkeyAdapter {
  private listener: GlobalKeyboardListener | null = null;
  private matcher: ComboMatcher;
  private suspended = false;
  private recorder: RecorderState | null = null;
  private cbs: PttCallbacks;

  // The "open AGR Pilot" shortcut used to live here too (v5 c2), which coupled it to AGR Flow:
  // disabling Flow killed the shortcut. It now belongs entirely to AGR Manager (its own always-on
  // LL hook), independent of Flow. This adapter only owns the dictation combo.
  constructor(combo: string[], cbs: PttCallbacks) {
    this.matcher = createComboMatcher(combo, {
      minHoldMs: MIN_HOLD_MS,
      doubleTapMs: DOUBLE_TAP_MS,
    });
    this.cbs = cbs;
  }

  async start(): Promise<void> {
    this.listener = new GlobalKeyboardListener();
    // keyspy spawns its key server; the promise rejects if the binary is missing.
    await this.listener.addListener((e: IGlobalKeyEvent) => {
      // The low-level hook gives the OS ~1 s per event before it silently
      // removes us: this handler must stay trivial (pure state machine, no IO).
      if (!e.name) return false;
      // keyspy also reports mouse buttons: clicking while dictating must not
      // cancel the capture, and a click is never part of a shortcut.
      if (e.name.startsWith("MOUSE")) return false;
      // The recorder OUTRANKS the pause (audit): recording a new shortcut from
      // Settings must work - and keep swallowing every key - even while the
      // tray pause has the PTT suspended. The old order made the recorder go
      // deaf during a pause AND let the keys leak to the OS (Start menu).
      if (this.recorder) return this.handleRecording(e);
      if (this.suspended) return false;
      const { action, swallow } = this.matcher.handle(
        { key: e.name, state: e.state },
        Date.now(),
      );
      if (action === "start") this.cbs.onStart();
      else if (action === "stop") this.cbs.onStop();
      else if (action === "cancel") this.cbs.onCancel();
      return swallow;
    });
  }

  /** Shortcut recorder (plan 5.8): the hook itself captures the gesture, so
   * modifiers-only combos work and NOTHING leaks to the OS while recording
   * (pressing Win cannot open the Start menu mid-recording). The combo is
   * finalized when every key is released; Esc cancels; Backspace clears. */
  record(): Promise<string[] | null> {
    if (this.recorder) return Promise.resolve(null); // one recorder at a time
    if (this.matcher.capturing()) this.cbs.onCancel();
    this.matcher.reset();
    return new Promise((resolve) => {
      const finish = (combo: string[] | null) => {
        if (!this.recorder) return;
        clearTimeout(this.recorder.timer);
        this.recorder = null;
        resolve(combo);
      };
      this.recorder = {
        down: new Set(),
        keys: new Set(),
        timer: setTimeout(() => finish(null), RECORD_TIMEOUT_MS),
        done: finish,
      };
    });
  }

  private handleRecording(e: IGlobalKeyEvent): boolean {
    const r = this.recorder!;
    const key = e.name!;
    if (e.state === "DOWN") {
      if (key === "ESCAPE") {
        r.done(null);
        return true;
      }
      if (key === "BACKSPACE") {
        // Clear and let the user start the gesture over (held keys will
        // re-register through their auto-repeat DOWNs).
        r.keys.clear();
        r.down.clear();
        return true;
      }
      r.down.add(key);
      r.keys.add(key);
    } else {
      r.down.delete(key);
      if (r.down.size === 0 && r.keys.size > 0) {
        r.done(normalizeCombo([...r.keys]));
      }
    }
    return true; // swallow everything while recording
  }

  /** Applies a new shortcut immediately (from the settings recorder). */
  setCombo(combo: string[]) {
    const wasCapturing = this.matcher.capturing();
    this.matcher.setCombo(combo);
    // Never leave a hot microphone behind a state reset.
    if (wasCapturing) this.cbs.onCancel();
  }

  /** User-facing pause (the tray's "Pause dictation"): PTT keys pass through
   * untouched. The shortcut RECORDER keeps working while suspended. */
  suspend(v: boolean) {
    if (v && this.matcher.capturing()) this.cbs.onCancel();
    this.suspended = v;
    this.matcher.reset();
  }

  stop() {
    this.listener?.kill();
    this.listener = null;
  }
}
