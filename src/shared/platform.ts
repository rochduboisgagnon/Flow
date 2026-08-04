// ---------------------------------------------------------------------------
// 2026-08-04 : CE QUE FLOW SAIT FAIRE, SELON LA MACHINE SUR LAQUELLE IL TOURNE.
//
// ---------------------------------------------------------------------------
// POURQUOI CE FICHIER EXISTE, ET POURQUOI MAINTENANT
// ---------------------------------------------------------------------------
//
// Roch, le 2026-08-04 : « la synchro pour les ordinateurs, il faut que tu fasses
// une version macOS parce que mon deuxieme ordinateur, c'est un MacBook. »
//
// La verification qui compte le plus du projet - un terme de dictionnaire ajoute
// sur A qui apparait sur B, un reglage qui ne revient pas en arriere, une reunion
// enregistree sur A qui se relit sur B - est la seule chose capable d'invalider
// toute la refonte de cette semaine. Elle demande DEUX ordinateurs, et le second
// est un Mac. Elle etait donc bloquee par une plateforme, pas par du code.
//
// CE QUE CETTE VERIFICATION A BESOIN : la fenetre, la connexion, le compte, le
// dictionnaire, les reglages, la page Notes. RIEN de plus.
// CE QU'ELLE N'A PAS BESOIN : le crochet clavier, les moteurs locaux, la capture
// du son du PC, le silence pendant une dictee, la sonde de fenetre au premier
// plan. Tout ca est specifique a Windows aujourd'hui.
//
// Ce fichier est donc la frontiere entre les deux, et il est ecrit pour DIRE ce
// qui manque plutot que pour le cacher.
//
// ---------------------------------------------------------------------------
// LA REGLE DE CE DEPOT QUI GOUVERNE CE FICHIER
// ---------------------------------------------------------------------------
//
// « Jamais un controle mort qui a l'air vivant. » Une capacite absente n'est donc
// pas un bouton grise ni une fonction qui ne repond pas : c'est une phrase a
// l'ecran qui nomme ce qui n'est pas la et pourquoi. Le meme raisonnement qui a
// fait supprimer les pages « Coming soon » plutot que de les griser, et retirer le
// bouton « Reprendre le nettoyage a 90 jours » qui ne nettoyait plus rien.
//
// ---------------------------------------------------------------------------
// CE QUI MANQUE SUR MACOS, NOMME UN PAR UN
// ---------------------------------------------------------------------------
//
//  - `dictation` : keyspy embarque un `MacKeyServer` a cote de son
//    `WinKeyServer.exe`, donc le crochet EXISTE. Ce qui n'est pas verifie est
//    l'essentiel : est-ce que la version macOS honore le verdict d'AVALEMENT ?
//    Flow renvoie ce verdict a chaque touche pour empecher le raccourci de fuir
//    dans l'application ou l'on tape. Sans lui, `Ctrl+Win` (ou son equivalent)
//    arriverait dans le document en meme temps que la dictee. Il faut aussi la
//    permission Accessibilite de macOS, et un raccourci par defaut qui ait un sens
//    sur un clavier Mac.
//  - `localEngines` : whisper-server et llama-server sont recuperes en
//    `win32-x64` en dur (scripts/fetch-whisper.cjs). Il faut des versions macOS
//    Metal, et verifier qu'elles existent chez la source utilisee.
//  - `systemAudio` : sur Windows, la capture du son du PC est du WASAPI loopback
//    que Chromium expose gratuitement. macOS n'a pas d'equivalent : il faut
//    ScreenCaptureKit (permission Enregistrement d'ecran) ou un pilote audio
//    virtuel. C'est une reecriture, pas un portage.
//  - `muteOthers` : macOS n'a AUCUNE API publique pour couper le son d'une autre
//    application - le volume par application n'existe pas. Cette capacite ne
//    traversera probablement jamais, et c'est ecrit ici plutot que decouvert.
//  - `focusProbe` : elle lance powershell.exe.
//
// Aucune de ces cinq lignes n'est un « pas encore » vague : chacune nomme ce
// qu'il faudrait, pour que la prochaine session n'ait pas a le redecouvrir.
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  /** Le crochet clavier global et l'insertion au curseur : la dictee. */
  dictation: boolean;
  /** Les moteurs locaux (parole et redaction), qui sont des binaires par
   * plateforme. Sans eux, aucun transcript et aucune note. */
  localEngines: boolean;
  /** Melanger le son du PC avec le microphone dans une reunion. */
  systemAudio: boolean;
  /** Couper le son des autres applications pendant une dictee. */
  muteOthers: boolean;
  /** La sonde qui identifie la fenetre au premier plan. */
  focusProbe: boolean;
}

/**
 * Ce que cette plateforme sait faire.
 *
 * PURE, et prend la plateforme en argument : c'est ce qui permet de tester les
 * deux reponses sans deux machines, et d'empecher un `process.platform` de se
 * glisser dans un module qui ne devrait pas s'en soucier.
 */
export function capabilitiesFor(platform: string): PlatformCapabilities {
  if (platform === "win32") {
    return { dictation: true, localEngines: true, systemAudio: true, muteOthers: true, focusProbe: true };
  }
  // macOS et tout le reste. Le defaut est FAUX pour chaque capacite, et c'est
  // deliberement l'inverse de la prudence habituelle : une capacite qu'on croit
  // presente et qui ne l'est pas produit une application qui a l'air de
  // fonctionner - ce qui est exactement le mode de panne que ce depot chasse.
  return { dictation: false, localEngines: false, systemAudio: false, muteOthers: false, focusProbe: false };
}

/** Ce qui manque, en une phrase par capacite, pour l'AFFICHER.
 *
 * Le texte vit ici et non dans les pages : la meme phrase sert la page Home, la
 * page Record et les Reglages, et trois copies divergeraient. */
export const MISSING_ON_THIS_PLATFORM: Record<keyof PlatformCapabilities, string> = {
  dictation:
    "Dictation is Windows-only for now. Its keyboard shortcut needs a system-wide hook that has not been built for this platform yet.",
  localEngines:
    "Flow's speech and notes engines are Windows-only builds for now, so nothing can be transcribed on this machine.",
  systemAudio: "Capturing what this computer plays is Windows-only.",
  muteOthers: "Muting other applications during a dictation is Windows-only: macOS has no per-application volume.",
  focusProbe: "Identifying the front window is Windows-only.",
};

/** Vrai quand cette machine ne peut RIEN faire du travail de Flow, et ne sert
 * qu'a lire le compte. La page Home s'en sert pour dire les choses une fois,
 * clairement, au lieu de repeter cinq refus. */
export function isReadOnlyPlatform(caps: PlatformCapabilities): boolean {
  return !caps.dictation && !caps.localEngines;
}
