// U7: the statistics MODEL - the day shape, the retention rule, and the tiles.
// Pure and Electron-free, so every rule below is unit-tested (test/stats.test.ts)
// without a window, a disk or a microphone. main/stats.ts is the thin disk
// layer on top; it owns the file and the accumulator, nothing else.
//
// ---------------------------------------------------------------------------
// THE PRIVACY POLICY, WHICH IS THE SPECIFICATION (Roch, 2026-07-27, plan §10)
// ---------------------------------------------------------------------------
//  1. AGGREGATED COUNTERS ARE WRITTEN: words per day, words per minute, day
//     streaks. Never a word of what was dictated, never an excerpt, never the
//     timestamp of an individual utterance.
//  2. PER-APPLICATION ATTRIBUTION IS NOT WRITTEN BY DEFAULT. The focus probe
//     (main/focus/probe.ts) has always SEEN the foreground application's name -
//     it has never stored it - and a log of which app you were typing in, hour
//     by hour, reveals working habits that are arguably more sensitive than the
//     text itself. One explicit switch, OFF at install, turns it on.
//  3. TWELVE ROLLING MONTHS, aggregated by day, with a button that erases
//     everything on the spot.
//
// THE LOAD-BEARING DESIGN DECISION: the aggregation happens at WRITE time, not
// at read time. A file holding one record per utterance would already be the
// leak - the timestamps alone would reconstruct a minute-by-minute log of
// someone's day - even if the page only ever displayed the sum. So there is no
// per-utterance record anywhere: main/stats.ts accumulates into a per-DAY
// bucket in memory and this module merges that bucket into a per-DAY file.
// The same reasoning applies one level down to `apps`: mergeDays() with
// perApp=false does not merely skip NEW attribution, it strips the field from
// every day it writes, so turning the switch off erases what was collected
// while it was on rather than leaving it on disk forever.
//
// WHY THE PARSER IS TOLERANT (unlike main/snippets.ts, which freezes writes on
// a file it did not fully understand): a snippet library is content the user
// typed by hand and cannot re-create; statistics are DERIVED data. A corrupt
// stats.json costs nobody anything but a chart, and refusing to write would
// mean a broken counter file permanently disables the counter. So this parses
// like settings.ts does - keep what is recognizable, drop the rest, never
// throw. The one thing it must never do is INVENT a day.

export const STATS_VERSION = 1 as const;

/** Rolling retention, in months (policy point 3). */
export const RETENTION_MONTHS = 12;

/** Hard cap on stored days. 12 months is at most 366 entries; the extra room
 * absorbs a clock that jumped forward and back without letting a hand-edited
 * or corrupt file grow the parse (and the IPC payload) without bound. */
export const MAX_DAYS = 400;

/** Per day, how many distinct applications may be attributed. A machine can
 * legitimately touch a couple of dozen apps in a day; past that it is noise or
 * a misbehaving probe, and this file is read and rewritten WHOLE on every
 * flush. Overflow is dropped, never merged into an "other" bucket - inventing
 * a total for apps we refused to name would be a chart that lies. */
export const MAX_APPS_PER_DAY = 40;

/** An application name is a window/process name from the focus probe. Bounded
 * because it is the only free-form string that ever reaches this file. */
export const MAX_APP_NAME_CHARS = 120;

/** How many application shares the payload carries. The page draws bars; a
 * hundred bars is not a chart. The rest is simply not sent. */
export const MAX_APP_SHARES = 12;

/** One DAY of dictation. The only granularity that exists anywhere in this
 * feature - there is deliberately no utterance-level shape to hold. */
export interface StatsDay {
  /** YYYY-MM-DD, the user's LOCAL calendar day (see dayKey). */
  date: string;
  words: number;
  /** Spoken milliseconds these words took - what makes words-per-minute a
   * speaking rate rather than a decode rate. */
  ms: number;
  utterances: number;
  /** Words per application. EXISTS ONLY when statsPerApp is on: mergeDays()
   * refuses to write this field otherwise (module note). */
  apps?: Record<string, number>;
}

export interface StatsFile {
  version: typeof STATS_VERSION;
  days: StatsDay[];
}

/** One bar of the "Where you dictate" panel. */
export interface StatsAppShare {
  name: string;
  words: number;
}

/** Everything the Statistics page renders, computed HERE so the page never has
 * to know the shape of the file (nor be tempted to re-derive a tile its own
 * way). PULL-only, like snippets and history: never in UiStatePayload, which
 * is re-serialized every second while the window is visible. */
