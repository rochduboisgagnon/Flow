import type { HookHealth } from "./hookWatchdog";

// ---------------------------------------------------------------------------
// 2026-08-04 : CE QUI EMPECHE LA DICTEE, QUAND CE N'EST PAS LE CROCHET.
//
// ---------------------------------------------------------------------------
// LA PANNE QUE RIEN NE VOYAIT
// ---------------------------------------------------------------------------
//
// Sur macOS, un processus qui n'est pas dans la liste des clients d'accessibilite
// approuves peut lancer MacKeyServer AVEC SUCCES et ne jamais recevoir un seul
// evenement clavier. Le systeme ne refuse pas : il ne livre rien.
//
// Consequence exacte, et c'est ce qui rend cette panne pire que les autres :
//   - hotkey.health() rend « armed »
//   - hookStatusLine() rend null
//   - le HookWatchdog n'a aucune mort a compter, donc rien a redemarrer
//   - selfCheck affiche une ligne VERTE sur le crochet clavier
//   - et le raccourci ne repond jamais.
//
// C'est la definition du mode de panne que ce depot chasse partout ailleurs : un
// controle vert au-dessus de quelque chose qui ne marche pas. Roch, apres le
// premier lancement sur son MacBook le 2026-08-04 : « le premier run a eu de la
// misere avec le keybinding de FN Shift, mais je l'ai rallume et ca a fonctionne. »
// Un redemarrage a masque le symptome et personne n'a su pourquoi.
//
// ---------------------------------------------------------------------------
// ET POURQUOI CA VA REVENIR A CHAQUE VERSION
// ---------------------------------------------------------------------------
//
// macOS attache l'autorisation Accessibilite a la SIGNATURE de l'application
// (TCC). Flow est signe ad-hoc : decision de Roch, aucun certificat ne sera
// achete, et un auto-signe n'apporte rien. Or une signature ad-hoc est un cdhash,
// c'est-a-dire une empreinte du code, donc elle change a chaque build. Chaque mise
// a jour est une NOUVELLE application aux yeux du systeme, et l'autorisation est a
// redonner.
//
// Roch a tranche ce que Flow doit faire dans ce cas : « prevenir et guider ». Pas
// de tentative de restauration silencieuse (impossible), pas d'echec muet.
//
// ---------------------------------------------------------------------------
// POURQUOI CE FICHIER EST PUR
// ---------------------------------------------------------------------------
//
// Meme raison que hookStatusLine juste a cote : engineStatus() dans index.ts, la
// carte de la page Home et selfCheck doivent donner la MEME reponse, et trois
// copies d'un « si la permission manque, alors » divergeraient. La question est
// posee au systeme a un seul endroit (src/main/macAccessibility.ts) ; ici on ne
// fait qu'interpreter la reponse.
// ---------------------------------------------------------------------------

/** Ce que macOS repond, plus le cas ou la question ne se pose pas.
 *
 * « unknown » n'est PAS un synonyme prudent de « missing » : c'est la reponse sur
 * Windows, ou il n'y a aucune permission a accorder. La confondre avec un refus
 * afficherait un message sur les Reglages Systeme a quelqu'un qui n'en a pas. */
export type AccessibilityVerdict = "unknown" | "granted" | "missing";

/** Ce qui empeche la dictee EN CE MOMENT, en une seule reponse.
 *
 * Deux causes possibles, et elles sont ORDONNEES et non exclusives : sur macOS,
 * une permission absente est ce qui fait mourir le serveur de touches, donc la
 * panne du crochet en est la consequence. Afficher « redemarrez Flow » quand
 * c'est le systeme qui refuse envoie l'utilisateur redemarrer en boucle. */
export type DictationBlocker = "none" | "accessibility" | "hook";

export function dictationBlocker(hook: HookHealth, access: AccessibilityVerdict): DictationBlocker {
  // La permission gagne quel que soit l'etat du crochet, y compris « armed » :
  // c'est exactement le cas silencieux, celui ou le crochet a l'air parfait.
  if (access === "missing") return "accessibility";
  if (hook.state === "abandoned" || hook.state === "restarting") return "hook";
  return "none";
}

/** La ligne de statut d'une permission ABSENTE, ou null quand il n'y a rien a
 * ajouter. Courte : elle alimente l'infobulle du tray. */
export function accessibilityStatusLine(access: AccessibilityVerdict): string | null {
  if (access !== "missing") return null;
  return "dictation blocked - grant Accessibility to Flow";
}

/** Le POURQUOI, pour la carte de la page Home et le rapport de self-check.
 *
 * Ce texte compte autant que la detection : Roch va le rencontrer apres chaque
 * mise a jour, et sans la cause il se lira comme une regression de Flow plutot
 * que comme une regle de macOS. */
export const ACCESSIBILITY_WHY =
  "macOS ties this permission to the application's exact signature. Flow's signature changes with every version, " +
  "so macOS treats a freshly updated Flow as a different application and the permission has to be given again. " +
  "Open the Accessibility list, and switch Flow back on.";

/** Le panneau des Reglages Systeme ou l'autorisation se redonne, ou null quand
 * cette plateforme n'a pas de tel panneau.
 *
 * PURE et prend la plateforme en argument, comme capabilitiesFor et
 * updateChannelFor : c'est ce qui permet de tester les deux reponses depuis
 * Windows, et surtout de garder uiBridge.ts sans aucun `process.platform` - un
 * canari de test/long-ipc-parity.test.ts l'interdit dans ce fichier, parce qu'un
 * fait de plateforme ecrit sur place est un fait qu'aucun test ne voit.
 *
 * 2026-08-04 : A VERIFIER SUR LE MAC AVANT DE CONSIDERER LA CHAINE ACQUISE. Cet
 * identifiant fonctionne de 10.13 a aujourd'hui, mais la reecriture des Reglages
 * Systeme de Ventura a deplace plusieurs panneaux. Si `open "<url>"` atterrit en
 * haut de « Confidentialite et securite » plutot que sur Accessibilite,
 * l'alternative a essayer est
 * `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility`.
 * Puis epingler ici la chaine retenue, avec la date et la version de macOS. */
export function accessibilityPaneUrl(platform: string): string | null {
  if (platform !== "darwin") return null;
  return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
}

/** Ce que dit le rapport de self-check. Une seule ligne pour cette panne, jamais
 * deux : deux lignes sur la meme cause est la facon dont un rapport devient du
 * bruit qu'on arrete de lire. */
export const ACCESSIBILITY_FIX =
  "Open System Settings > Privacy & Security > Accessibility and switch Flow on. " +
  "Restarting Flow does not help: the system, not Flow, is refusing.";
