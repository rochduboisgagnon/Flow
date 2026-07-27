import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./settings";
import { sanitizeSnippetHtml } from "../shared/htmlSanitize";
import type { Snippet, SnippetsResult } from "../shared/ipcContracts";

// U3b: the snippet library store. MIRROR of settings.ts (atomic tmp+rename
// write, tolerant read), with one deliberate difference explained below.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT A FIELD IN settings.json
// ---------------------------------------------------------------------------
// settings.json is rewritten WHOLESALE on every applySettings() call - including
// from the dictation hot path (a language/model tweak mid-session) - and its
// sanitizeSettings() is DELIBERATELY tolerant: a corrupt byte anywhere falls
// back to full defaults so a broken settings file can never stop the app from
// booting (settings.ts's own module note). That tolerance is exactly right for
// a dozen small config fields with sane defaults; it is exactly wrong for a
// user's hand-written snippet library, which has no default worth falling
// back to. One malformed byte in a shared file would silently erase both.
// Keeping snippets.json a SEPARATE file means the two failure domains stay
// separate too: a corrupt settings.json still loses only settings, and (see
// below) a corrupt or unrecognized snippets.json loses nothing at all - it is
// left on disk, untouched, rather than overwritten with an empty library.
//
// ---------------------------------------------------------------------------
// THE VERSION GUARD
// ---------------------------------------------------------------------------
// {version: 1, items: [...]} from the very first byte this format is ever
// written, because this file WILL grow (U5 and beyond), and settings.ts's
// "drop what we don't recognize" tolerance is the wrong default for content a
// user cannot re-create by hand. A snippets.json whose version this build does
// not recognize - e.g. a newer Flow wrote version 2 and the machine was then
// rolled back - is a file we cannot safely reinterpret. sanitizeSettings()
// would drop the unknown shape and move on; this module instead REFUSES to
// touch it: parseSnippetsFile() reports the file as empty-with-an-error, and
// saveSnippetsFile() re-checks what is ACTUALLY on disk immediately before
// every write and refuses to overwrite anything it does not recognize. The
// library then "starts empty" for this run, with a readable error surfaced up
// through SnippetsResult.error - annoying, but recoverable (the real file is
// still sitting there); overwriting it would not be.
//
// ---------------------------------------------------------------------------
// A LOSSY LOAD MAKES THE STORE READ-ONLY
// ---------------------------------------------------------------------------
// The version guard above covers a file we did not understand AT ALL. The same
// reasoning applies one level down, to a file we understood only PARTLY: an
// entry dropped for being malformed, a cue/text/html over its bound, more than
// MAX_ITEMS entries, an `items` field that is not an array. Those are tolerated
// at READ time - the user still sees the rest of his library, which is the
// whole point of being tolerant at the item level - but they must NOT be
// tolerated at WRITE time, because the next save would serialize the amputated
// in-memory version over the intact file and make the loss permanent. Editing
// one snippet's cue would quietly delete the four entries this build could not
// read.
// So any item-level loss sets ParsedSnippets.error, the single predicate the
// overwrite guard reads: the library stays readable and becomes READ-ONLY until
// the file is fixed. The message names what was lost AND where the file is,
// because a store that has silently gone read-only is worse than one that says
// so. Nothing here is sticky in memory: each operation re-loads, so fixing the
// file restores writes without restarting the app.
//
// ---------------------------------------------------------------------------
// WHO MINTS THE ID
// ---------------------------------------------------------------------------
// A `Snippet.id` is ALWAYS minted by this module (node:crypto randomUUID),
// never accepted from the caller as a creation key. An id arriving from the
// renderer over UI_SNIPPET_SAVE is a LOOKUP only: if it does not match an
// existing item, the save is refused rather than silently creating an entry
// under a caller-chosen id. This store is one JSON file, not a directory keyed
// by id - there is no path-traversal risk an id could open - but an
// attacker-chosen id is still a way to overwrite (or shadow) an entry that is
// not the caller's to touch, which is the actual thing being closed here.
//
// ---------------------------------------------------------------------------
// BOUNDS (documented, not guessed)
// ---------------------------------------------------------------------------
// MAX_CUE_CHARS (200): a spoken cue is a short trigger phrase ("adresse du
//   bureau", "signature courriel"), not a paragraph - 200 chars is already
//   several sentences of cue.
// MAX_TEXT_CHARS (20_000): the plain-text fallback is a snippet, not a
//   report - ~4000 words is generous for a canned reply or a contract clause
//   and still trivial on disk.
// MAX_HTML_CHARS (100_000): bounds what the STORE keeps on disk long-term
//   (the sanitizer's own 1 MiB MAX_SNIPPET_HTML_CHARS bounds what the PARSER
//   will look at - a different job). Markup overhead over the visible text can
//   run 2-3x, so this sits comfortably above MAX_TEXT_CHARS.
//   It is enforced as a REFUSAL, never as a trim of the sanitizer's output.
//   Slicing that output would cut mid-tag and write unbalanced markup, which
//   throws away the exact guarantee htmlSanitize.ts's docblock makes to every
//   future consumer (the local HTTP API, an MCP reader, a backup someone opens
//   in a browser) - and it would throw it away for the ONE file big enough to
//   be worth reading carefully. So the input is bounded before sanitizing and
//   the output is checked after (escaping can grow text ~5x, so a legal input
//   can still produce an illegal output). A user who pastes too much is told
//   so, instead of discovering a truncated snippet weeks later.
// MAX_ITEMS (500): already a very large personal snippet library. Bounds the
//   size of a file that is loaded and re-serialized WHOLE on every write, and
//   bounds enumeration cost for every future consumer.
// MAX_ID_CHARS (100): a minted id is always a 36-char UUID; this only clamps
//   a hand-edited file's id field so a single absurd string cannot bloat the
//   file on its own.

