import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CURRENT_VERSION,
  MAX_CUE_CHARS,
  MAX_TEXT_CHARS,
  MAX_HTML_CHARS,
  MAX_ITEMS,
  parseSnippetsFile,
  applySnippetSave,
  applySnippetDelete,
  saveSnippet,
  deleteSnippet,
  snippetsPath,
} from "../src/main/snippets";
import { sanitizeSnippetHtml } from "../src/shared/htmlSanitize";
import type { Snippet, SnippetsResult } from "../src/shared/ipcContracts";

// U3b: mostly the PURE, disk-free surface - same split as settings.test.ts,
// which exercises sanitizeSettings directly but never loadSettings/saveSettings
// (those touch the real ~/.flow on whatever machine runs the suite).
// parseSnippetsFile/applySnippetSave/applySnippetDelete are exported
// specifically so this file never has to.
//
// The last section is the exception, and it is deliberate: the promises that
// saveSnippet/deleteSnippet make - never overwrite a file we did not fully
// understand, answer a failed write with {ok:false} instead of throwing, read
// the library ONCE per operation - live exactly in the disk plumbing, so
// testing only the pure half is testing everything except the part that broke.
// node:fs is mocked rather than pointed at a temp folder, because a temp folder
// cannot be made to fail with ENOSPC or "an antivirus is holding this file".
// Every one of those tests starts with assertMockedFs(): if the interception
// ever stops working, the assertion fails BEFORE any write is attempted, so a
// broken mock can never reach the real ~/.flow/snippets.json.

function makeStored(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "abc-123",
    cue: "adresse bureau",
    enabled: true,
    format: "text",
    text: "123 rue Exemple",
    createdIso: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

test("parseSnippetsFile: null / non-object / array root are refused, not silently emptied without a reason", () => {
  for (const bad of [null, undefined, 42, "nope", ["a"]]) {
    const r = parseSnippetsFile(bad);
    assert.deepEqual(r.file.items, []);
    assert.ok(r.error, `expected an error for ${JSON.stringify(bad)}`);
  }
});

test("parseSnippetsFile: an unrecognized version is refused, library starts empty with a readable error", () => {
  const r = parseSnippetsFile({ version: 2, items: [makeStored()] });
  assert.deepEqual(r.file.items, []);
  assert.match(r.error ?? "", /version/i);
});

test("parseSnippetsFile: a missing version field is treated the same as an unrecognized one", () => {
  const r = parseSnippetsFile({ items: [makeStored()] });
  assert.deepEqual(r.file.items, []);
  assert.ok(r.error);
});

test("parseSnippetsFile: version 1 with no items is a normal empty library, no error", () => {
  const r = parseSnippetsFile({ version: CURRENT_VERSION, items: [] });
  assert.deepEqual(r.file, { version: 1, items: [] });
  assert.equal(r.error, undefined);
});

test("parseSnippetsFile: a valid text item round-trips, unknown fields dropped", () => {
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ evil: "ignored" })],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.file.items.length, 1);
  const s = r.file.items[0];
  assert.equal(s.id, "abc-123");
  assert.equal(s.cue, "adresse bureau");
  assert.equal(s.format, "text");
  assert.equal(s.text, "123 rue Exemple");
  assert.equal("html" in s, false, "a text-format item never carries an html field");
  assert.equal("evil" in s, false);
});

test("parseSnippetsFile: format defaults to text on anything but the literal string 'html'", () => {
  for (const bad of [undefined, "HTML", 1, null]) {
    const r = parseSnippetsFile({ version: CURRENT_VERSION, items: [makeStored({ format: bad })] });
    assert.equal(r.file.items[0].format, "text");
  }
});

test("parseSnippetsFile: enabled defaults true, only an explicit false turns it off", () => {
  assert.equal(parseSnippetsFile({ version: CURRENT_VERSION, items: [makeStored({ enabled: undefined })] }).file.items[0].enabled, true);
  assert.equal(parseSnippetsFile({ version: CURRENT_VERSION, items: [makeStored({ enabled: "no" })] }).file.items[0].enabled, true);
  assert.equal(parseSnippetsFile({ version: CURRENT_VERSION, items: [makeStored({ enabled: false })] }).file.items[0].enabled, false);
});

test("parseSnippetsFile: an html item is re-sanitized on load (defense in depth for a hand-edited file)", () => {
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ format: "html", html: "<b>bonjour</b><script>evil()</script>" })],
  });
  const s = r.file.items[0];
  assert.equal(s.format, "html");
  assert.equal(s.html, "<b>bonjour</b>");
});

