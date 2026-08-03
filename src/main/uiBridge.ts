import { ipcMain, shell, app } from "electron";
import {
  UI_GET_STATE,
  UI_SET_SETTINGS,
  UI_RECORD_SHORTCUT,
  UI_LIST_MICS,
  UI_DOWNLOAD_NOTES_MODEL,
  UI_SIGN_IN,
  UI_SIGN_OUT,
  UI_OPEN_PATH,
  UI_GET_LOGIN_ITEM,
  UI_SET_LOGIN_ITEM,
  UI_CHECK_UPDATES,
  UI_STATE_PUSH,
  UI_HOTPATH_SNAPSHOT,
  UI_SELF_CHECK,
  UI_STATS_READ,
  UI_HISTORY_READ,
  UI_HISTORY_CLEAR,
  UI_STATS_CLEAR,
  UI_DICT_LIST,
  UI_DICT_SAVE,
  UI_DICT_DELETE,
  UI_LONG_STATE,
  UI_LONG_START,
  UI_LONG_STOP,
  UI_LONG_MARK,
  UI_LONG_TRANSCRIPT,
  UI_LIVE_NOTES_LIST,
  UI_LIVE_NOTES_ADD,
  UI_LIVE_NOTES_EDIT,
  UI_LIVE_NOTES_DELETE,
  UI_HISTORY_LIST,
  UI_HISTORY_DELETE,
  UI_HISTORY_DOC,
  UI_DOWNLOAD_DOC,
  UI_DOWNLOAD_AUDIO,
  UI_REDACT_PASSAGES,
  UI_IMPORT_STATE,
  UI_IMPORT_START,
  UI_IMPORT_CANCEL,
  UI_IMPORT_PICK,
  type ImportQueueSnapshot,
  type ImportStartResult,
  type UiStatePayload,
  type SignInResult,
  type UpdateCheckResult,
  type DictResult,
  type LongStateSnapshot,
  type LongStartResult,
  type LongStopResult,
  type LongTranscriptResult,
  type LiveNotesResult,
  type RecordingSummary,
  type RecordingDocPayload,
  type DownloadResult,
  type RedactTarget,
  type RedactResult,
  type HotpathSnapshot,
  type SelfCheckReport,
  type StatsPayload,
  type HistoryPayload,
} from "../shared/ipcContracts";
import type { MainWindow } from "./mainWindow";
import { listDictionary, saveDictEntry, deleteDictEntry } from "./dictionary";
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
  /** D1 : va chercher le modele de redaction, sur pression d'un bouton. Rend
   * quand le telechargement est fini ou a echoue ; l'avancement, lui, voyage
   * dans `notesModel` de la poussee d'etat. */
  downloadNotesModel(): Promise<void>;
  /** A2 : l'onglet Account. Il n'y a PAS d'equivalent d'inscription, ici ni
   * ailleurs - Roch cree les comptes lui-meme, et le projet Supabase refuse
   * les inscriptions cote serveur. */
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<{ ok: boolean; error: string }>;
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

  // ---- live notes typed during a recording (V4, D7) ----
  // Main-only, NO HTTP equivalent - see ipcContracts.ts on why the one part of a
  // capture that cannot be regenerated is not exposed to a remote client. The
  // store owns persistence and the recording-identity check (main/liveNotes.ts);
  // this bridge only gates the sender, and the gate is not ceremony: the same
  // preload is loaded by the overlay and the hidden capture window, and these
  // channels WRITE the user's own irreplaceable words.
  //
  // `startedIso` is supplied by the CALLER on every write and checked by the
  // store, never remembered here: the page states which recording it believes it
  // is annotating, and a note aimed at a recording that has already been filed
  // is refused rather than landing on the next one.
  liveNotesList(): LiveNotesResult;
  liveNoteAdd(startedIso: string, text: string): LiveNotesResult;
  liveNoteEdit(startedIso: string, id: string, text: string): LiveNotesResult;
  liveNoteDelete(startedIso: string, id: string): LiveNotesResult;

  /** NativeCapture.available() (Windows-only "this is a PC" gate). Validated
   * by shared/longStart.ts BEFORE this bridge ever calls longStartNative, so
   * a machine that cannot loopback gets one clean, readable refusal instead
   * of a call that would refuse deeper down anyway. */
  canLoopback(): boolean;

  // ---- archive browser (U5a) ----
  // The SAME functions the HTTP /long/history* routes call (main/api.ts),
  // identical closures to LocalApi's (index.ts's listRecordingsDep &
  // readRecordingDocDep) - never a second implementation.
  //
  // B3e : les trois sont devenues ASYNCHRONES, et c'est le seul changement de
  // forme que le passage au compte impose a ce fichier. Une lecture de dossier
  // etait synchrone ; une lecture de ligne est un aller-retour reseau. `guarded`
  // acceptait deja une promesse, donc rien d'autre n'a bouge - et surtout, aucune
  // de ces trois-la n'est sur le chemin d'une dictee : elles servent une page que
  // quelqu'un a ouverte.
  listHistory(): Promise<RecordingSummary[]>;
  /** Deletes a capture, then answers with what is left. */
  deleteHistory(id: string): Promise<RecordingSummary[]>;
  readHistoryDoc(id: string): Promise<RecordingDocPayload | null>;

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

  // ---- audio file import (V4, D2) ----
  // Main-only, no HTTP equivalent, and that is a decision rather than an
  // omission: UI_IMPORT_START is the one channel in this whole surface that
  // accepts a filesystem PATH, and a remote PWA answering over the network has
  // no business naming files on this machine for the engine to read. The
  // renderer's paths come from a drag-and-drop or from main's own picker.
  importState(): ImportQueueSnapshot;
  importStart(req: unknown): ImportStartResult;
  importCancel(id: string): { ok: boolean };
  /** The native open dialog, opened BY MAIN: the safest possible source of
   * paths, and the only way in for a user who does not drag files. */
  importPick(): Promise<string[]>;

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
  // ---- voice functions (V5, E5) ----
  /** The dry run. Main-process only, with NO HTTP equivalent, and that is a
   * decision: this hands a language model a block of text on this machine, and
   * a remote PWA answering over the network has no business spending the GPU
   * dictation needs. It is the SAME closure the dictation path uses
   * (index.ts's voiceCommandsDep) - a dry run that could disagree with the
   * spoken path would be a lie about the engine, which is exactly the class of
   * defect this campaign counts as blocking. */

  statsRead(): StatsPayload;
  /** U7d: erases ~/.flow/stats.json on the spot and answers with the (now
   * empty) payload, so the page repaints from the same call. */
  statsClear(): StatsPayload;
  /** 2026-07-30: the dictation history. Read is a page opening; clear DELETES
   * what the user dictated, which is why it lives behind the same gate. */
  historyRead(): HistoryPayload;
  historyClear(): HistoryPayload;

}