export const CURRENT_VERSION = 1 as const;

export const MAX_CUE_CHARS = 200;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_HTML_CHARS = 100_000;
export const MAX_ITEMS = 500;
export const MAX_ID_CHARS = 100;
/** How many individual losses a read-only message names before it just counts
 * the rest: the message is read by a human in a dialog, and a corrupt file can
 * produce one loss per entry. */
export const MAX_REPORTED_LOSSES = 5;

export interface SnippetsFile {
  version: typeof CURRENT_VERSION;
  items: Snippet[];
}

export interface ParsedSnippets {
  file: SnippetsFile;
  /** Set when the input could not be trusted, at either level:
   *  - the FILE level (wrong shape, wrong/missing version, or, from
   *    loadSnippetsFile, unreadable bytes) - `file.items` is then EMPTY, never
   *    a partial guess;
   *  - the ITEM level (an entry dropped, a field truncated, more than
   *    MAX_ITEMS) - `file.items` then holds what we DID understand.
   * Either way this result must never justify overwriting whatever produced it:
   * it is the one predicate saveSnippetsFile's guard reads (module note). */
  error?: string;
}

/** What one stored entry yielded: the snippet we could build (absent when the
 * entry was too broken to read at all) and every way the file's content did not
 * survive the load intact. Losses are reported, never silently absorbed - see
 * the module note on why one of them freezes writes for the whole library. */
interface StoredItemRead {
  snippet?: Snippet;
  losses: string[];
}

function readStoredSnippet(raw: unknown, at: number): StoredItemRead {
  const where = `entry #${at + 1}`;
  if (typeof raw !== "object" || raw === null) return { losses: [`${where} is not an object`] };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) return { losses: [`${where} has no usable id`] };
  const id = r.id.trim();
  if (typeof r.cue !== "string") return { losses: [`${where} (id ${id}) has no cue string`] };
  if (typeof r.text !== "string") return { losses: [`${where} (id ${id}) has no text string`] };

  const losses: string[] = [];
  if (id.length > MAX_ID_CHARS) losses.push(`${where} has an id over ${MAX_ID_CHARS} chars`);
  if (r.cue.length > MAX_CUE_CHARS) losses.push(`${where} (id ${id}) has a cue over ${MAX_CUE_CHARS} chars`);
  if (r.text.length > MAX_TEXT_CHARS) losses.push(`${where} (id ${id}) has a text over ${MAX_TEXT_CHARS} chars`);

  const format: "text" | "html" = r.format === "html" ? "html" : "text";
  const createdIso = typeof r.createdIso === "string" ? r.createdIso : new Date(0).toISOString();
  const out: Snippet = {
    id: id.slice(0, MAX_ID_CHARS),
    cue: r.cue.slice(0, MAX_CUE_CHARS),
    enabled: r.enabled !== false,
    format,
    text: r.text.slice(0, MAX_TEXT_CHARS),
    createdIso,
  };
  if (format === "html") {
    // Re-sanitized on READ too, even though it was already sanitized at the
    // last WRITE (see saveSnippet below): a hand-edited file on disk earns no
    // more trust than one arriving fresh over IPC, and sanitizeSnippetHtml is
    // idempotent (htmlSanitize.ts DECISION 3), so re-running it here costs
    // nothing on the normal path and closes the gap on the abnormal one.
    //
    // The bound is applied to the INPUT and only CHECKED on the output: a
    // sanitized string cut at an arbitrary index is unbalanced HTML, and this
    // module must not be the thing that manufactures it (see the bounds note).
    // Both cases are losses, so the file goes read-only and the truncated
    // reading can never be written back over the intact one.
    const rawHtml = typeof r.html === "string" ? r.html : "";
    if (rawHtml.length > MAX_HTML_CHARS) {
      losses.push(`${where} (id ${id}) has stored html over ${MAX_HTML_CHARS} chars`);
    }
    out.html = sanitizeSnippetHtml(rawHtml.slice(0, MAX_HTML_CHARS));
    if (out.html.length > MAX_HTML_CHARS) {
      losses.push(`${where} (id ${id}) has html that exceeds ${MAX_HTML_CHARS} chars once escaped`);
    }
  }
  return { snippet: out, losses };
}

