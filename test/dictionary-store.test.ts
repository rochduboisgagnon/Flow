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
  dictionaryPath,
  listDictionary,
  parseDictionaryFile,
  primeDictionary,
  resetDictionaryCacheForTests,
  saveDictEntry,
} from "../src/main/dictionary";
import { compileDictionary, applyDictionary } from "../src/shared/dictionary";
import type { DictEntry, DictResult } from "../src/shared/ipcContracts";

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
// The disk half, over a mocked node:fs
// ---------------------------------------------------------------------------

interface FsCalls {
  reads: number;
  writes: string[];
  renames: number;
  removed: string[];
}

type FailAt = { step: "mkdir" | "write" | "rename"; error: Error };

function mockFs(
  t: { mock: { method: typeof import("node:test").mock.method } },
  fileContent: string | (() => never),
  failAt?: FailAt,
): FsCalls {
  const calls: FsCalls = { reads: 0, writes: [], renames: 0, removed: [] };
  const failing = (step: FailAt["step"]): void => {
    if (failAt?.step === step) throw failAt.error;
  };
  t.mock.method(fs, "readFileSync", () => {
    calls.reads++;
    if (typeof fileContent !== "string") return fileContent();
    return fileContent;
  });
  t.mock.method(fs, "mkdirSync", () => {
    failing("mkdir");
    return undefined;
  });
  t.mock.method(fs, "writeFileSync", (_p: unknown, data: unknown) => {
    failing("write");
    calls.writes.push(String(data));
  });
  t.mock.method(fs, "renameSync", () => {
    failing("rename");
    calls.renames++;
  });
  t.mock.method(fs, "rmSync", (p: unknown) => {
    calls.removed.push(String(p));
  });
  return calls;
}

/** The safety catch: if the fs interception ever stops working, these tests
 * would read and OVERWRITE the real ~/.flow/dictionary.json of whoever runs the
 * suite. Called first by every mocked test, so a broken mock fails before a
 * single write is attempted. */
function assertMockedFs(expected: string): void {
  assert.equal(
    fs.readFileSync(dictionaryPath(), "utf8"),
    expected,
    "node:fs is NOT mocked - aborting before this test can touch the real dictionary",
  );
}

const STORED = JSON.stringify({ version: CURRENT_VERSION, items: [makeStored({ id: "keep-me" })] });

test("saveDictEntry: one read per operation, atomic tmp + rename, whole dictionary back", (t) => {
  resetDictionaryCacheForTests();
  const calls = mockFs(t, STORED);
  assertMockedFs(STORED);
  const before = calls.reads;

  const r = saveDictEntry({ term: "Tailscale", aliases: [], kind: "vocabulary", starred: false });
  assert.equal(r.ok, true, r.error ?? "save failed");
  assert.equal(calls.reads - before, 1, "the dictionary was read more than once for a single save");
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.renames, 1, "still an atomic tmp + rename");
  assert.equal(r.items.length, 2);
  resetDictionaryCacheForTests();
});

test("deleteDictEntry: one read per operation too, and the whole dictionary back", (t) => {
  resetDictionaryCacheForTests();
  const calls = mockFs(t, STORED);
  assertMockedFs(STORED);
  const before = calls.reads;

  const r = deleteDictEntry("keep-me");
  assert.equal(r.ok, true, r.error ?? "delete failed");
  assert.equal(calls.reads - before, 1);
  assert.deepEqual(r.items, []);
  resetDictionaryCacheForTests();
});

test("a failed write answers {ok:false} with the dictionary as it was, and NEVER throws", (t) => {
  // ENOSPC, EACCES, or Bitdefender holding the file open - a known visitor on
  // this machine. All three steps of the atomic write, because they fail for
  // different real reasons and the module has to answer the same way for all.
  for (const failAt of [
    { step: "mkdir", error: Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" }) },
    { step: "write", error: Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }) },
    { step: "rename", error: Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }) },
  ] as const) {
    resetDictionaryCacheForTests();
    const calls = mockFs(t, STORED, failAt);
    assertMockedFs(STORED);

    let r: DictResult | undefined;
    assert.doesNotThrow(() => {
      r = saveDictEntry({ term: "Tailscale", aliases: [], kind: "vocabulary", starred: false });
    }, `saveDictEntry threw on ${failAt.step}`);
    assert.equal(r?.ok, false, failAt.step);
    assert.match(r?.error ?? "", /could not be written/, failAt.step);
    assert.match(r?.error ?? "", /unchanged/, "the user needs to know the dictionary survived");
    assert.match(r?.error ?? "", /dictionary\.json/, "and where the file is");
    assert.deepEqual(r?.items.map((e) => e.id), ["keep-me"], "the answer is what is still on DISK, not an optimistic guess");
    assert.equal(calls.removed.length, 1, `no .tmp cleanup after a failed ${failAt.step}`);
    t.mock.restoreAll();
  }
  resetDictionaryCacheForTests();
});

