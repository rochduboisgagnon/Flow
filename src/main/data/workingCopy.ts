import type { Repo, Snapshot } from "./repo";
import type { DictEntry } from "../../shared/ipcContracts";
import type { StatsDay } from "../../shared/stats";
import type { HistoryEntry } from "../../shared/dictationHistory";

// ---------------------------------------------------------------------------
// B1 : la copie de travail.
//
// Chargee A LA CONNEXION, servie depuis la RAM, reecrite vers Supabase a chaque
// changement. Rien n'est ecrit sur le disque de l'utilisateur.
//
// ---------------------------------------------------------------------------
// LA SEULE CHOSE QUI COMPTE VRAIMENT ICI : LE CHEMIN CHAUD NE CHANGE PAS
// ---------------------------------------------------------------------------
//
// Entre l'appui sur la touche et le texte au curseur, il n'y a aujourd'hui
// aucune I/O disque. Apres cette vague il ne doit y avoir aucun appel reseau
// NON PLUS, et ce n'est pas une preference d'architecture : le dictionnaire est
// applique a chaque enonce. S'il fallait le demander a Supabase, chaque dictee
// couterait un aller-retour Internet, et une coupure de reseau ARRETERAIT la
// dictee.
//
// Donc toutes les lectures de ce fichier sont SYNCHRONES et servies par un
// champ en memoire. Aucune n'est `async`, et ce n'est pas un detail de style :
// une lecture synchrone ne PEUT PAS attendre le reseau. C'est la seule forme
// d'invariant qu'un futur appelant ne peut pas contourner par distraction.
//
// ---------------------------------------------------------------------------
// LES ECRITURES PARTENT DERRIERE, ET NE BLOQUENT JAMAIS
// ---------------------------------------------------------------------------
//
// Une mutation met la memoire a jour, met un travail en file, et rend la main.
// L'appelant n'attend pas Supabase - la page a deja affiche le changement.
//
// La file est SERIALISEE (un envoi a la fois) et COALESCEE pour les reglages :
// bouger un curseur produit vingt mutations en trois secondes, et vingt PUT
// sur la meme ligne sont dix-neuf de trop. La derniere valeur gagne, ce qui est
// exactement ce qu'un reglage veut dire.
//
// HORS LIGNE, la file grandit et attend. Elle ne se vide pas dans le neant et
// elle ne bloque personne : c'est la promesse « une coupure reseau en cours de
// session ne casse pas la dictee ».
//
// ---------------------------------------------------------------------------
// CE QU'ELLE NE FAIT PAS : RETENIR LA FERMETURE
// ---------------------------------------------------------------------------
//
// `before-quit` est SYNCHRONE. Une file d'attente qui voudrait se vider avant
// de laisser partir l'application empecherait Flow de se fermer - troisieme des
// sept regressions que le plan demande de chercher, et la plus penible pour
// quelqu'un qui veut juste eteindre son ordinateur. Donc rien ici n'est appele
// depuis before-quit ; `pending()` existe pour DIRE ce qui n'est pas monte,
// jamais pour l'attendre.
// ---------------------------------------------------------------------------

export interface WorkingCopyDeps {
  repo: Repo;
  log?(msg: string): void;
  /** Couture de test : le temps d'attente entre deux tentatives. */
  retryDelayMs?: number;
  /** Couture de test : remplace setTimeout. */
  schedule?(fn: () => void, ms: number): void;
}

type Job =
  | { kind: "settings" }
  | { kind: "dict-upsert"; id: string }
  | { kind: "dict-delete"; id: string }
  | { kind: "stats-day"; day: string }
  | { kind: "dictation"; entry: HistoryEntry }
  | { kind: "dictations-clear" }
  | { kind: "stats-clear" };

/** Deux travaux qui se remplacent l'un l'autre plutot que de s'empiler. Les
 * reglages et une journee de statistiques sont des ETATS : seule la derniere
 * valeur compte. Une dictee est un EVENEMENT : chacune compte. */
function jobKey(j: Job): string | null {
  if (j.kind === "settings") return "settings";
  if (j.kind === "dict-upsert" || j.kind === "dict-delete") return `dict:${j.id}`;
  if (j.kind === "stats-day") return `stats:${j.day}`;
  return null; // dictations et purges : jamais fusionnees
}

export class WorkingCopy {
  private deps: WorkingCopyDeps;

  private settings: Record<string, unknown> = {};
  private dict: DictEntry[] = [];
  private stats: StatsDay[] = [];
  private dictations: HistoryEntry[] = [];
  private ready = false;

  private queue: Job[] = [];
  private draining = false;
  private failures = 0;

  constructor(deps: WorkingCopyDeps) {
    this.deps = deps;
  }

  /**
   * Charge tout, une fois, a la connexion.
   *
   * UN ECHEC LAISSE LA COPIE NON PRETE, et c'est le comportement voulu :
   * `isReady()` reste faux, l'interface le montre, et le moteur ne pretend pas
   * avoir un dictionnaire vide. La deuxieme des sept regressions du plan est un
   * terme de dictionnaire sans effet ; sa forme la plus vicieuse est un
   * chargement rate traite comme un chargement vide.
   */
  async load(): Promise<{ ok: boolean; error: string }> {
    const r = await this.deps.repo.loadAll();
    if (!r.ok) {
      this.deps.log?.(`[data] chargement du compte impossible : ${r.error}`);
      return { ok: false, error: r.error };
    }
    this.adopt(r.data);
    return { ok: true, error: "" };
  }

