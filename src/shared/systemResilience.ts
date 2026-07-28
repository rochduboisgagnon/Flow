// What Flow does when the MACHINE moves under it (plan V2, B9): sleep, wake,
// lock, unlock. Kept PURE (no Electron, no timers, no keyspy) for the same
// reason and with the same discipline as hookWatchdog.ts, overlayVisibility.ts
// and logQueue.ts: the adapter that subscribes to powerMonitor (main/
// systemWatch.ts) cannot exist outside a live Electron process, so every
// DECISION lives here, where a test can drive it transition by transition.
//
// WHY THIS EXISTS AT ALL - the fact that makes sleep different from every other
// outage Flow already handles. Microsoft documents, for LowLevelKeyboardProc:
//
//   "The hook procedure should process a message in less time than the data
//    entry specified in the LowLevelHooksTimeout value [...] on Windows 7 and
//    later, the hook is silently removed without being called. THERE IS NO WAY
//    FOR THE APPLICATION TO KNOW WHETHER THE HOOK IS REMOVED."
//   (learn.microsoft.com/windows/win32/winmsg/lowlevelkeyboardproc, Remarks)
//
// Read that against what B4 built. B4's watchdog watches the key server
// PROCESS: it hears a death because keyspy's child process closes. A hook that
// Windows removed leaves WinKeyServer.exe alive and perfectly healthy - and
// deaf. No close event, no exit code, nothing for the watchdog to catch, and by
// Microsoft's own words no API to ask. So B4 does NOT cover this case, and no
// amount of polishing it ever will.
//
// A resume from sleep is the moment that risk is at its highest: the whole
// process has been frozen for minutes or hours, and any hook callback that was
// in flight when the machine went down is exactly the kind of call that blows
// through a one-second budget. Since the state cannot be READ, the only honest
// move is to make it KNOWN: rebuild the hook on resume and stop guessing. That
// costs one respawn of a ~2 MB helper (~1.3 s of the shortcut being down,
// measured in B4) once per wake, against a shortcut that is otherwise dead for
// the rest of the session with every surface still reporting "armed".
//
// The same argument does NOT extend to unlock: locking switches the desktop, it
// does not unhook anything, and re-arming there would be pure churn on a
// transition that happens many times a day. See UNLOCK below.
//
// THE SECOND FACT, and the one this module first got wrong: a transition can
// also destroy the app's KEY STATE, and that is a different question from
// whether a dictation was running. The matcher tracks held keys from the events
// alone (shared/combo.ts explains why the OS cannot be asked mid-callback), so
// it is only ever as correct as the stream of events it saw. Windows switching
// to the secure desktop (lock, Ctrl+Alt+Del, a UAC prompt) or freezing the
// process (suspend) takes the key-UP with it. A combo held only PARTWAY - Ctrl
// down, Win not yet - therefore survives the transition as "Ctrl is still
// held", and the next lone Win press completes the shortcut and starts a
// dictation nobody asked for; two of them in a row arm hands-free mode, which
// keeps the microphone open with no key down at all.
//
// So every transition below forgets the key state, whether or not a capture was
// in flight (SystemReaction.forgetKeys). Losing a press the user has to make
// again is a nuisance; a microphone that opens by itself is the one failure
// this product cannot afford.
//
// AND THIS MODULE IS NOT ENOUGH FOR IT, by construction. powerMonitor reports
// what the OS chooses to report, and it says nothing about a UAC elevation
// prompt, a Ctrl+Alt+Del that the user backs out of, or some fast user
// switches - all of which switch to the secure desktop and swallow key-ups
// exactly the same way. A policy that only answers when it is told cannot close
// that door. The matcher therefore carries its own net, keyed on keyboard
// silence and on nothing the system has to volunteer (shared/combo.ts,
// dropStaleKeys) - the same stance B4's watchdog takes toward a hook Windows
// removes without a word. The two are complementary, not redundant: this one is
// immediate and certain when the signal arrives, that one needs a few seconds
// but needs no signal at all.

import type { HookState } from "./hookWatchdog";

