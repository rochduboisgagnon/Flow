// B2 : ni `fs` ni `path`. Ce module n'ecrit plus rien sur le disque, et les
// quatre fonctions de fichier (HISTORY_VERSION, emptyHistory, mergeEntries,
// parseHistoryFile) sont parties avec history.json. Elles restent dans
// shared/dictationHistory.ts, ou la migration en aura besoin si un jour on
// remonte un ancien fichier.
import { sanitizeHistoryText, type HistoryEntry } from "../shared/dictationHistory";

// The dictation history store. Deliberately the same shape as main/stats.ts,
// because it has the same hazard: the process that writes this file is the one
// carrying the keyboard hook, so nothing here may run synchronously per press.
//
// See shared/dictationHistory.ts for what this feature changed about what Flow
// promises. In short: it now writes down what you dictate, the README says so,
// and this file is what has to keep the four bounds that make that acceptable.


// ---------------------------------------------------------------------------
// B2 : history.json a disparu. Les dictees vivent dans le compte.
//
// CE QUI TOMBE AVEC LE FICHIER, et c'est l'essentiel de ce module : le
// minuteur de vidage toutes les minutes, l'ecriture atomique, la garde
// anti-ecrasement, et la purge de retention appliquee A CHAQUE ECRITURE. Tous
// existaient pour proteger un fichier. La copie de travail fait desormais le
// travail de file d'attente, et la retention devient une affaire de base.
//
// CE QUI RESTE, ET QUI EST LA VRAIE VALEUR DE CE MODULE : `sanitizeHistoryText`.
// Elle coupe a MAX_TEXT_CHARS et le DIT (`truncated`), pour que la page puisse
// annoncer un fragment au lieu de le presenter comme le tout. Cette regle n'a
// rien a voir avec un fichier et n'avait aucune raison de partir avec lui.
//
// LE CHEMIN CHAUD NE CHANGE PAS. `record()` reste une regex sur une chaine
// courte et un ajout en memoire : pas de lecture, pas d'ecriture, pas de JSON,
// et maintenant pas de reseau non plus - l'envoi part de la copie de travail,
// derriere, apres que le texte est deja au curseur.
// ---------------------------------------------------------------------------

export interface HistoryStoreDeps {
  /** Le magasin du compte. La copie de travail (main/data/workingCopy.ts)
   * l'implemente. Null tant que personne n'est connecte : `record()` garde
   * alors la dictee en memoire pour la page, et rien ne part. */
  backing(): HistoryBacking | null;
  /** Injectable clock - inchange. */
  now?(): number;
  log?(msg: string): void;
}

export interface HistoryBacking {
  readDictations(): HistoryEntry[];
  addDictation(e: HistoryEntry): void;
  clearDictations(): void;
}

export class DictationHistoryStore {
  private deps: HistoryStoreDeps;
  /** Les dictees de CETTE session, gardees quand personne n'est connecte. Sans
   * ca, dicter avant de se connecter effacerait le texte de la page. */
  private orphans: HistoryEntry[] = [];

  constructor(deps: HistoryStoreDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * THE HOT PATH. Une regex sur une chaine courte et un ajout en memoire : pas
   * de lecture, pas d'ecriture, pas de JSON, et pas de reseau. L'envoi vers le
   * compte part de la copie de travail, derriere, apres que le texte est deja
   * au curseur.
   *
   * Appelee avec le texte REELLEMENT insere, apres tous les filtres, pour que
   * l'historique montre ce qui a atterri et non ce que le modele a dit d'abord.
   */
  record(rawText: string): void {
    const { text, truncated } = sanitizeHistoryText(rawText);
    if (!text) return;
    const e: HistoryEntry = truncated
      ? { at: this.now(), text, truncated }
      : { at: this.now(), text };
    const b = this.deps.backing();
    if (b) b.addDictation(e);
    else this.orphans.unshift(e);
  }

  /** Ce que la page montre. Les dictees dites avant la connexion sont devant :
   * elles sont les plus recentes. */
  read(): { entries: HistoryEntry[]; error?: string } {
    const b = this.deps.backing();
    if (!b) return { entries: [...this.orphans] };
    return { entries: [...this.orphans, ...b.readDictations()] };
  }

  clear(): { entries: HistoryEntry[]; error?: string } {
    this.orphans = [];
    this.deps.backing()?.clearDictations();
    return { entries: [] };
  }

  /** La connexion vient d'avoir lieu : ce qui a ete dicte avant part vers le
   * compte plutot que de disparaitre a la fermeture. */
  adopt(): void {
    const b = this.deps.backing();
    if (!b) return;
    // Du plus ancien au plus recent, pour que l'ordre d'arrivee dans la base
    // suive l'ordre reel des paroles.
    for (const e of [...this.orphans].reverse()) b.addDictation(e);
    this.orphans = [];
  }
}