test("a file that did not load intact is NEVER written back", (t) => {
  resetDictionaryCacheForTests();
  const lossy = JSON.stringify({ version: CURRENT_VERSION, items: [makeStored({ id: "readable" }), { id: "broken" }] });
  const calls = mockFs(t, lossy);
  assertMockedFs(lossy);

  const r = saveDictEntry({ term: "X", aliases: [], kind: "vocabulary", starred: false });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /READ-ONLY/);
  assert.equal(calls.writes.length, 0, "the amputated dictionary reached the disk");
  assert.deepEqual(r.items.map((e) => e.id), ["readable"], "read-only is not unusable");

  const del = deleteDictEntry("readable");
  assert.equal(del.ok, false);
  assert.equal(calls.writes.length, 0, "a delete is a write like any other");
  resetDictionaryCacheForTests();
});

test("a version this build does not understand is never overwritten", (t) => {
  resetDictionaryCacheForTests();
  const future = JSON.stringify({ version: 2, items: [makeStored()] });
  const calls = mockFs(t, future);
  assertMockedFs(future);

  const r = saveDictEntry({ term: "X", aliases: [], kind: "vocabulary", starred: false });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /version/i);
  assert.equal(calls.writes.length, 0);
  resetDictionaryCacheForTests();
});

test("a corrupt dictionary.json destroys neither the settings nor the dictionary on disk", (t) => {
  resetDictionaryCacheForTests();
  const garbage = "{ this is not json";
  const calls = mockFs(t, garbage);
  assert.equal(fs.readFileSync(dictionaryPath(), "utf8"), garbage, "node:fs is NOT mocked");

  const listed = listDictionary();
  assert.equal(listed.ok, false);
  assert.deepEqual(listed.items, []);
  const saved = saveDictEntry({ term: "X", aliases: [], kind: "vocabulary", starred: false });
  assert.equal(saved.ok, false);
  assert.equal(calls.writes.length, 0, "the unreadable file was left exactly as it is, for the user to fix");
  resetDictionaryCacheForTests();
});

// ---------------------------------------------------------------------------
// Review constat 4: a FAILED read must not replace a good cache
// ---------------------------------------------------------------------------

test("listDictionary: an unreadable file does not empty the dictionary for the rest of the session", (t) => {
  // loadDictionaryFile answers with an EMPTY dictionary on every failure, and
  // listDictionary used to install that answer as the new truth. Opening the
  // page against a broken file therefore disarmed storey 2 on the DICTATION
  // path until the next launch: the user came to look at his dictionary and
  // lost the use of it. The write paths already returned before touching the
  // cache; this is the read catching up.
  resetDictionaryCacheForTests();
  const good = JSON.stringify({
    version: CURRENT_VERSION,
    items: [makeStored({ id: "keep-me", starred: true })],
  });
  mockFs(t, good);
  assertMockedFs(good);
  assert.equal(listDictionary().ok, true);
  assert.equal(applyDictionaryReplacements("la loi vingt-cinq"), "la Loi 25", "premise: the cache is warm and correct");
  t.mock.restoreAll();

  const garbage = "{ not json at all";
  mockFs(t, garbage);
  assertMockedFs(garbage);
  const listed = listDictionary();
  assert.equal(listed.ok, false, "the page must still be told the file is broken");
  assert.deepEqual(listed.items, [], "and shown what could be read, which is nothing");

  // ...and the dictation path is untouched: a stale cache beats a wrong one.
  assert.equal(applyDictionaryReplacements("la loi vingt-cinq"), "la Loi 25");
  assert.match(dictationPrompt("Seed."), /Loi 25/, "storey 1 was disarmed by a read that failed");
  resetDictionaryCacheForTests();
});

