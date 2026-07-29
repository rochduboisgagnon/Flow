import { ipcMain, shell, app, clipboard } from "electron";
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
  UI_STATE_PUSH,
  UI_HOTPATH_SNAPSHOT,
  UI_SELF_CHECK,
  UI_STATS_READ,
  UI_STATS_CLEAR,
  UI_SNIPPET_LIST,
  UI_SNIPPET_SAVE,
  UI_SNIPPET_DELETE,
  UI_SNIPPET_COPY,
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
  UI_REDACT_PASSAGES,
  type UiStatePayload,
  type UpdateCheckResult,
  type SnippetsResult,
  type DictResult,
  type LongStateSnapshot,
  type LongStartResult,
  type LongStopResult,
  type LongTranscriptResult,
  type HistoryItem,
  type HistoryDocPayload,
  type DownloadResult,
  type RedactTarget,
  type RedactResult,
  type HotpathSnapshot,
  type SelfCheckReport,
  type StatsPayload,
} from "../shared/ipcContracts";
import type { MainWindow } from "./mainWindow";
import { listSnippets, saveSnippet, deleteSnippet, getSnippet } from "./snippets";
import { listDictionary, saveDictEntry, deleteDictEntry } from "./dictionary";
import { cancelPendingRestore } from "./insert";
import { decideLongStart } from "../shared/longStart";

// The main window's bridge into the engine (plan V1, A2). One rule above all:
// these handlers call the SAME functions the local HTTP API is built on
// (applySettings and friends, passed in by index.ts). The bridge owns no
// state and never writes settings.json itself - one source of truth.
//
// Security: the preload is shared by the overlay and capture windows, so
// window.flowui exists there too. Every handler therefore refuses senders
// other than the main window (same discipline as NativeCapture's IPC).

export interface UiBridgeDeps {
  getUiState(): UiStatePayload;
  setSettings(patch: Record<string, unknown>): void;
  recordShortcut(): Promise<{ combo: string[] | null; comboLabel?: string }>;
  listMics(): Promise<Array<{ id: string; label: string }>>;
  ollamaModels(): Promise<string[] | null>;
  historyRootDir(): string;
  /** U2b: the pre-1.0.0 recordings folder, or null when there is none. Null is
   * the normal case and makes "legacy-history" a refused destination. U2c: main
   * also returns null when the folder no longer exists on disk. */
  legacyHistoryDirPath(): string | null;
  logPath(): string;
  dataDirPath(): string;
  /** U2c: shell.openPath RETURNS an error string instead of throwing, so a
   * failed open is invisible without this. Optional: pure tests need no log. */
  log?(msg: string): void;
  /** The Updates tab's "Check now" button (A4: FlowUpdater.checkNow). */
  checkUpdates(): Promise<UpdateCheckResult>;

  // ---- long-form recorder (U4a) ----
  // The SAME functions the HTTP /long/* routes call (main/api.ts): index.ts
  // injects the IDENTICAL closures into both LocalApi and this bridge (see
  // index.ts's longStateDep & friends), never a second implementation of the
  // recorder's control surface - the founding rule this whole class exists to
  // uphold (see the module note above guarded()).
  longState(): LongStateSnapshot;
  longStartNative(opts: { title?: string; keepAudio?: boolean; captureSystem?: boolean }): LongStartResult;
  longStop(): LongStopResult;
  longMark(): { ok: boolean };
  longTranscript(since: number): LongTranscriptResult;
  /** NativeCapture.available() (Windows-only "this is a PC" gate). Validated
   * by shared/longStart.ts BEFORE this bridge ever calls longStartNative, so
   * a machine that cannot loopback gets one clean, readable refusal instead
   * of a call that would refuse deeper down anyway. */
  canLoopback(): boolean;

