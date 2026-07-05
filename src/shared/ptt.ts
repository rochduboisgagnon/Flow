// Pure push-to-talk state machine. Kept free of Electron/keyspy so the exact
// hold semantics (auto-repeat, accidental taps, stray releases) are unit-tested.
//
// Windows auto-repeat fires DOWN events continuously while a key is held: only
// the FIRST one may start a capture. A release under minHoldMs cancels instead
// of stopping (an accidental tap must never trigger a transcription).

export type PttAction = "start" | "stop" | "cancel" | "none";

export interface Ptt {
  down(now: number): PttAction;
  up(now: number): PttAction;
  recording(): boolean;
}

export function createPtt(minHoldMs: number): Ptt {
  let downAt: number | null = null;
  return {
    down(now) {
      if (downAt !== null) return "none"; // auto-repeat while held
      downAt = now;
      return "start";
    },
    up(now) {
      if (downAt === null) return "none"; // stray release (e.g. key was down before we started)
      const held = now - downAt;
      downAt = null;
      return held < minHoldMs ? "cancel" : "stop";
    },
    recording() {
      return downAt !== null;
    },
  };
}
