import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatsStore } from "../src/main/stats";
import { countWords } from "../src/shared/wordCount";
import { MAX_APPS_PER_DAY, STATS_VERSION } from "../src/shared/stats";

// U7b/U7e: THE PROOF BY THE FILE.
//
// The review of this wave has to be able to say "nothing beyond the policy is
// written" by READING THE BYTES ON DISK - not by reading the code and trusting
// it. So every test below drives the real store, against a real file in a temp
// folder (never the machine's own ~/.flow), simulates dictations through the
// exact entry point main/index.ts calls, flushes, and then opens the file.
//
// The two halves that make an absence assertion mean something:
//   1. with attribution OFF, no application name appears anywhere in the file;
//   2. with attribution ON, those same names DO appear.
// Without (2), (1) would also pass on a store that simply never received the
// names - which would prove nothing about the gate.

interface Fixture {
  dir: string;
  file: string;
  store: StatsStore;
  /** Mutable so a test can flip a switch mid-run, exactly as applySettings
   * does (the store reads these through closures, never a snapshot). */
  settings: { counting: boolean; perApp: boolean };
  now: { value: Date };
  raw(): string;
  parsed(): { version: number; days: Array<Record<string, unknown>> };
  cleanup(): void;
}

function makeStore(over: Partial<{ counting: boolean; perApp: boolean; now: Date }> = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-stats-"));
  const file = path.join(dir, "stats.json");
  const settings = { counting: over.counting ?? true, perApp: over.perApp ?? false };
  const now = { value: over.now ?? new Date(2026, 6, 27, 10, 0, 0) };
  const store = new StatsStore({
    file: () => file,
    counting: () => settings.counting,
    perApp: () => settings.perApp,
    now: () => now.value,
  });
  return {
    dir,
    file,
    store,
    settings,
    now,
    raw: () => fs.readFileSync(file, "utf8"),
    parsed: () => JSON.parse(fs.readFileSync(file, "utf8")),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** One dictation, as main/index.ts records it: the TEXT is consumed by
 * countWords right here and never handed further - the store's own API takes a
 * number (main/stats.ts's StatsUtterance). */
function dictate(f: Fixture, text: string, ms: number, app: string): void {
  f.store.record({ words: countWords(text), ms, app });
}

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

test("PROOF BY THE FILE: dictating with attribution OFF writes no application name at all", () => {
  const f = makeStore({ perApp: false });
  const apps = ["Microsoft Word", "Slack", "chrome.exe", "Outlook"];
  for (const app of apps) {
    dictate(f, "Le rapport est pret pour la reunion de demain.", 12_000, app);
    dictate(f, "J'ai relu la section sur l'automatisation.", 8_000, app);
  }
  f.store.flush();

  const raw = f.raw();
  for (const app of apps) {
    assert.ok(!raw.includes(app), `stats.json contains the application name ${JSON.stringify(app)}`);
  }
  assert.ok(!raw.includes("apps"), "stats.json still carries an apps field with attribution off");

  // And structurally: every stored day holds exactly the four aggregate fields.
  for (const d of f.parsed().days) {
    assert.deepEqual(Object.keys(d).sort(), ["date", "ms", "utterances", "words"]);
  }
  f.cleanup();
});

test("the same run with attribution ON does write the names - so the test above is not vacuous", () => {
  const f = makeStore({ perApp: true });
  dictate(f, "Le rapport est pret.", 5_000, "Microsoft Word");
  dictate(f, "Merci beaucoup.", 2_000, "Slack");
  f.store.flush();

  const raw = f.raw();
  assert.ok(raw.includes("Microsoft Word"), "with the switch ON the name must be there, or the OFF test proves nothing");
  assert.ok(raw.includes("Slack"));
  const day = f.parsed().days[0];
  assert.deepEqual(day.apps, { "Microsoft Word": 4, Slack: 2 });
  f.cleanup();
});

test("PROOF BY THE FILE: no dictated word, and no time of day, ever reaches stats.json", () => {
  const f = makeStore({ perApp: true }); // the MOST permissive setting, on purpose
  const sentence = "Le contrat confidentiel avec Desjardins est signe depuis mardi.";
  dictate(f, sentence, 9_000, "Microsoft Word");
  dictate(f, "Rappelle-moi d'appeler Genevieve avant midi.", 6_000, "Microsoft Word");
  f.store.flush();

  const raw = f.raw();
  for (const word of ["contrat", "confidentiel", "Desjardins", "signe", "Genevieve", "Rappelle"]) {
    assert.ok(!raw.includes(word), `stats.json contains the dictated word ${JSON.stringify(word)}`);
  }
  // No utterance timestamp either: the file holds calendar DAYS, and a
  // per-utterance clock reading would reconstruct someone's working day even
  // without a single word of what they said.
  assert.ok(!/\d{2}:\d{2}/.test(raw), "stats.json carries a time of day somewhere");
  assert.ok(!/T\d/.test(raw), "stats.json carries an ISO timestamp somewhere");
  f.cleanup();
});

test("PROOF BY THE FILE: N dictations write ONE day object, never one record per utterance", () => {
  const f = makeStore();
  for (let i = 0; i < 25; i++) dictate(f, "un deux trois quatre cinq", 3_000, "Slack");
  f.store.flush();

  const parsed = f.parsed();
  assert.equal(parsed.version, STATS_VERSION);
  assert.equal(parsed.days.length, 1, "aggregation happens at WRITE time - the file must not grow per utterance");
  assert.equal(parsed.days[0].words, 125);
  assert.equal(parsed.days[0].utterances, 25);
  assert.equal(parsed.days[0].ms, 75_000);
  f.cleanup();
});

test("turning attribution OFF erases the names already on disk at the next write", () => {
  const f = makeStore({ perApp: true });
  dictate(f, "Bonjour tout le monde.", 4_000, "Microsoft Word");
  f.store.flush();
  assert.ok(f.raw().includes("Microsoft Word"));

  // Exactly what applySettings does: flip the setting, then tell the store.
  f.settings.perApp = false;
  f.store.settingsChanged();

  const raw = f.raw();
  assert.ok(!raw.includes("Microsoft Word"), "turning attribution off must ERASE what it collected, not merely pause");
  assert.ok(!raw.includes("apps"));
  // The counters themselves survive: the user gave up attribution, not history.
  assert.equal(f.parsed().days[0].words, 4);
  f.cleanup();
});

test("attribution accumulated between two flushes is dropped if the switch goes off first", () => {
  const f = makeStore({ perApp: true });
  dictate(f, "Bonjour tout le monde.", 4_000, "Microsoft Word"); // in memory only
  assert.equal(fs.existsSync(f.file), false);

  f.settings.perApp = false;
  f.store.settingsChanged();
  f.store.flush();

  assert.ok(!f.raw().includes("Microsoft Word"), "the in-memory bucket must be stripped too, not just the file");
  assert.equal(f.parsed().days[0].words, 4);
  f.cleanup();
});

test("turning attribution off erases the file even before this session has dictated once", () => {
  // The store loads lazily, so a fresh process that has never flushed holds no
  // copy of the file. Reading the switch must still erase what is on disk NOW,
  // not at whatever later moment something happens to make the store dirty.
  const f = makeStore({ perApp: true });
  dictate(f, "Bonjour tout le monde.", 4_000, "Microsoft Word");
  f.store.flush();

  const fresh = new StatsStore({
    file: () => f.file,
    counting: () => true,
    perApp: () => false, // the user turned it off, then restarted Flow
    now: () => f.now.value,
  });
  fresh.settingsChanged();
  assert.ok(!f.raw().includes("Microsoft Word"));
  assert.equal(f.parsed().days[0].words, 4);
  f.cleanup();
});

// ---------------------------------------------------------------------------
// the counters switch
// ---------------------------------------------------------------------------

test("with the counters OFF nothing is accumulated and no file is ever created", () => {
  const f = makeStore({ counting: false });
  for (let i = 0; i < 10; i++) dictate(f, "un deux trois", 2_000, "Slack");
  f.store.flush();
  assert.equal(fs.existsSync(f.file), false, "counters off must not even create the file");
  const p = f.store.read();
  assert.equal(p.counting, false);
  assert.equal(p.totalWords, 0);
  f.cleanup();
});

test("turning the counters off drops what is in memory before it can be written", () => {
  const f = makeStore({ counting: true });
  dictate(f, "un deux trois", 2_000, "Slack");
  f.settings.counting = false;
  f.store.settingsChanged();
  f.store.flush();
  assert.equal(fs.existsSync(f.file), false);
  f.cleanup();
});

// ---------------------------------------------------------------------------
// the hot path, retention, atomicity
// ---------------------------------------------------------------------------

test("record() alone touches NO disk: the dictation path never writes", () => {
  const f = makeStore();
  for (let i = 0; i < 50; i++) dictate(f, "un deux trois quatre", 2_000, "Slack");
  assert.equal(fs.existsSync(f.file), false, "a write on the dictation path is exactly what this store must never do");
  assert.equal(fs.readdirSync(f.dir).length, 0, "not even a temp file");
  // ...and the numbers are all there, in memory, ready for the timer.
  assert.equal(f.store.read().totalWords, 200);
  f.cleanup();
});

test("read() reflects the not-yet-flushed buckets, so today's words are never a minute stale", () => {
  const f = makeStore();
  dictate(f, "un deux trois", 2_000, "Slack");
  const p = f.store.read();
  assert.equal(p.totalWords, 3);
  assert.equal(p.monthWords, 3);
  assert.equal(p.days.length, 1);
  assert.equal(p.today, "2026-07-27");
  assert.equal(fs.existsSync(f.file), false, "reading must not write");
  f.cleanup();
});

test("days older than twelve months are purged from the FILE at the next write", () => {
  const f = makeStore();
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();
  assert.ok(f.raw().includes("2026-07-27"));

  // A year and a month later, one more dictation.
  f.now.value = new Date(2027, 7, 27, 10, 0, 0);
  dictate(f, "quatre cinq", 2_000, "Slack");
  f.store.flush();

  const raw = f.raw();
  assert.ok(!raw.includes("2026-07-27"), "the rolling window is enforced on disk, not only on display");
  assert.deepEqual(f.parsed().days.map((d) => d.date), ["2027-08-27"]);
  f.cleanup();
});

test("the write is atomic: no .tmp survives a successful flush", () => {
  const f = makeStore();
  dictate(f, "un deux", 1_000, "Slack");
  f.store.flush();
  assert.deepEqual(fs.readdirSync(f.dir), ["stats.json"]);
  f.cleanup();
});

test("a second flush with nothing new does not rewrite the file", () => {
  const f = makeStore();
  dictate(f, "un deux", 1_000, "Slack");
  f.store.flush();
  const first = fs.statSync(f.file).mtimeMs;
  f.store.flush();
  f.store.flush();
  assert.equal(fs.statSync(f.file).mtimeMs, first, "an idle app must write nothing at all");
  f.cleanup();
});

test("counters survive a restart: a new store over the same file continues the totals", () => {
  const f = makeStore();
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();

  const second = new StatsStore({
    file: () => f.file,
    counting: () => true,
    perApp: () => false,
    now: () => f.now.value,
  });
  second.record({ words: 2, ms: 1_000 });
  second.flush();
  assert.equal(second.read().totalWords, 5);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).days.length, 1);
  f.cleanup();
});

// ---------------------------------------------------------------------------
// U7d: clear
// ---------------------------------------------------------------------------

test("clear() deletes the file on the spot and answers with an empty payload", () => {
  const f = makeStore();
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();
  assert.equal(fs.existsSync(f.file), true);

  const after = f.store.clear();
  assert.equal(fs.existsSync(f.file), false, "'clear my statistics' means the file is gone, not blanked");
  assert.equal(after.totalWords, 0);
  assert.deepEqual(after.days, []);
  assert.equal(after.streakDays, 0);
  // The page repaints from this payload without a restart.
  assert.deepEqual(f.store.read().days, []);
  f.cleanup();
});

test("clear() also drops the in-memory bucket, so the next flush cannot resurrect it", () => {
  const f = makeStore();
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();
  dictate(f, "quatre cinq six", 3_000, "Slack"); // not flushed yet
  f.store.clear();
  f.store.flush();
  assert.equal(fs.existsSync(f.file), false, "a pending bucket written after a clear would undo the erasure");
  f.cleanup();
});

test("clear() on a machine that never had statistics is a clean no-op", () => {
  const f = makeStore();
  const after = f.store.clear();
  assert.equal(after.totalWords, 0);
  assert.equal(fs.existsSync(f.file), false);
  f.cleanup();
});

// ---------------------------------------------------------------------------
// hostile / broken files
// ---------------------------------------------------------------------------

test("a corrupt stats.json costs the counters, never the app: read and write both keep working", () => {
  const f = makeStore();
  fs.writeFileSync(f.file, "{not json at all");
  const logs: string[] = [];
  const store = new StatsStore({
    file: () => f.file,
    counting: () => true,
    perApp: () => false,
    now: () => f.now.value,
    log: (m) => logs.push(m),
  });
  const p = store.read();
  assert.equal(p.ok, false);
  assert.match(p.error ?? "", /could not be read/);
  assert.equal(logs.length, 1, "a counter file that could not be read is worth exactly one log line");

  // ...and the next dictation still lands: unlike the snippet library (user
  // content that must never be clobbered), derived counters restart from empty.
  store.record({ words: 4, ms: 2_000 });
  store.flush();
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).days[0].words, 4);
  f.cleanup();
});

