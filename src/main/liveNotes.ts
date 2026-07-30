import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./settings";
import {
  CURRENT_VERSION,
  applyNoteAdd,
  applyNoteDelete,
  applyNoteEdit,
  emptyLiveNotes,
  parseLiveNotesFile,
  type LiveNote,
  type LiveNotesFile,
  type LiveNotesResult,
  type ParsedLiveNotes,
} from "../shared/liveNotes";

// D7: the store behind the live notes panel. MIRROR of main/snippets.ts - atomic
// tmp+rename write, tolerant read, version guard, and a refusal to overwrite a
// file this build did not understand. Read that module's note for the reasoning;
// everything below is the same discipline, plus the three things that are
// specific to this store.
//
// ---------------------------------------------------------------------------
// WHERE THE FILE LIVES, AND WHY NOT IN THE RECORDING'S OWN FOLDER
// ---------------------------------------------------------------------------
// The obvious home for these notes is beside the document they will end up in,
// in the recording's folder. It was rejected: that folder MOVES. A staged
// recording is relocated into the dated archive by fileIntoHistory(), and again
// into a folder of the user's choosing by save(), and both of those move exactly
// two files - the .md and the .wav - by name. A third file in there would be
// left behind on the first move, in a staging folder nothing lists and the
// retention purge eventually deletes: the user's own notes, gone, silently.
// Teaching three move paths, a rollback and a boot rescan about a fourth file is
// precisely the "two places to keep right" that V4's review lists as a risk.
//
// So the slot lives at <dataDir>/live-notes.json, outside every folder that
// moves, and the notes travel into the document ONCE, at the end, by being
// written into it. After that the slot is cleared and there is nothing left to
// keep in step with anything.
//
// ---------------------------------------------------------------------------
// ONE SLOT, NAMED BY THE RECORDING
// ---------------------------------------------------------------------------
// LongRecorder.start() refuses to start a second recording while one is running,
// so there is never more than one live recording on this machine - one slot is
// enough, and there is no id for a caller to forge or guess.
//
// Every operation still NAMES the recording it believes it is writing for
// (startedIso, the recorder's own start instant), and a mismatch is REFUSED
// rather than reconciled. That is what makes it impossible for notes typed
// during one meeting to be attached to the next: not a convention, a check.
//
// ---------------------------------------------------------------------------
// A SLOT IS NEVER SILENTLY DISCARDED
// ---------------------------------------------------------------------------
// open() is called at the start of every recording, and it may find notes
// belonging to a DIFFERENT one. That means an earlier session's notes were never
// merged into their document - the session died in a way none of the three merge
// paths caught. Overwriting them would be a silent loss of the one thing in this
// app a machine cannot reproduce, so they are moved aside to a dated file and the
// log says exactly where they went. Nothing in Flow reads that file again; it
// exists so the answer to "where did my notes go" is never "nowhere".

/** What a caller gets when the store refuses outright. Shaped like every real
 * answer, so a page never has to tell "refused" apart from "genuinely empty" -
 * two states that look identical in a naive length check and mean the opposite
 * (main/snippets.ts's SNIPPETS_UNAVAILABLE, same reasoning). */
export const LIVE_NOTES_UNAVAILABLE: LiveNotesResult = {
  ok: false,
  startedIso: "",
  notes: [],
  error: "unavailable",
};

export function liveNotesPath(): string {
  return path.join(dataDir(), "live-notes.json");
}

/** Thin disk wrapper around parseLiveNotesFile: adds the ENOENT special case (no
 * recording has ever been annotated on this machine - normal, not an error to
 * surface) and turns any other read failure into the same protective shape a bad
 * version gets. */