test("listDictionary: a version this build refuses does not empty the cache either", (t) => {
  // The other failure mode of the same read: nothing is unreadable, the file is
  // simply not ours to interpret. Same rule.
  resetDictionaryCacheForTests();
  const good = JSON.stringify({ version: CURRENT_VERSION, items: [makeStored({ id: "keep-me" })] });
  mockFs(t, good);
  assertMockedFs(good);
  listDictionary();
  t.mock.restoreAll();

  const future = JSON.stringify({ version: 2, items: [] });
  mockFs(t, future);
  assert.equal(listDictionary().ok, false);
  assert.equal(applyDictionaryReplacements("la loi vingt-cinq"), "la Loi 25");
  resetDictionaryCacheForTests();
});

test("listDictionary: a read that SUCCEEDED still refreshes the cache, empty file included", (t) => {
  // The other half, or the fix above would be indistinguishable from never
  // refreshing at all. An empty (or absent) file is a successful read of
  // "nothing", and the cache has to follow it.
  resetDictionaryCacheForTests();
  const good = JSON.stringify({ version: CURRENT_VERSION, items: [makeStored({ id: "keep-me" })] });
  mockFs(t, good);
  assertMockedFs(good);
  listDictionary();
  assert.equal(applyDictionaryReplacements("la loi vingt-cinq"), "la Loi 25");
  t.mock.restoreAll();

  const emptied = JSON.stringify({ version: CURRENT_VERSION, items: [] });
  mockFs(t, emptied);
  assert.equal(listDictionary().ok, true);
  assert.equal(
    applyDictionaryReplacements("la loi vingt-cinq"),
    "la loi vingt-cinq",
    "a dictionary emptied from outside must be picked up by the next list",
  );
  resetDictionaryCacheForTests();
});

// ---------------------------------------------------------------------------
// U6e: seeding happens once, and a deletion is never resurrected
// ---------------------------------------------------------------------------

test("primeDictionary: a machine with no dictionary.json gets the shipped defaults, written once", (t) => {
  resetDictionaryCacheForTests();
  const calls = mockFs(t, () => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  });
  assert.throws(() => fs.readFileSync(dictionaryPath(), "utf8"), /ENOENT/, "node:fs is NOT mocked");

  const logs: string[] = [];
  primeDictionary((m) => logs.push(m));
  assert.equal(calls.writes.length, 1, "the defaults are written, so the next launch sees a file and stops seeding");
  const written = JSON.parse(calls.writes[0]) as { version: number; items: DictEntry[] };
  assert.equal(written.version, CURRENT_VERSION);
  assert.ok(written.items.some((e) => e.term === "Claude"));
  assert.match(logs.join(" "), /first run/);
  resetDictionaryCacheForTests();
});

test("primeDictionary: an EMPTY dictionary is left empty - a deletion is never resurrected", (t) => {
  // The trigger is "there is no file at all", never "the dictionary is empty".
  // A user who deletes every default term leaves {items: []} behind, and the
  // next launch has to respect that. This is the whole difference between a
  // default and a nag.
  resetDictionaryCacheForTests();
  const emptied = JSON.stringify({ version: CURRENT_VERSION, items: [] });
  const calls = mockFs(t, emptied);
  assertMockedFs(emptied);

  primeDictionary();
  assert.equal(calls.writes.length, 0, "the defaults came back after the user deleted them");
  assert.deepEqual(listDictionary().items, []);
  resetDictionaryCacheForTests();
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

test("primeDictionary: a failed seed write still leaves the defaults usable for this run", (t) => {
  // "Flow could not write a file" is not a reason to also stop recognizing
  // "Claude". The write is simply retried at the next launch.
  resetDictionaryCacheForTests();
  mockFs(
    t,
    () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    },
    { step: "write", error: Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) },
  );
  const logs: string[] = [];
  primeDictionary((m) => logs.push(m));
  assert.match(logs.join(" "), /could not be written/);
  resetDictionaryCacheForTests();
});
