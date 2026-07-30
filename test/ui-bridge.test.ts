import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  UI_GET_STATE,
  UI_SET_SETTINGS,
  UI_RECORD_SHORTCUT,
  UI_LIST_MICS,
  UI_OLLAMA_MODELS,
  UI_OPEN_PATH,
  UI_GET_LOGIN_ITEM,
  UI_SET_LOGIN_ITEM,
  UI_CHECK_UPDATES,
  UI_HOTPATH_SNAPSHOT,
  UI_SELF_CHECK,
  UI_STATS_READ,
  UI_STATS_CLEAR,
  UI_HISTORY_READ,
  UI_HISTORY_CLEAR,
  UI_REDACT_PASSAGES,
  UI_ASSIST_ASK,
  UI_ASSIST_DISMISS,
  UI_ASSIST_KEEP,
  UI_ASSIST_POLL,
  UI_LIVE_NOTES_ADD,
  UI_LIVE_NOTES_DELETE,
  UI_LIVE_NOTES_EDIT,
  UI_LIVE_NOTES_LIST,
  UI_DICT_LIST,
  UI_DICT_SAVE,
  UI_DICT_DELETE,
  UI_LONG_STATE,
  UI_LONG_START,
  UI_LONG_STOP,
  UI_LONG_MARK,
  UI_LONG_TRANSCRIPT,
  UI_HISTORY_LIST,
  UI_HISTORY_DOC,
  UI_DOWNLOAD_DOC,
  UI_DOWNLOAD_AUDIO,
  UI_IMPORT_STATE,
  UI_IMPORT_START,
  UI_IMPORT_CANCEL,
  UI_IMPORT_PICK,
} from "../src/shared/ipcContracts";

// U3c: uiBridge.ts imports "electron", which outside a real Electron process
// resolves to a path string rather than an object - `new UiBridge(...)` would
// throw the moment register() calls ipcMain.handle. So this test cannot
// instantiate the class; instead it reads the SOURCE as text, the same
// technique test/theme.test.ts uses to check main.css against the TypeScript
// theme constants without spinning up a renderer. Two structural facts are
// checked, and either one failing means a channel bypassed the fromMain()
// gate - the exact mistake this test exists to catch without relying on a
// reviewer noticing it by eye on some future channel.
const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "uiBridge.ts"), "utf8");