const REPO_URL = "https://github.com/rochduboisgagnon/Flow";

// Review A10: getLoginItemSettings() compares the registry entry ARGS-AND-ALL.
// Reading it without the args we register with reports openAtLogin=false
// forever - the toggle then shows OFF while the entry exists, and turning it
// "off" from that state is a no-op. One constant, used by set AND get, so the
// two can never diverge again.
export const LOGIN_ARGS = ["--hidden"];


// U6: the same fallback discipline for the dictionary. Shaped like every real
// DictResult so the page never has to special-case "refused" against "the
// dictionary is genuinely empty" - two states that look identical in a naive
// `items.length === 0` check and mean opposite things.
const DICT_UNAVAILABLE: DictResult = { ok: false, items: [], error: "unavailable" };

// D7: same fallback discipline again, with one field that matters. An empty
// `startedIso` means "these notes belong to no recording", which is exactly what
// the Record page needs to see in order to render nothing: a refused sender must
// never be able to make a page display, or write into, another capture's notes.
const LIVE_NOTES_UNAVAILABLE: LiveNotesResult = {
  ok: false,
  startedIso: "",
  notes: [],
  error: "unavailable",
};

// U4a: same fallback discipline as SNIPPETS_UNAVAILABLE - what a refused
// sender (guarded()'s fromMain() gate) gets back, shaped like every real
// answer so a caller never has to special-case "refused" vs "genuinely empty".
const LONG_START_UNAVAILABLE: LongStartResult = { ok: false, error: "unavailable" };
const LONG_STOP_UNAVAILABLE: LongStopResult = { ok: false, recordingId: "" };

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

