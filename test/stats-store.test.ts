import test from "node:test";
import assert from "node:assert/strict";
// B2 : plus aucun fichier a inspecter - ces tests visent desormais ce qui
// QUITTE la machine, ce qui est la meme question de confidentialite posee au
// bon endroit.
import { StatsStore } from "../src/main/stats";
import { countWords } from "../src/shared/wordCount";
import { MAX_APPS_PER_DAY, STATS_VERSION, type StatsDay } from "../src/shared/stats";

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
  store: StatsStore;
  /** Ce qui est REELLEMENT parti vers le compte. Remplace le fichier : les
   * preuves de confidentialite de U7a visaient « ce qui atterrit sur le
   * disque », elles visent maintenant « ce qui quitte la machine », ce qui est
   * la meme question posee au bon endroit depuis B2. */
  sent: StatsDay[];
  /** Mutable so a test can flip a switch mid-run, exactly as applySettings
   * does (the store reads these through closures, never a snapshot). */
  settings: { counting: boolean; perApp: boolean };
  now: { value: Date };
  raw(): string;
  parsed(): { version: number; days: Array<Record<string, unknown>> };
  cleanup(): void;
}

function makeStore(over: Partial<{ counting: boolean; perApp: boolean; now: Date }> = {}): Fixture {
  const settings = { counting: over.counting ?? true, perApp: over.perApp ?? false };
  const now = { value: over.now ?? new Date(2026, 6, 27, 10, 0, 0) };
  const sent: StatsDay[] = [];
  const backing = {
    readStats: () => sent,
    writeStatsDay: (d: StatsDay) => {
      const i = sent.findIndex((x) => x.date === d.date);
      // Une copie PROFONDE : le magasin garde une reference sur ses propres
      // journees, et les comparer a elles-memes ne prouverait rien de ce que
      // ces tests veulent prouver.
      const copy = JSON.parse(JSON.stringify(d)) as StatsDay;
      if (i >= 0) sent[i] = copy;
      else sent.push(copy);
    },
    deleteStatsDay: (day: string) => {
      const i = sent.findIndex((x) => x.date === day);
      if (i >= 0) sent.splice(i, 1);
    },
    clearStats: () => void (sent.length = 0),
  };
  const store = new StatsStore({
    backing: () => backing,
    counting: () => settings.counting,
    perApp: () => settings.perApp,
    now: () => now.value,
  });
  return {
    store,
    sent,
    settings,
    now,
    raw: () => JSON.stringify({ version: 1, days: sent }),
    parsed: () => ({ version: 1, days: sent as unknown as Array<Record<string, unknown>> }),
    cleanup: () => void (sent.length = 0),
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
  assert.deepEqual(f.sent, [], "rien n'a encore quitte la memoire");

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
    backing: () => ({
      readStats: () => f.sent,
      writeStatsDay: (d) => {
        const i = f.sent.findIndex((x) => x.date === d.date);
        if (i >= 0) f.sent[i] = d;
        else f.sent.push(d);
      },
      deleteStatsDay: (day) => {
        const i = f.sent.findIndex((x) => x.date === day);
        if (i >= 0) f.sent.splice(i, 1);
      },
      clearStats: () => void (f.sent.length = 0),
    }),
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
  assert.deepEqual(f.sent, [], "compteurs eteints : RIEN ne doit partir vers le compte");
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
  assert.deepEqual(f.sent, [], "rien n'a encore quitte la memoire");
  f.cleanup();
});

// ---------------------------------------------------------------------------
// the hot path, retention, atomicity
// ---------------------------------------------------------------------------

test("record() seul n'envoie RIEN : le chemin de la dictee ne parle pas au reseau", () => {
  // La formulation a change - « aucun disque » est devenu « aucun envoi » -
  // mais la garantie est la meme et elle est plus forte qu'avant : entre
  // l'appui sur la touche et le texte au curseur, il n'y a ni ecriture ni
  // requete.
  const f = makeStore();
  for (let i = 0; i < 50; i++) dictate(f, "un deux trois", 1_000, "Notepad");
  assert.deepEqual(f.sent, [], "cinquante dictees, aucun envoi tant que flush() n'est pas appele");
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
  assert.deepEqual(f.sent, [], "rien ne doit rester dans le compte");
  f.cleanup();
});

