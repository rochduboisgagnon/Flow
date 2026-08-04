import { app, BrowserWindow, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { THEME_BG, THEME_TITLEBAR, type ResolvedTheme } from "../shared/theme";
import { TITLEBAR_H } from "../shared/constants";
import { decideExternalOpen } from "../shared/externalNav";
import { restoreBounds, sanitizeBounds, MIN_HEIGHT, MIN_WIDTH } from "../shared/windowBounds";
import { dataDir } from "./settings";

// The main window (plan V1, A1): Flow's own face, now that the Manager no
// longer hosts the settings. Three rules, all engine-protecting:
//  - LAZY: the window is created on first show(), never at boot. The engine
//    (hook, ASR, API) must come up at full speed whether or not anyone looks.
//  - CLOSE = HIDE: closing the window never kills the engine. Real quit goes
//    through the tray or app.quit(), which flips `quitting` in before-quit.
//  - The window is an ORDINARY consumer of engine state over IPC. It owns
//    nothing; killing it loses nothing.
export class MainWindow {
  private win: BrowserWindow | null = null;
  private quitting = false;
  // U0: the last resolved theme, kept even while the window is hidden/absent
  // so a create-after-a-theme-flip show() paints the right color from frame 1
  // instead of the "dark" the class was built with.
  private resolved: ResolvedTheme = "dark";
  // Review U1j: fired on every native "show"/"restore". Both push channels
  // (the 1 Hz timer and pushNow) are visibility-gated, so WITHOUT this a
  // theme flip or status change that happened while the window was hidden
  // reaches the renderer only on the next timer tick - up to a full second of
  // a dark page under already-light native caption buttons on reopen.
  private onShowCb: (() => void) | null = null;
  // U3f: diagnostics for a refused navigation/popup. Optional and defaulted to
  // a no-op so tests/callers that do not care about logging need not supply
  // one - the same shape as UiBridgeDeps.log?.
  private log: (msg: string) => void;

  private boundsTimer: NodeJS.Timeout | undefined;

  /** Where the remembered bounds live. Its own small file rather than a field in
   * settings.json: this is written on every drag, and settings.json is a file
   * the user may be editing by hand. */
  private boundsFile(): string {
    return path.join(dataDir(), "window.json");
  }

  private readBounds(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.boundsFile(), "utf8"));
    } catch {
      // Missing or unreadable is not an error worth a log line: it means "first
      // run", which is the overwhelmingly common case for this file.
      return null;
    }
  }

  /** Never records a MAXIMIZED or minimized window: restoring one of those as a
   * normal window would open something the size of a screen the user may no
   * longer have, and Electron's own maximize flag is the right way to express
   * "big". getNormalBounds gives the size it would return to. */
  private writeBounds(): void {
    const w = this.win;
    if (!w || w.isDestroyed() || w.isMinimized() || w.isMaximized() || w.isFullScreen()) return;
    const b = sanitizeBounds(w.getNormalBounds());
    if (!b) return;
    try {
      fs.mkdirSync(path.dirname(this.boundsFile()), { recursive: true });
      fs.writeFileSync(this.boundsFile(), JSON.stringify(b), "utf8");
    } catch {
      // A window position is the least important thing on this disk. Failing to
      // save it must never surface anywhere, let alone stop the app.
    }
  }

  constructor(log: (msg: string) => void = () => {}) {
    this.log = log;
  }

  setOnShow(cb: () => void): void {
    this.onShowCb = cb;
  }

  /** Create (if needed) and show the window. Safe to call repeatedly. */
  show(dev: boolean): void {
    // L'icone du Dock revient AVEC la fenetre, et avant elle : une fenetre qui
    // apparait pendant que le Dock est encore vide donne une application qu'on ne
    // peut pas retrouver en cliquant a l'endroit ou tout le monde clique. Voir le
    // gestionnaire de fermeture pour le geste inverse.
    void app.dock?.show();
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return;
    }
    // 2026-07-30: the size and position the user last chose, when they still
    // land on a screen that exists. See shared/windowBounds.ts for why that
    // condition is the whole feature and not a detail.
    const stored = this.readBounds();
    const bounds = restoreBounds(
      stored,
      screen.getAllDisplays().map((d) => d.workArea),
    );
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false, // shown on ready-to-show: no white flash
      autoHideMenuBar: true,
      // What Chromium paints during resize/maximize, before the page itself
      // has painted a pixel - must track the CURRENTLY resolved theme (U0).
      backgroundColor: THEME_BG[this.resolved],
      // U1: the OS keeps drawing the caption buttons, we just take the bar.
      // titleBarStyle "hidden" + titleBarOverlay means Windows still owns
      // min/max/close - so Snap Layouts on maximize-hover, correct hit targets
      // and hovers at every DPI, and the close button's red all come for free,
      // where frame:false would have thrown them away and forced us to redraw
      // (badly) what the OS already does. "hidden" WITHOUT the overlay is the
      // one state that must never exist: a window nobody can close.
      // height MUST equal the CSS --titlebar-h, otherwise the native buttons
      // float above or below the custom row - hence the shared TITLEBAR_H.
      ...(process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: { ...THEME_TITLEBAR[this.resolved], height: TITLEBAR_H },
          }
        : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed preloads cannot require() relative files (Electron 20+),
        // same constraint as the overlay/capture windows.
        sandbox: false,
        // U1b: synchronous pre-paint theme channel. The renderer's first paint
        // happens before getState() resolves, so without this a light-theme
        // user would eat one dark frame on every open. Read at process start,
        // so the value set at this ONE-TIME window creation is correct.
        additionalArguments: ["--flow-theme=" + this.resolved],
      },
    });
    this.win.once("ready-to-show", () => this.win?.show());
    // Native events, not our show() method: they also cover a taskbar-click
    // restore of a minimized window, which never goes through show().
    this.win.on("show", () => this.onShowCb?.());
    this.win.on("restore", () => this.onShowCb?.());
    // U3f: this window renders user content it did not author - a snippet
    // preview's <a href>, in particular (htmlSanitize.ts allows http/https/
    // mailto hrefs, with no notion of "and never navigate the app there").
    // Both routes a link click can take are covered: will-navigate for an
    // ordinary same-window link, setWindowOpenHandler for target="_blank" /
    // window.open(). Neither ever lets the MAIN window's own location change;
    // an allowed URL is instead handed to the system browser, exactly like a
    // normal web page opening an external link safely.
    this.win.webContents.on("will-navigate", (e, url) => {
      e.preventDefault(); // main.html never navigates itself (SPA state, not location changes) - only page content does this
      this.openExternalIfAllowed(url);
    });
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalIfAllowed(url);
      return { action: "deny" }; // Flow never opens a second Electron window this way
    });
    // Remember where the user put it. On MOVE and RESIZE rather than on close,
    // and debounced: a window is dragged in dozens of events, and "close" is
    // not reached at all when the machine shuts down under the app.
    const remember = () => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer);
      this.boundsTimer = setTimeout(() => this.writeBounds(), 400);
      this.boundsTimer.unref?.();
    };
    this.win.on("resize", remember);
    this.win.on("move", remember);
    this.win.on("close", (e) => {
      // Closing hides; the engine keeps running (tray keeps the app reachable).
      this.writeBounds();
      if (!this.quitting) {
        e.preventDefault();
        this.win?.hide();
        // 2026-08-04, demande de Roch : « si je clique sur le X, je veux que
        // l'application disparaisse de mon Dock mais reste ouverte en arriere-plan
        // pour qu'elle fonctionne pareil. »
        //
        // C'est la convention macOS d'une application d'arriere-plan, et Flow en
        // est une : le crochet clavier, le moteur de parole et l'enregistrement
        // continuent, fenetre fermee ou pas. Une icone de Dock pour une fenetre qui
        // n'existe plus est du bruit dans une rangee ou l'on cherche ce qu'on est
        // en train d'utiliser.
        //
        // CE QUI REND CE GESTE SUR PLUTOT QU'UN PIEGE : l'icone de la barre de
        // menus reste. Elle est creee sans condition de plateforme, donc il y a
        // toujours un chemin de retour - `show()` juste au-dessus remet l'icone du
        // Dock au meme moment que la fenetre. Cacher le Dock SANS ce chemin
        // enfermerait quelqu'un dehors, ce qui est le seul etat que ce fichier
        // refuse depuis toujours (« une fenetre que personne ne peut fermer »,
        // devenue ici son inverse).
        //
        // `app.dock` n'existe pas ailleurs que sur macOS : le `?.` est ce qui rend
        // cette ligne inoffensive sur Windows plutot qu'un test de plateforme de
        // plus a maintenir.
        void app.dock?.hide();
      }
    });
    if (dev) void this.win.loadURL("http://localhost:5183/main.html");
    else void this.win.loadFile(path.join(__dirname, "..", "renderer", "main.html"));
  }

  /** before-quit flips this so the close handler lets the window die. */
  setQuitting(v: boolean): void {
    this.quitting = v;
  }

  /** U3f: the ONLY path from page content to the OS. decideExternalOpen is
   * pure (src/shared/externalNav.ts); this method just acts on its verdict
   * and journals a refusal, which is what "et journalise le refus" needs for
   * the loopback case specifically - logging every refusal uniformly is
   * simpler than special-casing which reason gets written down. */
  private openExternalIfAllowed(url: string): void {
    const decision = decideExternalOpen(url);
    if (decision.allow) void shell.openExternal(decision.url);
    else this.log(`[nav] refused to open external URL: ${decision.reason}`);
  }

  /** U0: applies (and remembers) the resolved theme's background paint. Called
   * on EVERY theme flip, window visible or hidden - not just at show() time -
   * so a maximize right after a hidden-window theme change never flashes the
   * previous theme's color before the page repaints. */
  applyTheme(resolved: ResolvedTheme): void {
    this.resolved = resolved;
    if (this.win && !this.win.isDestroyed()) {
      this.win.setBackgroundColor(THEME_BG[resolved]);
      // U1: recolor the NATIVE caption buttons on the same flip, or they keep
      // the other theme's ink over the new background. try/catch because the
      // API throws when the window has no overlay to update - a window built
      // on a platform where we did not pass titleBarOverlay at all.
      if (process.platform === "win32") {
        try {
          this.win.setTitleBarOverlay({ ...THEME_TITLEBAR[resolved], height: TITLEBAR_H });
        } catch {
          // No overlay on this window: the background repaint above is enough.
        }
      }
    }
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** The live webContents when the window exists (for state pushes). */
  contents(): Electron.WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  /** U3g: the live webContents id, or null while the (lazy) window does not
   * exist. The CSP hook in index.ts is installed at boot, long before the first
   * show(), and the window can be destroyed and rebuilt with a different id -
   * so the answer has to be asked for per request, never captured once. */
  webContentsId(): number | null {
    return this.contents()?.id ?? null;
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }
}