export function loadLiveNotesFile(file = liveNotesPath()): ParsedLiveNotes {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { file: emptyLiveNotes() };
    return {
      file: emptyLiveNotes(),
      error: `live-notes.json could not be read (${err instanceof Error ? err.message : String(err)}); left untouched, starting with no notes [${file}]`,
    };
  }
  const parsed = parseLiveNotesFile(raw);
  // The path is added HERE rather than in the pure parser: every refusal above
  // tells the user his file was left alone, which is only actionable if he knows
  // which file (main/snippets.ts does the same, for the same reason).
  if (parsed.error !== undefined) return { ...parsed, error: `${parsed.error} [${file}]` };
  return parsed;
}

/** Atomic write (tmp + rename), MIRROR of saveSnippetsFile. Refuses to clobber a
 * slot this build did not fully understand - `onDisk` is the load the caller
 * already did for this same operation (see snippets.ts on why re-reading buys no
 * stronger guarantee and costs a second synchronous pass on the loop that
 * carries the keyboard hook). */
function writeLiveNotesFile(
  onDisk: ParsedLiveNotes,
  next: LiveNotesFile,
  file = liveNotesPath(),
): { ok: true } | { ok: false; error: string } {
  if (onDisk.error) return { ok: false, error: `refusing to overwrite live-notes.json: ${onDisk.error}` };
  const tmp = file + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true }); // never leave a half-written .tmp behind
    } catch {
      /* the cleanup failing changes nothing about the error being reported */
    }
    return {
      ok: false,
      error: `that note could not be saved (${err instanceof Error ? err.message : String(err)}); the notes already recorded are unchanged [${file}]`,
    };
  }
  return { ok: true };
}

export interface LiveNotesStoreDeps {
  log?: (msg: string) => void;
  /** Tests only: keep the slot away from the real ~/.flow. Same seam, same
   * reason, as LongDeps.recentPathOverride. */
  pathOverride?: string;
}

/**
 * The live-notes slot. Holds NO state of its own: every operation re-loads the
 * file, so fixing a broken one restores writes without restarting the app (the
 * property main/snippets.ts spells out), and so a slot cleared by a finalize
 * running between two of the page's calls is seen immediately.
 */
export class LiveNotesStore {
  private deps: LiveNotesStoreDeps;

  constructor(deps: LiveNotesStoreDeps = {}) {
    this.deps = deps;
  }

  private file(): string {
    return this.deps.pathOverride ?? liveNotesPath();
  }

  /** Called by the recorder at start(). Rebinds the slot to this recording -
   * and moves any FOREIGN notes aside first, never over them (module note). */
  open(startedIso: string): void {
    const iso = (startedIso || "").trim();
    if (!iso) return;
    const file = this.file();
    const onDisk = loadLiveNotesFile(file);
    if (onDisk.file.startedIso === iso) return; // resuming the same recording: leave the notes alone
    if (onDisk.file.notes.length > 0 || onDisk.error) {
      // Notes from a session that never got merged, or a file this build could
      // not read. Either way: keep it, name it, and say where it went.
      const aside = file.replace(/\.json$/, "") + "." + Date.now() + ".orphan.json";
      try {
        fs.renameSync(file, aside);
        this.deps.log?.(
          `[live-notes] found notes from an earlier recording (${onDisk.file.startedIso || "unattributed"}) that were never filed into a document; moved aside to ${aside} rather than overwritten`,
        );
      } catch (err) {
        // Could not move it: refuse to start a fresh slot on top of it. The
        // panel will report the slot as unavailable, which is annoying and
        // recoverable; overwriting would not be.
        this.deps.log?.(`[live-notes] could not set aside earlier notes, leaving them in place: ${err}`);
        return;
      }
    }
    const fresh = loadLiveNotesFile(file); // the file is gone now: a clean, empty load
    const written = writeLiveNotesFile(fresh, emptyLiveNotes(iso), file);
    if (!written.ok) this.deps.log?.(`[live-notes] could not open a slot for this recording: ${written.error}`);
  }