  // ---- archive browser (U5a) ----
  // The SAME functions the HTTP /long/history* routes call (main/api.ts),
  // identical closures to LocalApi's (index.ts's listHistoryDep &
  // readHistoryDocDep) - never a second implementation.
  listHistory(): HistoryItem[];
  readHistoryDoc(id: string): HistoryDocPayload | null;

  // ---- capture downloads (U5c, Roch's decision) ----
  // Browser-style, straight into the OS Downloads folder - main-only, no HTTP
  // equivalent (see main/downloads.ts's module note).
  downloadDoc(id: string): Promise<DownloadResult>;
  downloadAudio(id: string): Promise<DownloadResult>;

  // ---- removing a passage (D11) ----
  // Main-only too, and for a stronger reason than downloads: this one
  // DESTROYS, irreversibly. The renderer passes an id and passage targets; main
  // resolves the id with the archive's own containment guarantees and refuses a
  // target whose index has drifted (see main/redact.ts).
  redactPassages(id: string, targets: RedactTarget[]): Promise<RedactResult>;
  /** The last file THIS session actually wrote (main/downloads.ts), for
   * UI_OPEN_PATH's "downloaded-file" destination. Never sourced from the
   * renderer - null means nothing has been downloaded yet, a clean refusal. */
  lastDownloadedPath(): string | null;

  // ---- activation hot-path diagnostics (V2, B1) ----
  // The SAME closure the HTTP /diagnostics/hotpath route calls (main/api.ts) -
  // see index.ts's hotpathSnapshotDep, never a second implementation.
  hotpathSnapshot(): HotpathSnapshot;

  // ---- self-diagnostic (V2, B5) ----
  // The SAME closure the HTTP /diagnostics/selfcheck route calls - see
  // index.ts's selfCheckDep. Async because enumerating audio devices needs a
  // round trip to a renderer.
  selfCheck(): Promise<SelfCheckReport>;

  // ---- statistics (U7) ----
  // Main-process only, with NO HTTP equivalent on purpose: these counters
  // describe the owner of this machine, and the local API answers a remote PWA
  // over the network. The store (main/stats.ts) owns the file; this bridge only
  // gates the sender.
  statsRead(): StatsPayload;
  /** U7d: erases ~/.flow/stats.json on the spot and answers with the (now
   * empty) payload, so the page repaints from the same call. */
  statsClear(): StatsPayload;
}

const REPO_URL = "https://github.com/rochduboisgagnon/Flow";

// Review A10: getLoginItemSettings() compares the registry entry ARGS-AND-ALL.
// Reading it without the args we register with reports openAtLogin=false
// forever - the toggle then shows OFF while the entry exists, and turning it
// "off" from that state is a no-op. One constant, used by set AND get, so the
// two can never diverge again.
export const LOGIN_ARGS = ["--hidden"];

// U3c: the fallback SnippetsResult for a request that never reaches the
// store at all - refused by guarded() (wrong sender) or aimed at an id that
// resolves to nothing. Shaped like every other SnippetsResult (ok/items/
// error) so the page never has to special-case "no library" vs "empty
// library".
const SNIPPETS_UNAVAILABLE: SnippetsResult = { ok: false, items: [], error: "unavailable" };

// U6: the same fallback discipline for the dictionary. Shaped like every real
// DictResult so the page never has to special-case "refused" against "the
// dictionary is genuinely empty" - two states that look identical in a naive
// `items.length === 0` check and mean opposite things.
const DICT_UNAVAILABLE: DictResult = { ok: false, items: [], error: "unavailable" };

// U4a: same fallback discipline as SNIPPETS_UNAVAILABLE - what a refused
// sender (guarded()'s fromMain() gate) gets back, shaped like every real
// answer so a caller never has to special-case "refused" vs "genuinely empty".
const LONG_START_UNAVAILABLE: LongStartResult = { ok: false, error: "unavailable" };
const LONG_STOP_UNAVAILABLE: LongStopResult = { ok: false, docPath: "" };

