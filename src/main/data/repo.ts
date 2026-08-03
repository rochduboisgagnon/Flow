import type { SupabaseClient } from "./client";
import type { DictEntry, DictKind } from "../../shared/ipcContracts";
import type { StatsDay } from "../../shared/stats";
import { retentionCutoff, type HistoryEntry } from "../../shared/dictationHistory";
import type { OpenRecording, RecordingRow, RecordingSummary } from "../../shared/recordings";

// ---------------------------------------------------------------------------
// A3 : le depot. Toute lecture et toute ecriture des donnees de l'utilisateur
// passe par ce fichier, et par lui seul.
//
// ---------------------------------------------------------------------------
// LA REGLE QUI GOUVERNE TOUT CE FICHIER : IL N'EST JAMAIS SUR LE CHEMIN CHAUD
// ---------------------------------------------------------------------------
//
// Entre l'appui sur la touche et le texte au curseur, il n'y a aujourd'hui
// aucune I/O disque, et il ne doit y avoir aucun appel reseau. Le dictionnaire
// est applique a CHAQUE enonce : s'il fallait le demander a Supabase, une
// dictee couterait un aller-retour Internet, et une coupure de reseau
// arreterait la dictee.
//
// Donc ce depot n'est jamais appele pendant une dictee. Il alimente la copie de
// travail en memoire (workingCopy.ts) au moment de la connexion, et il recoit
// les ecritures APRES coup, en arriere-plan. C'est la premiere des sept
// regressions que le plan demande de chercher, et la seule qui se mesure : le
// banc `bench:hotpath` doit rendre les memes chiffres reseau coupe et reseau
// sature.
//
// ---------------------------------------------------------------------------
// CE QUI N'EST PAS ICI : LE user_id
// ---------------------------------------------------------------------------
//
// Aucune methode ne le prend en argument, et c'est delibere. Le RLS le deduit
// du jeton, et une signature qui l'accepterait inviterait un appelant a en
// passer un autre - exactement ce que la politique `with check` refuse, mais un
// refus a l'execution est un bogue trouve tard. Ici la question ne se pose pas.
//
// Les INSERT, eux, doivent le fournir : Postgres ne le devine pas. Il vient
// donc de la session, jamais d'un appelant.
// ---------------------------------------------------------------------------

export interface RepoResult<T> {
  ok: boolean;
  data: T;
  /** Vide quand tout va bien. JAMAIS un jeton ni une adresse : ce texte finit
   * dans le journal et dans l'interface. */
  error: string;
}

function fail<T>(fallback: T, err: { message?: string } | null): RepoResult<T> {
  return { ok: false, data: fallback, error: err?.message ?? "erreur inconnue" };
}

/** Ce que la copie de travail recoit a la connexion : tout ce que le moteur a
 * besoin d'avoir a chaud, en UNE fois. Quatre requetes en parallele plutot
 * qu'un aller-retour par magasin. */
export interface Snapshot {
  settings: Record<string, unknown>;
  dictionary: DictEntry[];
  stats: StatsDay[];
  dictations: HistoryEntry[];
}

export class Repo {
  private client: SupabaseClient;
  private log?: (msg: string) => void;

  constructor(deps: { client: SupabaseClient; log?(msg: string): void }) {
    this.client = deps.client;
    this.log = deps.log;
  }

  /** L'identifiant du compte connecte, ou "" - lu de la session, jamais recu.
   * Voir le bandeau. */
  private async uid(): Promise<string> {
    const { data } = await this.client.auth.getSession();
    return data.session?.user.id ?? "";
  }

  // -------------------------------------------------------------------------
  // LECTURE : une seule fois, a la connexion
  // -------------------------------------------------------------------------