test("parseSnippetsFile: malformed items are dropped individually, the rest survives, and the loss is REPORTED", () => {
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ id: "good-1" }), { cue: "no id or text" }, 42, null, makeStored({ id: "good-2" })],
  });
  assert.deepEqual(
    r.file.items.map((s) => s.id),
    ["good-1", "good-2"],
  );
  // Tolerance is about what we KEEP, never about staying quiet: three entries
  // just vanished from the in-memory library, and without this error the next
  // save would write the amputated version straight over the file that still
  // holds them. The error is what turns the library read-only until it is fixed.
  assert.ok(r.error, "an item-level drop has to raise the read-only signal");
  assert.match(r.error ?? "", /READ-ONLY/);
  assert.match(r.error ?? "", /entry #2/, "the message says WHICH entries were lost");
  assert.match(r.error ?? "", /entry #3/);
  assert.match(r.error ?? "", /entry #4/);
});

test("parseSnippetsFile: cue/text are truncated at the documented bounds, and truncation is a reported loss", () => {
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ cue: "x".repeat(MAX_CUE_CHARS + 50), text: "y".repeat(MAX_TEXT_CHARS + 50) })],
  });
  assert.equal(r.file.items[0].cue.length, MAX_CUE_CHARS);
  assert.equal(r.file.items[0].text.length, MAX_TEXT_CHARS);
  assert.ok(r.error, "a silent truncation is a save away from being permanent");
  assert.match(r.error ?? "", /cue over 200 chars/);
  assert.match(r.error ?? "", /text over 20000 chars/);
});

test("parseSnippetsFile: a hand-edited file over the item cap keeps the first MAX_ITEMS and says so", () => {
  const items = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => makeStored({ id: `id-${i}` }));
  const r = parseSnippetsFile({ version: CURRENT_VERSION, items });
  assert.equal(r.file.items.length, MAX_ITEMS);
  assert.ok(r.error, "5 snippets are about to disappear on the next save");
  assert.match(r.error ?? "", new RegExp(`${MAX_ITEMS + 5} entries`));
});

test("parseSnippetsFile: a thoroughly broken file names a few losses and counts the rest", () => {
  // The message ends up in a dialog. One loss per entry would produce a wall of
  // text nobody reads, which is its own way of hiding the problem.
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: Array.from({ length: 40 }, () => ({ nothing: "usable" })),
  });
  assert.deepEqual(r.file.items, []);
  assert.match(r.error ?? "", /and 35 more/);
  assert.equal((r.error ?? "").length < 600, true, `the message is a wall of text: ${(r.error ?? "").length} chars`);
});

test("parseSnippetsFile: an items field that is not an array is a loss, not an empty library", () => {
  // Reading it as [] and then allowing a write is how a file gets replaced by
  // an empty one. A missing items field, on the other hand, IS an empty library.
  for (const bad of ["nope", 42, { 0: makeStored() }]) {
    const r = parseSnippetsFile({ version: CURRENT_VERSION, items: bad });
    assert.deepEqual(r.file.items, []);
    assert.match(r.error ?? "", /items field is not an array/, JSON.stringify(bad));
  }
  assert.equal(parseSnippetsFile({ version: CURRENT_VERSION }).error, undefined);
});