// U5c: same fallback discipline - what a refused sender gets back for a
// download, shaped like every real DownloadResult so the page never has to
// special-case "refused" vs "genuinely failed".
const DOWNLOAD_UNAVAILABLE: DownloadResult = { ok: false, error: "unavailable" };

// D11: same fallback discipline, and the gate behind it is not ceremony here -
// it is the strictest one in the file. The same preload is loaded by the
// overlay and the hidden capture window, and this channel permanently destroys
// part of a recording. `ok: false` with nothing else set is the only honest
// shape for a request that never reached the redactor: a refused sender must
// never be able to make a page report that audio was silenced.
const REDACT_UNAVAILABLE: RedactResult = { ok: false, error: "unavailable" };

// U7: same fallback discipline again. Every counter reads zero and both
// switches read off, which is the honest thing for an answer that never
// reached the store: a refused sender must not be able to make a page claim
// that attribution is on.
const STATS_UNAVAILABLE: StatsPayload = {
  ok: false,
  counting: false,
  perApp: false,
  days: [],
  monthWords: 0,
  totalWords: 0,
  avgWpm: 0,
  streakDays: 0,
  apps: [],
  today: "",
  error: "unavailable",
};

export class UiBridge {
  private deps: UiBridgeDeps;
  private mainWindow: MainWindow;
  private pushTimer: NodeJS.Timeout | undefined;

  constructor(deps: UiBridgeDeps, mainWindow: MainWindow) {
    this.deps = deps;
    this.mainWindow = mainWindow;
    this.register();
    // Push a coherent snapshot once a second WHILE the window is visible.
    // Hidden window = zero work: the engine must never pay for an unwatched UI.
    this.pushTimer = setInterval(() => {
      if (!this.mainWindow.isVisible()) return;
      this.mainWindow.contents()?.send(UI_STATE_PUSH, this.deps.getUiState());
    }, 1000);
  }

  /** True when the invoke came from the main window (not overlay/capture). */
  private fromMain(e: Electron.IpcMainInvokeEvent): boolean {
    const c = this.mainWindow.contents();
    return c !== null && e.sender === c;
  }

  /**
   * The ONLY place ipcMain.handle is ever called (test/ui-bridge.test.ts
   * enforces this by reading the source). Registers `channel` so the
   * fromMain() gate applies BY CONSTRUCTION: a handler written with
   * this.guarded(...) cannot forget the check, because there is nowhere to
   * write it - unlike the old pattern of `if (!this.fromMain(e)) return ...`
   * repeated at the top of every handler, which only takes one omission to
   * break.
   *
   * Why this matters here specifically (U3c): preload.js is the SAME file
   * loaded by the overlay and the hidden capture window, so `window.flowui`
   * exists there too. Without a gate that cannot be skipped, an unguarded
   * ui:snippet-save would let either of those windows rewrite the user's
   * whole snippet library - and neither of them is a page a reviewer is
   * likely to be staring at when a new channel is added six months from now.
   */
  private guarded<Args extends unknown[], T>(
    channel: string,
    fallback: T,
    handler: (...args: Args) => T | Promise<T>,
  ): void {
    ipcMain.handle(channel, (e: Electron.IpcMainInvokeEvent, ...args: Args) => {
      if (!this.fromMain(e)) return fallback;
      return handler(...args);
    });
  }

