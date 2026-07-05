import { GlobalKeyboardListener } from "keyspy";
import type { IGlobalKeyEvent } from "keyspy";
import { createPtt, type PttAction } from "../shared/ptt";
import { MIN_HOLD_MS } from "../shared/constants";

// HotkeyAdapter: the only place that touches keyspy. The rest of the app sees
// three callbacks (start / stop / cancel), so the listener library can be
// swapped (e.g. for OpenWhispr's C key-listener) without touching the loop.
export interface PttCallbacks {
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}

export class HotkeyAdapter {
  private listener: GlobalKeyboardListener | null = null;
  private ptt = createPtt(MIN_HOLD_MS);
  private key: string;
  private cbs: PttCallbacks;

  constructor(key: string, cbs: PttCallbacks) {
    this.key = key;
    this.cbs = cbs;
  }

  async start(): Promise<void> {
    this.listener = new GlobalKeyboardListener();
    // keyspy spawns its key server; the promise rejects if the binary is missing.
    await this.listener.addListener((e: IGlobalKeyEvent) => {
      if (e.name !== this.key) return;
      const action: PttAction =
        e.state === "DOWN" ? this.ptt.down(Date.now()) : this.ptt.up(Date.now());
      if (action === "start") this.cbs.onStart();
      else if (action === "stop") this.cbs.onStop();
      else if (action === "cancel") this.cbs.onCancel();
      // Never capture/block the key: dictating must not eat the keystroke for
      // other apps (RIGHT CTRL may be part of someone's muscle memory).
      return false;
    });
  }

  setKey(key: string) {
    this.key = key;
  }

  stop() {
    this.listener?.kill();
    this.listener = null;
  }
}
