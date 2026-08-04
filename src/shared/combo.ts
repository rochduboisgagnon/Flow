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
//   toggle (plan 5.8): capture keeps running after the second tap's release.
// - LEAVING hands-free takes ONE press, not a second double-tap (2026-08-04, at
//   Roch's request: « j'aime ca, mais ca s'annule quand la personne clique une
//   fois sur le raccourci »). Entering is a deliberate gesture and deserves a
//   deliberate one; LEAVING is what you do when you have finished speaking, and
//   asking for two taps there made people double-tap, wait, and check whether it
//   had worked. One press stops the capture and DELIVERS what was said - never
//   discards it, whatever the press lasted.
// - While holding to talk, a keydown OUTSIDE the combo ends the capture - but
//   HOW depends on when it arrives. Within STRAY_KEY_STOPS_AFTER_MS it is
//   cancelled (the user is invoking an OS shortcut like Ctrl+Win+arrow, and
//   that must not insert text); after it, the capture is STOPPED and what was
//   already said is delivered, because by then the user was dictating and
//   discarding their words is the only unrecoverable outcome. In toggle mode
//   other keys are ignored entirely - being hands-free is the point.
//   ONE consequence of the one-press rule above had to be kept: Ctrl+Win+Arrow
//   switches virtual desktops, and its Ctrl+Win half is Flow's shortcut. Seen
//   from the release alone it is indistinguishable from "stop", so the matcher
//   remembers whether a key outside the combo was pressed during the hold and
//   refuses to read that press as a stop. Without it, changing desktop during a
//   hands-free dictation would end it and paste the text into whatever window
//   the switch landed on.
// - THE STALE-HOLD NET (see dropStaleKeys): key state is only as good as the
//   events that built it, and Windows can take events away without telling
//   anyone. shared/systemResilience.ts covers the transitions Electron reports
//   (sleep, wake, lock, unlock); it cannot cover a UAC prompt, a Ctrl+Alt+Del
//   that does not end in a lock, or some fast user switches, because
//   powerMonitor never mentions them. Those still switch to the secure desktop
//   and still swallow the key-up of anything held, so a half-pressed shortcut
//   can survive as "Ctrl is down" and let the next lone Win press start a
//   dictation nobody asked for. The net closes that door from inside the hook,
//   depending on no notification at all - the same stance as B4's watchdog.

import { STRAY_KEY_STOPS_AFTER_MS } from "./constants";

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
  /** B2: is the shortcut ALMOST pressed - a good moment to warm the microphone?
   * Currently always false: see preArmed() below for why no rule over a combo
   * that holds at most one non-modifier can answer yes without answering yes to
   * Ctrl+Shift. The seam is kept so the answer can change in one place. */
  preArmed(): boolean;
  setCombo(combo: string[]): void;
  reset(): void;
}

/** How long a key we believe is held may stay COMPLETELY silent before that
 * belief is thrown away. See dropStaleKeys() for the whole argument; the number
 * itself comes from Windows' typematic repeat, not from taste:
 *
 * a key that is really down auto-repeats, and the slowest repeat Windows can be
 * configured for is a 1000 ms initial delay followed by roughly two repeats a
 * second. So the longest gap a genuinely held key can produce is about one
 * second. Three seconds is three times that worst case - wide enough that no
 * repeat setting, and no hiccup on a busy machine, can look like silence - and
 * still short enough that a trip to the secure desktop (a UAC prompt to read
 * and answer, a Ctrl+Alt+Del screen, a user switch) is over the line long
 * before the user comes back and presses anything.
 *
 * It cannot be derived from MIN_HOLD_MS or DOUBLE_TAP_MS: those bound how SHORT
 * a press may be, and say nothing about how long a hand may rest on a key. */
export const STALE_HOLD_MS = 3_000;