/**
 * Pure: turn an already-JSON.parsed value into a trustworthy SnippetsFile, or
 * a documented refusal. No disk I/O - see loadSnippetsFile for the thin
 * wrapper that adds the "file does not exist yet" special case. Tolerant at
 * the ITEM level (a single malformed entry is dropped, the rest of a
 * recognized-version file is kept) but NOT at the version level (see the
 * module note on why) - and "tolerant" means the load SUCCEEDS, not that the
 * loss is unreported: anything dropped or truncated sets `error`, which makes
 * the library read-only until the file is fixed.
 */
export function parseSnippetsFile(raw: unknown): ParsedSnippets {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: "snippets.json is not a JSON object; left untouched, starting with an empty library",
    };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== CURRENT_VERSION) {
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: `snippets.json has version ${JSON.stringify(r.version)}, which this build does not understand; left untouched, library starts empty`,
    };
  }
  const losses: string[] = [];
  // An `items` that is present but is not an array is a file we did not
  // understand, not an empty library: reading it as [] and then allowing a
  // write would replace it with one.
  if (r.items !== undefined && !Array.isArray(r.items)) losses.push("the items field is not an array");
  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items: Snippet[] = [];
  for (const [at, it] of rawItems.entries()) {
    if (items.length >= MAX_ITEMS) {
      // A hand-edited file over the cap: keep the first MAX_ITEMS, and say so.
      // Dropping the overflow silently was the bug - the next save wrote the
      // survivors back and the rest was gone for good.
      losses.push(`the file holds ${rawItems.length} entries, over the ${MAX_ITEMS} cap`);
      break;
    }
    const read = readStoredSnippet(it, at);
    losses.push(...read.losses);
    if (read.snippet) items.push(read.snippet);
  }
  if (losses.length > 0) {
    // A thoroughly broken file can produce one loss per entry, and this string
    // is shown to a human in a dialog: list enough to identify the problem, then
    // count the rest. The point is to be actionable, not exhaustive.
    const shown = losses.slice(0, MAX_REPORTED_LOSSES).join("; ");
    const rest = losses.length - MAX_REPORTED_LOSSES;
    return {
      file: { version: CURRENT_VERSION, items },
      error: `snippets.json did not load intact, so the library is READ-ONLY until it is fixed (saving now would make the loss permanent): ${shown}${rest > 0 ? `; and ${rest} more` : ""}`,
    };
  }
  return { file: { version: CURRENT_VERSION, items } };
}

/**
 * Pure: what UI_SNIPPET_SAVE does to an items array, given the CURRENT
 * library and the raw IPC payload. Exported and disk-free specifically so the
 * id-lookup-vs-mint rule and the bounds are unit-testable without touching
 * ~/.flow (mirrors sanitizeSettings in settings.ts).
 */
