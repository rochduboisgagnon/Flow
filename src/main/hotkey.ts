import { GlobalKeyboardListener } from "keyspy";
import type { IGlobalKeyEvent } from "keyspy";
import { createComboMatcher, type ComboMatcher } from "../shared/combo";
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

export class HotkeyAdapter {
  private listener: GlobalKeyboardListener | null = null;
  private matcher: ComboMatcher;
  private suspended = false;
  private cbs: PttCallbacks;

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
      if (this.suspended || !e.name) return false;
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

  /** Applies a new shortcut immediately (from the settings recorder). */
  setCombo(combo: string[]) {
    const wasCapturing = this.matcher.capturing();
    this.matcher.setCombo(combo);
    // Never leave a hot microphone behind a state reset.
    if (wasCapturing) this.cbs.onCancel();
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
