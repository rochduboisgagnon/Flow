// B2 : ni `fs` ni `path`. `sanitizeStatsFile` part avec eux - elle protegeait
// contre un stats.json ecrit a la main ou corrompu, et il n'y a plus de
// fichier. Ce qui vient du compte est deja passe par les conversions du depot
// (main/data/repo.ts).
import {
  STATS_VERSION,
  MAX_APPS_PER_DAY,
  MAX_APP_NAME_CHARS,
  MAX_DAYS,
  dayKey,
  deriveStats,
  emptyAppTable,
  emptyStatsFile,
  mergeDays,
  type PendingDay,
  type StatsFile,
  type StatsPayload,
  type StatsDay,
} from "../shared/stats";

// U7b: the statistics STORE - ~/.flow/stats.json and the in-memory accumulator
// that feeds it. The model, the retention rule and the tiles are pure in
// shared/stats.ts (read its module note first: the privacy policy IS the
// specification); this file is the disk and the timer, nothing else.
//
// ---------------------------------------------------------------------------
// NEVER ON THE HOT PATH
// ---------------------------------------------------------------------------
// record() does arithmetic on a Map and returns. No read, no write, no stat,
// no JSON. This process carries the low-level keyboard hook: Windows removes a
// hook that overruns its budget WITHOUT telling the application, and the whole
// previous wave was spent taking synchronous I/O OFF this thread (the buffered
// logger, the cached `recent` list, the 15 s legacy-folder probe). Adding one
// disk write per utterance to count words would put it right back, for the
// least important feature in the app. So the disk is touched on a 60 s timer
// and at before-quit, and the worst case of a hard kill is up to a minute of
// counters - a trade nobody will ever notice, unlike a dropped keystroke.
//
// ---------------------------------------------------------------------------
// SEPARATE FILE, LIKE snippets.json AND FOR A SECOND REASON
// ---------------------------------------------------------------------------
// settings.json is rewritten WHOLE on every applySettings(), including from the
// dictation path. Counters that tick all day inside it would mean rewriting the
// user's configuration all day. And the reverse: sanitizeSettings() falls back
// to defaults on a malformed byte, so a corrupt counter would take the settings
// with it. Two files, two failure domains.
//
// ---------------------------------------------------------------------------
// SINGLE WRITER
// ---------------------------------------------------------------------------
// One Flow process owns this file (the app holds a single-instance lock), so
// the loaded copy is cached in memory and re-serialized whole at each flush
// rather than re-read every minute. A file edited by hand under a running Flow
// is overwritten at the next flush; that is the documented cost of caching, and
// it is the same bargain settings.json already makes.

/** How often the accumulator is written out. Long enough that the write is
 * rare, short enough that a crash costs a minute of counters, never more. */
export const FLUSH_INTERVAL_MS = 60_000;

export interface StatsBacking {
  readStats(): StatsDay[];
  writeStatsDay(d: StatsDay): void;
  deleteStatsDay(day: string): void;
  clearStats(): void;
}

export interface StatsStoreDeps {
  /** B2 : stats.json a disparu. Le magasin du compte le remplace ; null tant
   * que rien n'est charge - les compteurs s'accumulent alors en memoire et
   * partent au premier vidage qui trouve un magasin. */
  backing(): StatsBacking | null;
  /** settings.stats - aggregated counters are being written at all. */
  counting(): boolean;
  /** settings.statsPerApp - per-application attribution is allowed. Read at
   * every record AND at every write (see flush): the switch takes effect on
   * the spot, in both directions. */
  perApp(): boolean;
  /** Injectable clock - the retention tests need a machine whose "today" is a
   * year from now without waiting for one. */
  now?(): Date;
  log?(msg: string): void;
  /** Test seam only; production uses FLUSH_INTERVAL_MS. */
  flushIntervalMs?: number;
}

/** What one finished dictation contributes. `text` is deliberately NOT part of
 * this shape: the caller counts the words (shared/wordCount.ts) and hands over
 * a number, so no dictated text is ever passed into the statistics subsystem in
 * the first place - the zero-retention rule holds at the type level. */