export function applySnippetSave(
  items: readonly Snippet[],
  rawInput: unknown,
): { items: Snippet[] } | { error: string } {
  // The value crosses IPC from the renderer, where the declared type
  // (SnippetInput) is a promise, not a fact - same discipline as
  // sanitizeSettings(raw: unknown) in settings.ts.
  const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
  const requestedId = typeof input.id === "string" ? input.id.trim() : "";
  const format: "text" | "html" = input.format === "html" ? "html" : "text";
  const cue = (typeof input.cue === "string" ? input.cue : "").slice(0, MAX_CUE_CHARS);
  const text = (typeof input.text === "string" ? input.text : "").slice(0, MAX_TEXT_CHARS);
  const enabled = input.enabled !== false;
  // Sanitized HERE, at the write boundary, before the bytes ever reach
  // saveSnippetsFile - see htmlSanitize.ts's own module note on why
  // sanitizing later (on read, in the renderer) would be too late for every
  // OTHER future reader of the stored file.
  let html: string | undefined;
  if (format === "html") {
    const rawHtml = typeof input.html === "string" ? input.html : "";
    // Bound the INPUT, refuse an oversized OUTPUT, never slice what the
    // sanitizer returned: a cut lands mid-tag and puts unbalanced HTML on
    // disk, which is precisely the guarantee htmlSanitize.ts's docblock makes
    // to every future consumer of the file (bounds note above). Refusing is
    // also the honest answer to the user - the alternative is a snippet that
    // silently stops in the middle of a sentence.
    if (rawHtml.length > MAX_HTML_CHARS) {
      return {
        error: `this snippet's formatted text is ${rawHtml.length} characters, over the ${MAX_HTML_CHARS} limit; shorten it and save again`,
      };
    }
    html = sanitizeSnippetHtml(rawHtml);
    if (html.length > MAX_HTML_CHARS) {
      // Escaping can grow text ~5x ("&" -> "&amp;"), so an input under the cap
      // can still land over it.
      return {
        error: `this snippet's formatted text grows to ${html.length} characters once encoded, over the ${MAX_HTML_CHARS} limit; shorten it and save again`,
      };
    }
  }

  if (requestedId) {
    const at = items.findIndex((it) => it.id === requestedId);
    if (at < 0) {
      // The id is a LOOKUP key only, never a creation key (module note): a
      // stale or forged id must fail loudly, not silently mint an
      // attacker-named entry.
      return { error: `snippet ${requestedId} was not found` };
    }
    const updated: Snippet = { ...items[at], cue, enabled, format, text };
    if (format === "html") updated.html = html;
    else delete updated.html;
    const next = items.slice();
    next[at] = updated;
    return { items: next };
  }

  if (items.length >= MAX_ITEMS) {
    return { error: `the snippet library is full (${MAX_ITEMS} max)` };
  }
  const created: Snippet = {
    id: randomUUID(), // minted by the STORE, never accepted from the caller
    cue,
    enabled,
    format,
    text,
    createdIso: new Date().toISOString(),
  };
  if (format === "html") created.html = html;
  return { items: [...items, created] };
}

/**
 * Pure: what UI_SNIPPET_DELETE does. Deleting an id that is already gone is a
 * no-op, not an error - idempotent, matching what a page holding a possibly
 * stale list expects.
 */
export function applySnippetDelete(items: readonly Snippet[], rawId: unknown): Snippet[] {
  const id = typeof rawId === "string" ? rawId : "";
  return items.filter((it) => it.id !== id);
}

export function snippetsPath(): string {
  return path.join(dataDir(), "snippets.json");
}

/** Thin disk wrapper around parseSnippetsFile: adds the ENOENT special case
 * (a fresh install has no snippets.json yet - that is normal, not an error to
 * surface) and turns any other read failure into the same protective shape a
 * bad version gets. */
export function loadSnippetsFile(): ParsedSnippets {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(snippetsPath(), "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { file: { version: CURRENT_VERSION, items: [] } }; // first run: normal, nothing to warn about
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: `snippets.json could not be read (${err instanceof Error ? err.message : String(err)}); left untouched, starting with an empty library [${snippetsPath()}]`,
    };
  }
  const parsed = parseSnippetsFile(raw);
  // The path is added HERE rather than inside the pure parser: every refusal
  // above tells the user his file was left alone, and that is only actionable
  // if he knows which file. One place to add it, one place to keep right.
  if (parsed.error !== undefined) return { ...parsed, error: `${parsed.error} [${snippetsPath()}]` };
  return parsed;
}

