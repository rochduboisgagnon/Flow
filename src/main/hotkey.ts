import { GlobalKeyboardListener } from "keyspy";
import type { IGlobalKeyEvent } from "keyspy";
import { createComboMatcher, createEdgeMatcher, normalizeCombo, type ComboMatcher, type EdgeMatcher } from "../shared/combo";
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
  onOpenPilot?(): void; // v5 c2: the "open AGR Pilot" combo fired
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
  private openMatcher: EdgeMatcher; // v5 c2: "open AGR Pilot" shortcut
  private suspended = false;
  private recorder: RecorderState | null = null;
  private cbs: PttCallbacks;

  constructor(combo: string[], openPilotCombo: string[], cbs: PttCallbacks) {
    this.matcher = createComboMatcher(combo, {
      minHoldMs: MIN_HOLD_MS,
      doubleTapMs: DOUBLE_TAP_MS,
    });
    this.openMatcher = createEdgeMatcher(openPilotCombo);
    this.cbs = cbs;
  }

  async start(): Promise<void> {
    this.listener = new GlobalKeyboardListener();
    // keyspy spawns its key server; the promise rejects if the binary is missing.
    await this.listener.addListener((e: IGlobalKeyEvent) => {
      // The low-level hook gives the OS ~1 s per event before it silently
      // removes us: this handler must stay trivial (pure state machine, no IO).
      if (this.suspended || !e.name) return false;
      // keyspy also reports mouse buttons: clicking while dictating must not
      // cancel the capture, and a click is never part of a shortcut.
      if (e.name.startsWith("MOUSE")) return false;
      if (this.recorder) return this.handleRecording(e);
      // v5 c2: the "open AGR Pilot" shortcut shares this dedicated listener thread
      // (a rising-edge single fire, independent of the push-to-talk matcher). Both
      // matchers see every event so their state stays consistent.
      const open = this.openMatcher.handle({ key: e.name, state: e.state });
      if (open.fire) this.cbs.onOpenPilot?.();
      const { action, swallow } = this.matcher.handle(
        { key: e.name, state: e.state },
        Date.now(),
      );
      if (action === "start") this.cbs.onStart();
      else if (action === "stop") this.cbs.onStop();
      else if (action === "cancel") this.cbs.onCancel();
      return open.swallow || swallow;
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

  /** v5 c2: applies a new "open AGR Pilot" combo ([] disables the shortcut). */
  setOpenCombo(combo: string[]) {
    this.openMatcher.setCombo(combo);
  }

  /** While suspended (shortcut recorder open), keys pass through untouched. */
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