  /**
   * Tout ce dont le moteur a besoin, en parallele.
   *
   * UN ECHEC PARTIEL N'EST PAS UN SUCCES PARTIEL. Si le dictionnaire ne
   * descend pas, cette methode le DIT plutot que de rendre une liste vide :
   * un dictionnaire vide et un dictionnaire qu'on n'a pas pu lire se
   * ressemblent, et le second ferait dicter l'utilisateur sans ses termes
   * pendant qu'il croit les avoir. C'est la deuxieme des sept regressions du
   * plan, prise a la source.
   */
  async loadAll(): Promise<RepoResult<Snapshot>> {
    const empty: Snapshot = { settings: {}, dictionary: [], stats: [], dictations: [] };
    const [s, d, st, dic] = await Promise.all([
      this.client.from("settings").select("data").maybeSingle(),
      this.client.from("dictionary").select("*").order("created_at", { ascending: true }),
      this.client.from("stats_days").select("*").order("day", { ascending: true }),
      this.client.from("dictations").select("*").order("said_at", { ascending: false }).limit(500),
    ]);
    for (const r of [s, d, st, dic]) {
      if (r.error) return fail(empty, r.error);
    }
    return {
      ok: true,
      error: "",
      data: {
        settings: (s.data?.data as Record<string, unknown>) ?? {},
        dictionary: (d.data ?? []).map(rowToDictEntry),
        stats: (st.data ?? []).map(rowToStatsDay),
        dictations: (dic.data ?? []).map(rowToHistoryEntry),
      },
    };
  }

  // -------------------------------------------------------------------------
  // ECRITURE : toujours apres coup, jamais pendant
  // -------------------------------------------------------------------------