  private register(): void {
    this.guarded<[], UiStatePayload | null>(UI_GET_STATE, null, () => this.deps.getUiState());

    this.guarded<[unknown], UiStatePayload | null>(UI_SET_SETTINGS, null, (patch) => {
      // Same path as POST /settings: applySettings sanitizes and persists.
      this.deps.setSettings(patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {});
      return this.deps.getUiState();
    });

    this.guarded<[], { combo: string[] | null; comboLabel?: string }>(UI_RECORD_SHORTCUT, { combo: null }, () =>
      this.deps.recordShortcut(),
    );

    this.guarded<[], Array<{ id: string; label: string }>>(UI_LIST_MICS, [], () => this.deps.listMics());

    this.guarded<[], string[] | null>(UI_OLLAMA_MODELS, null, () => this.deps.ollamaModels());

    this.guarded<[unknown], void>(UI_OPEN_PATH, undefined, async (which) => {
      // Fixed destinations only: the renderer never passes a path, so a
      // compromised page cannot use this as an arbitrary-open primitive.
      if (which === "log") await shell.openPath(this.deps.logPath());
      else if (which === "data") await shell.openPath(this.deps.dataDirPath());
      else if (which === "history") await shell.openPath(this.deps.historyRootDir());
      else if (which === "legacy-history") {
        // U2b: still a FIXED destination - the path comes from main (the
        // migration captured it), the renderer only names the destination. No
        // value captured means nothing to open: refuse rather than guess.
        // U2c: main returns null for a folder that is gone (the UI hides the
        // button in that case), and a late failure is logged rather than lost.
        const legacy = this.deps.legacyHistoryDirPath();
        if (!legacy) this.deps.log?.("[ui] open legacy recordings folder: nothing to open");
        else {
          const err = await shell.openPath(legacy);
          if (err) this.deps.log?.(`[ui] could not open ${legacy}: ${err}`);
        }
      } else if (which === "downloaded-file") {
        // U5c: reveal the LAST file this session's downloads actually wrote -
        // never a path the renderer supplies, and a clean no-op (logged, not
        // thrown) when nothing has been downloaded yet.
        const last = this.deps.lastDownloadedPath();
        if (!last) this.deps.log?.("[ui] show downloaded file: nothing downloaded yet");
        else shell.showItemInFolder(last);
      } else if (which === "repo") await shell.openExternal(REPO_URL);
    });

    this.guarded<[], boolean>(UI_GET_LOGIN_ITEM, false, () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin);

    this.guarded<[unknown], boolean>(UI_SET_LOGIN_ITEM, false, (on) => {
      // --hidden: a login launch starts the engine without popping the window.
      app.setLoginItemSettings({ openAtLogin: on === true, args: LOGIN_ARGS });
      return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
    });

    this.guarded<[], UpdateCheckResult>(UI_CHECK_UPDATES, { ok: false, message: "unavailable" }, () =>
      this.deps.checkUpdates(),
    );

    // ---- snippets (U3b/U3c): the store owns persistence, this class only
    // gates the sender and (for copy) writes the clipboard. Every channel
    // answers with the WHOLE library (SnippetsResult) - see ipcContracts.ts's
    // module note on why snippets are PULL-only and never in UiStatePayload.
    this.guarded<[], SnippetsResult>(UI_SNIPPET_LIST, SNIPPETS_UNAVAILABLE, () => listSnippets());
    this.guarded<[unknown], SnippetsResult>(UI_SNIPPET_SAVE, SNIPPETS_UNAVAILABLE, (input) => saveSnippet(input));
    this.guarded<[unknown], SnippetsResult>(UI_SNIPPET_DELETE, SNIPPETS_UNAVAILABLE, (id) => deleteSnippet(id));
    this.guarded<[unknown], SnippetsResult>(UI_SNIPPET_COPY, SNIPPETS_UNAVAILABLE, (id) => this.copySnippet(id));

    // ---- dictionary (U6a): exactly the snippets shape - the store owns
    // persistence AND the runtime caches (main/dictionary.ts), this class only
    // gates the sender. Every channel answers with the WHOLE dictionary, and
    // none of it is ever in UiStatePayload (see ipcContracts.ts).
    //
    // The gate is not ceremony here: the same preload is loaded by the overlay
    // and the hidden capture window, and ui:dict-save is a write that changes
    // what every FUTURE dictation is transcribed and rewritten into. An
    // ungated one would let either of those windows edit the engine's own
    // vocabulary.
    this.guarded<[], DictResult>(UI_DICT_LIST, DICT_UNAVAILABLE, () => listDictionary());
    this.guarded<[unknown], DictResult>(UI_DICT_SAVE, DICT_UNAVAILABLE, (input) => saveDictEntry(input));
    this.guarded<[unknown], DictResult>(UI_DICT_DELETE, DICT_UNAVAILABLE, (id) => deleteDictEntry(id));

    // ---- long-form recorder (U4a): IPC surface only, no page consumes it yet
    // (the plan wants this surface reviewed as its own unit before the page
    // exists). Every handler below calls the SAME dep the matching HTTP
    // /long/* route calls - see UiBridgeDeps' module note.
    // Piege (U4a spec): this channel is polled at 1 Hz while the Record page
    // is open, and LongStateSnapshot.recent costs a synchronous read
    // (existingRecent(loadRecent()), same shape of hazard as the one
    // recentForUi() (main/index.ts) already guards for UiStatePayload's own
    // 1 Hz push. Rather than special-case this one channel, LongRecorder.state()
    // itself caches `recent` briefly (see main/longform.ts) - so this handler
    // stays the plain pass-through every other UI_LONG_* channel is, and the
    // HTTP /long/state route gets the same protection for free.
    this.guarded<[], LongStateSnapshot | null>(UI_LONG_STATE, null, () => this.deps.longState());

    this.guarded<[unknown], LongStartResult>(UI_LONG_START, LONG_START_UNAVAILABLE, (opts) => {
      // The decision (valid source? native capture available? "system" is not
      // real yet) is pure and unit-tested in shared/longStart.ts; this handler
      // only acts on the verdict - never its own platform/availability check.
      const decision = decideLongStart(opts, this.deps.canLoopback());
      if (!decision.ok) return { ok: false, error: decision.error };
      return this.deps.longStartNative({
        title: decision.title,
        keepAudio: decision.keepAudio,
        captureSystem: decision.captureSystem,
      });
    });

    this.guarded<[], LongStopResult>(UI_LONG_STOP, LONG_STOP_UNAVAILABLE, () => this.deps.longStop());

    this.guarded<[], { ok: boolean }>(UI_LONG_MARK, { ok: false }, () => this.deps.longMark());

    // `since` is a byte offset (see shared/longform.ts's LongTranscriptResult);
    // anything else from a misbehaving caller is treated as "from the start"
    // rather than thrown - transcriptSince() itself clamps the rest.
    this.guarded<[unknown], LongTranscriptResult>(UI_LONG_TRANSCRIPT, { text: "", nextSince: 0 }, (since) =>
      this.deps.longTranscript(typeof since === "number" ? since : 0),
    );

    // ---- archive browser (U5a) ----
    // Deliberately NOT cached (unlike UiStatePayload.recent / LongStateSnapshot.recent):
    // the Notes page pulls this on demand, not at 1 Hz under the keyboard hook,
    // and needs the EXACT on-disk state - see ipcContracts.ts's module note.
    this.guarded<[], HistoryItem[]>(UI_HISTORY_LIST, [], () => this.deps.listHistory());
    this.guarded<[unknown], HistoryDocPayload | null>(UI_HISTORY_DOC, null, (id) =>
      this.deps.readHistoryDoc(typeof id === "string" ? id : ""),
    );

    // ---- capture downloads (U5c, Roch's decision) ----
    // The renderer only ever passes an id; main resolves it (see
    // main/downloads.ts) - an unknown/forged id is refused there, never here.
    this.guarded<[unknown], DownloadResult>(UI_DOWNLOAD_DOC, DOWNLOAD_UNAVAILABLE, (id) =>
      this.deps.downloadDoc(typeof id === "string" ? id : ""),
    );
    this.guarded<[unknown], DownloadResult>(UI_DOWNLOAD_AUDIO, DOWNLOAD_UNAVAILABLE, (id) =>
      this.deps.downloadAudio(typeof id === "string" ? id : ""),
    );

    // ---- removing a passage (D11) ----
    // The targets cross IPC, so the declared type is a promise and not a fact
    // (same discipline as sanitizeSettings). They are sanitized to plain
    // {index, startMs} numbers HERE, at the boundary, so nothing shaped like a
    // getter or a prototype trick reaches the redactor - and anything that does
    // not survive the filter is DROPPED rather than coerced to 0, which would
    // aim a permanent deletion at the first passage of the transcript.
    this.guarded<[unknown, unknown], RedactResult>(UI_REDACT_PASSAGES, REDACT_UNAVAILABLE, (id, targets) => {
      const clean: RedactTarget[] = (Array.isArray(targets) ? targets : [])
        .map((t) => (typeof t === "object" && t !== null ? (t as Record<string, unknown>) : {}))
        .filter((t) => Number.isInteger(t.index) && Number.isFinite(t.startMs))
        .map((t) => ({ index: t.index as number, startMs: t.startMs as number }));
      return this.deps.redactPassages(typeof id === "string" ? id : "", clean);
    });

    // ---- activation hot-path diagnostics (V2, B1) ----
    this.guarded<[], HotpathSnapshot | null>(UI_HOTPATH_SNAPSHOT, null, () => this.deps.hotpathSnapshot());

    // ---- self-diagnostic (V2, B5): on demand only, never on a timer ----
    this.guarded<[], SelfCheckReport | null>(UI_SELF_CHECK, null, () => this.deps.selfCheck());

    // ---- statistics (U7): PULL, on demand. The store owns the file; this
    // only gates the sender - and the gate matters here as much as anywhere,
    // because ui:stats-clear DESTROYS data and the same preload is loaded by
    // the overlay and the hidden capture window.
    this.guarded<[], StatsPayload>(UI_STATS_READ, STATS_UNAVAILABLE, () => this.deps.statsRead());
    this.guarded<[], StatsPayload>(UI_STATS_CLEAR, STATS_UNAVAILABLE, () => this.deps.statsClear());
  }