  /** UI_LIVE_NOTES_LIST. Answers with the slot's own startedIso, so the page can
   * refuse to render notes that belong to another capture (LiveNotesResult). */
  list(): LiveNotesResult {
    const { file, error } = loadLiveNotesFile(this.file());
    return { ok: error === undefined, startedIso: file.startedIso, notes: file.notes, error };
  }

  /** UI_LIVE_NOTES_ADD. `atMs` is computed by the CALLER from the recorder's own
   * start instant (main/index.ts) - this store never reads a clock, so the stamp
   * and the recording's timeline can never come from two different places. */
  add(startedIso: string, rawText: unknown, atMs: number): LiveNotesResult {
    return this.mutate(startedIso, (notes) => applyNoteAdd(notes, rawText, atMs, randomUUID()));
  }

  /** UI_LIVE_NOTES_EDIT. The stamp does not move (shared/liveNotes.ts DECISION 2). */
  edit(startedIso: string, rawId: unknown, rawText: unknown): LiveNotesResult {
    return this.mutate(startedIso, (notes) => applyNoteEdit(notes, rawId, rawText));
  }

  /** UI_LIVE_NOTES_DELETE. Idempotent: an id already gone is a no-op. */
  remove(startedIso: string, rawId: unknown): LiveNotesResult {
    return this.mutate(startedIso, (notes) => ({ notes: applyNoteDelete(notes, rawId) }));
  }

  /** What the recorder reads at the end of a recording, to write into the
   * document. Empty for a recording that was never annotated, and empty - never
   * another recording's notes - when the slot names a different capture. */
  read(startedIso: string): LiveNote[] {
    const iso = (startedIso || "").trim();
    if (!iso) return [];
    const { file, error } = loadLiveNotesFile(this.file());
    if (error) {
      this.deps.log?.(`[live-notes] the slot did not load intact, the document gets no notes block: ${error}`);
      return [];
    }
    if (file.startedIso !== iso) return [];
    return file.notes;
  }

  /** Called ONLY after the notes are safely in the document. If the document
   * write failed, the slot is deliberately left alone: a later open() will find
   * it, see a foreign startedIso and set it aside with a log line, which is a
   * recoverable outcome. Clearing first would not be. */
  clear(startedIso: string): void {
    const iso = (startedIso || "").trim();
    const file = this.file();
    const onDisk = loadLiveNotesFile(file);
    // Never clear a slot that belongs to someone else, and never "clear" a file
    // this build could not read (that would be an overwrite, not a clear).
    if (onDisk.error || (iso && onDisk.file.startedIso !== iso)) return;
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      this.deps.log?.(`[live-notes] could not clear the slot after filing its notes: ${err}`);
    }
  }

  private mutate(
    startedIso: string,
    apply: (notes: readonly LiveNote[]) => { notes: LiveNote[] } | { error: string },
  ): LiveNotesResult {
    const iso = (startedIso || "").trim();
    const file = this.file();
    const onDisk = loadLiveNotesFile(file);
    const cur = onDisk.file;
    if (onDisk.error) return { ok: false, startedIso: cur.startedIso, notes: cur.notes, error: onDisk.error };
    // No recording, or a different one than the caller thinks: refuse. A page
    // that raced the end of a recording must be told, not have its note filed
    // against whatever the slot happens to hold now.
    if (!iso || cur.startedIso !== iso) {
      return {
        ok: false,
        startedIso: cur.startedIso,
        notes: cur.notes,
        error: "that recording is no longer the one being annotated; its notes have already been written into its document",
      };
    }
    const applied = apply(cur.notes);
    if ("error" in applied) return { ok: false, startedIso: cur.startedIso, notes: cur.notes, error: applied.error };
    const next: LiveNotesFile = { version: CURRENT_VERSION, startedIso: iso, notes: applied.notes };
    const written = writeLiveNotesFile(onDisk, next, file);
    if (!written.ok) return { ok: false, startedIso: cur.startedIso, notes: cur.notes, error: written.error };
    return { ok: true, startedIso: iso, notes: applied.notes };
  }
}
