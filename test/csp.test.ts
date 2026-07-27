import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shouldApplyCsp, isMainWindowDocument, MAIN_WINDOW_CSP } from "../src/shared/csp";

// U3g. The bug this file exists to keep dead: the CSP was installed on
// session.defaultSession, so it covered the overlay and the hidden capture
// window too - and both load their AudioWorklet from a blob: URL, which
// `script-src 'self'` refuses. A packaged build would have captured no audio at
// all. The header must reach the main window and NOTHING else.

// Plausible ids: Electron numbers webContents in creation order, and the
// overlay + capture windows are created at boot, long before the lazy main
// window. So the main window's id is normally the HIGHEST of the three.
const OVERLAY = 1;
const CAPTURE = 2;
const MAIN = 3;

const FILE_MAIN = "file:///C:/Program%20Files/Flow/resources/app/dist/renderer/main.html";
const FILE_OVERLAY = "file:///C:/Program%20Files/Flow/resources/app/dist/renderer/overlay.html";
const FILE_CAPTURE = "file:///C:/Program%20Files/Flow/resources/app/dist/renderer/capture.html";

test("the main window's own responses carry the policy", () => {
  assert.equal(shouldApplyCsp({ url: FILE_MAIN, webContentsId: MAIN }, MAIN), true);
  // Its subresources too, when they are attributed to it: harmless (a document's
  // CSP already governs them) and it means no request of ours is left guessing.
  assert.equal(
    shouldApplyCsp({ url: "file:///C:/app/dist/renderer/assets/main-abc123.js", webContentsId: MAIN }, MAIN),
    true,
  );
});

test("THE dictation invariant: the overlay never gets the policy (its AudioWorklet is a blob: URL)", () => {
  assert.equal(shouldApplyCsp({ url: FILE_OVERLAY, webContentsId: OVERLAY }, MAIN), false);
  // The worklet module fetch itself, whatever it is attributed to.
  assert.equal(shouldApplyCsp({ url: "blob:file:///9f2b-4c11", webContentsId: OVERLAY }, MAIN), false);
});

test("the hidden capture window never gets the policy either (same blob: worklet)", () => {
  assert.equal(shouldApplyCsp({ url: FILE_CAPTURE, webContentsId: CAPTURE }, MAIN), false);
  assert.equal(shouldApplyCsp({ url: "blob:file:///0a71-88ce", webContentsId: CAPTURE }, MAIN), false);
});

test("before the lazy main window exists, nothing is covered - the boot is overlay + capture only", () => {
  assert.equal(shouldApplyCsp({ url: FILE_OVERLAY, webContentsId: OVERLAY }, null), false);
  assert.equal(shouldApplyCsp({ url: FILE_CAPTURE, webContentsId: CAPTURE }, null), false);
});

test("a rebuilt main window is followed by id, not remembered", () => {
  // Close-then-reopen destroys the BrowserWindow and creates a new one, so the
  // id changes. The OLD id must stop being covered on the spot.
  assert.equal(shouldApplyCsp({ url: FILE_MAIN, webContentsId: MAIN }, 7), false);
  assert.equal(shouldApplyCsp({ url: FILE_MAIN, webContentsId: 7 }, 7), true);
});

test("unattributed: the main window's DOCUMENT is still recognized, by name", () => {
  // details.webContentsId is optional in Electron's own typings. A missing id
  // must never cost the main window its policy, because the document response is
  // the one that has to carry it.
  assert.equal(shouldApplyCsp({ url: FILE_MAIN, webContentsId: null }, MAIN), true);
  assert.equal(shouldApplyCsp({ url: FILE_MAIN, webContentsId: null }, null), true);
});

test("unattributed: overlay.html and capture.html are still refused", () => {
  assert.equal(shouldApplyCsp({ url: FILE_OVERLAY, webContentsId: null }, MAIN), false);
  assert.equal(shouldApplyCsp({ url: FILE_CAPTURE, webContentsId: null }, MAIN), false);
  assert.equal(shouldApplyCsp({ url: "blob:file:///9f2b-4c11", webContentsId: null }, MAIN), false);
});

test("isMainWindowDocument: recognizes the page wherever it is served from", () => {
  assert.equal(isMainWindowDocument(FILE_MAIN), true);
  assert.equal(isMainWindowDocument("http://localhost:5183/main.html"), true); // Vite, dev
  assert.equal(isMainWindowDocument("file:///c:/x/renderer/MAIN.HTML"), true); // Windows paths are not case-sensitive
  assert.equal(isMainWindowDocument(FILE_OVERLAY), false);
  assert.equal(isMainWindowDocument(FILE_CAPTURE), false);
  // A path that merely CONTAINS the name must not match: only the last segment.
  assert.equal(isMainWindowDocument("file:///c:/main.html/overlay.html"), false);
  assert.equal(isMainWindowDocument("file:///c:/x/not-main.html"), false);
  assert.equal(isMainWindowDocument("not a url"), false);
});

test("the policy itself does NOT allow blob: scripts - the fix is scope, not a wider policy", () => {
  // Widening script-src with blob: would have been the other way to keep
  // dictation alive, and it would have handed the one window that renders
  // user-written HTML the right to run a script assembled in memory.
  assert.ok(MAIN_WINDOW_CSP.includes("script-src 'self'"));
  assert.ok(!MAIN_WINDOW_CSP.includes("blob:"), "no blob: anywhere in the main window's policy");
  assert.ok(!MAIN_WINDOW_CSP.includes("unsafe-eval"));
  assert.ok(MAIN_WINDOW_CSP.includes("default-src 'self'"));
});

// Structural, in the spirit of test/ui-bridge.test.ts: the pure decision above
// is worth nothing if index.ts stops asking it. Both facts are checked - that
// the hook consults shouldApplyCsp, and that no policy string was re-inlined
// next to it.
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8");

test("index.ts decides through shared/csp.ts, and holds no policy string of its own", () => {
  assert.match(INDEX_SRC, /onHeadersReceived/, "the CSP hook is still installed");
  assert.match(INDEX_SRC, /shouldApplyCsp\(/, "the hook must route through the tested decision");
  assert.match(INDEX_SRC, /MAIN_WINDOW_CSP/, "the policy comes from shared/csp.ts");
  assert.ok(
    !/["']default-src/.test(INDEX_SRC),
    "a policy string written inline in index.ts is a second source of truth the tests above cannot see",
  );
});