/**
 * Atomic write (tmp + rename), MIRROR of settings.ts's saveSettings - a crash
 * mid-save must not corrupt the library. Unlike settings.ts, it refuses to
 * clobber a file this build did not fully understand (module note).
 *
 * That guard reads `onDisk`, the ParsedSnippets the CALLER already produced for
 * this same operation, instead of loading the file a second time. The property
 * is unchanged and the cost is halved: the caller's load and this write happen
 * on the SAME synchronous turn of the main-process event loop (everything in
 * between - applySnippetSave, applySnippetDelete - is pure and does no I/O),
 * so nothing in this process can have touched the file in between, and against
 * an outside editor the old shape was no better - it only moved the same
 * unavoidable read/write window a few microseconds later. What the guard
 * actually enforces is what `onDisk.error` says: we overwrite only a file we
 * understood completely. Reading the library twice per keystroke-triggered save
 * was not buying a stronger promise, just two more synchronous readFileSync +
 * JSON.parse + re-sanitize passes over every stored snippet, on the loop that
 * carries the keyboard hook.
 */
function saveSnippetsFile(onDisk: ParsedSnippets, file: SnippetsFile): { ok: true } | { ok: false; error: string } {
  // Kept even though both callers already returned on this: it is the invariant
  // of the function, not of its callers, and the next caller will not read the
  // module note first.
  if (onDisk.error) return { ok: false, error: `refusing to overwrite snippets.json: ${onDisk.error}` };
  const p = snippetsPath();
  const tmp = p + ".tmp";
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    // A full disk, a read-only profile, or an antivirus holding the file open
    // (Bitdefender does exactly this on this machine) must come back as a
    // SnippetsResult the page can show. Letting the exception cross the IPC
    // handler leaves the user staring at a dialog that did nothing and said
    // nothing - and the library on disk is intact, which is worth saying.
    try {
      fs.rmSync(tmp, { force: true }); // best effort: never leave a half-written .tmp behind
    } catch {
      /* the cleanup failing changes nothing about the error we are reporting */
    }
    return {
      ok: false,
      error: `snippets.json could not be written (${err instanceof Error ? err.message : String(err)}); the library on disk is unchanged [${p}]`,
    };
  }
  return { ok: true };
}

/** UI_SNIPPET_LIST: always the whole library (PULL-only, see
 * ipcContracts.ts's module note on why it is never in the periodic push). */
export function listSnippets(): SnippetsResult {
  const { file, error } = loadSnippetsFile();
  return { ok: error === undefined, items: file.items, error };
}

/** UI_SNIPPET_SAVE: create when rawInput carries no (or an unknown) id, else
 * update in place. Every channel answers with the WHOLE library so the page
 * can never hold a stale list after a write it did not itself make. */
export function saveSnippet(rawInput: unknown): SnippetsResult {
  // ONE load per operation: it is also what saveSnippetsFile's overwrite guard
  // checks (see there for why that keeps the same guarantee).
  const onDisk = loadSnippetsFile();
  const { file, error } = onDisk;
  if (error) return { ok: false, items: file.items, error };
  const applied = applySnippetSave(file.items, rawInput);
  if ("error" in applied) return { ok: false, items: file.items, error: applied.error };
  const saved = saveSnippetsFile(onDisk, { version: CURRENT_VERSION, items: applied.items });
  return saved.ok ? { ok: true, items: applied.items } : { ok: false, items: file.items, error: saved.error };
}

/** UI_SNIPPET_DELETE. */
export function deleteSnippet(rawId: unknown): SnippetsResult {
  const onDisk = loadSnippetsFile();
  const { file, error } = onDisk;
  if (error) return { ok: false, items: file.items, error };
  const next = applySnippetDelete(file.items, rawId);
  if (next.length === file.items.length) return { ok: true, items: file.items }; // nothing matched: idempotent no-op
  const saved = saveSnippetsFile(onDisk, { version: CURRENT_VERSION, items: next });
  return saved.ok ? { ok: true, items: next } : { ok: false, items: file.items, error: saved.error };
}

/** Lookup for UI_SNIPPET_COPY (uiBridge.ts owns the actual clipboard write -
 * this module stays Electron-free, like settings.ts, so it stays testable
 * under plain node:test). */
export function getSnippet(rawId: unknown): Snippet | undefined {
  const id = typeof rawId === "string" ? rawId : "";
  if (!id) return undefined;
  return loadSnippetsFile().file.items.find((it) => it.id === id);
}
