import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CURRENT_VERSION,
  MAX_ALIASES,
  MAX_ALIAS_CHARS,
  MAX_ITEMS,
  MAX_TERM_CHARS,
  applyDictDelete,
  applyDictSave,
  applyDictionaryReplacements,
  defaultEntries,
  deleteDictEntry,
  dictationPrompt,
  listDictionary,
  parseDictionaryFile,
  primeDictionary,
  refreshDictionaryCache,
  useDictionaryBacking,
  saveDictEntry,
} from "../src/main/dictionary";
import { compileDictionary, applyDictionary } from "../src/shared/dictionary";
import type { DictEntry } from "../src/shared/ipcContracts";

// U6a: the store. Same split - and the same safety catch - as
// test/snippets.test.ts, which this file is a deliberate mirror of: the pure
// half (parseDictionaryFile / applyDictSave / applyDictDelete) is exercised
// directly, and the disk half is exercised over a MOCKED node:fs rather than a
// temp folder, because a temp folder cannot be made to fail with ENOSPC or
// "an antivirus is holding this file open". Every mocked test calls
// assertMockedFs() first: if the interception ever stops working, the assertion
// fails BEFORE any write is attempted, so a broken mock can never reach the
// real ~/.flow/dictionary.json of whoever runs the suite.

function makeStored(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "abc-123",
    term: "Loi 25",
    aliases: ["loi vingt-cinq"],
    kind: "replacement",
    starred: false,
    createdIso: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// parseDictionaryFile
// ---------------------------------------------------------------------------

test("parse: null / non-object / array root are refused, not silently emptied without a reason", () => {
  for (const bad of [null, undefined, 42, "nope", ["a"]]) {
    const r = parseDictionaryFile(bad);
    assert.deepEqual(r.file.items, []);
    assert.ok(r.error, `expected an error for ${JSON.stringify(bad)}`);
  }
});

test("parse: an unrecognized (or missing) version is refused, dictionary starts empty with a readable error", () => {
  for (const raw of [{ version: 2, items: [makeStored()] }, { items: [makeStored()] }]) {
    const r = parseDictionaryFile(raw);
    assert.deepEqual(r.file.items, []);
    assert.match(r.error ?? "", /version/i);
  }
});

test("parse: version 1 with no items is a normal empty dictionary, no error", () => {
  const r = parseDictionaryFile({ version: CURRENT_VERSION, items: [] });
  assert.deepEqual(r.file, { version: 1, items: [] });
  assert.equal(r.error, undefined);
  assert.equal(r.missing, undefined, "an EMPTY dictionary is not a MISSING one - that difference is what U6e rests on");
});

test("parse: a valid entry round-trips, unknown fields dropped", () => {
  const r = parseDictionaryFile({ version: CURRENT_VERSION, items: [makeStored({ evil: "ignored" })] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.file.items[0], {
    id: "abc-123",
    term: "Loi 25",
    aliases: ["loi vingt-cinq"],
    kind: "replacement",
    starred: false,
    createdIso: "2026-01-01T00:00:00.000Z",
  });
});

test("parse: kind falls back to VOCABULARY on anything but the literal 'replacement'", () => {
  // The safe direction: a garbled kind must not be able to turn into a
  // substitution rule nobody asked for. Vocabulary never rewrites a transcript.
  for (const bad of [undefined, "Replacement", "rewrite", 1, null]) {
    assert.equal(parseDictionaryFile({ version: CURRENT_VERSION, items: [makeStored({ kind: bad })] }).file.items[0].kind, "vocabulary");
  }
});

test("parse: starred needs a literal true", () => {
  for (const bad of [undefined, "yes", 1, null]) {
    assert.equal(parseDictionaryFile({ version: CURRENT_VERSION, items: [makeStored({ starred: bad })] }).file.items[0].starred, false);
  }
  assert.equal(parseDictionaryFile({ version: CURRENT_VERSION, items: [makeStored({ starred: true })] }).file.items[0].starred, true);
});

test("parse: whitespace in a term is tidied, and that is NOT counted as a loss", () => {
  // A newline in a term would break the whisper prompt into two lines of
  // pseudo-transcript; collapsing it changes no word, so writing the tidied
  // form back loses nothing and must not freeze the store.
  const r = parseDictionaryFile({ version: CURRENT_VERSION, items: [makeStored({ term: "  Loi\n 25 " })] });
  assert.equal(r.file.items[0].term, "Loi 25");
  assert.equal(r.error, undefined);
});

test("parse: malformed entries are dropped individually, the rest survives, and the loss is REPORTED", () => {
  const r = parseDictionaryFile({
    version: CURRENT_VERSION,
    items: [makeStored({ id: "good-1" }), { term: "no id" }, 42, makeStored({ id: "x", term: "   " }), makeStored({ id: "good-2" })],
  });
  assert.deepEqual(r.file.items.map((e) => e.id), ["good-1", "good-2"]);
  // Tolerance is about what we KEEP, never about staying quiet: without this
  // error the next save would write the amputated version over a file that
  // still holds everything.
  assert.match(r.error ?? "", /READ-ONLY/);
  assert.match(r.error ?? "", /entry #2/);
  assert.match(r.error ?? "", /entry #4/);
});

test("parse: over-long term/aliases are truncated, and truncation is a reported loss", () => {
  const r = parseDictionaryFile({
    version: CURRENT_VERSION,
    items: [makeStored({ term: "T".repeat(MAX_TERM_CHARS + 10), aliases: ["a".repeat(MAX_ALIAS_CHARS + 10)] })],
  });
  assert.equal(r.file.items[0].term.length, MAX_TERM_CHARS);
  assert.equal(r.file.items[0].aliases[0].length, MAX_ALIAS_CHARS);
  assert.ok(r.error, "a silent truncation is one save away from being permanent");
});

test("parse: an aliases field that is not an array is a file we did not understand", () => {
  const r = parseDictionaryFile({ version: CURRENT_VERSION, items: [makeStored({ aliases: "loi vingt-cinq" })] });
  assert.deepEqual(r.file.items[0].aliases, []);
  assert.match(r.error ?? "", /aliases/);
});

test("parse: a hand-edited file over the item cap keeps the first MAX_ITEMS and says so", () => {
  const items = Array.from({ length: MAX_ITEMS + 3 }, (_, i) => makeStored({ id: `id-${i}` }));
  const r = parseDictionaryFile({ version: CURRENT_VERSION, items });
  assert.equal(r.file.items.length, MAX_ITEMS);
  assert.match(r.error ?? "", new RegExp(`${MAX_ITEMS + 3} entries`));
});

test("parse: a thoroughly broken file names a few losses and counts the rest", () => {
  const r = parseDictionaryFile({ version: CURRENT_VERSION, items: Array.from({ length: 40 }, () => ({ junk: 1 })) });
  assert.deepEqual(r.file.items, []);
  assert.match(r.error ?? "", /and 35 more/);
});

// ---------------------------------------------------------------------------
// applyDictSave / applyDictDelete
// ---------------------------------------------------------------------------

test("save: an id is a LOOKUP key, never a creation key", () => {
  const items: DictEntry[] = [];
  const r = applyDictSave(items, { id: "chosen-by-the-caller", term: "X", aliases: [], kind: "vocabulary", starred: false });
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /not found/);
});

test("save: a create mints its own id and stamps its own date", () => {
  const r = applyDictSave([], { term: "Tailscale", aliases: [" tail scale "], kind: "vocabulary", starred: true });
  assert.ok("items" in r);
  const created = (r as { items: DictEntry[] }).items[0];
  assert.notEqual(created.id, "");
  assert.deepEqual(created.aliases, ["tail scale"], "aliases are tidied at the write boundary");
  assert.equal(created.starred, true);
  assert.ok(Date.parse(created.createdIso) > 0);
});

test("save: an update keeps the id and the creation date, and replaces the rest", () => {
  const before: DictEntry[] = [
    { id: "keep", term: "Old", aliases: ["a"], kind: "vocabulary", starred: false, createdIso: "2020-01-01T00:00:00.000Z" },
  ];
  const r = applyDictSave(before, { id: "keep", term: "New", aliases: ["b"], kind: "replacement", starred: true });
  assert.ok("items" in r);
  assert.deepEqual((r as { items: DictEntry[] }).items[0], {
    id: "keep",
    term: "New",
    aliases: ["b"],
    kind: "replacement",
    starred: true,
    createdIso: "2020-01-01T00:00:00.000Z",
  });
});

test("save: an entry with no term is refused - it would be invisible and match nothing", () => {
  const r = applyDictSave([], { term: "   ", aliases: [], kind: "vocabulary", starred: false });
  assert.ok("error" in r);
});

test("save: aliases are deduplicated on the NORMALIZED phrase, capped, and blanks dropped", () => {
  const r = applyDictSave([], {
    term: "Loi 25",
    aliases: ["loi vingt-cinq", "Loi Vingt Cinq", "  ", "loi 25"],
    kind: "replacement",
    starred: false,
  });
  assert.ok("items" in r);
  // "loi vingt-cinq" and "Loi Vingt Cinq" normalize alike: one alias, two
  // spellings. Keeping both would just spend the entry's budget twice.
  assert.deepEqual((r as { items: DictEntry[] }).items[0].aliases, ["loi vingt-cinq", "loi 25"]);

  const many = applyDictSave([], {
    term: "X",
    aliases: Array.from({ length: MAX_ALIASES + 10 }, (_, i) => `alias ${i}`),
    kind: "replacement",
    starred: false,
  });
  assert.ok("items" in many);
  assert.equal((many as { items: DictEntry[] }).items[0].aliases.length, MAX_ALIASES);
});

test("save: an over-long term or alias is REFUSED, never silently trimmed", () => {
  const longTerm = applyDictSave([], { term: "T".repeat(MAX_TERM_CHARS + 1), aliases: [], kind: "vocabulary", starred: false });
  assert.ok("error" in longTerm);
  const longAlias = applyDictSave([], { term: "X", aliases: ["a".repeat(MAX_ALIAS_CHARS + 1)], kind: "replacement", starred: false });
  assert.ok("error" in longAlias);
});

test("save: garbage from IPC is treated as garbage, not trusted because it type-checked upstream", () => {
  for (const bad of [null, undefined, 42, "nope", { term: 7 }, { term: "X", aliases: "not-an-array" }]) {
    const r = applyDictSave([], bad);
    if (bad !== null && typeof bad === "object" && "term" in bad && bad.term === "X") {
      assert.ok("items" in r, "a bad aliases field is tolerated as 'no aliases', the term is still usable");
      assert.deepEqual((r as { items: DictEntry[] }).items[0].aliases, []);
    } else {
      assert.ok("error" in r, JSON.stringify(bad));
    }
  }
});

test("save: the dictionary is capped", () => {
  const full = Array.from({ length: MAX_ITEMS }, (_, i): DictEntry => ({
    id: `id-${i}`, term: `T${i}`, aliases: [], kind: "vocabulary", starred: false, createdIso: "2026-01-01T00:00:00.000Z",
  }));
  const r = applyDictSave(full, { term: "one more", aliases: [], kind: "vocabulary", starred: false });
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /full/);
});

test("delete: idempotent - removing an id that is already gone is a no-op, not an error", () => {
  const items: DictEntry[] = [
    { id: "a", term: "A", aliases: [], kind: "vocabulary", starred: false, createdIso: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(applyDictDelete(items, "a"), []);
  assert.deepEqual(applyDictDelete(items, "gone"), items);
  assert.deepEqual(applyDictDelete(items, 42), items);
});

// ---------------------------------------------------------------------------
// U6e: what a fresh install ships with
// ---------------------------------------------------------------------------

test("defaults: « Claude » is there, and it is VOCABULARY, not a cloud -> Claude rewrite", () => {
  const items = defaultEntries();
  const claude = items.find((e) => e.term === "Claude");
  assert.ok(claude, "the whole reason the default list exists");
  assert.equal(claude.kind, "vocabulary");
  assert.equal(claude.starred, true, "starred, so it is first in line for the bounded prompt budget");

  // The honest half of that decision, asserted rather than trusted: with the
  // shipped defaults loaded, an ordinary sentence about cloud computing is NOT
  // rewritten. A blind cloud -> Claude replacement rule would have broken it.
  const dict = compileDictionary(items);
  const sentence = "notre fournisseur cloud est fiable";
  assert.equal(applyDictionary(sentence, dict), sentence);
});

test("defaults: « cloud code » IS fixed, because that phrase is unambiguous", () => {
  const dict = compileDictionary(defaultEntries());
  assert.equal(applyDictionary("j'ouvre cloud code", dict), "j'ouvre Claude Code");
  assert.equal(applyDictionary("j'ouvre Claude Code", dict), "j'ouvre Claude Code", "already right: unchanged");
});

test("defaults: the maquette's five terms and the names this repo actually uses are all present", () => {
  const terms = defaultEntries().map((e) => e.term);
  for (const expected of ["AGR Labs", "whisper.cpp", "Loi 25", "keyspy", "Tailscale", "Claude", "Claude Code"]) {
    assert.ok(terms.includes(expected), `missing default term ${expected}`);
  }
  assert.ok(terms.length <= 10, "a SMALL starter list - the user's own terms are the point, not ours");
});

test("defaults: every shipped entry is a well-formed one this build would itself accept", () => {
  const round = parseDictionaryFile({ version: CURRENT_VERSION, items: defaultEntries() });
  assert.equal(round.error, undefined, round.error ?? "");
  assert.equal(round.file.items.length, defaultEntries().length);
  for (const e of defaultEntries()) {
    assert.ok(e.id.length > 0);
    assert.ok(e.term.length > 0 && e.term.length <= MAX_TERM_CHARS);
    assert.ok(Date.parse(e.createdIso) > 0);
    assert.ok(e.aliases.length <= MAX_ALIASES);
  }
});

// ---------------------------------------------------------------------------
// B2 : la moitie « magasin », desormais sur la copie de travail et plus sur un
// node:fs simule.
//
// CE QUI A DISPARU AVEC LE FICHIER, et qu'il faut savoir en lisant ce qui
// suit : l'ecriture atomique tmp + rename, la garde anti-ecrasement, la
// distinction entre ENOENT et un fichier vide, et tous les cas d'antivirus qui
// tient le fichier ouvert. Ils protegeaient contre des pannes de FICHIER. Il
// n'y a plus de fichier.
//
// CE QUI LES REMPLACE est plus haut dans la pile et se teste ailleurs : la
// copie de travail ne se declare jamais « vide » sur un chargement rate
// (test/working-copy.test.ts), et sa file d'attente survit a une coupure
// reseau. Ce qui reste ICI est ce que le dictionnaire, lui, doit garantir.
// ---------------------------------------------------------------------------

/** Une copie de travail minimale : la memoire, et un compte de ce qui est
 * parti vers le compte. */
function fakeBacking(initial: DictEntry[] = [], ready = true) {
  const items = [...initial];
  const sent: string[] = [];
  return {
    backing: {
      readDictionary: () => items,
      upsertDictEntry: (e: DictEntry) => {
        sent.push("upsert:" + e.term);
        const i = items.findIndex((x) => x.id === e.id);
        if (i >= 0) items[i] = e;
        else items.push(e);
      },
      deleteDictEntry: (id: string) => {
        sent.push("delete:" + id);
        const i = items.findIndex((x) => x.id === id);
        if (i >= 0) items.splice(i, 1);
      },
      isReady: () => ready,
    },
    items,
    sent,
  };
}

test("B2: sans compte charge, le dictionnaire le DIT au lieu de se dire vide", () => {
  // Une liste vide se lit « vous n'avez aucun terme », ce qui est faux et
  // alarmant pour quelqu'un qui en a quarante.
  const f = fakeBacking([], false);
  useDictionaryBacking(f.backing);
  const r = listDictionary();
  assert.equal(r.ok, false);
  assert.deepEqual(r.items, []);
  assert.match(String(r.error), /pas encore charge/);
  useDictionaryBacking(null);
});

test("B2: enregistrer sans compte charge est refuse, jamais avale", () => {
  const f = fakeBacking([], false);
  useDictionaryBacking(f.backing);
  assert.equal(saveDictEntry({ term: "AGR", kind: "vocabulary" }).ok, false);
  assert.equal(deleteDictEntry("x").ok, false);
  assert.deepEqual(f.sent, [], "et RIEN ne part vers le compte");
  useDictionaryBacking(null);
});

test("B2: on enregistre L'ENTREE, jamais la liste entiere", () => {
  // La ligne qui merite d'etre lue deux fois. Envoyer la liste ferait qu'une
  // machine effacerait les termes qu'une autre vient d'ajouter : deux
  // ordinateurs, un dictionnaire, et le dernier qui enregistre gagne.
  const f = fakeBacking([]);
  useDictionaryBacking(f.backing);
  const r = saveDictEntry({ term: "MXepoxy", kind: "vocabulary" });
  assert.equal(r.ok, true);
  assert.deepEqual(f.sent, ["upsert:MXepoxy"], "un seul envoi, et c'est l'entree touchee");
  useDictionaryBacking(null);
});

test("B2: supprimer envoie UNE suppression, et rien quand rien ne correspond", () => {
  const seed = applyDictSave([], { term: "Tailscale", kind: "vocabulary" });
  assert.ok(!("error" in seed));
  const f = fakeBacking([...seed.items]);
  useDictionaryBacking(f.backing);

  assert.equal(deleteDictEntry("aucun-tel-id").ok, true, "idempotent : sans effet, pas une erreur");
  assert.deepEqual(f.sent, [], "et surtout aucun envoi");

  assert.equal(deleteDictEntry(seed.items[0].id).ok, true);
  assert.deepEqual(f.sent, ["delete:" + seed.items[0].id]);
  useDictionaryBacking(null);
});

test("B2: LE terme sans effet - le cache compile suit le compte, ou il ne sert a rien", () => {
  // DEUXIEME DES SEPT REGRESSIONS DU PLAN, dans sa forme exacte : « un terme de
  // dictionnaire sans effet, parce que le cache compile n'a pas ete rafraichi
  // apres un chargement ».
  //
  // Elle est silencieuse par nature - le terme apparait dans la page, il est
  // bien enregistre, et il ne change rien a ce qui est dicte. Rien n'echoue.
  const seed = applyDictSave([], { term: "MXepoxy", kind: "replacement", aliases: ["m x epoxy"] });
  assert.ok(!("error" in seed));

  // Le compte n'a pas encore charge : rien ne doit etre reecrit.
  const f = fakeBacking([...seed.items], false);
  useDictionaryBacking(f.backing);
  assert.equal(applyDictionaryReplacements("j'utilise du m x epoxy"), "j'utilise du m x epoxy");

  // Le compte finit de charger. SANS le rafraichissement, le cache garde la
  // table d'avant et le terme reste sans effet.
  const f2 = fakeBacking([...seed.items], true);
  useDictionaryBacking(f2.backing);
  refreshDictionaryCache();
  assert.equal(applyDictionaryReplacements("j'utilise du m x epoxy"), "j'utilise du MXepoxy");
  useDictionaryBacking(null);
});

test("B2: « pas encore charge » n'est JAMAIS mis en cache", () => {
  // Le figer condamnerait la session entiere a un dictionnaire vide, alors que
  // le compte finit de charger une seconde plus tard. C'est la meme classe de
  // defaut que le trousseau interroge trop tot en A2.
  // ETOILE, et ce n'est pas un detail : seules les entrees etoilees entrent
  // dans le prompt whisper. Une entree « vocabulaire » non etoilee ne fait
  // litteralement rien (voir shared/dictionary.ts, promptTerms). Le premier
  // jet de ce test l'ignorait et attendait l'inverse.
  const seed = applyDictSave([], { term: "Voiceflow", kind: "vocabulary", starred: true });
  assert.ok(!("error" in seed));
  const f = fakeBacking([...seed.items], false);
  useDictionaryBacking(f.backing);
  assert.equal(dictationPrompt("base"), "base", "rien a ajouter tant que rien n'est charge");

  const f2 = fakeBacking([...seed.items], true);
  useDictionaryBacking(f2.backing);
  refreshDictionaryCache();
  assert.match(dictationPrompt("base"), /Voiceflow/, "et le terme arrive des que le compte est la");
  useDictionaryBacking(null);
});

test("B2: un compte NEUF recoit les termes par defaut, une seule fois", () => {
  const f = fakeBacking([]);
  useDictionaryBacking(f.backing);
  const logs: string[] = [];
  primeDictionary((m) => logs.push(m));
  assert.ok(f.sent.length > 0, "les defauts doivent partir vers le compte");
  assert.match(logs.join(" "), /compte neuf/);

  // Un compte qui a deja des termes n'en recoit aucun.
  const f2 = fakeBacking([...f.items]);
  useDictionaryBacking(f2.backing);
  primeDictionary(() => {});
  assert.deepEqual(f2.sent, [], "un compte deja garni ne doit rien recevoir");
  useDictionaryBacking(null);
});

test("B2: sans compte du tout, semer ne fait rien et ne dit rien", () => {
  useDictionaryBacking(null);
  const logs: string[] = [];
  assert.doesNotThrow(() => primeDictionary((m) => logs.push(m)));
  assert.deepEqual(logs, [], "avant la connexion, il n'y a rien a dire");
});

// ---------------------------------------------------------------------------
// The wiring, asserted as source text (index.ts imports "electron" and cannot
// be loaded here) - the same technique test/csp.test.ts and
// test/capture-continuity.test.ts use. A perfectly tested pure module is worth
// nothing if the hot path calls it in the wrong place, or stops calling it.
// ---------------------------------------------------------------------------

const INDEX_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");

test("wiring: storey 2 runs on the FINAL text, after gateTranscript, on the kept branch only", () => {
  const at = INDEX_SRC.indexOf("async function processUtterance(");
  assert.ok(at > 0, "processUtterance must still be the shared utterance pipeline");
  const body = INDEX_SRC.slice(at, INDEX_SRC.indexOf("\n}\n", at));

  const gate = body.indexOf("gateTranscript(");
  const apply = body.indexOf("applyDictionaryReplacements(");
  assert.ok(gate >= 0, "the hallucination gate must still run");
  assert.ok(apply >= 0, "the dictionary pass must still run on the dictation path");
  // Before the gate, a rule could rewrite a known hallucination into something
  // the gate no longer recognizes, and the phantom string would land at the
  // cursor. After it, the only text a rule can touch is text Flow already kept.
  assert.ok(gate < apply, "the dictionary must run AFTER the hallucination gate, never before");
  // ...and on the kept branch: the early return for rejected text must not go
  // through the dictionary at all.
  const earlyReturn = body.indexOf('return { text: "", ms };', gate);
  assert.ok(earlyReturn >= 0 && earlyReturn < apply, "the rejected branch must return before the dictionary pass");
});

test("wiring: the whisper prompt is a FUNCTION, resolved per request", () => {
  // A string captured when the sidecar was built would go stale the moment a
  // term is added, and would not come back until the next model swap.
  const at = INDEX_SRC.indexOf("initialPrompt:");
  assert.ok(at > 0, "the sidecar must still receive an initial prompt");
  const line = INDEX_SRC.slice(at, INDEX_SRC.indexOf("\n", at));
  assert.match(line, /\(\)\s*=>\s*dictationPrompt\(/, `initialPrompt is not resolved per request: ${line}`);
});

test("wiring: the dictionary is primed at boot, so no dictation ever pays a synchronous read", () => {
  assert.match(INDEX_SRC, /primeDictionary\(/, "without this, the first utterance loads the file on the hook's process");
  const prime = INDEX_SRC.indexOf("primeDictionary(");
  const loadSettings = INDEX_SRC.indexOf("loadSettings()");
  assert.ok(loadSettings >= 0 && loadSettings < prime, "dataDir() must already be the post-migration folder");
});