test("PROOF BY THE FILE: an application named after a prototype member is a plain counter", () => {
  // Review constat 1, reproduced then pinned. The focus probe hands over a raw
  // process name, and `constructor.exe` or `valueOf.exe` is an executable
  // anyone can create. Against an ordinary `{}` accumulator, `name in apps` is
  // true for every one of these before a single word is counted, so the cap
  // waves them through and `apps[name] ?? 0` yields the INHERITED FUNCTION: the
  // bytes on disk read "toString": "function toString() { [native code] }...5".
  // `__proto__` fails the other way and loses that application's words with no
  // log at all. Both are read back HERE, from the file.
  const f = makeStore({ perApp: true });
  const hostile = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"];
  for (const app of hostile) {
    f.store.record({ words: 3, ms: 1_000, app });
    f.store.record({ words: 2, ms: 1_000, app }); // twice: a second hit must SUM, not concatenate
  }
  f.store.flush();

  const raw = f.raw();
  assert.equal(raw.includes("native code"), false, `a function reached stats.json: ${raw}`);
  assert.equal(raw.includes("function"), false, raw);
  const apps = f.parsed().days[0].apps as Record<string, unknown>;
  assert.deepEqual(
    Object.entries(apps).sort(),
    hostile.map((name) => [name, 5]).sort(),
    "every hostile name must be present exactly once, as its own counter",
  );
  for (const [name, n] of Object.entries(apps)) {
    assert.equal(typeof n, "number", `${name} is a ${typeof n}, not a word count`);
  }
  f.cleanup();
});