export function createComboMatcher(
  initialCombo: string[],
  opts?: {
    minHoldMs?: number;
    doubleTapMs?: number;
    staleHoldMs?: number;
    strayKeyStopsAfterMs?: number;
    /** Called when the net drops keys, with their physical names. Kept as a
     * callback rather than a log line because this file is pure - and because
     * the caller runs inside the hook callback Windows is timing, so it is the
     * caller's job to get the writing off that thread. */
    onStaleDrop?(keys: string[]): void;
  },
): ComboMatcher {
  const minHoldMs = opts?.minHoldMs ?? 200;
  const doubleTapMs = opts?.doubleTapMs ?? 400;
  const staleHoldMs = opts?.staleHoldMs ?? STALE_HOLD_MS;
  const strayKeyStopsAfterMs = opts?.strayKeyStopsAfterMs ?? STRAY_KEY_STOPS_AFTER_MS;

  let combo = [...initialCombo];
  const down = new Set<string>(); // physical keys currently held (event-tracked)
  const swallowed = new Set<string>(); // WIN keys whose DOWN we blocked
  const lastSeen = new Map<string, number>(); // per held key: when we last heard from IT
  /** Physical keys this session has actually WATCHED auto-repeat. The net only
   * distrusts a key that is in here, so it never rests on an assumption about
   * the machine it is running on - see dropStaleKeys(). Survives reset() on
   * purpose: it is a fact about the keyboard, not about the current press. */
  const repeaters = new Set<string>();
  let pressedAt: number | null = null; // combo fully down since (null = not pressed)
  let capturing = false;
  let toggledOn = false;
  let lastTapUpAt: number | null = null; // end of the previous quick tap

  function comboFullyDown(): boolean {
    return combo.every((entry) => [...down].some((k) => satisfies(entry, k)));
  }

  /**
   * B2: "open the microphone on the FIRST key of the combo" - the plan's idea,
   * examined, narrowed, and finally TURNED OFF. It always answers false.
   *
   * The plan proposes treating a lone Ctrl as probable intent to dictate. It is
   * not. Ctrl is the most-pressed key on the keyboard: copy, paste, save, undo,
   * every browser tab shortcut. On the DEFAULT shortcut (Ctrl+Win) that rule
   * would open the microphone dozens to hundreds of times a day, for keystrokes
   * that have nothing to do with speaking - and each one lights Windows'
   * microphone indicator. Trading the user's trust for a few milliseconds is a
   * bad trade in a product whose one differentiator is that it does not listen.
   *
   * The first narrowing was "every key but one is held, and at least two keys of
   * evidence" - i.e. three-key shortcuts only. It reads as safe and is not, for
   * a reason that lives one function up: normalizeCombo keeps AT MOST ONE
   * non-modifier. So a three-key shortcut is always MOD+MOD+key (or three bare
   * modifiers), "every key but one" is satisfied by the two modifiers alone, and
   * Ctrl+Shift or Ctrl+Alt - two of the most common shortcut prefixes in
   * existence - open the microphone. That is the very argument made against a
   * lone Ctrl, arriving one key later.
   *
   * The candidate replacement was to demand the shortcut's NON-MODIFIER key,
   * the only key in a combo that carries intent by itself. It is safe, and it is
   * also unreachable: people press modifiers first and the main key last, so on
   * Ctrl+Shift+F9 the "one key away" position is {Ctrl, Shift}, never {Ctrl, F9}
   * - and a three-modifier shortcut has no such key at all. The rule would fire
   * essentially never while still costing a scan inside the hook callback
   * Windows is timing, and would leave the docs claiming a feature nobody can
   * trigger.
   *
   * There is no third candidate: with at most one non-modifier available, any
   * rule that fires before the last key necessarily fires on modifiers alone,
   * and modifiers alone are not an intention to dictate. So pre-arming is off,
   * and the two mechanisms that already cover the cost stay: the microphone is
   * warmed once at startup, and it stays warm for a window after each dictation
   * (shared/micWarmth.ts) - which covers the case that actually matters,
   * dictating several times in a row.
   *
   * Kept as a function rather than deleted so the wiring behind it stays intact
   * (the adapter's rising-edge detector, the onPreArm callback, the renderer's
   * warm policy). Re-enabling is a change to this one body - for instance if
   * combos ever allow more than one non-modifier, which is the only change that
   * would make a partial press mean something on its own.
   */
  function preArmed(): boolean {
    return false;
  }

  function isComboKey(key: string): boolean {
    return combo.some((entry) => satisfies(entry, key));
  }

  /** Has THIS key produced an event of its own recently? */
  function fresh(key: string, now: number): boolean {
    const at = lastSeen.get(key);
    return at !== undefined && now - at < staleHoldMs;
  }

  /**
   * THE STALE-HOLD NET. Throws away keys we believe are held but that have gone
   * silent, so a key-up lost to a desktop this app cannot see (a UAC prompt, a
   * Ctrl+Alt+Del that does not end in a lock, a fast user switch - none of which
   * powerMonitor reports) cannot survive to complete the shortcut on its own.
   *
   * Three narrowings, and each one is a false positive refused rather than
   * caution for its own sake. A false positive here costs a press the user has
   * to make again; the wrong version of this net would cost a dictation cut in
   * half, which is not a trade this product may make.
   *
   * 1. NEVER while capturing. A live hold is the one state where being wrong is
   *    unaffordable, so the net simply does not look at it. Note what this
   *    buys for free: hands-free mode holds NO key at all (the user double-
   *    tapped and let go), so a thirty-second hands-free dictation is out of
   *    this function's reach twice over - by `capturing`, and by `down` being
   *    empty. The push-to-talk hold that IS long and silent keeps running, and
   *    its own key-up still ends it normally.
   * 2. Only keys this session has WATCHED auto-repeat. "Silence means the key
   *    is up" is only true where held keys repeat. Rather than assume Windows
   *    typematic reaches the low-level hook on every keyboard, RDP session or
   *    virtual device, the net waits until it has seen that key repeat with its
   *    own eyes. On a keyboard that never repeats, it stays off and Flow is
   *    exactly as it is today - never worse.
   * 3. PER KEY, never on global keyboard traffic. Deliberate, and the opposite
   *    of the obvious choice: if any keystroke anywhere refreshed the clock, a
   *    user who comes back from a UAC prompt and writes an email would keep a
   *    stale Ctrl alive for as long as they type - which is precisely the
   *    window the phantom fires in. A key that is really down speaks for
   *    itself; nothing else can speak for it.
   *
   * The known cost of (3): Windows typematic follows the LAST key pressed, so a
   * modifier genuinely held while the user types other keys goes quiet and can
   * be dropped. The bill is one shortcut press that does nothing (and, for a
   * Win-key combo, a Start menu) - paid by the rare hand that holds Ctrl through
   * several seconds of typing and then reaches for the shortcut without letting
   * go. Set against a microphone that opens by itself, that is the right side to
   * be wrong on.
   */
  function dropStaleKeys(now: number): void {
    if (capturing || down.size === 0) return; // (1), and the common case, in one line
    const dropped: string[] = [];
    for (const key of [...down]) {
      if (fresh(key, now) || !repeaters.has(key)) continue; // (3), then (2)
      down.delete(key);
      lastSeen.delete(key);
      // The swallow bookkeeping goes with it. Keeping it would be the worse
      // failure of the two the Start-menu trap balances: this key's next REAL
      // press would go through to the OS and its release would be swallowed,
      // leaving Windows with a modifier stuck down. Letting an orphan release
      // through can at worst open a menu; a stuck modifier breaks the machine.
      swallowed.delete(key);
      dropped.push(key);
    }
    if (dropped.length === 0) return;
    // Nothing here can be mid-press: (1) guaranteed no capture, and a combo can
    // only become fully down by starting or joining one.
    pressedAt = null;
    lastTapUpAt = null; // can only PREVENT a hands-free toggle, never invent one
    opts?.onStaleDrop?.(dropped);
  }

  function reset() {
    down.clear();
    swallowed.clear();
    lastSeen.clear();
    pressedAt = null;
    capturing = false;
    toggledOn = false;
    lastTapUpAt = null;
    strayDuringPress = false;
  }

  /** Une touche HORS du combo a-t-elle ete pressee pendant la pression en cours ?
   *
   * Sert a UNE chose : distinguer « j'ai fini de parler » de « je change de
   * bureau avec Ctrl+Win+fleche » en mode mains libres. Les deux se terminent par
   * la meme rupture de combo, et depuis le relachement seul ils sont identiques.
   * Remis a zero a chaque nouvelle pression complete. */
  let strayDuringPress = false;

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
      strayDuringPress = false; // une pression neuve se juge sur elle-meme
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

    if (capturing && toggledOn && !isComboKey(key) && comboFullyDown()) {
      // Mains libres, et le combo est tenu pendant qu'une autre touche arrive :
      // c'est un raccourci de l'OS, pas une demande d'arret. Le noter est ce qui
      // permet a la regle « une pression suffit » de ne pas casser
      // Ctrl+Win+fleche. Rien n'est decide ici : le capture continue.
      strayDuringPress = true;
      return { action: "none", swallow: false };
    }

    if (capturing && !toggledOn && !isComboKey(key)) {
      // A key outside the combo, while holding to talk. Two very different
      // things look identical here, and WHEN it arrives is what tells them
      // apart (see STRAY_KEY_STOPS_AFTER_MS for the human report behind this).
      //
      // Early: the user is invoking an OS shortcut - Ctrl+Win+Arrow switches
      // virtual desktops - and inserting a dictation into that would be wrong.
      // Cancel, nothing reaches the engine.
      //
      // Late: the user has been SPEAKING for seconds. Whatever that keystroke
      // was - a stray press, another application, a media key - it is not the
      // start of a shortcut, and throwing away what was already said is the one
      // outcome they cannot undo. Stop, and deliver it.
      const heldMs = pressedAt === null ? 0 : now - pressedAt;
      capturing = false;
      pressedAt = null;
      lastTapUpAt = null;
      if (heldMs >= strayKeyStopsAfterMs) return { action: "stop", swallow: false };
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
      // 2026-08-04 : UNE SEULE PRESSION SORT DU MODE MAINS LIBRES.
      //
      // Il en fallait deux (un nouveau double-tap). Roch : « j'aime ca, mais ca
      // s'annule quand la personne clique une fois sur le raccourci ». Entrer
      // dans le mode est un geste delibere et garde son double-tap ; en SORTIR
      // est ce qu'on fait quand on a fini de parler, et exiger deux taps a cet
      // endroit-la faisait double-taper, attendre, puis verifier si ca avait
      // marche.
      //
      // « stop » et jamais « cancel », quelle que soit la duree de la pression :
      // ce qui a ete dit est livre. Jeter les mots de quelqu'un est le seul
      // resultat qu'il ne peut pas defaire, et la duree d'un appui n'est pas une
      // raison de le faire.
      if (strayDuringPress) {
        // Ctrl+Win+fleche : un raccourci de Windows, pas une fin de dictee. Voir
        // `strayDuringPress`. Le mode continue, comme avant ce changement.
        strayDuringPress = false;
        lastTapUpAt = null;
        return { action: "none", swallow };
      }
      capturing = false;
      toggledOn = false;
      lastTapUpAt = null;
      return { action: "stop", swallow };
    }
    return { action: "none", swallow };
  }

  return {
    handle(e, now) {
      if (e.state === "DOWN") {
        // A DOWN for a key we already believe is held, arriving on time, is an
        // auto-repeat: proof that this key repeats on this keyboard, which is
        // what licenses the net to read its silence later. Read BEFORE the net
        // runs, so a fresh press of a key whose release was lost - which looks
        // identical except for the gap - cannot be mistaken for evidence.
        if (down.has(e.key) && fresh(e.key, now)) repeaters.add(e.key);
        // And judged BEFORE the event is interpreted: a stale key must not be
        // allowed to complete the combo with the very keystroke that exposes it.
        dropStaleKeys(now);
        const decision = handleDown(e.key, now);
        lastSeen.set(e.key, now);
        return decision;
      }
      // Deliberately NOT on an UP. An UP is the event that legitimately ends
      // things, and it is the only one the user can be waiting on: judging
      // staleness here could only turn a long, silent, perfectly real hold into
      // a release nobody hears - the dictation cut in half this net exists to
      // avoid causing.
      const decision = handleUp(e.key, now);
      lastSeen.delete(e.key);
      return decision;
    },
    capturing: () => capturing,
    preArmed,
    setCombo(next) {
      combo = [...next];
      reset();
    },
    reset,
  };
}