test("parseSnippetsFile: an oversized stored html is reported, and what we keep is never cut mid-tag", () => {
  // The bound is applied to the INPUT and only CHECKED on the output. Slicing
  // the sanitizer's output is what used to happen, and it produces unbalanced
  // markup - which is exactly the guarantee htmlSanitize.ts's docblock makes to
  // every future reader of the file (local HTTP API, MCP reader, backup opened
  // in a browser). The tail here is sized so that a cut at MAX_HTML_CHARS lands
  // in the middle of a tag.
  const unit = "<b>xx</b>";
  const huge = unit.repeat(Math.ceil((MAX_HTML_CHARS + 5000) / unit.length));
  assert.ok(huge.length > MAX_HTML_CHARS);
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ format: "html", html: huge })],
  });
  const kept = r.file.items[0].html ?? "";
  assert.ok(r.error, "dropping the tail of a snippet is a loss like any other");
  assert.match(r.error ?? "", /stored html over/);
  // The fixed point IS the proof of balance: a string cut mid-tag is not one
  // (sanitizing it again would repair or drop the stump and return something
  // else), and htmlSanitize.ts guarantees sanitize(sanitize(x)) === sanitize(x).
  assert.equal(sanitizeSnippetHtml(kept), kept, "the stored html is not a valid sanitizer output");
  assert.equal(kept, sanitizeSnippetHtml(huge.slice(0, MAX_HTML_CHARS)), "the bound belongs on the input, not on the output");
  // ...and the shape this replaced really was broken: cutting the OUTPUT at the
  // same index leaves a stump the sanitizer does not reproduce, so the old code
  // could not have passed the assertion above.
  const outputSliced = sanitizeSnippetHtml(huge).slice(0, MAX_HTML_CHARS);
  assert.notEqual(sanitizeSnippetHtml(outputSliced), outputSliced, "this corpus no longer catches output-slicing");

  // An html that only breaks the bound once ESCAPED is the same story: nothing
  // is cut, the overflow is reported.
  const amps = "&".repeat(MAX_HTML_CHARS - 10);
  const r2 = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ format: "html", html: amps })],
  });
  const kept2 = r2.file.items[0].html ?? "";
  assert.ok(kept2.length > MAX_HTML_CHARS, "escaping grows ~5x, so this is over the bound");
  assert.equal(sanitizeSnippetHtml(kept2), kept2);
  assert.match(r2.error ?? "", /once escaped/);
});

test("parseSnippetsFile: an ordinary, intact file raises NO read-only signal", () => {
  // The counterweight to everything above: if the losses were over-eager, every
  // normal library would be frozen read-only and the store would be useless.
  const r = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [
      makeStored({ id: "a" }),
      makeStored({ id: "b", format: "html", html: "<b>bonjour</b>" }),
      makeStored({ id: "c", cue: "x".repeat(MAX_CUE_CHARS), text: "y".repeat(MAX_TEXT_CHARS) }),
      makeStored({ id: "d", enabled: false, createdIso: undefined }),
    ],
  });
  assert.equal(r.file.items.length, 4);
  assert.equal(r.error, undefined, `unexpected read-only signal: ${r.error ?? ""}`);
  // Including a file whose html the sanitizer had to CLEAN: that is a repair of
  // something hostile, not a loss of something the user wrote, and freezing the
  // library over it would punish the user for a file we just fixed.
  const cleaned = parseSnippetsFile({
    version: CURRENT_VERSION,
    items: [makeStored({ format: "html", html: "<b>ok</b><script>evil()</script>" })],
  });
  assert.equal(cleaned.file.items[0].html, "<b>ok</b>");
  assert.equal(cleaned.error, undefined);
});

// ---------------------------------------------------------------------------
// applySnippetSave
// ---------------------------------------------------------------------------

test("applySnippetSave: no id creates a new item with a store-minted UUID", () => {
  const result = applySnippetSave([], { cue: "salut", format: "text", text: "bonjour", enabled: true });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  assert.equal(result.items.length, 1);
  const created = result.items[0];
  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  assert.equal(created.cue, "salut");
  assert.ok(created.createdIso.length > 0);
});

test("applySnippetSave: format html sanitizes the stored html and always keeps the plain-text fallback", () => {
  const result = applySnippetSave([], {
    cue: "adresse",
    format: "html",
    text: "123 rue Exemple",
    html: "<b>123</b> <script>evil()</script>rue Exemple",
  });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  const created = result.items[0];
  assert.equal(created.format, "html");
  assert.equal(created.text, "123 rue Exemple", "the plain-text fallback is stored as-is, never derived from the html");
  assert.equal(created.html?.includes("script"), false);
});

test("applySnippetSave: format text never carries an html field, even if the caller sent one", () => {
  const result = applySnippetSave([], { cue: "a", format: "text", text: "b", html: "<b>evil</b>" });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  assert.equal("html" in result.items[0], false);
});

test("applySnippetSave: an id that does not match an existing item is REFUSED, never used to create one", () => {
  // This is the load-bearing rule from the module note: an id is a lookup
  // key only. Without this test, a future edit could silently turn a bad
  // lookup into "create it with that id anyway", which is exactly the
  // attacker-chosen-id path the store must not have.
  const result = applySnippetSave([], { id: "attacker-chosen-id", cue: "a", format: "text", text: "b" });
  assert.ok("error" in result);
  if ("error" in result) assert.match(result.error, /not found/);
});

