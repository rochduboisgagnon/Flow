import fs from "node:fs";
import path from "node:path";
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
  sanitizeStatsFile,
  type PendingDay,
  type StatsFile,
  type StatsPayload,
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

export interface StatsStoreDeps {
  /** Absolute path of stats.json. A closure, never a captured string:
   * dataDir() caches the POST-migration folder on its first call, and this
   * store is constructed at module load, before the migration has run. */
  file(): string;
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
  private ensureLoaded(): StatsFile {
    if (this.loaded) return this.loaded;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.deps.file(), "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // A fresh install has no file: that is normal and silent. Anything else
        // is worth one line, because the counters are about to start from zero.
        this.loadError = `stats.json could not be read (${err instanceof Error ? err.message : String(err)}); the counters start from empty`;
        this.deps.log?.(`[stats] ${this.loadError}`);
      }
      this.loaded = emptyStatsFile();
      return this.loaded;
    }
    const { file, error } = sanitizeStatsFile(raw);
    this.loadError = error;
    if (error) this.deps.log?.(`[stats] ${error}`);
    this.loaded = file;
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
  private write(file: StatsFile): boolean {
    const p = this.deps.file();
    const tmp = p + ".tmp";
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
      fs.renameSync(tmp, p);
      this.reportedWriteFailure = false;
      return true;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true }); // never leave a half-written .tmp behind
      } catch {
        /* the cleanup failing changes nothing about the failure we are reporting */
      }
      if (!this.reportedWriteFailure) {
        this.reportedWriteFailure = true;
        this.deps.log?.(
          `[stats] stats.json could not be written (${err instanceof Error ? err.message : String(err)}); ` +
            "counters are kept in memory and retried. Further occurrences are not logged.",
        );
      }
      return false;
    }
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
    const p = this.deps.file();
    try {
      fs.rmSync(p, { force: true });
      fs.rmSync(p + ".tmp", { force: true }); // a .tmp orphaned by a crash holds the same data
    } catch (err) {
      this.deps.log?.(`[stats] stats.json could not be deleted (${err instanceof Error ? err.message : String(err)})`);
    }
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
