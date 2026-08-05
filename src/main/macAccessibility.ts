import { systemPreferences } from "electron";
import { accessibilityPaneUrl, type AccessibilityVerdict } from "../shared/accessibility";

// ---------------------------------------------------------------------------
// 2026-08-04 : L'UNIQUE ENDROIT DU DEPOT QUI POSE LA QUESTION A macOS.
//
// Meme regle que « CAPS est lu une fois » dans index.ts : un fait de plateforme
// consulte a deux endroits finit par etre consulte differemment. Un test
// (test/accessibility.test.ts, A11Y-7) verifie qu'il n'y a bien qu'un seul
// appelant dans tout src/.
//
// LA GARDE DE PLATEFORME N'EST PAS DE LA PRUDENCE : systemPreferences
// .isTrustedAccessibilityClient existe dans le TYPAGE d'Electron sur les trois
// plateformes, mais son implementation est macOS seulement. Un appel sur Windows
// n'est pas un `false` : c'est une exception, sur un chemin qui est appele depuis
// une verification de sante.
//
// ---------------------------------------------------------------------------
// POURQUOI `prompt: false`
// ---------------------------------------------------------------------------
//
// La methode enrobe AXIsProcessTrustedWithOptions. Avec `true`, macOS affiche SON
// dialogue (« Flow souhaite controler cet ordinateur... ») et inscrit l'app,
// decochee, dans la liste. C'est un effet de bord appartenant au systeme, a un
// instant que nous n'avons pas choisi - et cette sonde tourne toutes les dix
// secondes tant que la permission manque.
//
// Une sonde ne doit rien faire. Le dialogue, quand il est justifie, est un bouton
// que quelqu'un clique ; et meme la on fait mieux que le dialogue systeme, qui ne
// mene nulle part : on ouvre directement le bon panneau (uiBridge.ts,
// ACCESSIBILITY_PANE_URL).
// ---------------------------------------------------------------------------

/** Le panneau a ouvrir, resolu UNE fois, ou null hors macOS.
 *
 * Il vit ici et non dans uiBridge.ts pour deux raisons qui n'en font qu'une : ce
 * module est deja le seul du depot qui a le droit de lire la plateforme pour cette
 * question, et un canari (test/long-ipc-parity.test.ts) interdit tout
 * `process.platform` dans uiBridge.ts - un fait de plateforme ecrit sur place est
 * un fait qu'aucun test ne voit. La chaine elle-meme est dans la fonction pure
 * accessibilityPaneUrl, avec la mesure qui reste a faire sur le Mac. */
export const ACCESSIBILITY_PANE_URL: string | null = accessibilityPaneUrl(process.platform);

export function probeAccessibility(): AccessibilityVerdict {
  if (process.platform !== "darwin") return "unknown";
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "missing";
  } catch {
    // Jamais une exception sur le chemin d'un getUiState() ni d'un self-check.
    // « unknown » est honnete : la question n'a pas pu etre posee.
    return "unknown";
  }
}