test("applySnippetSave: a matching id updates in place, preserving id and createdIso", () => {
  const existing: Snippet = {
    id: "keep-me",
    cue: "old cue",
    enabled: true,
    format: "text",
    text: "old text",
    createdIso: "2020-01-01T00:00:00.000Z",
  };
  const result = applySnippetSave([existing], { id: "keep-me", cue: "new cue", format: "text", text: "new text", enabled: false });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "keep-me");
  assert.equal(result.items[0].createdIso, "2020-01-01T00:00:00.000Z");
  assert.equal(result.items[0].cue, "new cue");
  assert.equal(result.items[0].enabled, false);
});

test("applySnippetSave: switching an existing item from html back to text drops the stale html field", () => {
  const existing: Snippet = {
    id: "x",
    cue: "c",
    enabled: true,
    format: "html",
    text: "t",
    html: "<b>t</b>",
    createdIso: "2020-01-01T00:00:00.000Z",
  };
  const result = applySnippetSave([existing], { id: "x", cue: "c", format: "text", text: "t" });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  assert.equal("html" in result.items[0], false);
});

test("applySnippetSave: creating beyond MAX_ITEMS is refused with a clear reason, library unchanged", () => {
  const full: Snippet[] = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    id: `id-${i}`,
    cue: `cue ${i}`,
    enabled: true,
    format: "text" as const,
    text: "t",
    createdIso: "2020-01-01T00:00:00.000Z",
  }));
  const result = applySnippetSave(full, { cue: "one too many", format: "text", text: "t" });
  assert.ok("error" in result);
  if ("error" in result) assert.match(result.error, /full/);
});

test("applySnippetSave: updating an existing item is allowed even when the library is already at MAX_ITEMS", () => {
  const full: Snippet[] = Array.from({ length: MAX_ITEMS }, (_, i) => ({
    id: `id-${i}`,
    cue: `cue ${i}`,
    enabled: true,
    format: "text" as const,
    text: "t",
    createdIso: "2020-01-01T00:00:00.000Z",
  }));
  const result = applySnippetSave(full, { id: "id-0", cue: "updated", format: "text", text: "t" });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  assert.equal(result.items.length, MAX_ITEMS);
  assert.equal(result.items[0].cue, "updated");
});

test("applySnippetSave: cue/text are truncated at the documented bounds on save too", () => {
  const result = applySnippetSave([], {
    cue: "x".repeat(MAX_CUE_CHARS + 10),
    format: "text",
    text: "y".repeat(MAX_TEXT_CHARS + 10),
  });
  assert.ok("items" in result);
  if (!("items" in result)) return;
  assert.equal(result.items[0].cue.length, MAX_CUE_CHARS);
  assert.equal(result.items[0].text.length, MAX_TEXT_CHARS);
});

test("applySnippetSave: html over MAX_HTML_CHARS is REFUSED, never trimmed into broken markup", () => {
  // Trimming was the old behaviour and it cut the sanitizer's OUTPUT at an
  // arbitrary index: the file on disk stopped being balanced, which silently
  // withdraws htmlSanitize.ts's guarantee from every future consumer - and the
  // user was never told his snippet had been amputated.
  const result = applySnippetSave([], {
    cue: "a",
    format: "html",
    text: "t",
    html: "<p>" + "a".repeat(MAX_HTML_CHARS + 1000) + "</p>",
  });
  assert.ok("error" in result, "an oversized paste must fail loudly");
  if ("error" in result) {
    assert.match(result.error, new RegExp(String(MAX_HTML_CHARS)));
    assert.match(result.error, /shorten it/, "the message has to tell the user what to do");
  }

  // Under the bound as written, over it once escaped: same refusal. Escaping
  // grows text up to ~5x ("&" -> "&amp;"), so bounding only the input would
  // still let an over-bound string reach the disk.
  const grown = applySnippetSave([], {
    cue: "a",
    format: "html",
    text: "t",
    html: "&".repeat(MAX_HTML_CHARS - 10),
  });
  assert.ok("error" in grown);
  if ("error" in grown) assert.match(grown.error, /once encoded/);

  // The boundary itself still saves, and what it stores is a whole sanitizer
  // output - the fixed point proves it was not cut (see the parse test).
  const ok = applySnippetSave([], {
    cue: "a",
    format: "html",
    text: "t",
    html: "<b>x</b>".repeat(MAX_HTML_CHARS / 8),
  });
  assert.ok("items" in ok, "a snippet exactly at the bound is legal");
  if (!("items" in ok)) return;
  const html = ok.items[0].html ?? "";
  assert.equal(html.length, MAX_HTML_CHARS);
  assert.equal(sanitizeSnippetHtml(html), html);
});