/** The four system transitions Electron's powerMonitor reports on Windows and
 * that can affect dictation. Deliberately NOT a superset of powerMonitor's
 * events: on-ac/on-battery/speed-limit-change change nothing about the hook,
 * the microphone or the engine, and a policy that pretended to have an opinion
 * about them would be noise. */
export type SystemTransition = "suspend" | "resume" | "lock" | "unlock";

export interface SystemContext {
  /** A push-to-talk hold is in flight right now (the key went down and its UP
   * has not been seen).
   *
   * This must come from the COMBO MATCHER itself and from nothing else. Any
   * flag kept beside it in the main process is a copy, and a copy is free to
   * disagree: when a long recording is running, the adapter's onStart refuses
   * the dictation and returns without ever setting main's `listening`, while
   * the matcher is very much capturing. Read the copy and a sleep during that
   * hold cleans up nothing at all. See SystemWatchDeps.holdInFlight. */
  holdInFlight: boolean;
  /** What the keyboard hook's own watchdog (B4) currently believes. */
  hookState: HookState;
  /** Time since the last VOLUNTARY re-arm this policy asked for, or null if it
   * has never asked. Guards against a machine that reports resume several times
   * for one wake - which Windows does. */
  msSinceLastRearm: number | null;
}

export interface SystemReaction {
  /** Throw away every key the combo matcher believes is held.
   *
   * Deliberately TRUE for all four transitions, and deliberately a field of its
   * own rather than a side effect of interruptHold: the two answer different
   * questions and the narrower one used to stand in for the broader one, which
   * is exactly how the phantom dictation above got through. Interrupting a hold
   * is about a COMPLETE combo that was already capturing; forgetting the keys is
   * about EVERY key the matcher has seen go down, including the partial press
   * that never started anything. Every transition here can swallow a key-up - a
   * frozen process for suspend/resume, a desktop switch for lock/unlock - so
   * every transition invalidates that state.
   *
   * It stays an explicit field, rather than being hard-coded in the adapter,
   * because it is a decision: a test can pin it transition by transition, and a
   * future transition that genuinely cannot lose an event (a user switch, say,
   * once Electron surfaces one) can answer false without touching the adapter. */
  forgetKeys: boolean;
  /** A hold that spans this transition can never be released by the keyboard:
   * tear the capture down instead of leaving a hot microphone and a pinned
   * overlay behind a key nobody can lift. Same reasoning as B4's hook death.
   *
   * Never true without forgetKeys, and that is not a coincidence: forgetting the
   * keys under a live capture is precisely what makes the release unusable, so
   * whoever forgets must also close what the release can no longer close. */
  interruptHold: boolean;
  /** Rebuild the low-level keyboard hook (see the module note). */
  rearmHook: boolean;
  /** One line for flow.log. A transition that changes nothing still says so:
   * "nothing happened at 03:12" is the fact that lets a support read rule sleep
   * out, instead of leaving it as the eternal suspect. */
  logLine: string;
}

/** Two resume events for one wake is normal on Windows (a modern-standby exit
 * can report several). One respawn per wake is the intent; a burst of them
 * would be the crash loop B4's guard exists to prevent, arriving by another
 * door. Thirty seconds is far longer than any burst and far shorter than the
 * gap between two genuine wakes. */
export const MIN_VOLUNTARY_REARM_INTERVAL_MS = 30_000;

/** True when a voluntary re-arm is safe to ask for right now.
 *
 * Only "armed" qualifies, and each exclusion is a real bug avoided rather than
 * caution for its own sake:
 *   - "starting"   : an arm() is already in flight; a second one racing it is
 *                    precisely how two live listeners (two swallow verdicts for
 *                    one keypress) happen - the invariant HotkeyAdapter defends.
 *   - "restarting" : the B4 watchdog owns a scheduled retry with its own
 *                    backoff. Jumping the queue would both double the listeners
 *                    and defeat the backoff.
 *   - "abandoned"  : terminal BY DESIGN (the crash-loop guard gave up). A
 *                    resume must not quietly resurrect what three consecutive
 *                    failures already ruled out; the user is told to restart
 *                    Flow, and that message must stay true.
 *   - "stopped"    : Flow is quitting.
 */