export interface StatsUtterance {
  words: number;
  /** Spoken milliseconds (the press, minus any pre-roll credit) - what makes
   * the words-per-minute tile a speaking rate rather than a decode rate. */
  ms: number;
  /** Foreground application, as the focus probe saw it. Passed in ALWAYS and
   * dropped HERE when attribution is off, so the decision lives in one place
   * (see record) instead of being re-taken at every call site. */
  app?: string;
}

export class StatsStore {
  private deps: StatsStoreDeps;
  /** One bucket per LOCAL day, never per utterance (shared/stats.ts note). */
  private pending = new Map<string, PendingDay>();
  private loaded: StatsFile | null = null;
  private loadError: string | undefined;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  /** A failing disk must not log the same line every minute forever. */
  private reportedWriteFailure = false;

  constructor(deps: StatsStoreDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** THE HOT PATH. Memory only - see the module note on why this may not touch
   * the disk. Called once per finished dictation, from main/index.ts. */
  record(u: StatsUtterance): void {
    if (!this.deps.counting()) return; // counters off: nothing is accumulated, so nothing can be written
    const words = Math.max(0, Math.floor(u.words));
    if (words === 0) return; // a gated/empty utterance is not a dictation to count
    const key = dayKey(this.now());
    let bucket = this.pending.get(key);
    if (!bucket) {
      // Cannot grow without bound in practice (one key per day between two
      // 60 s flushes), but a clock jumping around must not turn this into a
      // leak either.
      if (this.pending.size >= MAX_DAYS) return;
      bucket = { date: key, words: 0, ms: 0, utterances: 0, apps: emptyAppTable() };
      this.pending.set(key, bucket);
    }
    bucket.words += words;
    bucket.ms += Math.max(0, Math.floor(u.ms));
    bucket.utterances += 1;
    // THE ATTRIBUTION GATE, FIRST HALF: with the switch off the name is not
    // even accumulated in memory. The second half is in mergeDays(), which
    // refuses to serialize an apps field at all - one gate would be enough to
    // be correct, two are what make it provable by reading the file.
    if (this.deps.perApp()) {
      const name = cleanAppName(u.app);
      // Object.hasOwn, never `name in`, and over a prototype-less table
      // (shared/stats.ts's emptyAppTable): the key is a process name, and
      // `constructor.exe` is an executable anyone can create.
      if (name && (Object.hasOwn(bucket.apps, name) || Object.keys(bucket.apps).length < MAX_APPS_PER_DAY)) {
        bucket.apps[name] = (bucket.apps[name] ?? 0) + words;
      }
    }
    this.dirty = true;
  }

  /** Lazily read the file. Never called by record(): the first dictation of a
   * session must not pay a synchronous read (module note). */
  /** Ce que le compte detient, ou un fichier vide quand rien n'est charge.
   *
   * Le resultat n'est PAS mis en cache tant qu'il n'y a pas de magasin : figer
   * « aucun compteur » condamnerait la session entiere, alors que le compte
   * finit de charger une seconde plus tard. Meme classe de defaut que le
   * trousseau interroge trop tot en A2 et que le dictionnaire en B2. */
  private ensureLoaded(): StatsFile {
    if (this.loaded) return this.loaded;
    const b = this.deps.backing();
    if (!b) return emptyStatsFile();
    this.loaded = { version: STATS_VERSION, days: b.readStats() };
    return this.loaded;
  }


  /**
   * Merge the accumulator into the file, purge the rolling window, write
   * atomically. A no-op when nothing changed, so the idle app writes nothing
   * at all.
   *
   * Deliberately NOT gated on counting(): the two places that already decide
   * are record(), which accumulates nothing while the switch is off, and
   * settingsChanged(), which erases outright and leaves nothing pending. A
   * third reading of the same switch here would be one more place to keep in
   * agreement with the other two, for a case they have both already handled.
   */
  flush(): void {
    if (!this.dirty) return;
    const file = this.ensureLoaded();
    const todayKey = dayKey(this.now());
    const days = mergeDays(file.days, [...this.pending.values()], {
      perApp: this.deps.perApp(),
      todayKey,
    });
    const next: StatsFile = { version: STATS_VERSION, days };
    if (!this.write(next)) return; // keep pending + dirty: the next flush retries the same merge
    this.loaded = next;
    this.pending.clear();
    this.dirty = false;
  }

  /** Atomic write (tmp + rename), mirror of settings.ts's saveSettings and
   * snippets.ts's saveSnippetsFile: a crash mid-save must not leave a
   * half-written counter file behind. Returns false instead of throwing - a
   * full disk or an antivirus holding the file open (Bitdefender does exactly
   * this on this machine) may not take a dictation session down with it. */
  /**
   * Envoie les journees qui ont bouge, une par une.
   *
   * PAS LE FICHIER ENTIER, et la raison est la meme que pour le dictionnaire :
   * ecrire tout l'historique ferait qu'une machine ecraserait les journees que
   * l'autre vient d'enregistrer. Une journee a la fois laisse la base fusionner
   * - et `stats_days` a justement pour clef (compte, jour).
   *
   * Rend vrai des que le magasin existe : l'envoi lui-meme part en
   * arriere-plan par la copie de travail, qui a sa propre file et ses propres
   * reprises. Ce module n'a plus a savoir si le reseau repond.
   */
  /**
   * Envoie ce qui a CHANGE, journee par journee.
   *
   * PAS SEULEMENT LES JOURNEES DE CETTE SESSION, et c'est le defaut que les
   * tests ont trouve. La premiere version n'envoyait que les journees en
   * attente - celles ou quelqu'un vient de dicter. Deux promesses passaient
   * alors a la trappe, sans que rien n'echoue :
   *
   *  - eteindre l'attribution par application doit effacer les noms DEJA
   *    enregistres, y compris ceux de la semaine derniere. C'est une promesse
   *    de confidentialite, pas une preference d'affichage.
   *  - les journees trop vieilles doivent disparaitre du compte, et elles ne
   *    sont evidemment jamais « en attente ».
   *
   * D'ou la comparaison avec ce qui etait charge, et la SUPPRESSION des
   * journees qui ont disparu du resultat fusionne.
   *
   * Journee par journee, jamais l'historique entier : `stats_days` a pour clef
   * (compte, jour), et ecrire tout ferait qu'une machine ecraserait les
   * journees que l'autre vient d'enregistrer.
   */
  private write(file: StatsFile): boolean {
    const b = this.deps.backing();
    if (!b) return false; // pas de compte : on garde tout en memoire et on reessaie
    const before = new Map((this.loaded?.days ?? []).map((d) => [d.date, JSON.stringify(d)]));
    const after = new Set<string>();
    for (const d of file.days) {
      after.add(d.date);
      if (before.get(d.date) !== JSON.stringify(d)) b.writeStatsDay(d);
    }
    for (const date of before.keys()) {
      if (!after.has(date)) b.deleteStatsDay(date);
    }
    return true;
  }



  /** UI_STATS_READ. Derived from the file PLUS the not-yet-flushed buckets, so
   * a user who dictates and immediately opens the page sees the words they just
   * said instead of a total that is up to a minute stale. Reading never
   * writes. */
  read(): StatsPayload {
    const file = this.ensureLoaded();
    const todayKey = dayKey(this.now());
    const perApp = this.deps.perApp();
    const days = mergeDays(file.days, [...this.pending.values()], { perApp, todayKey });
    return deriveStats({ version: STATS_VERSION, days }, {
      todayKey,
      counting: this.deps.counting(),
      perApp,
      error: this.loadError,
    });
  }

  /**
   * UI_STATS_CLEAR (U7d): erase everything, NOW. The file is deleted rather
   * than rewritten empty - "clear my statistics" means nothing of mine is left
   * in that file, and an empty-but-present file is a weaker statement than an
   * absent one.
   *
   * The in-memory accumulator is dropped in the SAME breath, before anything
   * else can flush: clearing the disk while today's counters sat in a Map would
   * have the next flush resurrect exactly what the user just erased.
   */
  clear(): StatsPayload {
    this.erase();
    return this.read();
  }

  /** Everything `clear` means, without the payload: the file AND the
   * accumulator, gone, in the same breath. Shared with the counters switch
   * (settingsChanged) and with the boot check (start), because those three are
   * the same promise made at three moments. */
  private erase(): void {
    this.pending.clear();
    this.loaded = emptyStatsFile();
    this.loadError = undefined;
    this.dirty = false;
    // B2 : le compte, pas le fichier. Et pas non plus le `.tmp` orphelin d'un
    // plantage - il n'y a plus de fichier temporaire parce qu'il n'y a plus
    // d'ecriture atomique a proteger.
    this.deps.backing()?.clearStats();
  }


  /**
   * The two settings changed. Called from applySettings(), and it is what makes
   * both switches act immediately rather than "from the next dictation on":
   *
   *  - attribution turned OFF: strip what is accumulated in memory AND rewrite
   *    the file without any apps field. Turning it off is an erasure, not a
   *    pause (shared/stats.ts's mergeDays).
   *  - counters turned OFF: DELETE stats.json, and the accumulator with it.
   *
   * That second rule is the review's constat 2, and the decision behind it: a
   * switch that only stopped ADDING left up to twelve months of counters - and,
   * if attribution had ever been on, of application names - sitting on disk
   * under a page that says "Flow keeps no figures at all". The attribution
   * switch already settled the principle one storey down (off means the names
   * already written are erased, which is what makes the promise true
   * PERMANENTLY rather than from now on); the master switch cannot mean less
   * than the switch it contains.
   *
   * The cost is real and belongs in the open: turning counting off destroys the
   * history, streak included, and no undo exists. It is accepted because these
   * are DERIVED counters - unlike a snippet library or a dictionary, nothing
   * here was typed by hand and nothing is unrecoverable except the fact that
   * time passed - and because the alternative is a page that lies. The page
   * owns the confirmation that makes the click deliberate.
   */
  settingsChanged(): void {
    if (!this.deps.counting()) {
      // Subsumes the attribution strip below: a deleted file holds no names.
      this.erase();
      return;
    }
    // Does the FILE hold attribution the switch now forbids? Asked INSIDE the
    // guard, so ensureLoaded only ever runs with attribution off - on a
    // deliberate click, never on the dictation path. Loading here rather than
    // reading a possibly-null cache is the point: a user who turns attribution
    // off before the first dictation of the session must still see the names
    // already on disk erased now.
    if (!this.deps.perApp()) {
      const mustStripFile = this.ensureLoaded().days.some((d) => d.apps !== undefined);
      for (const bucket of this.pending.values()) bucket.apps = emptyAppTable();
      if (mustStripFile) this.dirty = true;
    }
    this.flush();
  }

  start(): void {
    // Boot is the third moment the counters-off promise has to be made true.
    // Without this, a machine whose file predates the switch being turned off -
    // an upgrade, a restored backup, a hand-copied ~/.flow - would keep serving
    // twelve months of counters to a page that says none are kept, and would go
    // on doing so until the user happened to touch a setting.
    if (!this.deps.counting()) this.erase();
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.deps.flushIntervalMs ?? FLUSH_INTERVAL_MS);
    // A counter timer has no business keeping a process alive on its own.
    this.timer.unref?.();
  }

  /** before-quit: the last flush, synchronously, while the process still
   * exists. Same reasoning and the same place in the sequence as the log
   * queue's flushSync - whatever is only in memory at this instant is lost
   * forever otherwise. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }
}

/** C0 controls plus DEL. Named rather than inlined so the eslint exemption
 * sits on one line that can be read for what it is. */
// eslint-disable-next-line no-control-regex -- matching control characters is the entire job
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** An application name is the one free-form string that ever reaches this
 * file, and it comes from a PowerShell probe reading whatever window happens to
 * be focused. Trim it, bound it, and drop control characters so a hostile
 * window title cannot smuggle newlines into a JSON file a human may open. */
function cleanAppName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_APP_NAME_CHARS).trim();
}
