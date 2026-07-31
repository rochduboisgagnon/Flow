// U3g: WHICH responses get a Content-Security-Policy header, extracted as PURE
// logic so the decision is unit-testable without an Electron process - the same
// reasoning (and the same shape) as externalNav.ts next to it. index.ts is the
// one caller: it installs the onHeadersReceived hook and acts on this verdict.
//
// ---------------------------------------------------------------------------
// WHY THE POLICY IS NOT GLOBAL (the bug this module exists to make impossible)
// ---------------------------------------------------------------------------
// U3f put the CSP on session.defaultSession, which every window of the app
// shares. That silently covered the OVERLAY and the hidden CAPTURE window too -
// and both of them load their AudioWorklet from a `blob:` URL
// (URL.createObjectURL(new Blob([WORKLET])) then ctx.audioWorklet.addModule).
// A worklet module fetched from `blob:` is NOT covered by `script-src 'self'`;
// Chromium refuses it outright. In a packaged build that means the microphone
// graph never starts: dictation captures nothing, which is invariant number one
// of this app. The dev build never showed it, because the policy is
// packaged-only.
//
// So the policy is scoped to the MAIN WINDOW, which is also the correct
// architectural cut, not merely the cheapest fix:
//   - the main window is the ONLY window that renders content the user wrote
//     (snippet HTML), i.e. the only one with an attacker-influenced DOM;
//   - the overlay and the capture window render nothing but code shipped inside
//     the app, and they are the two windows that need `blob:` to work at all.
// Widening the policy with `blob:` instead would have handed exactly the
// window that renders user content the right to run a blob-URL script - the
// opposite trade.

/**
 * The policy the main window's responses carry. Packaged builds only (see
 * index.ts): a <meta> tag would ship in the same main.html `npm run dev`
 * serves from Vite, whose HMR client needs inline scripts, eval and a
 * ws://localhost:5183 socket.
 *
 * `data:` is for the titlebar icon; `http://127.0.0.1:*` is Flow's own local
 * API and the U5 audio player, never a third-party origin. Deliberately NO
 * `blob:` in script-src: the two windows that need it are not covered by this
 * policy at all, and the one window that IS covered has no business running a
 * script it assembled in memory.
 */
/** The three ports the local API may bind, in order (main/api.ts PORTS).
 *
 * 2026-07-31, security pass: the policy used to say `http://127.0.0.1:*`, which
 * is 65 535 ports for an app that uses one of three. That wildcard let the
 * renderer reach ANY local service - Ollama, a database, another app's debug
 * port - which is not something this window has any business doing, and is
 * exactly the reach an injected script would want.
 *
 * Kept in sync with api.ts by a test rather than by intention: two lists that
 * must agree, and only one of them fails loudly when they drift, is how a
 * narrowing quietly becomes a blockage the day a port is added. */
export const API_PORT_ORIGINS = ["http://127.0.0.1:8176", "http://127.0.0.1:8296", "http://127.0.0.1:8396"];

export const MAIN_WINDOW_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  `img-src 'self' data:; media-src 'self' ${API_PORT_ORIGINS.join(" ")}; ` +
  `connect-src 'self' ${API_PORT_ORIGINS.join(" ")}`;

/** The renderer document the main window loads. Its two siblings are
 * overlay.html and capture.html - a different file name is the whole reason
 * the URL fallback below can tell them apart with certainty. */
export const MAIN_WINDOW_DOCUMENT = "main.html";

/** The part of an onHeadersReceived `details` this decision needs. */
export interface CspRequest {
  /** details.url */
  url: string;
  /** details.webContentsId, or null when Electron did not attribute it. */
  webContentsId: number | null;
}

/**
 * True when `url` names the main window's own document, whatever it was loaded
 * from (file:// in a packaged build, http://localhost:5183 under Vite).
 * Compares the LAST path segment only: the install directory is not knowable
 * here and is not what identifies the page.
 */
export function isMainWindowDocument(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false; // not a URL at all: certainly not our document
  }
  const slash = pathname.lastIndexOf("/");
  const file = slash < 0 ? pathname : pathname.slice(slash + 1);
  return file.toLowerCase() === MAIN_WINDOW_DOCUMENT;
}

/**
 * Decide whether this response gets the CSP header.
 *
 * `mainWindowWebContentsId` is read LIVE at request time, never captured once:
 * the main window is lazy (created on the first show(), long after this hook is
 * installed) and can be destroyed and rebuilt with a different id.
 *
 * Two signals, in strict priority:
 *  1. ATTRIBUTION. When Electron says which webContents asked, that is the
 *     answer - it is ours or it is not. This is what keeps the overlay and the
 *     capture window out of the policy, which is the dictation invariant.
 *  2. URL, only when attribution is ABSENT. `details.webContentsId` is optional
 *     in Electron's own typings, and a navigation request is exactly the kind
 *     that can arrive unattributed. Falling back to "is this the main window's
 *     document?" means a missing id costs us nothing: the document response is
 *     the only one that has to carry the policy anyway (a document's CSP
 *     already governs every subresource it goes on to load), and overlay.html /
 *     capture.html can never match it.
 *
 * The failure directions are deliberate and opposite for the two risks: an
 * unrecognized request gets NO header (dictation keeps working, the worst case
 * is an unhardened response that governs nothing), while the main window's
 * document is recognized by either signal (the policy cannot go missing).
 */
export function shouldApplyCsp(req: CspRequest, mainWindowWebContentsId: number | null): boolean {
  if (req.webContentsId !== null) {
    return mainWindowWebContentsId !== null && req.webContentsId === mainWindowWebContentsId;
  }
  return isMainWindowDocument(req.url);
}