function mayRearm(ctx: SystemContext): boolean {
  if (ctx.hookState !== "armed") return false;
  return ctx.msSinceLastRearm === null || ctx.msSinceLastRearm >= MIN_VOLUNTARY_REARM_INTERVAL_MS;
}

/** Appended to every line, because the key state is dropped on every
 * transition. Written once so four lines cannot drift apart, and worded as the
 * consequence rather than the mechanism: "Flow started recording by itself" is
 * the report this sentence has to answer, months later, in a log. */
const FORGET_CLAUSE =
  "; every key believed held was forgotten - a release lost to a frozen process or to the secure desktop " +
  "would otherwise complete the shortcut on its own";

/** The whole policy, as one pure function. */
export function reactToSystemTransition(transition: SystemTransition, ctx: SystemContext): SystemReaction {
  switch (transition) {
    case "suspend":
      // The machine is going down. Any key-up owed to us - the one that ends a
      // hold, or the one that ends a half-pressed shortcut - will be delivered
      // to a frozen process, or not at all.
      return {
        forgetKeys: true,
        interruptHold: ctx.holdInFlight,
        rearmHook: false,
        logLine:
          (ctx.holdInFlight
            ? "[system] the machine is suspending during a dictation; the capture was ended rather than left holding the microphone"
            : "[system] the machine is suspending") + FORGET_CLAUSE,
      };

    case "resume":
      return {
        forgetKeys: true,
        interruptHold: ctx.holdInFlight,
        rearmHook: mayRearm(ctx),
        logLine: rearmLine(ctx) + FORGET_CLAUSE,
      };

    case "lock":
      // Locking switches to the secure desktop. A global WH_KEYBOARD_LL hook is
      // per-desktop, so from here on the physical keys - including the UP that
      // would end a hold, and the UP of a shortcut held only partway - go
      // somewhere this app cannot see.
      return {
        forgetKeys: true,
        interruptHold: ctx.holdInFlight,
        rearmHook: false,
        logLine:
          (ctx.holdInFlight
            ? "[system] the session was locked during a dictation; the capture was ended (the key release happens on the secure desktop and never reaches Flow)"
            : "[system] the session was locked") + FORGET_CLAUSE,
      };

    case "unlock":
      // The HOOK needs nothing, and that is a decision, not an oversight: a
      // desktop switch does not remove a hook, so the shortcut works the moment
      // the desktop comes back. Re-arming here would cost ~1.3 s of dead
      // shortcut several times a day to fix nothing.
      //
      // The KEY STATE is another matter, and it is the whole reason this branch
      // no longer returns a flat "nothing to do": everything the user pressed on
      // the other desktop happened out of our sight. Interrupting a hold stays
      // driven by the fact rather than assumed away - normally the lock already
      // ended it, but Windows does not guarantee a lock for every secure-desktop
      // trip, and forgetting the keys under a capture that is still live would
      // leave a microphone no key release can ever close.
      return {
        forgetKeys: true,
        interruptHold: ctx.holdInFlight,
        rearmHook: false,
        logLine:
          (ctx.holdInFlight
            ? "[system] the session was unlocked with a dictation still open; the capture was ended (its key release happened on the secure desktop and never reaches Flow)"
            : "[system] the session was unlocked; the keyboard shortcut was never torn down and needs nothing") +
          FORGET_CLAUSE,
      };
  }
}

function rearmLine(ctx: SystemContext): string {
  if (mayRearm(ctx)) {
    return (
      "[system] the machine resumed from sleep; rebuilding the keyboard hook - Windows removes a low-level " +
      "hook that timed out without telling the application, and a frozen process is exactly when that happens"
    );
  }
  if (ctx.hookState === "abandoned") {
    return "[system] the machine resumed from sleep; the keyboard shortcut is already off (Flow stopped restarting it) - restart Flow";
  }
  if (ctx.hookState === "restarting" || ctx.hookState === "starting") {
    return `[system] the machine resumed from sleep; the keyboard hook is already ${ctx.hookState}, leaving its own watchdog to finish`;
  }
  if (ctx.hookState === "stopped") {
    return "[system] the machine resumed from sleep while Flow was shutting down; nothing to rebuild";
  }
  return "[system] the machine resumed from sleep; the keyboard hook was rebuilt moments ago, not rebuilding it again";
}
