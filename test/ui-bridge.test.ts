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
  UI_SNIPPET_LIST,
  UI_SNIPPET_SAVE,
  UI_SNIPPET_DELETE,
  UI_SNIPPET_COPY,
  UI_LONG_STATE,
  UI_LONG_START,
  UI_LONG_STOP,
  UI_LONG_MARK,
  UI_LONG_TRANSCRIPT,
  UI_HISTORY_LIST,
  UI_HISTORY_DOC,
  UI_DOWNLOAD_DOC,
  UI_DOWNLOAD_AUDIO,
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
    UI_SNIPPET_LIST,
    UI_SNIPPET_SAVE,
    UI_SNIPPET_DELETE,
    UI_SNIPPET_COPY,
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

test("copySnippet disarms the pending clipboard restore BEFORE it writes the clipboard", () => {
  const method = /private copySnippet\([\s\S]*?\n {2}\}/.exec(SRC);
  assert.ok(method, "copySnippet must still exist as a method on the bridge");
  const body = method[0];

  const disarm = body.indexOf("cancelPendingRestore(");
  const write = Math.min(
    ...[body.indexOf("clipboard.write("), body.indexOf("clipboard.writeText(")].filter((i) => i >= 0),
  );
  assert.ok(disarm >= 0, "copySnippet must cancel the restore that may be in flight");
  assert.ok(write >= 0, "copySnippet must still put the snippet on the clipboard");
  assert.ok(
    disarm < write,
    "cancelling AFTER the write leaves a window where the armed timer can still clobber the copy",
  );
});

test("cancelPendingRestore drops the pending value instead of writing it back", () => {
  assert.match(INSERT_SRC, /export function cancelPendingRestore\(\)/);
  const fn = /export function cancelPendingRestore\(\)[\s\S]*?\n\}/.exec(INSERT_SRC);
  assert.ok(fn);
  assert.ok(
    !fn[0].includes("restoreClipboard("),
    "restoring here would write the pre-dictation clipboard over the copy the user just asked for - the exact clobber this cancels",
  );
  assert.ok(fn[0].includes("clearTimeout("), "the armed timer has to actually be cleared");
});

test("flushPendingRestore still RESTORES (quit) - the two paths must not be confused", () => {
  const fn = /export function flushPendingRestore\(\)[\s\S]*?\n\}/.exec(INSERT_SRC);
  assert.ok(fn);
  assert.ok(fn[0].includes("restoreClipboard("), "quitting owes the user their clipboard back");
});