  private adopt(s: Snapshot): void {
    this.settings = s.settings;
    this.dict = s.dictionary;
    this.stats = s.stats;
    this.dictations = s.dictations;
    this.ready = true;
  }

  /** Deconnexion : la copie disparait de la memoire. Sans ca, la personne
   * suivante a se connecter sur cette machine verrait le dictionnaire de la
   * precedente jusqu'au premier rechargement. */
  reset(): void {
    this.settings = {};
    this.dict = [];
    this.stats = [];
    this.dictations = [];
    this.ready = false;
    this.queue = [];
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Ce qui n'est pas encore monte. Pour le DIRE, jamais pour l'attendre. */
  pending(): number {
    return this.queue.length;
  }

  // -------------------------------------------------------------------------
  // LECTURES - toutes synchrones. Voir le bandeau.
  // -------------------------------------------------------------------------

  readSettings(): Record<string, unknown> {
    return this.settings;
  }

  /** Le tableau REEL, pas une copie : il est lu a chaque enonce et le copier
   * couterait une allocation par dictee. Les appelants ne le mutent pas. */
  readDictionary(): DictEntry[] {
    return this.dict;
  }

  readStats(): StatsDay[] {
    return this.stats;
  }

  readDictations(): HistoryEntry[] {
    return this.dictations;
  }

  // -------------------------------------------------------------------------
  // ECRITURES - memoire d'abord, reseau derriere
  // -------------------------------------------------------------------------

  writeSettings(next: Record<string, unknown>): void {
    this.settings = next;
    this.enqueue({ kind: "settings" });
  }

  upsertDictEntry(e: DictEntry): void {
    const i = this.dict.findIndex((d) => d.id === e.id);
    if (i >= 0) this.dict[i] = e;
    else this.dict.push(e);
    this.enqueue({ kind: "dict-upsert", id: e.id });
  }

  deleteDictEntry(id: string): void {
    this.dict = this.dict.filter((d) => d.id !== id);
    this.enqueue({ kind: "dict-delete", id });
  }

  writeStatsDay(d: StatsDay): void {
    const i = this.stats.findIndex((x) => x.date === d.date);
    if (i >= 0) this.stats[i] = d;
    else this.stats.push(d);
    this.enqueue({ kind: "stats-day", day: d.date });
  }

  /** Une dictee vient d'etre inseree au curseur. Appelee APRES l'insertion,
   * jamais avant : le chemin chaud est deja fini quand cette ligne s'execute. */
  addDictation(e: HistoryEntry): void {
    this.dictations.unshift(e); // les plus recentes d'abord, comme la page les lit
    this.enqueue({ kind: "dictation", entry: e });
  }

  clearDictations(): void {
    this.dictations = [];
    this.enqueue({ kind: "dictations-clear" });
  }

  clearStats(): void {
    this.stats = [];
    this.enqueue({ kind: "stats-clear" });
  }

  // -------------------------------------------------------------------------
  // LA FILE
  // -------------------------------------------------------------------------

  private enqueue(j: Job): void {
    const key = jobKey(j);
    if (key !== null) {
      // Remplace le travail equivalent deja en attente. La position n'est pas
      // conservee : un etat n'a pas d'ordre, il a une derniere valeur.
      const i = this.queue.findIndex((q) => jobKey(q) === key);
      if (i >= 0) this.queue.splice(i, 1);
    }
    this.queue.push(j);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const j = this.queue[0];
        const r = await this.run(j);
        if (r) {
          this.queue.shift();
          this.failures = 0;
          continue;
        }
        // Echec : le travail RESTE en tete de file. Hors ligne, la file
        // grandit et attend le retour du reseau ; elle ne se vide pas dans le
        // neant. On sort de la boucle pour ne pas marteler.
        this.failures++;
        if (this.failures === 1) {
          this.deps.log?.("[data] envoi impossible : les changements attendent en memoire");
        }
        const wait = Math.min(30_000, (this.deps.retryDelayMs ?? 2_000) * Math.min(this.failures, 8));
        const again = () => void this.drain();
        if (this.deps.schedule) this.deps.schedule(again, wait);
        else setTimeout(again, wait).unref?.();
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  /** Rend vrai quand c'est monte. Ne LANCE jamais : une exception ici
   * remonterait dans une promesse que personne n'attend. */
  private async run(j: Job): Promise<boolean> {
    try {
      const repo = this.deps.repo;
      switch (j.kind) {
        case "settings":
          return (await repo.saveSettings(this.settings)).ok;
        case "dict-upsert": {
          const e = this.dict.find((d) => d.id === j.id);
          // Le terme a ete supprime entre la mise en file et l'envoi : il n'y a
          // plus rien a ecrire, et le travail de suppression est deja derriere
          // dans la file. C'est un succes, pas un echec.
          if (!e) return true;
          return (await repo.upsertDictEntry(e)).ok;
        }
        case "dict-delete":
          return (await repo.deleteDictEntry(j.id)).ok;
        case "stats-day": {
          const d = this.stats.find((x) => x.date === j.day);
          if (!d) return true;
          return (await repo.saveStatsDay(d)).ok;
        }
        case "dictation":
          return (await repo.addDictation(j.entry)).ok;
        case "dictations-clear":
          return (await repo.clearDictations()).ok;
        case "stats-clear":
          return (await repo.clearStats()).ok;
      }
    } catch (err) {
      this.deps.log?.(`[data] envoi echoue : ${(err as Error).message}`);
      return false;
    }
  }
}
