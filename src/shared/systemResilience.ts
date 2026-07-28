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

import type { HookState } from "./hookWatchdog";

/** The four system transitions Electron's powerMonitor reports on Windows and
 * that can affect dictation. Deliberately NOT a superset of powerMonitor's
 * events: on-ac/on-battery/speed-limit-change change nothing about the hook,
 * the microphone or the engine, and a policy that pretended to have an opinion
 * about them would be noise. */
export type SystemTransition = "suspend" | "resume" | "lock" | "unlock";

export interface SystemContext {
  /** A push-to-talk hold is in flight right now (the key went down and its UP
   * has not been seen). */
  holdInFlight: boolean;
  /** What the keyboard hook's own watchdog (B4) currently believes. */
  hookState: HookState;
  /** Time since the last VOLUNTARY re-arm this policy asked for, or null if it
   * has never asked. Guards against a machine that reports resume several times
   * for one wake - which Windows does. */
  msSinceLastRearm: number | null;
}

export interface SystemReaction {
  /** A hold that spans this transition can never be released by the keyboard:
   * tear the capture down instead of leaving a hot microphone and a pinned
   * overlay behind a key nobody can lift. Same reasoning as B4's hook death. */
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

/** The whole policy, as one pure function. */
export function reactToSystemTransition(transition: SystemTransition, ctx: SystemContext): SystemReaction {
  switch (transition) {
    case "suspend":
      // The machine is going down mid-hold. The UP event will be delivered to a
      // frozen process, or not at all.
      return {
        interruptHold: ctx.holdInFlight,
        rearmHook: false,
        logLine: ctx.holdInFlight
          ? "[system] the machine is suspending during a dictation; the capture was ended rather than left holding the microphone"
          : "[system] the machine is suspending",
      };

    case "resume":
      return {
        interruptHold: ctx.holdInFlight,
        rearmHook: mayRearm(ctx),
        logLine: rearmLine(ctx),
      };

    case "lock":
      // Locking switches to the secure desktop. A global WH_KEYBOARD_LL hook is
      // per-desktop, so from here on the physical keys - including the UP that
      // would end a hold - go somewhere this app cannot see.
      return {
        interruptHold: ctx.holdInFlight,
        rearmHook: false,
        logLine: ctx.holdInFlight
          ? "[system] the session was locked during a dictation; the capture was ended (the key release happens on the secure desktop and never reaches Flow)"
          : "[system] the session was locked",
      };

    case "unlock":
      // Nothing to do, and that is a decision, not an oversight: a desktop
      // switch does not remove a hook, so the shortcut works the moment the
      // desktop comes back. Re-arming here would cost ~1.3 s of dead shortcut
      // several times a day to fix nothing.
      return {
        interruptHold: false,
        rearmHook: false,
        logLine: "[system] the session was unlocked; the keyboard shortcut was never torn down and needs nothing",
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