test("applySnippetSave: garbage input (not an object) creates an empty-but-valid snippet rather than throwing", () => {
  for (const bad of [null, undefined, "nope", 42]) {
    const result = applySnippetSave([], bad);
    assert.ok("items" in result, `expected a created item for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// applySnippetDelete
// ---------------------------------------------------------------------------

test("applySnippetDelete: removes the matching item only", () => {
  const items: Snippet[] = [
    { id: "a", cue: "1", enabled: true, format: "text", text: "1", createdIso: "x" },
    { id: "b", cue: "2", enabled: true, format: "text", text: "2", createdIso: "x" },
  ];
  const next = applySnippetDelete(items, "a");
  assert.deepEqual(next.map((s) => s.id), ["b"]);
});

test("applySnippetDelete: an id that matches nothing is a no-op, not an error", () => {
  const items: Snippet[] = [{ id: "a", cue: "1", enabled: true, format: "text", text: "1", createdIso: "x" }];
  const next = applySnippetDelete(items, "does-not-exist");
  assert.deepEqual(next, items);
});

// ---------------------------------------------------------------------------
// saveSnippet / deleteSnippet: the disk plumbing, with node:fs mocked
// ---------------------------------------------------------------------------

interface FsCalls {
  reads: number;
  writes: string[];
  renames: number;
  mkdirs: number;
  removed: string[];
}

/** Which step of the atomic write should fail, and with what. */
type FailAt = { step: "mkdir" | "write" | "rename"; error: Error };

/**
 * Replace every node:fs call these functions make. `t.mock` restores them when
 * the test ends. `failAt` makes one step fail the way a full disk, a read-only
 * profile or an antivirus holding the file open would - each step matters,
 * because they fail for different real reasons and the module has to answer the
 * same way for all three.
 */
function mockFs(
  t: { mock: { method: typeof import("node:test").mock.method } },
  fileContent: string | (() => never),
  failAt?: FailAt,
): FsCalls {
  const calls: FsCalls = { reads: 0, writes: [], renames: 0, mkdirs: 0, removed: [] };
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
    calls.mkdirs++;
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

/**
 * The safety catch. If the fs interception ever stops working (a module-loading
 * change, a Node version that freezes the builtin's exports), these tests would
 * silently start reading and OVERWRITING the real ~/.flow/snippets.json of
 * whoever runs the suite. Every mocked test calls this first, so a broken mock
 * fails the test before a single write is attempted.
 */
function assertMockedFs(expected: string): void {
  assert.equal(
    fs.readFileSync(snippetsPath(), "utf8"),
    expected,
    "node:fs is NOT mocked - aborting before this test can touch the real snippet library",
  );
}

const LIBRARY = JSON.stringify({
  version: CURRENT_VERSION,
  items: [makeStored({ id: "keep-me", cue: "adresse" })],
});

test("saveSnippet: one read per operation, not two", (t) => {
  // saveSnippet used to load the library, then hand it to a writer that loaded
  // it AGAIN for its overwrite guard: two readFileSync + JSON.parse +
  // re-sanitize of every stored html, synchronously, on the loop that carries
  // the keyboard hook. The guard now reads what the caller already loaded,
  // which is the same file (nothing between them does I/O) and half the work.
  const calls = mockFs(t, LIBRARY);
  assertMockedFs(LIBRARY);
  const before = calls.reads;

  const result = saveSnippet({ cue: "nouveau", format: "text", text: "t" });
  assert.equal(result.ok, true, result.error ?? "save failed");
  assert.equal(calls.reads - before, 1, "the library was read more than once for a single save");
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.renames, 1, "still an atomic tmp + rename");
  assert.equal(result.items.length, 2);
});

test("deleteSnippet: one read per operation too", (t) => {
  const calls = mockFs(t, LIBRARY);
  assertMockedFs(LIBRARY);
  const before = calls.reads;

  const result = deleteSnippet("keep-me");
  assert.equal(result.ok, true, result.error ?? "save failed");
  assert.equal(calls.reads - before, 1);
  assert.deepEqual(result.items, []);
});

test("saveSnippet: a failed write answers {ok:false} with the library as it was, and never throws", (t) => {
  // ENOSPC, EACCES, or Bitdefender holding the file open - a known visitor on
  // this machine. Before, the exception crossed the IPC handler and the page
  // showed nothing at all: no new snippet, no error, no clue.
  // All three steps of the atomic write, because they fail for different real
  // reasons: the folder cannot be created, the disk is full, or the rename is
  // blocked - the last being what an antivirus scanning the .tmp actually does.
  for (const failAt of [
    { step: "mkdir", error: Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" }) },
    { step: "write", error: Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }) },
    { step: "rename", error: Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }) },
  ] as const) {
    const calls = mockFs(t, LIBRARY, failAt);
    assertMockedFs(LIBRARY);

    let result: SnippetsResult | undefined;
    assert.doesNotThrow(() => {
      result = saveSnippet({ cue: "nouveau", format: "text", text: "t" });
    }, `saveSnippet threw on ${failAt.step}`);
    assert.equal(result?.ok, false, failAt.step);
    assert.match(result?.error ?? "", /could not be written/, failAt.step);
    assert.match(result?.error ?? "", new RegExp(failAt.error.message.split(":")[0]), "the OS reason has to survive to the page");
    assert.match(result?.error ?? "", /unchanged/, "the user needs to know the library survived");
    assert.match(result?.error ?? "", /snippets\.json/, "and where the file is");
    // The library that comes back is the one still on disk, not the optimistic
    // in-memory version the page would otherwise start displaying.
    assert.deepEqual(result?.items.map((s) => s.id), ["keep-me"], failAt.step);
    // No half-written .tmp left behind for the next run to trip on.
    assert.equal(calls.removed.length, 1, `no .tmp cleanup after a failed ${failAt.step}`);
    t.mock.restoreAll();
  }
});

test("deleteSnippet: a failed write answers {ok:false} with the library as it was", (t) => {
  mockFs(t, LIBRARY, {
    step: "write",
    error: Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" }),
  });
  assertMockedFs(LIBRARY);

  let result: SnippetsResult | undefined;
  assert.doesNotThrow(() => {
    result = deleteSnippet("keep-me");
  });
  assert.equal(result?.ok, false);
  assert.deepEqual(result?.items.map((s) => s.id), ["keep-me"], "the deleted item is still there, because the delete did not happen");
});

test("saveSnippet: a file that did not load intact is NEVER written back", (t) => {
  // The end-to-end version of the read-only rule. The file holds one entry this
  // build can read and one it cannot; the library is usable, but saving would
  // serialize the surviving entry alone over a file that still holds both.
  const lossy = JSON.stringify({
    version: CURRENT_VERSION,
    items: [makeStored({ id: "readable" }), { id: "broken", cue: "no text field" }],
  });
  const calls = mockFs(t, lossy);
  assertMockedFs(lossy);

  const result = saveSnippet({ cue: "nouveau", format: "text", text: "t" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /READ-ONLY/);
  assert.match(result.error ?? "", /entry #2/);
  assert.equal(calls.writes.length, 0, "the amputated library reached the disk");
  assert.equal(calls.renames, 0);
  // Still readable: read-only is not "unusable".
  assert.deepEqual(result.items.map((s) => s.id), ["readable"]);

  // Same for a delete - it is a write like any other.
  const del = deleteSnippet("readable");
  assert.equal(del.ok, false);
  assert.equal(calls.writes.length, 0);
});

test("saveSnippet: a version this build does not understand is still never overwritten", (t) => {
  const future = JSON.stringify({ version: 2, items: [makeStored()] });
  const calls = mockFs(t, future);
  assertMockedFs(future);

  const result = saveSnippet({ cue: "nouveau", format: "text", text: "t" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /version/i);
  assert.equal(calls.writes.length, 0);
  assert.deepEqual(result.items, []);
});

test("saveSnippet: a first run with no file at all writes normally", (t) => {
  // ENOENT is the one read failure that is not a refusal: a fresh install has
  // no snippets.json, and the first save has to create one.
  const calls = mockFs(t, () => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  });
  assert.throws(() => fs.readFileSync(snippetsPath(), "utf8"), /ENOENT/, "node:fs is NOT mocked");

  const result = saveSnippet({ cue: "premier", format: "text", text: "t" });
  assert.equal(result.ok, true, result.error ?? "save failed");
  assert.equal(calls.writes.length, 1);
  const written = JSON.parse(calls.writes[0]) as { version: number; items: Snippet[] };
  assert.equal(written.version, CURRENT_VERSION);
  assert.equal(written.items.length, 1);
  assert.equal(written.items[0].cue, "premier");
});
