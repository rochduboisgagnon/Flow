import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shouldApplyCsp, isMainWindowDocument, MAIN_WINDOW_CSP, API_PORT_ORIGINS } from "../src/shared/csp";

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

// U5 review, MINEUR 8: the archive's audio player has exactly ONE thing
// standing between it and silence - `media-src http://127.0.0.1:*`. Without it
// `default-src 'self'` applies to <audio>, Chromium refuses the stream, and the
// only symptom is a player that does nothing (which is why the page now has an
// onError). Nothing tested that directive, so tightening the policy one day
// would have broken playback in packaged builds only, where the policy is the
// one that ships.
const NOTES_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "renderer", "ui", "pages", "Notes.tsx"),
  "utf8",
);

test("the audio player's one dependency: media-src still allows Flow's own local API", () => {
  const media = MAIN_WINDOW_CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith("media-src"));
  assert.ok(media, "the policy must carry a media-src directive of its own: default-src 'self' would refuse the player");
  // 2026-07-31: this used to require the wildcard `http://127.0.0.1:*`, on the
  // reasoning that "the port is chosen at boot". True, but too broad by 65 532
  // ports: it is chosen from THREE. The narrowed policy names them, and this
  // assertion now checks the property that actually matters - the audio player
  // can reach whichever one the API bound.
  assert.ok(
    API_PORT_ORIGINS.every((o) => media.includes(o)),
    `media-src must allow every port the API can bind, or the player breaks on one machine in three; got "${media}"`,
  );
  // Loopback and nothing else: this is the app's own engine, never a third party.
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(media), `media-src must name no other origin; got "${media}"`);
});

test("and the player really is pointed at that origin (the policy and the page cannot drift apart)", () => {
  assert.match(
    NOTES_SRC,
    /<audio[\s\S]{0,400}?src=\{`http:\/\/127\.0\.0\.1:\$\{s\.apiPort\}/,
    "the Notes player streams from 127.0.0.1 - if that ever changes, the CSP above has to change with it",
  );
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

// 2026-07-31, security pass: the policy allowed `http://127.0.0.1:*` - every
// local port, for an app that binds one of three. A test rather than a comment,
// because two lists that must agree will drift, and this is the one that fails
// loudly when they do.
test("the CSP names the API's ports exactly, and no wildcard", () => {
  const api = fs.readFileSync(path.join(__dirname, "..", "src", "main", "api.ts"), "utf8");
  const m = /const PORTS = \[([^\]]+)\]/.exec(api);
  assert.ok(m, "api.ts must still declare its candidate ports as a literal list");
  const ports = m[1].split(",").map((p) => p.trim()).filter(Boolean);
  for (const port of ports) {
    assert.ok(
      MAIN_WINDOW_CSP.includes(`http://127.0.0.1:${port}`),
      `port ${port} binds the API but the CSP does not allow it - the window could not reach its own audio`,
    );
  }
  assert.equal(API_PORT_ORIGINS.length, ports.length, "one origin per port, no stragglers");
  assert.doesNotMatch(MAIN_WINDOW_CSP, /127\.0\.0\.1:\*/, "the wildcard must not come back");
});

// ---------------------------------------------------------------------------
// F : POPPINS, ET LE REFUS QUI NE SE VOIT PAS.
//
// La CSP de la fenetre principale n'a AUCUNE directive `font-src`, donc elle
// retombe sur `default-src 'self'`. Consequence exacte : un fichier servi avec
// le document passe, une `data:` URI est REFUSEE - et le refus est silencieux.
// La page s'affiche dans la police de repli, sans erreur visible, et personne ne
// sait que la charte n'est pas appliquee.
//
// C'est donc la classe de defaut que seule une porte peut attraper : elle ne
// casse rien, elle ne dit rien, et elle se relit comme un succes. Ces trois
// tests la ferment par la forme du CSS plutot que par la vigilance.
//
// Verifie en LANCANT, aussi : l'application demarree sur ses fichiers construits
// n'emet aucun « Refused to load the font » dans la console du rendu.
// ---------------------------------------------------------------------------

const MAIN_CSS = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "main.css"), "utf8");

test("F: la police est servie par un chemin RELATIF, jamais une data: URI", () => {
  const faces = [...MAIN_CSS.matchAll(/@font-face\s*\{[\s\S]*?\}/g)].map((m) => m[0]);
  assert.equal(faces.length, 2, "deux graisses : 400 pour le corps, 600 pour les titres");
  for (const face of faces) {
    assert.match(face, /src:\s*url\("\.\/fonts\//, "un chemin relatif, servi avec le document");
    assert.ok(!/data:/.test(face), "une data: URI serait refusee par default-src 'self', EN SILENCE");
    assert.ok(!/https?:/.test(face), "et une police distante ferait sortir une application 100 % locale");
  }
});

test("F: les deux fichiers de police existent vraiment", () => {
  // Un @font-face qui pointe un fichier absent echoue exactement comme un refus
  // de CSP : silencieusement, sur la police de repli.
  for (const f of ["Poppins-Regular.ttf", "Poppins-SemiBold.ttf"]) {
    const p = path.join(__dirname, "..", "src", "renderer", "fonts", f);
    assert.ok(fs.existsSync(p), `${f} doit etre dans le depot`);
    assert.ok(fs.statSync(p).size > 50_000, `${f} doit etre une vraie police, pas un fichier vide`);
  }
});

test("F: la CSP autorise la police, et le raisonnement reste vrai", () => {
  // Pas de `font-src`, donc `default-src 'self'` decide. Si quelqu'un ajoutait un
  // jour un `font-src` plus etroit, ce test le lui ferait remarquer avant que la
  // charte disparaisse sans un mot.
  assert.ok(!/font-src/.test(MAIN_WINDOW_CSP), "aucune directive font-src : c'est default-src qui decide");
  assert.match(MAIN_WINDOW_CSP, /default-src 'self'/, "et elle autorise un fichier de meme origine");
});

test("F: le jeton de police nomme Poppins, avec un repli lisible derriere", () => {
  const token = /--font:\s*([^;]+);/.exec(MAIN_CSS);
  assert.ok(token, "le jeton --font doit exister");
  assert.match(token[1], /^"Poppins"/, "Poppins en premier");
  assert.match(token[1], /sans-serif/, "et un repli, pour qu'un paquet mal construit reste lisible");
});