test("PROOF BY THE FILE: a prototype name cannot buy a slot past the per-day cap", () => {
  const f = makeStore({ perApp: true });
  for (let i = 0; i < MAX_APPS_PER_DAY; i++) f.store.record({ words: 1, ms: 100, app: `app-${i}` });
  f.store.record({ words: 99, ms: 100, app: "toString" });
  f.store.flush();

  const apps = f.parsed().days[0].apps as Record<string, unknown>;
  assert.equal(Object.keys(apps).length, MAX_APPS_PER_DAY, "the cap on what this file may name is not a suggestion");
  assert.equal(Object.hasOwn(apps, "toString"), false);
  f.cleanup();
});

// ---------------------------------------------------------------------------
// Review constat 2: what turning the counters OFF actually does
// ---------------------------------------------------------------------------

test("turning the counters OFF erases the file, not just the accumulator", () => {
  // The switch used to drop the in-memory buckets and stop there, leaving up to
  // twelve months of counters - and, if attribution had ever been on, of
  // application names - on disk under a page that says Flow keeps no figures at
  // all. Off is an erasure, exactly like the attribution switch it contains.
  const f = makeStore({ counting: true, perApp: true });
  dictate(f, "un deux trois", 3_000, "Microsoft Word");
  f.store.flush();
  assert.equal(fs.existsSync(f.file), true);

  f.settings.counting = false;
  f.store.settingsChanged();

  assert.equal(fs.existsSync(f.file), false, "the counters the user just refused are still on disk");
  assert.deepEqual(fs.readdirSync(f.dir), [], "not even an orphaned .tmp");
  const p = f.store.read();
  assert.equal(p.counting, false);
  assert.equal(p.totalWords, 0);
  f.cleanup();
});