test("les journees de plus de douze mois ne partent plus vers le compte", () => {
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

// ---------------------------------------------------------------------------
// TROIS TESTS ONT DISPARU ICI, ET C'EST VOULU :
//
//  - « l'ecriture est atomique : aucun .tmp ne survit »
//  - « un second flush sans rien de neuf ne reecrit pas le fichier »
//  - « les compteurs survivent a un redemarrage sur le meme fichier »
//
// Les trois portaient sur la mecanique d'un fichier qui n'existe plus. Le
// premier protegeait contre un plantage en pleine ecriture, le deuxieme contre
// l'usure du disque, le troisieme contre une relecture ratee. La copie de
// travail (main/data/workingCopy.ts) tient desormais l'equivalent des trois -
// file serialisee, fusion des ecritures d'un meme etat, reprise apres coupure -
// et ses propres tests les couvrent la-bas.
//
// Ce qui suit reste, parce que ce sont des promesses faites a l'utilisateur et
// pas des proprietes d'un support.
// ---------------------------------------------------------------------------

test("clear() efface cote compte sur-le-champ et rend une charge vide", () => {
  const f = makeStore();
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();
  assert.equal(f.sent.length, 1, "la journee est bien partie vers le compte");

  const after = f.store.clear();
  assert.deepEqual(f.sent, [], "« effacer mes statistiques » veut dire parties du COMPTE, pas mises a blanc");
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
  assert.deepEqual(f.sent, [], "rien ne doit rester dans le compte");
  f.cleanup();
});

test("clear() on a machine that never had statistics is a clean no-op", () => {
  const f = makeStore();
  const after = f.store.clear();
  assert.equal(after.totalWords, 0);
  assert.deepEqual(f.sent, [], "rien n'a encore quitte la memoire");
  f.cleanup();
});

// ---------------------------------------------------------------------------
// hostile / broken files
// ---------------------------------------------------------------------------

// « un stats.json corrompu coute les compteurs, jamais l'application » a disparu
// avec le fichier. Son equivalent vit maintenant un etage plus haut et couvre
// plus de cas : la copie de travail ne se declare jamais « chargee » sur une
// lecture ratee, donc les compteurs ne repartent pas de zero sur un reseau qui
// bafouille (test/working-copy.test.ts).

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

test("eteindre les compteurs efface le COMPTE, pas seulement l'accumulateur", () => {
  // The switch used to drop the in-memory buckets and stop there, leaving up to
  // twelve months of counters - and, if attribution had ever been on, of
  // application names - on disk under a page that says Flow keeps no figures at
  // all. Off is an erasure, exactly like the attribution switch it contains.
  const f = makeStore({ counting: true, perApp: true });
  dictate(f, "un deux trois", 3_000, "Microsoft Word");
  f.store.flush();
  assert.ok(f.sent.length > 0, "quelque chose doit etre parti vers le compte");

  f.settings.counting = false;
  f.store.settingsChanged();

  assert.deepEqual(f.sent, [], "rien ne doit rester dans le compte");
  const p = f.store.read();
  assert.equal(p.counting, false);
  assert.equal(p.totalWords, 0);
  f.cleanup();
});

test("rallumer les compteurs repart de zero, et le montre en n'ayant rien envoye", () => {
  const f = makeStore({ counting: true });
  dictate(f, "un deux trois", 3_000, "Slack");
  f.store.flush();
  f.settings.counting = false;
  f.store.settingsChanged();

  f.settings.counting = true;
  f.store.settingsChanged();
  assert.deepEqual(f.sent, [], "rien ne doit rester dans le compte");
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
    backing: () => ({
      readStats: () => f.sent,
      writeStatsDay: () => {},
      deleteStatsDay: () => {},
      clearStats: () => void (f.sent.length = 0),
    }),
    counting: () => false, // le reglage etait deja eteint au demarrage de Flow
    perApp: () => false,
    now: () => f.now.value,
  });
  fresh.start();
  assert.deepEqual(f.sent, [], "rien ne doit rester dans le compte");
  fresh.stop();
  f.cleanup();
});

test("un nom d'application hostile ne peut pas faire passer de caracteres de controle", () => {
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
  assert.deepEqual(f.sent, [], "rien ne doit rester dans le compte");
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