// D2: same fallback discipline for the import queue. An empty, idle queue is
// the honest shape for an answer that never reached it, and the start channel
// answers `ok: false` with nothing accepted - a refused sender must never be
// able to make a page believe an import is under way.
const IMPORT_STATE_UNAVAILABLE: ImportQueueSnapshot = { items: [], activeId: "", busy: false };
const IMPORT_START_UNAVAILABLE: ImportStartResult = {
  ok: false,
  accepted: [],
  rejected: [],
  error: "unavailable",
};

// U7: same fallback discipline again. Every counter reads zero and both
// switches read off, which is the honest thing for an answer that never
// reached the store: a refused sender must not be able to make a page claim
// that attribution is on.
const HISTORY_UNAVAILABLE: HistoryPayload = { ok: false, entries: [], error: "unavailable" };

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

    // D1: the Local AI tab's one button. No arguments to validate - the file it
    // fetches is pinned in modelStore (immutable revision, hash checked before
    // the rename), so the renderer chooses NOTHING here, it only asks.
    this.guarded<[], void>(UI_DOWNLOAD_NOTES_MODEL, undefined, () => this.deps.downloadNotesModel());

    // A2. Les deux arguments sont valides ICI plutot que crus sur parole : ce
    // canal est joignable depuis le preload que partagent l'overlay et la
    // fenetre de capture, et il porte un mot de passe.
    //
    // Le repli en cas de sender refuse est un ECHEC explicite, jamais un
    // « ok: true » : une page qui croit avoir connecte quelqu'un afficherait
    // une application vide.
    this.guarded<[unknown, unknown], SignInResult>(
      UI_SIGN_IN,
      { ok: false, error: "refuse", account: { signedIn: false, email: "", userId: "" } },
      (email, password) => {
        if (typeof email !== "string" || typeof password !== "string") {
          return Promise.resolve({
            ok: false,
            error: "adresse ou mot de passe manquant",
            account: { signedIn: false, email: "", userId: "" },
          });
        }
        return this.deps.signIn(email.trim(), password);
      },
    );

    this.guarded<[], { ok: boolean; error: string }>(UI_SIGN_OUT, { ok: false, error: "refuse" }, () =>
      this.deps.signOut(),
    );

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

    // ---- live notes typed during a recording (D7) ----
    // The store owns persistence, the bounds, the one-line rule and the
    // recording-identity check (main/liveNotes.ts + shared/liveNotes.ts); this
    // only gates the sender and coerces the arguments at the boundary. Coerced
    // rather than trusted for the usual reason: the declared types cross IPC, so
    // they are a claim and not a fact - a non-string id or text becomes "", which
    // the store refuses cleanly instead of stringifying into a note.
    this.guarded<[], LiveNotesResult>(UI_LIVE_NOTES_LIST, LIVE_NOTES_UNAVAILABLE, () => this.deps.liveNotesList());
    this.guarded<[unknown, unknown], LiveNotesResult>(UI_LIVE_NOTES_ADD, LIVE_NOTES_UNAVAILABLE, (iso, text) =>
      this.deps.liveNoteAdd(typeof iso === "string" ? iso : "", typeof text === "string" ? text : ""),
    );
    this.guarded<[unknown, unknown, unknown], LiveNotesResult>(
      UI_LIVE_NOTES_EDIT,
      LIVE_NOTES_UNAVAILABLE,
      (iso, id, text) =>
        this.deps.liveNoteEdit(
          typeof iso === "string" ? iso : "",
          typeof id === "string" ? id : "",
          typeof text === "string" ? text : "",
        ),
    );
    this.guarded<[unknown, unknown], LiveNotesResult>(UI_LIVE_NOTES_DELETE, LIVE_NOTES_UNAVAILABLE, (iso, id) =>
      this.deps.liveNoteDelete(typeof iso === "string" ? iso : "", typeof id === "string" ? id : ""),
    );

    // ---- archive browser (U5a) ----
    // Deliberately NOT cached (unlike UiStatePayload.recent / LongStateSnapshot.recent):
    // the Notes page pulls this on demand, not at 1 Hz under the keyboard hook,
    // and needs the EXACT on-disk state - see ipcContracts.ts's module note.
    this.guarded<[], RecordingSummary[]>(UI_HISTORY_LIST, [], () => this.deps.listHistory());
    // The one channel here that DESTROYS a recording. Behind the same gate as
    // the rest, and answering with the refreshed list so a refused sender can
    // never make a page show a capture as gone when it is still on disk.
    this.guarded<[unknown], RecordingSummary[]>(UI_HISTORY_DELETE, [], (id) =>
      this.deps.deleteHistory(typeof id === "string" ? id : ""),
    );
    this.guarded<[unknown], RecordingDocPayload | null>(UI_HISTORY_DOC, null, (id) =>
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

    // ---- audio file import (V4, D2) ----
    // The gate matters as much here as on ui:stats-clear, for a different
    // reason: ui:import-start hands the engine a PATH TO READ, and the same
    // preload is loaded by the overlay and the hidden capture window. Behind the
    // gate, main still trusts nothing - the queue itself refuses anything that
    // is not an existing regular file with a supported audio extension, and an
    // import never writes to, moves or deletes the file it was pointed at.
    this.guarded<[], ImportQueueSnapshot>(UI_IMPORT_STATE, IMPORT_STATE_UNAVAILABLE, () =>
      this.deps.importState(),
    );
    // The request crosses IPC, so its shape is a claim, not a fact: it is
    // sanitized by shared/audioImport.ts's sanitizeImportRequest inside the
    // queue (pure, unit-tested), exactly as UI_LONG_START defers to
    // shared/longStart.ts rather than validating here.
    this.guarded<[unknown], ImportStartResult>(UI_IMPORT_START, IMPORT_START_UNAVAILABLE, (req) =>
      this.deps.importStart(req),
    );
    this.guarded<[unknown], { ok: boolean }>(UI_IMPORT_CANCEL, { ok: false }, (id) =>
      this.deps.importCancel(typeof id === "string" ? id : ""),
    );
    // An empty list is what "the user pressed Cancel" looks like too, so the
    // page treats both identically and never has to tell them apart.
    this.guarded<[], string[]>(UI_IMPORT_PICK, [], () => this.deps.importPick());

    // ---- voice functions (V5, E2/E5): the store owns persistence and the
    // runtime cache (main/functions.ts); this class only gates the sender. The
    // gate matters as much here as on ui:dict-save and for a longer reach:
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

    // ---- dictation history (2026-07-30) ----
    // Same fallback discipline: an empty list with ok:false is the honest shape
    // for an answer that never reached the store. A refused sender must not be
    // able to make a page report that the history is empty - which, on this
    // feature, would read as "your dictations were erased".
    this.guarded<[], HistoryPayload>(UI_HISTORY_READ, HISTORY_UNAVAILABLE, () => this.deps.historyRead());
    this.guarded<[], HistoryPayload>(UI_HISTORY_CLEAR, HISTORY_UNAVAILABLE, () => this.deps.historyClear());
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
