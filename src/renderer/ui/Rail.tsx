import React from "react";
import { Icon, IC } from "./components";

// The rail is the product's promise (plan §2.1): every section is visible,
// including the ones whose engine work is a later wave - those pages say so
// honestly instead of hiding. Three families: DO, LIBRARY, and one Settings.
//
// ---------------------------------------------------------------------------
// DEUX SECTIONS SONT PARTIES LE 2026-08-04 (demande de Roch)
// ---------------------------------------------------------------------------
//
// IMPORT a fondu dans NOTES. « Toutes les options qui sont dans ce menu-la
// melees dans le menu Notes. Dans le fond, dans Notes, on pourrait avoir
// l'option de Import. » C'est le bon endroit : un import PRODUIT une entree de
// Notes, et l'ancienne page finissait par un bouton « See it in Notes » - la
// preuve que la destination etait deja la. Rien n'est perdu : le depot de
// fichiers, les deux options et la file d'attente sont dans la page Notes
// (pages/Import.tsx exporte maintenant ImportPanel).
//
// DIAGNOSTICS est SUPPRIME, et ca coute quelque chose : « ca ne sert un peu a
// rien, je ne pense pas que ce serait des informations utiles a l'utilisateur ».
// Il avait raison sur le public - c'etait une page de developpeur dans une
// application de dictee - mais il faut nommer ce qui s'en va : l'auto-diagnostic
// au demarrage, les budgets du chemin chaud, la latence du crochet clavier, le
// retard de la boucle d'evenements, les incidents du crochet. Rien de tout ca
// n'est perdu POUR MOI : les deux mesures vivent encore dans flow.log, dans
// `npm run bench:hotpath` et sur les routes /diagnostics/* de l'API locale. Ce
// qui disparait est l'ecran, pas l'instrument.
export type Section = "home" | "record" | "notes" | "stats" | "dictionary" | "settings";

const TOP: Array<[Section, string, { d: string; d2?: string }]> = [
  ["home", "Home", { d: IC.home }],
  ["record", "Record", { d: IC.record, d2: IC.record2 }],
  ["notes", "Notes", { d: IC.notes }],
  ["stats", "Statistics", { d: IC.stats }],
];
const LIBRARY: Array<[Section, string, { d: string; d2?: string }]> = [
  ["dictionary", "Dictionary", { d: IC.dict }],
];

export function Rail({
  section,
  go,
  /** 2026-08-04 : les capacites de CETTE machine. Le rail ne montre pas une
   * section qui ne pourrait pas repondre - c'est la meme regle qui a fait
   * supprimer les pages « Coming soon » plutot que de les griser, et qui a fait
   * retirer le rail entier derriere l'ecran de connexion. */
  canRecord,
}: {
  section: Section;
  go: (s: Section) => void;
  canRecord: boolean;
}) {
  const nav = ([id, label, icon]: [Section, string, { d: string; d2?: string }]) => (
    <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => go(id)}>
      <Icon d={icon.d} d2={icon.d2} />
      {label}
    </button>
  );
  return (
    <nav className="rail" aria-label="Sections">
      {TOP.filter(([id]) => canRecord || id !== "record").map(nav)}
      <div className="grp">Library</div>
      {LIBRARY.map(nav)}
      <div className="spacer" />
      {nav(["settings", "Settings", { d: IC.gear, d2: IC.gear2 }])}
    </nav>
  );
}