test("turning the counters back ON starts from zero, and says so by having no file", () => {
  const f = makeStore({ counting: true });
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();
  f.settings.counting = false;
  f.store.settingsChanged();

  f.settings.counting = true;
  f.store.settingsChanged();
  assert.equal(fs.existsSync(f.file), false, "turning it back on must not resurrect what off erased");
  dictate(f, "quatre cinq", 2_000, "Slack");
  f.store.flush();
  assert.equal(f.parsed().days[0].words, 2, "the new history starts at the moment counting resumed");
  f.cleanup();
});

test("a machine that BOOTS with the counters off does not go on holding yesterday's file", () => {
  // The promise has to be true continuously, not from the next click on. A file
  // that predates the switch - an upgrade, a restored backup, a copied ~/.flow -
  // is erased at boot rather than served to a page that says none is kept.
  const f = makeStore({ counting: true, perApp: true });
  dictate(f, "un deux trois", 3_000, "Microsoft Word");
  f.store.flush();
  assert.ok(f.raw().includes("Microsoft Word"));

  const fresh = new StatsStore({
    file: () => f.file,
    counting: () => false, // the setting was already off when Flow started
    perApp: () => false,
    now: () => f.now.value,
  });
  fresh.start();
  assert.equal(fs.existsSync(f.file), false, "twelve months of counters survived a boot that promised none");
  fresh.stop();
  f.cleanup();
});

test("a hostile application name cannot smuggle control characters into the file", () => {
  const f = makeStore({ perApp: true });
  f.store.record({ words: 3, ms: 1_000, app: "Ev\u0000il\u001bApp\u007f" });
  f.store.flush();
  const [name] = Object.keys(f.parsed().days[0].apps as Record<string, number>);
  assert.equal(name, "Ev il App");
  f.cleanup();
});

test("an utterance that produced no words is not counted as a dictation", () => {
  const f = makeStore();
  f.store.record({ words: 0, ms: 4_000, app: "Slack" });
  f.store.record({ words: countWords("   "), ms: 4_000, app: "Slack" });
  f.store.flush();
  assert.equal(fs.existsSync(f.file), false, "zero words must not create a day, nor an utterance count");
  f.cleanup();
});

test("stop() performs the final flush (before-quit) and disarms the timer", () => {
  const f = makeStore();
  f.store.start();
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.stop();
  assert.equal(f.parsed().days[0].words, 3, "whatever is only in memory at quit is lost without this flush");
  f.cleanup();
});
