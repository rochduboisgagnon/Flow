import fs from "node:fs";
import path from "node:path";
import {
  HISTORY_VERSION,
  emptyHistory,
  mergeEntries,
  parseHistoryFile,
  sanitizeHistoryText,
  type HistoryEntry,
  type HistoryFile,
} from "../shared/dictationHistory";

// The dictation history store. Deliberately the same shape as main/stats.ts,
// because it has the same hazard: the process that writes this file is the one
// carrying the keyboard hook, so nothing here may run synchronously per press.
//
// See shared/dictationHistory.ts for what this feature changed about what Flow
// promises. In short: it now writes down what you dictate, the README says so,
// and this file is what has to keep the four bounds that make that acceptable.

const FLUSH_INTERVAL_MS = 60_000;

export interface HistoryStoreDeps {
  /** Absolute path of history.json. A closure, never a captured string:
   * dataDir() caches the post-migration folder on its FIRST call, and this
   * store is constructed at module load, before the migration has run. */
  file(): string;
  /** Injectable clock - the retention tests need a machine whose "now" is five
   * weeks from here without waiting five weeks. */
  now?(): number;
  log?(msg: string): void;
  /** Test seam only; production uses FLUSH_INTERVAL_MS. */
  flushIntervalMs?: number;
}

export class DictationHistoryStore {
  private deps: HistoryStoreDeps;
  private pending: HistoryEntry[] = [];
  private loaded: HistoryFile | null = null;
  private loadError: string | undefined;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  /** A failing disk must not log the same line every minute forever. */
  private reportedWriteFailure = false;

  constructor(deps: HistoryStoreDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * THE HOT PATH. Memory only: one sanitize (a regex over a short string) and
   * one array push. No read, no write, no JSON.
   *
   * Called with the text that was actually inserted, after every filter, so the
   * history shows what landed rather than what the model first said.
   */
  record(rawText: string): void {
    const { text, truncated } = sanitizeHistoryText(rawText);
    if (!text) return;
    this.pending.push(truncated ? { at: this.now(), text, truncated } : { at: this.now(), text });
    this.dirty = true;
  }

  private ensureLoaded(): HistoryFile {
    if (this.loaded) return this.loaded;
    const p = this.deps.file();
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        // A file we could not read is NOT the same as no file. Recording the
        // error is what stops the next flush writing an empty history over
        // something a later build might have understood.
        this.loadError = `history could not be read: ${e.message}`;
        this.deps.log?.(`[history] ${this.loadError}`);
      }
      this.loaded = emptyHistory();
      return this.loaded;
    }
    const parsed = parseHistoryFile(raw);
    this.loadError = parsed.error;
    if (parsed.error) this.deps.log?.(`[history] ${parsed.error}`);
    this.loaded = parsed.file;
    return this.loaded;
  }

  /** Periodic, and on quit. Purges as it writes: the retention is a property of
   * the FILE, not a filter the page applies afterwards. */
  flush(): void {
    if (!this.dirty) return;
    const file = this.ensureLoaded();
    if (this.loadError) {
      // The overwrite guard. Keep collecting in memory - the session's own
      // dictations are not lost from the page - but never write a copy of a
      // file we failed to understand.
      return;
    }
    const entries = mergeEntries(file.entries, this.pending, this.now());
    const next: HistoryFile = { version: HISTORY_VERSION, entries };
    if (!this.write(next)) return; // keep pending + dirty: the next flush retries
    this.loaded = next;
    this.pending = [];
    this.dirty = false;
  }

  /** Atomic write (tmp + rename), the same discipline as settings and stats: a
   * crash mid-save must not leave a half-written history behind. */
  private write(file: HistoryFile): boolean {
    const p = this.deps.file();
    const tmp = p + ".tmp";
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
      fs.renameSync(tmp, p);
      this.reportedWriteFailure = false;
      return true;
    } catch (err) {
      if (!this.reportedWriteFailure) {
        this.reportedWriteFailure = true;
        this.deps.log?.(`[history] could not be written: ${(err as Error).message}`);
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* the tmp file is ours; failing to remove it changes nothing */
      }
      return false;
    }
  }

  /** What the page renders. Merges the not-yet-flushed entries so the list is
   * never up to a minute stale, and never writes anything. */
  read(): { entries: HistoryEntry[]; error?: string } {
    const file = this.ensureLoaded();
    return {
      entries: mergeEntries(file.entries, this.pending, this.now()),
      error: this.loadError,
    };
  }

  /**
   * Erase everything, now. DELETES the file rather than writing an empty one:
   * "there is no history" and "there is a history that happens to be empty" are
   * different facts on a disk, and only the first is what the button promises.
   */
  clear(): { entries: HistoryEntry[]; error?: string } {
    this.pending = [];
    this.loaded = emptyHistory();
    this.loadError = undefined;
    this.dirty = false;
    const p = this.deps.file();
    try {
      fs.rmSync(p, { force: true });
      fs.rmSync(p + ".tmp", { force: true });
    } catch (err) {
      const msg = `history could not be erased: ${(err as Error).message}`;
      this.deps.log?.(`[history] ${msg}`);
      // Said out loud rather than swallowed: a user who clicked "erase" and got
      // a silent failure would believe something false about their own machine.
      return { entries: [], error: msg };
    }
    return { entries: [] };
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), this.deps.flushIntervalMs ?? FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** before-quit: the last flush, and the timer stops. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }
}
