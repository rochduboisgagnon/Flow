// Default push-to-talk shortcut: Ctrl + Win (both sides accepted), the combo
// chosen by design (plan 5.8). A modifiers-only combination - which is exactly
// why the hotkey path is a low-level monitor (keyspy) with our own matcher
// (src/shared/combo.ts) instead of any OS hotkey registration API.
/**
 * LE RACCOURCI PAR DEFAUT, PAR PLATEFORME (2026-08-04, decision de Roch).
 *
 * Windows : Ctrl+Shift. macOS : Fn+Shift.
 *
 * ---------------------------------------------------------------------------
 * CTRL+SHIFT A DEUX COUTS SUR WINDOWS, MESURES ET SIGNALES AVANT D'ETRE ACCEPTES
 * ---------------------------------------------------------------------------
 *
 * Roch a tranche en connaissance de cause, apres que les deux lui ont ete dits.
 * Ils sont ecrits ici pour que personne ne les redecouvre comme des bogues :
 *
 *  1. WINDOWS S'EN SERT DEJA. « Changer de disposition du clavier » vaut
 *     Ctrl+Shift par defaut. Mesure sur la machine de Roch le 2026-08-04 : quatre
 *     langues installees (en-US, en-CA, fr-FR, fr-CA) et les trois clefs de
 *     bascule de `HKCU\Keyboard Layout\Toggle` NON DEFINIES, donc les defauts
 *     de Windows s'appliquent. Le remede est cote Windows, pas cote Flow :
 *     Parametres > Clavier avance > touches d'acces rapide > Non attribue.
 *  2. C'EST UN PREFIXE DE RACCOURCI TRES REPANDU (Ctrl+Shift+T, Ctrl+Shift+N,
 *     Ctrl+Shift+Esc). Chacun ouvre une capture que la regle de touche etrangere
 *     annule ensuite - le raccourci de l'application fonctionne donc toujours -
 *     mais on entend le signal de depart et le silence tombe une fraction de
 *     seconde. Ctrl+Win n'avait pas ce cout, Win n'etant presque jamais un
 *     prefixe d'application. Le raisonnement de `preArmed()` dans ce meme dossier
 *     nommait deja Ctrl+Shift comme « l'un des prefixes les plus repandus qui
 *     existent ».
 *
 * ---------------------------------------------------------------------------
 * SHIFT N'EST PAS AVALEE, ET C'EST UNE DECISION
 * ---------------------------------------------------------------------------
 *
 * Seule la touche WIN est avalee quand elle complete le combo (le piege du menu
 * Demarrer, voir le bandeau de combo.ts). Avaler Shift ferait arriver Ctrl+T dans
 * l'application a la place de Ctrl+Shift+T : Flow casserait les raccourcis qu'il
 * ne fait que cotoyer. Et Shift n'ouvre aucun menu, donc il n'y a rien a cacher.
 *
 * ---------------------------------------------------------------------------
 * FN SUR MACOS : UNE INCONNUE ASSUMEE
 * ---------------------------------------------------------------------------
 *
 * Fn n'est pas une touche ordinaire : macOS la rapporte comme un changement de
 * drapeaux plutot que comme une frappe, et rien ne garantit que le serveur de
 * touches de keyspy la fasse remonter. Ca ne peut pas se verifier depuis une
 * machine Windows ; le premier lancement sur le MacBook repondra. Le raccourci est
 * changeable dans les reglages, donc une Fn muette coute un reglage, pas une
 * fonctionnalite.
 *
 * ---------------------------------------------------------------------------
 * CE DEFAUT NE CHANGE PAS UN RACCOURCI DEJA CHOISI
 * ---------------------------------------------------------------------------
 *
 * Il ne s'applique qu'a un compte qui n'en a jamais enregistre. Reecrire le
 * raccourci de quelqu'un parce que le defaut a change serait exactement le genre
 * de decision silencieuse que ce depot refuse : Roch devra donc l'enregistrer une
 * fois dans les reglages sur sa machine, et c'est dit dans les notes de version.
 */
export function defaultComboFor(platform: string): string[] {
  return platform === "darwin" ? ["FN", "SHIFT"] : ["CTRL", "SHIFT"];
}

/** Le defaut de CETTE machine. Garde comme constante parce que la plupart des
 * appelants n'ont aucune raison de connaitre la notion de plateforme. */
export const DEFAULT_COMBO = defaultComboFor(process.platform);

// A press shorter than this is treated as an accidental tap and cancelled:
// no capture reaches the ASR, nothing is inserted.
export const MIN_HOLD_MS = 200;

// How long a hold has to have lasted before a stray key STOPS the dictation
// (delivering what was said) instead of CANCELLING it (throwing it away).
//
// 2026-07-30, from a human report: "sometimes the transcript stops in the
// middle without me releasing the shortcut, so I don't get to finish."
//
// The cause was one line: ANY keydown outside the combo cancelled a capture in
// progress. The intent behind it is real - Ctrl+Win then Arrow is a virtual
// desktop switch, not dictation - but the rule ignored the one thing that tells
// the two apart. Somebody invoking a shortcut presses the third key almost
// immediately; somebody dictating has been speaking for seconds. A stray key at
// second nine is not the start of a shortcut.
//
// So the response is split by WHEN it arrives, and the asymmetry is on purpose:
// early, the capture is cancelled (a shortcut must not insert text); late, it is
// stopped and what was already said is delivered. Cancelling late is the only
// version that destroys work the user cannot get back, and that is the outcome
// worth eliminating - the same reasoning as the pre-roll and the partial import.
export const STRAY_KEY_STOPS_AFTER_MS = 1_500;

// Two quick taps of the shortcut within this window toggle hands-free capture
// (plan 5.8): dictate without holding the keys. 2026-08-04 : SORTIR n'en demande
// plus qu'une seule (voir le bandeau de shared/combo.ts) ; cette fenetre ne sert
// donc plus qu'a ENTRER dans le mode.
export const DOUBLE_TAP_MS = 400;

// THE single source of truth for the titlebar's height. U1 feeds this (in DIP)
// to BrowserWindow's titleBarOverlay so Windows' native caption buttons are
// drawn at this height, while main.css reads the SAME number as --titlebar-h
// to size its own custom titlebar row. If the two ever diverge, the native
// buttons float above or below the custom row instead of sitting flush in it.
export const TITLEBAR_H = 40;