export interface StatsPayload {
  ok: boolean;
  /** settings.stats - counters are being written at all. */
  counting: boolean;
  /** settings.statsPerApp - attribution is being written. */
  perApp: boolean;
  /** Ascending by date, at most 12 rolling months. Empty is a real answer (a
   * fresh install), never a reason to invent a demo curve. */
  days: StatsDay[];
  /** Words in the CURRENT calendar month (the "words this month" tile). */
  monthWords: number;
  /** Words over the whole retained window. */
  totalWords: number;
  /** Average speaking rate over the retained window, rounded. 0 when there is
   * nothing to average - never a placeholder number. */
  avgWpm: number;
  /** Consecutive days with at least one word, ending today or yesterday (see
   * computeStreak for why yesterday counts). */
  streakDays: number;
  /** Descending by words, capped at MAX_APP_SHARES. ALWAYS empty when perApp
   * is off, whatever happens to be on disk. */
  apps: StatsAppShare[];
  /** The local day the tiles were computed against, so the page can label
   * "this month" without a second, possibly different, clock reading. */
  today: string;
  /** Human-readable, shown as-is by the page. */
  error?: string;
}

/** What main/stats.ts accumulates in memory between two flushes: one bucket
 * per local day, never per utterance (module note). */
export interface PendingDay {
  date: string;
  words: number;
  ms: number;
  utterances: number;
  /** Only ever filled while statsPerApp is on - and stripped again at write
   * time if it went off in between. */
  apps: Record<string, number>;
}

export function emptyStatsFile(): StatsFile {
  return { version: STATS_VERSION, days: [] };
}

/**
 * An application table with NO prototype - and the reason every `apps` object in
 * this feature is built here instead of with a `{}` literal.
 *
 * Its keys are PROCESS NAMES, handed over raw by the focus probe, and an
 * executable called `constructor.exe` or `valueOf.exe` is a file anyone can
 * create without a single privilege. On an ordinary object literal such a name
 * is already "there": `"toString" in {}` is true, so the per-day cap lets it
 * through as if it were an app we had already counted, and `apps[name] ?? 0`
 * yields the INHERITED FUNCTION - `function + words` is a string, and that
 * string is what would land in stats.json where the schema promises a number,
 * and on the page where it would be drawn as a word count. `__proto__` fails the
 * other way: assigning a number to it on a normal object runs the setter, which
 * ignores it, so that application's words disappear without one line of log.
 *
 * Object.create(null) removes the whole class at the source - nothing to
 * inherit, `__proto__` an ordinary key - and changes nothing about
 * JSON.stringify, Object.entries or Object.keys. The Object.hasOwn tests around
 * the callers are belt AND braces: they keep the invariant readable at the two
 * places where it actually decides something.
 */
