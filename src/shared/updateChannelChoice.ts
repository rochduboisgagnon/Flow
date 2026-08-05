// ---------------------------------------------------------------------------
// 2026-08-04 : QUEL MECANISME DE MISE A JOUR, SELON LA PLATEFORME.
//
// Ecrit sur le modele exact de capabilitiesFor() dans src/shared/platform.ts, et
// pour la meme raison : la fonction est PURE et prend la plateforme en argument,
// donc les deux reponses se testent sans deux machines, et aucun
// `process.platform` n'a besoin de se glisser dans src/main/updater.ts (qui n'en
// contient aucun, et doit continuer de n'en contenir aucun).
//
// Elle rend un NOM et non un objet, deliberement : construire le canal
// electron-updater importe electron-updater, ce qui rendrait ce fichier
// inimportable par un test Windows - et c'est precisement le probleme que toute
// cette refonte vient de resoudre. La construction se fait dans index.ts, au seul
// endroit qui lit deja la plateforme une fois.
//
// POURQUOI CE N'EST PAS UN DRAPEAU DE PlatformCapabilities : chaque drapeau de
// cette interface repond a « qu'est-ce que Flow sait FAIRE pour l'utilisateur sur
// cette machine » et porte une phrase affichable dans MISSING_ON_THIS_PLATFORM.
// Se mettre a jour n'est pas une capacite de ce genre, c'est un detail de
// livraison ; et le drapeau vaudrait `true` sur les deux seules plateformes qui
// existent, soit une constante deguisee en variable.
// ---------------------------------------------------------------------------

export type UpdateChannelName = "electron-updater" | "mac-zip" | null;

export function updateChannelFor(platform: string): UpdateChannelName {
  // Le seul feed publie depuis la 1.0.0 : electron-builder ecrit latest.yml,
  // electron-updater le lit, l'installeur NSIS s'echange tout seul.
  if (platform === "win32") return "electron-updater";
  // macOS : un zip signe ad-hoc, une empreinte publiee a cote, et un echange de
  // bundle qu'on fait nous-memes (Squirrel.Mac exige un Developer ID, qui ne sera
  // pas achete). Le mecanisme se construit en plusieurs commits ; ce nom ne sera
  // rendu qu'au commit de basculement, quand macZipChannel.ts ET la chaine de
  // publication existeront tous les deux. Rendre "mac-zip" avant cela donnerait un
  // updater qui interroge un document que personne ne publie : un controle mort
  // qui a l'air vivant, ce que ce depot refuse.
  if (platform === "darwin") return null;
  // Tout le reste. Rien n'est publie pour cette plateforme, donc l'updater reste
  // inerte - et le DIT, au lieu de laisser un bouton qui ne repond pas. Meme
  // defaut prudent que capabilitiesFor().
  return null;
}