  /** Les reglages, en un seul objet. Un `upsert` parce qu'il y a exactement une
   * ligne par compte et qu'elle n'existe pas au premier lancement. */
  async saveSettings(data: Record<string, unknown>): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client
      .from("settings")
      .upsert({ user_id, data, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  async upsertDictEntry(e: DictEntry): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("dictionary").upsert({
      id: e.id,
      user_id,
      term: e.term,
      aliases: e.aliases,
      kind: e.kind,
      starred: e.starred,
      created_at: e.createdIso,
      updated_at: new Date().toISOString(),
    });
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  async deleteDictEntry(id: string): Promise<RepoResult<null>> {
    const { error } = await this.client.from("dictionary").delete().eq("id", id);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /**
   * Une journee de statistiques.
   *
   * `upsert` sur (user_id, day), et les compteurs sont ECRASES et non
   * incrementes : la copie de travail en memoire detient le total du jour et
   * l'envoie en entier. Un increment cote base semblerait plus sur et serait
   * l'inverse - deux machines qui incrementent la meme journee doubleraient les
   * mots au lieu de converger. Ecraser depuis une source unique est ce qui rend
   * la synchronisation entre deux ordinateurs previsible.
   */
  async saveStatsDay(d: StatsDay): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("stats_days").upsert(
      {
        user_id,
        day: d.date,
        words: d.words,
        ms: d.ms,
        utterances: d.utterances,
        // NULL veut dire « on ne mesurait pas », ce qui n'est pas la meme chose
        // qu'un objet vide (« on mesurait et il n'y avait rien »).
        apps: d.apps ?? null,
      },
      { onConflict: "user_id,day" },
    );
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /** Une dictee, ajoutee apres son insertion au curseur - jamais avant. */
  async addDictation(e: HistoryEntry): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("dictations").insert({
      user_id,
      said_at: new Date(e.at).toISOString(),
      text: e.text,
      truncated: e.truncated === true,
    });
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /**
   * LA RETENTION. Un mois glissant, applique cote base.
   *
   * ELLE VIENT D'UN CONSTAT DE SECURITE (F3/F9 du scan du 2026-08-02) et pas
   * d'un souci de place : Flow ecrit ce que quelqu'un dicte, ce qui inclut des
   * mots de passe epeles, des adresses, des choses dites a un medecin. La
   * promesse qui rend ca acceptable est qu'elles ne s'accumulent pas
   * indefiniment.
   *
   * Elle passait avant par une purge a chaque ecriture du fichier. Le fichier
   * n'existe plus, et la purge devait etre re-ecrite quelque part ou elle
   * s'execute VRAIMENT - pas simplement disparaitre avec lui. Ici, au
   * chargement du compte : c'est le seul moment garanti de chaque session, y
   * compris sur une machine ou personne ne dicte jamais - le cas exact que le
   * constat F3 nommait.
   */
  async purgeOldDictations(nowMs: number): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const cutoff = new Date(retentionCutoff(nowMs)).toISOString();
    const { error } = await this.client
      .from("dictations")
      .delete()
      .eq("user_id", user_id)
      .lt("said_at", cutoff);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  async clearDictations(): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("dictations").delete().eq("user_id", user_id);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /** Une journee precise. Necessaire pour deux promesses qui ne sont PAS des
   * ecritures : la purge des journees trop vieilles, et l'effacement des noms
   * d'application quand l'attribution est eteinte - qui peut vider une journee
   * au point qu'elle ne doive plus exister. */
  async deleteStatsDay(day: string): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("stats_days").delete().eq("user_id", user_id).eq("day", day);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  async clearStats(): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("stats_days").delete().eq("user_id", user_id);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  // -------------------------------------------------------------------------
  // LES NOTES PRISES PENDANT UN ENREGISTREMENT
  //
  // La seule partie d'une capture qu'on ne peut PAS regenerer : le transcript
  // se refait depuis l'audio, les notes non. Elles sont donc ecrites au fil de
  // la frappe plutot qu'a la fin, et rattachees a `started_iso` - l'instant que
  // la page declare - parce qu'elles s'ecrivent AVANT que la ligne
  // d'enregistrement existe.
  // -------------------------------------------------------------------------

  async loadLiveNotes(startedIso: string): Promise<RepoResult<Array<{ id: string; at_ms: number; text: string }>>> {
    const { data, error } = await this.client
      .from("live_notes")
      .select("id, at_ms, text")
      .eq("started_iso", startedIso)
      .order("at_ms", { ascending: true });
    return error ? fail([], error) : { ok: true, data: data ?? [], error: "" };
  }

  async upsertLiveNote(startedIso: string, n: { id: string; atMs: number; text: string }): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client
      .from("live_notes")
      .upsert({ id: n.id, user_id, started_iso: startedIso, at_ms: n.atMs, text: n.text });
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  async deleteLiveNote(id: string): Promise<RepoResult<null>> {
    const { error } = await this.client.from("live_notes").delete().eq("id", id);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /** Apres que les notes sont SUREMENT dans le document. Voir LiveNotesStore.clear. */
  async clearLiveNotes(startedIso: string): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client
      .from("live_notes")
      .delete()
      .eq("user_id", user_id)
      .eq("started_iso", startedIso);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  // -------------------------------------------------------------------------
  // B3 : LES ENREGISTREMENTS
  //
  // La difference avec tout ce qui precede est une difference de CHRONOLOGIE.
  // Un reglage, un terme, une dictee : la ligne est ecrite une fois, quand la
  // chose existe. Une reunion, non - sa ligne nait au premier mot et grandit
  // pendant une heure.
  //
  // D'ou la forme retenue : UN SEUL verbe d'ecriture, `saveRecording`, un
  // `upsert` sur un identifiant que le CLIENT fabrique. Consequence, et c'est
  // tout l'interet : il n'y a pas d'ordre a respecter entre « creer » et « mettre
  // a jour ». Une file hors ligne qui garde la derniere version d'une ligne et
  // jette les precedentes ecrit la bonne chose, quel que soit ce qui a reussi
  // avant elle. Deux verbes auraient introduit un ordre, donc une facon de le
  // violer.
  //
  // La cinquieme lecon des vagues closes dit « envoyer ce qui a change, pas
  // l'etat entier », et ce fichier envoie ici le document ENTIER. Ce n'est pas
  // une entorse : la lecon vient de deux machines qui s'ecrasaient l'une
  // l'autre sur la meme donnee. Une reunion est enregistree par UNE machine, du
  // debut a la fin ; celle qui detient le tampon est la seule a pouvoir dire ce
  // que vaut le document, et le decoupage se fait en TRANCHES DANS LE TEMPS
  // plutot qu'en morceaux de texte. L'autre ordinateur ne peut que la lire.
  // -------------------------------------------------------------------------

  /**
   * Ecrit une reunion, en entier, sous son identifiant.
   *
   * `started_at` et `notes_key` recoivent la MEME chaine, pour deux usages qui
   * ne peuvent pas partager une colonne : l'une est une date qu'on trie,
   * l'autre est une cle de jointure qui doit rester exacte. Voir le commentaire
   * de la migration.
   *
   * `heartbeat_at` est pousse a CHAQUE appel, y compris quand seul le document
   * a bouge. C'est ce qui empeche le sauvetage au demarrage de confondre une
   * reunion en cours avec une session morte.
   */
  async saveRecording(r: RecordingRow): Promise<RepoResult<null>> {
    const user_id = await this.uid();
    if (!user_id) return fail(null, { message: "personne n'est connecte" });
    const { error } = await this.client.from("recordings").upsert({
      id: r.id,
      user_id,
      title: r.title,
      started_at: r.startedIso,
      notes_key: r.startedIso,
      duration_ms: r.durationMs,
      doc: r.doc,
      audio_path: r.audioPath,
      audio_bytes: r.audioBytes,
      audio_uploaded: r.audioUploaded,
      staged: r.staged,
      // "" = pas encore terminee. NULL cote base, parce qu'un timestamptz vide
      // n'existe pas et que l'index partiel du sauvetage porte sur `is null`.
      ended_at: r.endedIso || null,
      heartbeat_at: new Date().toISOString(),
    });
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /** Les reunions du compte, les plus recentes d'abord, SANS leur document.
   * Voir RecordingSummary sur pourquoi le document n'en fait pas partie. */
  async listRecordings(limit = MAX_RECORDINGS_LISTED): Promise<RepoResult<RecordingSummary[]>> {
    const { data, error } = await this.client
      .from("recordings")
      .select("id, title, started_at, notes_key, duration_ms, doc_bytes, audio_path, audio_bytes, audio_uploaded, staged, ended_at")
      .order("started_at", { ascending: false })
      .limit(limit);
    return error ? fail([], error) : { ok: true, data: (data ?? []).map(rowToSummary), error: "" };
  }

  /** Une reunion avec son document. L'equivalent de l'ancien readHistoryDoc,
   * sans son schema d'identifiants opaques : le RLS remplace la verification de
   * confinement, et il la remplace mieux - un identifiant forge ne rend pas une
   * ligne d'un autre compte, il ne rend rien. */
  async readRecording(id: string): Promise<RepoResult<RecordingRow | null>> {
    const { data, error } = await this.client.from("recordings").select("*").eq("id", id).maybeSingle();
    if (error) return fail(null, error);
    return { ok: true, data: data ? rowToRecording(data as RecordingRow2) : null, error: "" };
  }

  async deleteRecording(id: string): Promise<RepoResult<null>> {
    const { error } = await this.client.from("recordings").delete().eq("id", id);
    return error ? fail(null, error) : { ok: true, data: null, error: "" };
  }

  /**
   * Les lignes de CE compte restees ouvertes.
   *
   * Le remplacant de `rescueOrphanedStaging()`, et il couvre strictement plus :
   * l'ancien lisait un dossier local, donc il ne voyait que les sessions mortes
   * SUR CETTE MACHINE. Celui-ci voit aussi la reunion coupee sur l'autre
   * ordinateur - le cas que la refonte cree et que rien ne couvrait.
   *
   * Le tri decide qui est mort : cette methode rend les lignes ouvertes, et
   * `looksAbandoned` tranche sur le pouls. La decision n'est pas ici parce
   * qu'elle a besoin d'une horloge, et une horloge dans le depot serait une
   * horloge qu'un test ne peut pas avancer.
   */
  async listOpenRecordings(): Promise<RepoResult<OpenRecording[]>> {
    const { data, error } = await this.client
      .from("recordings")
      .select("*")
      .is("ended_at", null)
      .order("heartbeat_at", { ascending: true });
    if (error) return fail([], error);
    return {
      ok: true,
      error: "",
      data: (data ?? []).map((r) => {
        const row = r as RecordingRow2 & { heartbeat_at: string | null };
        // Le pouls manquant est traite comme l'instant de depart, donc comme
        // VIEUX : la ligne existe, elle est ouverte, et refuser de la sauver
        // parce qu'on ne sait pas la dater perdrait la reunion.
        return { ...rowToRecording(row), heartbeatIso: row.heartbeat_at ?? row.started_at };
      }),
    };
  }

  /** Journalise un echec d'ecriture SANS son contenu : ce qui rate ici, c'est
   * souvent une dictee, et une dictee est le texte de quelqu'un. */
  reportWriteFailure(what: string, r: RepoResult<unknown>): void {
    if (!r.ok) this.log?.(`[data] ${what} n'a pas pu etre enregistre : ${r.error}`);
  }
}

/** Le meme plafond que l'ancienne archive disque (MAX_HISTORY_ITEMS valait
 * 2000). Il n'a pas change de valeur en changeant de support : ce qu'il borne
 * est ce qu'une page peut afficher, pas ce qu'un dossier peut contenir. */
export const MAX_RECORDINGS_LISTED = 2000;

// ---------------------------------------------------------------------------
// Conversions ligne <-> forme applicative.
//
// Elles vivent ici et pas dans les modules metier, pour que la forme SQL ne
// remonte nulle part. Le jour ou une colonne change de nom, ce fichier est le
// seul a le savoir.
// ---------------------------------------------------------------------------

interface DictRow {
  id: string;
  term: string;
  aliases: string[] | null;
  kind: string;
  starred: boolean | null;
  created_at: string;
}

function rowToDictEntry(r: DictRow): DictEntry {
  return {
    id: r.id,
    term: r.term,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    kind: (r.kind === "replacement" ? "replacement" : "vocabulary") as DictKind,
    starred: r.starred === true,
    createdIso: r.created_at,
  };
}

interface StatsRow {
  day: string;
  words: number | null;
  ms: number | null;
  utterances: number | null;
  apps: Record<string, number> | null;
}

function rowToStatsDay(r: StatsRow): StatsDay {
  const d: StatsDay = {
    date: r.day,
    words: r.words ?? 0,
    ms: r.ms ?? 0,
    utterances: r.utterances ?? 0,
  };
  // Le champ n'est ajoute QUE s'il existe : mergeDays refuse d'ecrire `apps`
  // quand l'attribution par application est eteinte, et rendre `{}` ici
  // reintroduirait par la porte de derriere ce que ce reglage interdit.
  if (r.apps && typeof r.apps === "object") d.apps = r.apps;
  return d;
}

interface DictationRow {
  said_at: string;
  text: string;
  truncated: boolean | null;
}

function rowToHistoryEntry(r: DictationRow): HistoryEntry {
  const e: HistoryEntry = { at: Date.parse(r.said_at), text: r.text };
  if (r.truncated) e.truncated = true;
  return e;
}

// ---- B3 : les enregistrements ----

interface RecordingRow2 {
  id: string;
  title: string | null;
  started_at: string;
  notes_key: string | null;
  duration_ms: number | null;
  doc: string | null;
  audio_path: string | null;
  audio_bytes: number | null;
  audio_uploaded: number | null;
  staged: boolean | null;
  ended_at: string | null;
}

interface SummaryRow extends Omit<RecordingRow2, "doc"> {
  doc_bytes: number | null;
}

/** `notes_key` d'abord, `started_at` en repli : les lignes ecrites avant que
 * `notes_key` existe portent "" (son defaut), et le repli evite qu'elles
 * perdent leur instant de depart. Le repli n'est PAS interchangeable avec la
 * cle - il sert a afficher une date, jamais a retrouver des notes. */
function startedIsoOf(r: { notes_key: string | null; started_at: string }): string {
  return r.notes_key || r.started_at;
}

function rowToRecording(r: RecordingRow2): RecordingRow {
  return {
    id: r.id,
    title: r.title ?? "",
    startedIso: startedIsoOf(r),
    durationMs: r.duration_ms ?? 0,
    doc: r.doc ?? "",
    audioPath: r.audio_path ?? "",
    audioBytes: r.audio_bytes ?? 0,
    audioUploaded: r.audio_uploaded ?? 0,
    staged: r.staged === true,
    endedIso: r.ended_at ?? "",
  };
}

function rowToSummary(r: SummaryRow): RecordingSummary {
  const audioPath = r.audio_path ?? "";
  return {
    id: r.id,
    title: r.title ?? "",
    startedIso: startedIsoOf(r),
    durationMs: r.duration_ms ?? 0,
    docBytes: r.doc_bytes ?? 0,
    audioBytes: r.audio_bytes ?? 0,
    audioUploaded: r.audio_uploaded ?? 0,
    // « il y a un audio » se lit sur le CHEMIN et non sur les octets : une
    // reunion dont le televersement est encore en cours a un chemin et zero
    // octet arrive, et la page doit pouvoir montrer sa progression plutot que
    // pretendre qu'il n'y a pas d'audio.
    hasAudio: audioPath !== "",
    staged: r.staged === true,
    endedIso: r.ended_at ?? "",
  };
}