export function emptyAppTable(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

/**
 * The user's LOCAL calendar day as YYYY-MM-DD.
 *
 * Local, not UTC, and it matters: dictating at 20:00 in Montreal is 00:00 UTC
 * the NEXT day, so a UTC key would file half of every evening under tomorrow,
 * break the streak the user can see with their own eyes, and put "words this
 * month" a day out at every month boundary. The cost is that a machine which
 * changes time zone re-labels nothing retroactively, which is the right
 * trade: the day a thing happened is the day the user was living in.
 */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(v: unknown): v is string {
  return typeof v === "string" && DAY_RE.test(v);
}

/** Day arithmetic on the KEY, through Date.UTC on purpose: the keys are
 * calendar labels, and doing this in local time would make a day that contains
 * a DST switch either 23 or 25 hours long and drop or duplicate a key. */
function shiftDays(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86_400_000;
  const out = new Date(t);
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, "0")}-${String(out.getUTCDate()).padStart(2, "0")}`;
}

export function previousDay(key: string): string {
  return shiftDays(key, -1);
}

/**
 * The oldest day the file may keep: the same calendar day RETENTION_MONTHS
 * back. Days are kept when `date > cutoff`, so the window is the last twelve
 * months not counting that anniversary day itself - a rolling window with no
 * fencepost ambiguity to argue about later.
 */
export function retentionCutoff(todayKey: string): string {
  const [y, m, d] = todayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 - RETENTION_MONTHS, 1));
  // Clamp the day of month: 12 months back from the 31st of a month that has
  // no 31st must not roll into the following month (Date.UTC would).
  const lastOfMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastOfMonth);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Drop everything older than the rolling window. Called on EVERY write (never
 * only at read time): the promise is about what is ON DISK. Date strings in
 * YYYY-MM-DD compare correctly with a plain string comparison, which is the
 * whole reason the key has that shape. */
export function purgeDays(days: readonly StatsDay[], todayKey: string): StatsDay[] {
  const cutoff = retentionCutoff(todayKey);
  return days.filter((d) => d.date > cutoff);
}

function positiveInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Read one stored day. Anything unrecognizable yields undefined: this parser
 * keeps what it understands and drops the rest (module note), but it never
 * invents a day out of a broken entry. */
function readStoredDay(raw: unknown): StatsDay | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isDayKey(r.date)) return undefined;
  const out: StatsDay = {
    date: r.date,
    words: positiveInt(r.words),
    ms: positiveInt(r.ms),
    utterances: positiveInt(r.utterances),
  };
  if (typeof r.apps === "object" && r.apps !== null && !Array.isArray(r.apps)) {
    // Prototype-less: a stored `"__proto__": 12` is an own property after
    // JSON.parse, and writing it into a `{}` literal would silently drop it.
    const apps = emptyAppTable();
    let kept = 0;
    for (const [name, words] of Object.entries(r.apps as Record<string, unknown>)) {
      if (kept >= MAX_APPS_PER_DAY) break;
      const clean = name.trim().slice(0, MAX_APP_NAME_CHARS);
      const n = positiveInt(words);
      if (!clean || n === 0) continue;
      apps[clean] = n;
      kept++;
    }
    // An empty map is not written: `apps` present-but-empty and `apps` absent
    // would be the same fact stored two ways, and the file-level promise
    // ("no attribution means no apps key") is easier to check with one.
    if (kept > 0) out.apps = apps;
  }
  return out;
}

/**
 * Tolerant read of an already-JSON.parsed value. Wrong version, wrong shape,
 * unreadable entries: all degrade to "what we could read", with a readable
 * note in `error` for the log - never a throw, never a refusal to write later
 * (see the module note on why this differs from main/snippets.ts).
 */
export function sanitizeStatsFile(raw: unknown): { file: StatsFile; error?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { file: emptyStatsFile(), error: "stats.json is not a JSON object; starting the counters from empty" };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== STATS_VERSION) {
    return {
      file: emptyStatsFile(),
      error: `stats.json has version ${JSON.stringify(r.version)}, which this build does not understand; starting the counters from empty`,
    };
  }
  const rawDays = Array.isArray(r.days) ? r.days : [];
  const byDate = new Map<string, StatsDay>();
  let dropped = 0;
  for (const it of rawDays) {
    const day = readStoredDay(it);
    if (!day) {
      dropped++;
      continue;
    }
    // A duplicated date in a hand-edited file collapses into one bucket rather
    // than producing two rows the tiles would double-count.
    const seen = byDate.get(day.date);
    byDate.set(day.date, seen ? addDay(seen, day) : day);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const over = Math.max(0, days.length - MAX_DAYS);
  // Over the cap, the OLDEST go: the recent days are the ones every tile reads.
  const kept = over > 0 ? days.slice(over) : days;
  const notes: string[] = [];
  if (dropped > 0) notes.push(`${dropped} unreadable day ${dropped === 1 ? "entry" : "entries"} dropped`);
  if (over > 0) notes.push(`${over} days over the ${MAX_DAYS} cap dropped`);
  return {
    file: { version: STATS_VERSION, days: kept },
    error: notes.length > 0 ? `stats.json did not load intact: ${notes.join("; ")}` : undefined,
  };
}

/** Sum two buckets for the same date. Kept private-ish and total: both callers
 * (a duplicated date on load, a pending bucket at flush) must agree on what
 * "adding a day to a day" means, apps included. */
function addDay(base: StatsDay, extra: StatsDay | PendingDay): StatsDay {
  const out: StatsDay = {
    date: base.date,
    words: base.words + extra.words,
    ms: base.ms + extra.ms,
    utterances: base.utterances + extra.utterances,
  };
  // The SECOND storey of the prototype problem (main/stats.ts's record() is the
  // first): a spread of `base.apps` copies the right keys but hands back an
  // ordinary object, so `"toString" in merged` is true for an app nobody
  // counted - the cap is bypassed and the sum starts from a function.
  const merged = emptyAppTable();
  for (const [name, n] of Object.entries(base.apps ?? {})) merged[name] = n;
  for (const [name, n] of Object.entries(extra.apps ?? {})) {
    if (!Object.hasOwn(merged, name) && Object.keys(merged).length >= MAX_APPS_PER_DAY) continue;
    merged[name] = (merged[name] ?? 0) + n;
  }
  if (Object.keys(merged).length > 0) out.apps = merged;
  return out;
}

/**
 * THE WRITE GATE. Merge the in-memory buckets into the loaded file, purge the
 * rolling window, and - when `perApp` is off - guarantee that NO day carries an
 * `apps` field, including days written while it was on.
 *
 * That last clause is the one that makes the policy provable by reading the
 * file: it is not "we stop adding attribution", it is "a file written with the
 * switch off contains no application name at all". Turning the switch off is
 * therefore an erasure, not just a pause - which is what a user who turns it
 * off is asking for.
 */
export function mergeDays(
  base: readonly StatsDay[],
  pending: readonly PendingDay[],
  opts: { perApp: boolean; todayKey: string },
): StatsDay[] {
  const byDate = new Map<string, StatsDay>();
  for (const d of base) byDate.set(d.date, d);
  for (const p of pending) {
    if (!isDayKey(p.date)) continue;
    const seen = byDate.get(p.date);
    byDate.set(
      p.date,
      seen
        ? addDay(seen, p)
        : addDay({ date: p.date, words: 0, ms: 0, utterances: 0 }, p),
    );
  }
  const days = purgeDays([...byDate.values()], opts.todayKey).sort((a, b) => a.date.localeCompare(b.date));
  if (opts.perApp) return days;
  // Not a filter over the OUTPUT of a chart: the field is removed from the
  // object that is about to be serialized.
  return days.map(({ date, words, ms, utterances }) => ({ date, words, ms, utterances }));
}

/** Consecutive days with at least one word, ending today OR yesterday.
 *
 * Yesterday counts on purpose: a streak that resets at midnight would show a
 * user their 40-day run had become 0 every morning before their first
 * dictation, which is both discouraging and false - the run is not broken
 * until a WHOLE day goes by without a word. */
export function computeStreak(days: readonly StatsDay[], todayKey: string): number {
  const spoken = new Set(days.filter((d) => d.words > 0).map((d) => d.date));
  let cursor = todayKey;
  if (!spoken.has(cursor)) {
    cursor = previousDay(todayKey);
    if (!spoken.has(cursor)) return 0;
  }
  let streak = 0;
  while (spoken.has(cursor)) {
    streak++;
    cursor = previousDay(cursor);
  }
  return streak;
}

/**
 * The tiles, computed once, in main. `perApp` false empties `apps` in the
 * PAYLOAD too, so a page cannot render attribution out of a file that still
 * carried some when the switch was flipped a moment ago.
 */
export function deriveStats(
  file: StatsFile,
  opts: { todayKey: string; counting: boolean; perApp: boolean; error?: string },
): StatsPayload {
  const days = purgeDays(file.days, opts.todayKey).sort((a, b) => a.date.localeCompare(b.date));
  const month = opts.todayKey.slice(0, 7);
  let monthWords = 0;
  let totalWords = 0;
  let totalMs = 0;
  const appTotals = new Map<string, number>();
  for (const d of days) {
    totalWords += d.words;
    totalMs += d.ms;
    if (d.date.startsWith(month)) monthWords += d.words;
    if (!opts.perApp) continue;
    for (const [name, n] of Object.entries(d.apps ?? {})) {
      appTotals.set(name, (appTotals.get(name) ?? 0) + n);
    }
  }
  const apps = [...appTotals.entries()]
    .map(([name, words]) => ({ name, words }))
    // Ties broken by name so two runs on the same data produce the same order:
    // bars that reshuffle on every poll look like data changing when it is not.
    .sort((a, b) => b.words - a.words || a.name.localeCompare(b.name))
    .slice(0, MAX_APP_SHARES);
  return {
    ok: opts.error === undefined,
    counting: opts.counting,
    perApp: opts.perApp,
    days,
    monthWords,
    totalWords,
    // Zero, not a guess, when there is nothing to average.
    avgWpm: totalMs > 0 ? Math.round(totalWords / (totalMs / 60_000)) : 0,
    streakDays: computeStreak(days, opts.todayKey),
    apps,
    today: opts.todayKey,
    error: opts.error,
  };
}
