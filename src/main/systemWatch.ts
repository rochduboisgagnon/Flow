import { powerMonitor } from "electron";
import {
  reactToSystemTransition,
  type SystemContext,
  type SystemTransition,
} from "../shared/systemResilience";
import type { HookState } from "../shared/hookWatchdog";

// SystemWatch (plan V2, B9): the ONE place that listens to the machine itself -
// sleep, wake, lock, unlock - and the thinnest possible adapter around
// shared/systemResilience.ts, which holds every decision and is unit-tested
// transition by transition.
//
// The split is the same one main/overlay.ts has against overlayVisibility.ts,
// and main/hotkey.ts against hookWatchdog.ts, for the same reason: powerMonitor
// only exists inside a live Electron process, so nothing decidable may live in
// this file. What is here is four subscriptions, one clock read, and the
// ordering below.
//
// ORDER MATTERS, and it is the only real logic in this file: a hold is torn
// down BEFORE the key state is dropped and before the hook is rebuilt. Both of
// those clear the combo matcher (see HotkeyAdapter.arm), so running either one
// first would erase the app's memory of the press while the renderer was still
// holding a live microphone and the overlay was still pinned open - a hot mic
// with nothing left to close it. Same failure B4 fixed for a hook death,
// reached from the other end.
//
// The teardown and the drop are two calls and not one: a hold that was running
// is the rare case, a half-pressed shortcut is the common one, and only the
// second of those has to happen on EVERY transition. Collapsing them is what
// let a stale Ctrl survive a lock and start a dictation by itself.
//
// WHY POWERMONITOR AND NOT A TIMER HEURISTIC: "the wall clock jumped forward,
// we must have slept" is the classic guess, and it is wrong in both directions
// (an NTP correction is not a sleep; modern standby can wake and re-sleep
// without a visible jump). powerMonitor reports what the OS actually did.

export interface SystemWatchDeps {
  /** Is a push-to-talk hold in flight right now?
   *
   * MUST be HotkeyAdapter.holdInFlight() - the combo matcher's own verdict -
   * and never a flag the main process keeps beside it. The two disagree on a
   * path that ships: when a long recording is running, onStart refuses the
   * dictation and returns BEFORE setting main's `listening`, while the matcher
   * is capturing and the user's fingers are still on the keys. Reading the copy
   * makes a sleep during that hold clean up nothing. */
  holdInFlight(): boolean;
  /** The keyboard hook's current state (HotkeyAdapter.health().state). */
  hookState(): HookState;
  /** Throw away the combo matcher's key state (HotkeyAdapter.forgetKeys()).
   * Called on EVERY transition, hold or no hold - see SystemReaction.forgetKeys
   * for the phantom dictation this exists to stop.
   *
   * Optional ONLY as a bridge while index.ts is rewired by hand: when it is
   * absent, interruptHold() stands in, because in the wiring that exists today
   * it is the one callback that also reaches the matcher. Make it required the
   * moment index.ts supplies it - a silent fallback is a migration step, not a
   * design. */
  forgetKeys(): void;
  /** Tear down a hold that the keyboard can no longer end. Must be safe to call
   * when nothing is in flight. */
  interruptHold(): void;
  /** Rebuild the low-level keyboard hook. Never throws to the caller: the
   * adapter routes its own failure through the B4 watchdog. */
  rearmHook(): void;
  log(msg: string): void;
  /** Tests / determinism seam. */
  now?(): number;
}

type Sub = { event: string; fn: () => void };

export class SystemWatch {
  private subs: Sub[] = [];
  private lastRearmAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SystemWatchDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.subs.length) return; // idempotent: never two handlers per event
    this.subscribe("suspend", "suspend");
    this.subscribe("resume", "resume");
    // Windows reports a fast USER SWITCH as a console disconnect, not as a
    // lock, and Electron does not surface it. That gap is written down in the
    // plan (§3.6b) rather than papered over with a guess here.
    this.subscribe("lock-screen", "lock");
    this.subscribe("unlock-screen", "unlock");
  }

  stop(): void {
    for (const s of this.subs) {
      try {
        powerMonitor.removeListener(s.event as "suspend", s.fn);
      } catch {
        // Teardown at quit: an already-torn-down emitter must never keep the
        // app from exiting.
      }
    }
    this.subs = [];
  }

  /** Exposed so a live session can be driven from the Diagnostics side later,
   * and so the ordering above is one named method rather than four closures. */
  handle(transition: SystemTransition): void {
    const ctx: SystemContext = {
      holdInFlight: this.deps.holdInFlight(),
      hookState: this.deps.hookState(),
      msSinceLastRearm: this.lastRearmAt === null ? null : this.now() - this.lastRearmAt,
    };
    const reaction = reactToSystemTransition(transition, ctx);
    this.deps.log(reaction.logLine);
    if (reaction.interruptHold) this.deps.interruptHold();
    if (reaction.forgetKeys) this.forgetKeys(reaction.interruptHold);
    if (reaction.rearmHook) {
      this.lastRearmAt = this.now();
      this.deps.rearmHook();
    }
  }

  /** Drop the matcher's key state, whichever wiring this instance was built
   * with. `alreadyInterrupted` exists only so the legacy path cannot fire the
   * same callback twice for one transition. */
  private forgetKeys(alreadyInterrupted: boolean): void {
    if (this.deps.forgetKeys) {
      this.deps.forgetKeys();
      return;
    }
    if (!alreadyInterrupted) this.deps.interruptHold();
  }

  private subscribe(event: string, transition: SystemTransition): void {
    const fn = () => this.handle(transition);
    powerMonitor.on(event as "suspend", fn);
    this.subs.push({ event, fn });
  }
}