  /** U3c: copy is not paste. No Ctrl+V, no clipboard snapshot/restore dance -
   * insertRichViaPaste (src/main/insert.ts) exists for LANDING dictation at
   * the cursor and is deliberately NOT reused here; this only has to put the
   * snippet on the clipboard for the user's own next Ctrl+V, same as any
   * ordinary copy. */
  private copySnippet(rawId: unknown): SnippetsResult {
    const found = getSnippet(rawId);
    const current = listSnippets();
    if (!found) return { ...current, ok: false, error: "snippet not found" };
    // U3g (review, major): "no restore dance" was not the same as "immune to
    // one". A dictation arms a ~250 ms clipboard restore, and copying a snippet
    // inside that window used to be undone by it a quarter second later - the
    // user's copy silently replaced by their pre-dictation clipboard. Disarm it
    // FIRST, before the write, so no timer can be sitting between our write and
    // the user's Ctrl+V. This is the one place in the app where the user
    // explicitly chose what belongs on their clipboard, and that choice is both
    // more recent and more intentional than the restore it cancels.
    if (cancelPendingRestore()) this.deps.log?.("[snippets] copy cancelled a pending clipboard restore");
    if (found.format === "html" && found.html !== undefined) clipboard.write({ text: found.text, html: found.html });
    else clipboard.writeText(found.text);
    return current;
  }

  /** U0: pushes a snapshot immediately instead of waiting for the 1 Hz timer.
   * A theme flip (OS event or in-app toggle) must repaint the window on the
   * SAME tick, not up to a second later - the same visibility guard as the
   * timer, so this stays a no-op while nobody is looking. */
  pushNow(): void {
    if (!this.mainWindow.isVisible()) return;
    this.mainWindow.contents()?.send(UI_STATE_PUSH, this.deps.getUiState());
  }

  stop(): void {
    clearInterval(this.pushTimer);
    this.pushTimer = undefined;
  }
}
