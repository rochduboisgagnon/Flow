// ---------------------------------------------------------------------------
// 2026-08-04 : « EST-CE PLUS RECENT ? », SANS DEPENDANCE.
//
// Le canal Windows n'a jamais eu besoin de ceci : electron-updater compare les
// versions lui-meme, et deux de ses reglages sont ecrits explicitement dans
// electronUpdaterChannel.ts pour cette raison - `allowDowngrade = false` et
// `allowPrerelease = false`. Le canal macOS lit un document que nous publions,
// donc il doit porter la meme politique dans notre propre code.
//
// LES DEUX REFUS SONT DES PROPRIETES DE SECURITE, pas des preferences :
//
//  - une RETROGRADATION est la facon dont quelqu'un capable de publier ramene une
//    machine sur une version dont le trou est deja bouche. Le canal de mise a jour
//    utilise a l'envers. C'est le commentaire deja ecrit dans updater.ts, et il
//    s'applique mot pour mot ici.
//  - une PREVERSION n'est pas un canal que cette application publie, et l'accepter
//    elargirait ce qu'une page de release compromise peut pousser sur une machine.
//    Elle est refusee PAR CONSTRUCTION : l'analyse est stricte, donc « 2.6.0-beta.1 »
//    ne s'analyse simplement pas.
//
// Aucun `semver` en dependance : ce dont on a besoin tient en dix lignes, et une
// dependance de plus dans le processus qui porte le crochet clavier est une
// surface de plus a surveiller pour un gain nul.
// ---------------------------------------------------------------------------

const STRICT = /^(\d+)\.(\d+)\.(\d+)$/;

/** MAJOR.MINOR.PATCH, ou null si ce n'est pas exactement cela. */
function parse(v: string): [number, number, number] | null {
  const m = STRICT.exec(v.trim());
  if (!m) return null;
  const out: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Une version dont un champ deborde n'est pas une version : mieux vaut refuser
  // la mise a jour que comparer des nombres qui ont perdu leur sens.
  return out.every((n) => Number.isSafeInteger(n)) ? out : null;
}

/**
 * Vrai SEULEMENT si `candidate` est strictement plus recent que `current`.
 *
 * Faux a egalite, faux en arriere, faux si l'un des deux ne s'analyse pas. Le
 * defaut est donc « on ne met pas a jour », ce qui est le bon sens du doute pour
 * une fonction qui autorise le remplacement d'un binaire.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    // Champ par champ et NUMERIQUEMENT. Une comparaison de chaines dirait que
    // « 2.10.0 » est plus ancien que « 2.9.0 », ce qui bloquerait toutes les mises
    // a jour a partir de la dixieme mineure sans que rien ne signale d'erreur.
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
