// The one-time "start with Windows" registration, as a pure decision.
//
// Roch 2026-07-27: Flow registers itself at login on FIRST RUN, because a
// dictation daemon that is not running dictates nothing. It is registered
// exactly ONCE, gated by a persisted flag, so a user who turns the toggle off
// is never overridden at the next boot.
//
// U2c (review finding): a dev checkout and the packaged app share the SAME
// ~/.flow/settings.json. Recording the flag from a `npm run dev` boot therefore
// burns the packaged app's only chance to register itself - one dev run and the
// installed Flow never starts with Windows, forever. So an unpackaged build
// decides NOTHING here: it neither registers nor writes.
//
// Kept pure (no electron, no fs) so both branches are unit-testable.

export interface LaunchAtLoginInputs {
  /** settings.loginItemInitialized: the one-time registration already happened. */
  alreadyInitialized: boolean;
  /** app.isPackaged: false for a dev checkout running from source. */
  packaged: boolean;
}

export interface LaunchAtLoginDecision {
  /** Call app.setLoginItemSettings({ openAtLogin: true, ... }). */
  register: boolean;
  /** Persist loginItemInitialized: true (only ever alongside a registration). */
  recordFlag: boolean;
}

export function decideLaunchAtLogin(i: LaunchAtLoginInputs): LaunchAtLoginDecision {
  if (i.alreadyInitialized) return { register: false, recordFlag: false };
  if (!i.packaged) return { register: false, recordFlag: false };
  return { register: true, recordFlag: true };
}