test("ipcMain.handle is called exactly once - inside guarded() - never directly by a channel handler", () => {
  const rawCalls = SRC.match(/ipcMain\.handle\(/g) ?? [];
  assert.equal(
    rawCalls.length,
    1,
    "a second ipcMain.handle( call means some channel is registered without going through guarded(), i.e. without the fromMain() sender check",
  );
});

test("every ui:* invoke channel this bridge owns is registered through guarded(), and none are missing or stray", () => {
  // "this.guarded<" specifically - not just "guarded<" - so this only matches
  // actual CALL sites (this.guarded<Args, T>(CHANNEL, ...)) and never the
  // private method's own declaration (`private guarded<Args extends
  // unknown[], T>(channel: string, ...)`), which has no "this." prefix and
  // would otherwise false-match its own `channel` parameter name.
  // The type-args span is matched non-greedily over [\s\S] (some calls carry
  // a nested generic, e.g. Array<{ id: string; label: string }>, and some
  // wrap across lines) - the shortest span ending in ">(" always lands on the
  // real call parenthesis, since nothing inside these type expressions ever
  // produces a spurious ">(" of its own.
  const guardedChannels = [...SRC.matchAll(/\bthis\.guarded<[\s\S]*?>\(\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]);

  // Named by IMPORTING the real constants, not string literals: a rename in
  // ipcContracts.ts fails this test instead of the two silently drifting.
  // UI_STATE_PUSH is deliberately absent - it is a push (.send), never an
  // invoke handler, so it must never appear here.
  const expected: Record<string, string> = {
    UI_GET_STATE,
    UI_SET_SETTINGS,
    UI_RECORD_SHORTCUT,
    UI_LIST_MICS,
    UI_OLLAMA_MODELS,
    UI_OPEN_PATH,
    UI_GET_LOGIN_ITEM,
    UI_SET_LOGIN_ITEM,
    UI_CHECK_UPDATES,
            // U6: ui:dict-save changes what every FUTURE dictation is transcribed and
    // rewritten into - a write with a longer reach than any snippet edit, and
    // reachable from the overlay's preload if it were ever left ungated.
    UI_DICT_LIST,
    UI_DICT_SAVE,
    UI_DICT_DELETE,
    UI_LONG_STATE,
    UI_LONG_START,
    UI_LONG_STOP,
    UI_LONG_MARK,
    UI_LONG_TRANSCRIPT,
    UI_HISTORY_LIST,
    UI_HISTORY_DOC,
    UI_DOWNLOAD_DOC,
    UI_DOWNLOAD_AUDIO,
    UI_HOTPATH_SNAPSHOT,
    UI_SELF_CHECK,
    // U7: ui:stats-clear DESTROYS data, and the same preload is loaded by the
    // overlay and the hidden capture window - exactly the shape of channel this
    // enumeration exists to keep behind the fromMain() gate.
    UI_STATS_READ,
    UI_STATS_CLEAR,
    // 2026-07-30: the dictation history. ui:history-clear DELETES a month of
    // what the user actually said, which makes it the most consequential write
    // on this whole surface - and the same preload is loaded by the overlay and
    // the hidden capture window, neither of which is a page anyone reviews.
    UI_HISTORY_READ,
    UI_HISTORY_CLEAR,
    // D11: ui:redact-passages DESTROYS part of a transcript on purpose, and it
    // is the user's only recourse for a sentence someone else regrets saying.
    // It belongs behind the same gate for the same reason as ui:stats-clear.
    UI_REDACT_PASSAGES,
    // D2: ui:import-start is the ONLY channel of this surface that hands main a
    // filesystem path to open, and ui:import-pick opens a native dialog. Both
    // are decisions a page the user is looking at gets to make, and neither is
    // something the overlay or the hidden capture window has any business
    // reaching through the shared preload.
    UI_IMPORT_STATE,
    UI_IMPORT_START,
    UI_IMPORT_CANCEL,
    UI_IMPORT_PICK,
    // U8 (live assist) and the live notes. Each is a reason this registry stays
    // hand-written: the assist channels hand a language model what a meeting
    // just said, and the live-notes channels write and DELETE the user's own
    // typed notes. The same preload is loaded by the overlay and the hidden
    // capture window, so neither may sit outside fromMain().
    //
    // 2026-07-30: the four ui:function-* channels were here too, until voice
    // functions were removed from Flow. Their absence is now asserted by this
    // very list: a registry that must match the bridge exactly is also what
    // catches a removed feature being wired back in by accident.
    UI_ASSIST_ASK,
    UI_ASSIST_DISMISS,
    UI_ASSIST_KEEP,
    UI_ASSIST_POLL,
            UI_LIVE_NOTES_ADD,
    UI_LIVE_NOTES_DELETE,
    UI_LIVE_NOTES_EDIT,
    UI_LIVE_NOTES_LIST,
  };

  assert.deepEqual(
    guardedChannels.sort(),
    Object.keys(expected).sort(),
    "guarded() must wrap exactly the UI_* invoke channels this bridge owns - nothing missing (an ungated channel), nothing stray (a typo'd or duplicate registration)",
  );

  for (const name of guardedChannels) {
    assert.ok(expected[name].startsWith("ui:"), `${name} must resolve to a ui: channel string`);
  }
});

// U3g (review, major): copying a snippet inside the ~250 ms restore window that
// a dictation arms had the timer overwrite the copy a quarter second later with
// the pre-dictation clipboard - the copy vanished under the user's fingers. The
// ORDER is the whole fix (disarm, then write), so it is what gets asserted;
// like the tests above, this is read from source because uiBridge.ts imports
// electron and cannot be instantiated outside an Electron process.
const INSERT_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "insert.ts"), "utf8");


test("the clipboard restore has no CANCEL path any more, and that is deliberate", () => {
  // cancelPendingRestore existed for one caller: copying a snippet inside the
  // ~250 ms restore window, where the timer would overwrite the user's copy a
  // quarter second later. Snippets are gone (2026-07-30), so nothing can put
  // something on the clipboard on purpose between a dictation and its restore,
  // and the rule it encoded has no case left to arbitrate.
  //
  // Asserted rather than simply deleted: an exported function with no caller is
  // how a removed feature grows back, and this is the file that would notice.
  assert.doesNotMatch(INSERT_SRC, /export function cancelPendingRestore/);
  // What must NOT have gone with it: quitting still gives the clipboard back,
  // which protects a real user from losing it forever to a dying process.
  assert.match(INSERT_SRC, /export function flushPendingRestore\(\)/);
});

test("flushPendingRestore still RESTORES (quit) - the two paths must not be confused", () => {
  const fn = /export function flushPendingRestore\(\)[\s\S]*?\n\}/.exec(INSERT_SRC);
  assert.ok(fn);
  assert.ok(fn[0].includes("restoreClipboard("), "quitting owes the user their clipboard back");
});
