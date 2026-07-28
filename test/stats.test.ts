import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_APPS_PER_DAY,
  MAX_APP_NAME_CHARS,
  MAX_APP_SHARES,
  MAX_DAYS,
  RETENTION_MONTHS,
  STATS_VERSION,
  computeStreak,
  dayKey,
  deriveStats,
  mergeDays,
  previousDay,
  purgeDays,
  retentionCutoff,
  sanitizeStatsFile,
  type PendingDay,
  type StatsDay,
} from "../src/shared/stats";

// U7: the statistics MODEL - the day shape, the rolling window, the tiles, and
// above all the WRITE GATE that keeps per-application attribution out of the
// file unless the user turned it on. The store's own proof (a real file on a
// real disk, read back byte by byte) is in test/stats-store.test.ts; this file
// pins the rules that decide what that file may contain.

function day(date: string, over: Partial<StatsDay> = {}): StatsDay {
  return { date, words: 10, ms: 60_000, utterances: 2, ...over };
}

function pending(date: string, over: Partial<PendingDay> = {}): PendingDay {
  return { date, words: 5, ms: 30_000, utterances: 1, apps: {}, ...over };
}

// ---------------------------------------------------------------------------
// day keys and date arithmetic
// ---------------------------------------------------------------------------

test("dayKey is the LOCAL calendar day, zero-padded", () => {
  // Built from local components on purpose: a UTC key would file a Montreal
  // evening under tomorrow and break the streak the user can see (module note).
  assert.equal(dayKey(new Date(2026, 6, 27, 20, 30)), "2026-07-27");
  assert.equal(dayKey(new Date(2026, 0, 5, 0, 0)), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("previousDay walks calendar days, month and year boundaries included", () => {
  assert.equal(previousDay("2026-07-27"), "2026-07-26");
  assert.equal(previousDay("2026-07-01"), "2026-06-30");
  assert.equal(previousDay("2026-01-01"), "2025-12-31");
  assert.equal(previousDay("2024-03-01"), "2024-02-29", "2024 is a leap year");
});

test("retentionCutoff is the same calendar day twelve months back, clamped to a real date", () => {
  assert.equal(retentionCutoff("2026-07-27"), "2025-07-27");
  assert.equal(RETENTION_MONTHS, 12);
  // The 31st of a month whose counterpart has no 31st must not roll forward
  // into the next month (plain Date.UTC arithmetic would give 2025-03-03).
  assert.equal(retentionCutoff("2026-03-31"), "2025-03-31");
  assert.equal(retentionCutoff("2024-02-29"), "2023-02-28");
});

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

test("purgeDays keeps the rolling twelve months and drops what is older", () => {
  const days = [
    day("2024-01-01"),
    day("2025-07-26"), // one day past the window
    day("2025-07-27"), // the anniversary day itself: out (window is exclusive)
    day("2025-07-28"), // in
    day("2026-07-27"), // today
  ];
  assert.deepEqual(
    purgeDays(days, "2026-07-27").map((d) => d.date),
    ["2025-07-28", "2026-07-27"],
  );
});

test("purgeDays on an empty history is an empty history, not a throw", () => {
  assert.deepEqual(purgeDays([], "2026-07-27"), []);
});

// ---------------------------------------------------------------------------
// mergeDays - THE WRITE GATE
// ---------------------------------------------------------------------------

test("mergeDays adds a pending bucket to the matching day and creates missing ones", () => {
  const out = mergeDays([day("2026-07-26"), day("2026-07-27")], [pending("2026-07-27"), pending("2026-07-28")], {
    perApp: false,
    todayKey: "2026-07-28",
  });
  assert.deepEqual(out.map((d) => d.date), ["2026-07-26", "2026-07-27", "2026-07-28"]);
  const merged = out.find((d) => d.date === "2026-07-27");
  assert.equal(merged?.words, 15, "10 on disk + 5 pending");
  assert.equal(merged?.ms, 90_000);
  assert.equal(merged?.utterances, 3);
  const created = out.find((d) => d.date === "2026-07-28");
  assert.deepEqual(created, { date: "2026-07-28", words: 5, ms: 30_000, utterances: 1 });
});

test("mergeDays with perApp OFF writes NO apps field - not even for days that already had one", () => {
  // This is the load-bearing clause of the whole policy: turning attribution
  // off is an ERASURE, not a pause. A "we stop adding names" implementation
  // would leave months of them sitting on disk after the user said stop.
  const onDisk = [day("2026-07-26", { apps: { "Microsoft Word": 40 } }), day("2026-07-27", { apps: { Slack: 10 } })];
  const out = mergeDays(onDisk, [pending("2026-07-27", { apps: { Slack: 5 } })], {
    perApp: false,
    todayKey: "2026-07-27",
  });
  for (const d of out) {
    assert.equal("apps" in d, false, `${d.date} still carries attribution after a perApp=false write`);
  }
  // And the counters themselves are untouched: turning attribution off does not
  // cost the user their word counts.
  assert.equal(out.find((d) => d.date === "2026-07-27")?.words, 15);
});

test("mergeDays with perApp ON keeps and sums attribution", () => {
  const out = mergeDays([day("2026-07-27", { apps: { Slack: 10, Word: 5 } })], [pending("2026-07-27", { apps: { Slack: 3 } })], {
    perApp: true,
    todayKey: "2026-07-27",
  });
  // Spread onto an ordinary object before comparing: the stored table has NO
  // prototype on purpose (emptyAppTable), and deepStrictEqual compares those.
  assert.deepEqual({ ...out[0].apps }, { Slack: 13, Word: 5 });
});

test("mergeDays purges the rolling window on every write, not only at read time", () => {
  // The promise is about what is ON DISK: a file that kept fourteen months and
  // filtered on display would still be fourteen months of history to leak.
  const out = mergeDays([day("2024-01-01"), day("2026-07-01")], [pending("2026-07-27")], {
    perApp: false,
    todayKey: "2026-07-27",
  });
  assert.deepEqual(out.map((d) => d.date), ["2026-07-01", "2026-07-27"]);
});

test("mergeDays ignores a pending bucket with a malformed date rather than writing it", () => {
  const out = mergeDays([], [pending("not-a-date"), pending("2026-07-27")], { perApp: false, todayKey: "2026-07-27" });
  assert.deepEqual(out.map((d) => d.date), ["2026-07-27"]);
});

test("mergeDays caps the applications recorded for one day", () => {
  const apps: Record<string, number> = {};
  for (let i = 0; i < MAX_APPS_PER_DAY + 20; i++) apps[`app-${i}`] = 1;
  const out = mergeDays([], [pending("2026-07-27", { apps })], { perApp: true, todayKey: "2026-07-27" });
  assert.equal(Object.keys(out[0].apps ?? {}).length, MAX_APPS_PER_DAY);
});

// ---------------------------------------------------------------------------
// Review constat 1: an application named after a member of Object.prototype
// ---------------------------------------------------------------------------
// The keys of `apps` are PROCESS NAMES from the focus probe, so `toString.exe`
// or `constructor.exe` is a file anyone can create with no privilege at all. On
// an ordinary object literal every one of those names is already "present", so
// the cap lets it through and the running total starts from the INHERITED
// FUNCTION - `function + words` is a string, and a string is what would reach a
// file whose schema promises a number. `__proto__` fails the other way round:
// assigning a number to it runs the setter, which ignores it, and that
// application's words vanish without a line of log.
//
// The tables are built with JSON.parse rather than with a literal on purpose:
// `{ __proto__: 5 }` in source is the prototype setter, while JSON.parse creates
// an honest own property - which is exactly what a stats.json holds.

/** An application table shaped like a hand-edited (or hostile) file: an
 * ORDINARY object whose own keys happen to be prototype member names. */
function hostileApps(json: string): Record<string, number> {
  return JSON.parse(json) as Record<string, number>;
}

test("a stored application named after a prototype member survives the parse as a NUMBER", () => {
  const raw = JSON.parse(
    '{"version":1,"days":[{"date":"2026-07-27","words":9,"ms":1000,"utterances":3,' +
      '"apps":{"toString":4,"constructor":3,"__proto__":2}}]}',
  );
  const { file } = sanitizeStatsFile(raw);
  const apps = file.days[0].apps ?? {};
  assert.equal(Object.getPrototypeOf(apps), null, "the table must carry no prototype to inherit from");
  assert.deepEqual(
    Object.entries(apps).sort(),
    [["__proto__", 2], ["constructor", 3], ["toString", 4]],
    "__proto__ is the one that disappears silently on an ordinary object",
  );
  for (const [name, n] of Object.entries(apps)) assert.equal(typeof n, "number", name);
});

test("addDay SUMS such a name instead of adding words to an inherited function", () => {
  const out = mergeDays(
    [day("2026-07-27", { apps: hostileApps('{"toString":4,"__proto__":2}') })],
    [pending("2026-07-27", { apps: hostileApps('{"toString":5,"__proto__":3,"valueOf":7}') })],
    { perApp: true, todayKey: "2026-07-27" },
  );
  const apps = out[0].apps ?? {};
  assert.deepEqual(
    Object.entries(apps).sort(),
    [["__proto__", 5], ["toString", 9], ["valueOf", 7]],
    "the second storey of the same defect: the merge accumulator was a plain literal",
  );
  for (const [name, n] of Object.entries(apps)) assert.equal(typeof n, "number", name);
  // And the serialized form is what the file will hold: numbers, no source code.
  assert.equal(JSON.stringify(apps).includes("native code"), false, JSON.stringify(apps));
});

test("a prototype name does not slip past the per-day application cap either", () => {
  // The cap test above only proves the cap counts; this one proves it cannot be
  // walked around by a name that every object already answers to.
  const full: Record<string, number> = {};
  for (let i = 0; i < MAX_APPS_PER_DAY; i++) full[`app-${i}`] = 1;
  const out = mergeDays(
    [day("2026-07-27", { apps: full })],
    [pending("2026-07-27", { apps: hostileApps('{"toString":9,"hasOwnProperty":9}') })],
    { perApp: true, todayKey: "2026-07-27" },
  );
  const names = Object.keys(out[0].apps ?? {});
  assert.equal(names.length, MAX_APPS_PER_DAY);
  assert.equal(names.includes("toString"), false, "a prototype key satisfied the 'already counted' test");
  assert.equal(names.includes("hasOwnProperty"), false);
});

// ---------------------------------------------------------------------------
// sanitizeStatsFile
// ---------------------------------------------------------------------------

test("sanitizeStatsFile: garbage and unknown versions start from empty, with a readable reason", () => {
  for (const bad of [null, undefined, 42, "nope", ["a"]]) {
    const r = sanitizeStatsFile(bad);
    assert.deepEqual(r.file.days, []);
    assert.ok(r.error, `expected a reason for ${JSON.stringify(bad)}`);
  }
  const wrongVersion = sanitizeStatsFile({ version: 2, days: [day("2026-07-27")] });
  assert.deepEqual(wrongVersion.file.days, []);
  assert.match(wrongVersion.error ?? "", /version/i);
});

test("sanitizeStatsFile: a normal file loads intact and raises no error", () => {
  const r = sanitizeStatsFile({ version: STATS_VERSION, days: [day("2026-07-26"), day("2026-07-27")] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.file.days.map((d) => d.date), ["2026-07-26", "2026-07-27"]);
  assert.equal(r.file.version, STATS_VERSION);
});

test("sanitizeStatsFile: unreadable entries are dropped and counted, the rest survives", () => {
  const r = sanitizeStatsFile({
    version: STATS_VERSION,
    days: [day("2026-07-26"), { date: "nope" }, 42, null, day("2026-07-27")],
  });
  assert.deepEqual(r.file.days.map((d) => d.date), ["2026-07-26", "2026-07-27"]);
  assert.match(r.error ?? "", /3 unreadable/);
});

test("sanitizeStatsFile: negative, fractional and non-numeric counters read as zero, never as a negative total", () => {
  const r = sanitizeStatsFile({
    version: STATS_VERSION,
    days: [{ date: "2026-07-27", words: -5, ms: "60000", utterances: 2.7 }],
  });
  assert.deepEqual(r.file.days[0], { date: "2026-07-27", words: 0, ms: 0, utterances: 2 });
});

test("sanitizeStatsFile: a duplicated date collapses into one bucket instead of double-counting", () => {
  const r = sanitizeStatsFile({
    version: STATS_VERSION,
    days: [day("2026-07-27", { words: 10 }), day("2026-07-27", { words: 7 })],
  });
  assert.equal(r.file.days.length, 1);
  assert.equal(r.file.days[0].words, 17);
});

test("sanitizeStatsFile: application names are trimmed, bounded, and empty maps are not kept", () => {
  const long = "x".repeat(MAX_APP_NAME_CHARS + 50);
  const r = sanitizeStatsFile({
    version: STATS_VERSION,
    days: [
      { date: "2026-07-26", words: 1, ms: 1, utterances: 1, apps: { "  Slack  ": 4, [long]: 2, empty: 0, "": 9 } },
      { date: "2026-07-27", words: 1, ms: 1, utterances: 1, apps: {} },
      { date: "2026-07-28", words: 1, ms: 1, utterances: 1, apps: "not an object" },
    ],
  });
  const first = r.file.days.find((d) => d.date === "2026-07-26");
  assert.deepEqual(Object.keys(first?.apps ?? {}).sort(), ["Slack", "x".repeat(MAX_APP_NAME_CHARS)].sort());
  // "apps: {}" and "no apps at all" are the same fact; only one of them is
  // ever stored, which is what makes "no attribution = no apps key" checkable.
  assert.equal("apps" in (r.file.days.find((d) => d.date === "2026-07-27") ?? {}), false);
  assert.equal("apps" in (r.file.days.find((d) => d.date === "2026-07-28") ?? {}), false);
});

test("sanitizeStatsFile: a file over the day cap keeps the MOST RECENT days", () => {
  const dates: string[] = [];
  for (let i = 0; i < MAX_DAYS + 10; i++) {
    dates.push(new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
  }
  const r = sanitizeStatsFile({
    version: STATS_VERSION,
    days: dates.map((date) => ({ date, words: 1, ms: 1, utterances: 1 })),
  });
  assert.equal(r.file.days.length, MAX_DAYS);
  assert.match(r.error ?? "", new RegExp(`over the ${MAX_DAYS} cap`));
  // The OLDEST are the ones dropped: every tile reads the recent end.
  assert.equal(r.file.days[r.file.days.length - 1].date, dates[dates.length - 1]);
  assert.equal(r.file.days[0].date, dates[10]);
});

// ---------------------------------------------------------------------------
// streak
// ---------------------------------------------------------------------------

test("computeStreak counts consecutive days ending today", () => {
  const days = [day("2026-07-25"), day("2026-07-26"), day("2026-07-27")];
  assert.equal(computeStreak(days, "2026-07-27"), 3);
});

test("computeStreak still counts a run that ended YESTERDAY (a streak breaks after a whole day, not at midnight)", () => {
  // Without this, every user would see their 40-day run read 0 each morning
  // until their first dictation - discouraging AND false.
  const days = [day("2026-07-25"), day("2026-07-26")];
  assert.equal(computeStreak(days, "2026-07-27"), 2);
});

test("computeStreak is zero when the last dictation is two days old, and stops at the first gap", () => {
  assert.equal(computeStreak([day("2026-07-20"), day("2026-07-25")], "2026-07-27"), 0);
  assert.equal(
    computeStreak([day("2026-07-20"), day("2026-07-25"), day("2026-07-26"), day("2026-07-27")], "2026-07-27"),
    3,
  );
  assert.equal(computeStreak([], "2026-07-27"), 0);
});

test("computeStreak ignores a day that exists but holds no words", () => {
  const days = [day("2026-07-25"), day("2026-07-26", { words: 0 }), day("2026-07-27")];
  assert.equal(computeStreak(days, "2026-07-27"), 1);
});

// ---------------------------------------------------------------------------
// deriveStats - the tiles
// ---------------------------------------------------------------------------

test("deriveStats: an empty history gives zeros, never a placeholder", () => {
  const p = deriveStats({ version: STATS_VERSION, days: [] }, { todayKey: "2026-07-27", counting: true, perApp: false });
  assert.deepEqual(p.days, []);
  assert.equal(p.monthWords, 0);
  assert.equal(p.totalWords, 0);
  assert.equal(p.avgWpm, 0, "no data must read zero, not an invented average");
  assert.equal(p.streakDays, 0);
  assert.deepEqual(p.apps, []);
  assert.equal(p.ok, true);
  assert.equal(p.today, "2026-07-27");
  assert.equal(p.counting, true);
});

test("deriveStats: month words cover the CURRENT calendar month only", () => {
  const days = [day("2026-06-30", { words: 100 }), day("2026-07-01", { words: 30 }), day("2026-07-27", { words: 12 })];
  const p = deriveStats({ version: STATS_VERSION, days }, { todayKey: "2026-07-27", counting: true, perApp: false });
  assert.equal(p.monthWords, 42);
  assert.equal(p.totalWords, 142);
});

test("deriveStats: words per minute is words over SPOKEN minutes, rounded", () => {
  const days = [day("2026-07-26", { words: 150, ms: 60_000 }), day("2026-07-27", { words: 150, ms: 120_000 })];
  const p = deriveStats({ version: STATS_VERSION, days }, { todayKey: "2026-07-27", counting: true, perApp: false });
  assert.equal(p.avgWpm, 100, "300 words over 3 minutes");
});

test("deriveStats: application shares are summed, sorted, capped - and EMPTY when attribution is off", () => {
  const days = [
    day("2026-07-26", { apps: { Slack: 10, Word: 30 } }),
    day("2026-07-27", { apps: { Slack: 25, Notepad: 30 } }),
  ];
  const on = deriveStats({ version: STATS_VERSION, days }, { todayKey: "2026-07-27", counting: true, perApp: true });
  assert.deepEqual(on.apps, [
    { name: "Slack", words: 35 },
    { name: "Notepad", words: 30 },
    { name: "Word", words: 30 },
  ]);
  // Ties are broken by name so two consecutive reads of the same data cannot
  // reorder the bars under the user's eyes.
  const off = deriveStats({ version: STATS_VERSION, days }, { todayKey: "2026-07-27", counting: true, perApp: false });
  assert.deepEqual(off.apps, [], "a payload must never carry attribution the user did not enable");
  assert.equal(off.perApp, false);
});

test("deriveStats: the application list is capped for the page", () => {
  const apps: Record<string, number> = {};
  for (let i = 0; i < MAX_APP_SHARES + 15; i++) apps[`app-${String(i).padStart(2, "0")}`] = i + 1;
  const p = deriveStats({ version: STATS_VERSION, days: [day("2026-07-27", { apps })] }, {
    todayKey: "2026-07-27",
    counting: true,
    perApp: true,
  });
  assert.equal(p.apps.length, MAX_APP_SHARES);
  assert.equal(p.apps[0].words, MAX_APP_SHARES + 15, "the biggest share comes first");
});

test("deriveStats: days older than the window never reach the payload either", () => {
  const p = deriveStats({ version: STATS_VERSION, days: [day("2024-01-01", { words: 999 }), day("2026-07-27", { words: 5 })] }, {
    todayKey: "2026-07-27",
    counting: true,
    perApp: false,
  });
  assert.deepEqual(p.days.map((d) => d.date), ["2026-07-27"]);
  assert.equal(p.totalWords, 5);
});

test("deriveStats: a load error travels to the page and clears ok", () => {
  const p = deriveStats({ version: STATS_VERSION, days: [] }, {
    todayKey: "2026-07-27",
    counting: true,
    perApp: false,
    error: "stats.json did not load intact",
  });
  assert.equal(p.ok, false);
  assert.match(p.error ?? "", /did not load intact/);
});
