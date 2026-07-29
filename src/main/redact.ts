import fs from "node:fs";
import path from "node:path";
import { resolveHistoryEntry } from "./longform";
import {
  planRedaction,
  parseTranscriptPassages,
  locateWavData,
  byteRangeFor,
  type RedactionRange,
} from "../shared/redact";
import type { RedactResult } from "../shared/ipcContracts";

// D11: the writing half of "remove a passage from a capture". The decisions
// this obeys - audio silenced, derived notes dropped, timestamps frozen, no
// undo - are argued in shared/redact.ts's module note; this file is about
// carrying them out without ever leaving a half-done state on disk.
//
// Main-process IPC only, with NO HTTP route, and that is deliberate: the local
// API answers a remote PWA on another device (see main/downloads.ts for the
// same call). Downloading a file over it is a read; DESTROYING part of a
// recording is not something a phone on the network gets to ask for.
//
// ---------------------------------------------------------------------------
// THE ORDER OF OPERATIONS IS THE WHOLE SAFETY ARGUMENT
// ---------------------------------------------------------------------------
// A removal touches two files, so one of them is written first and a crash can
// land in between. The two orders are NOT symmetric:
//
//   document first, then audio - a crash in between leaves a transcript whose
//     tombstone reads "The audio for that range was silenced." while the audio
//     still holds every word of it. The app would be lying, in writing, about
//     the exact thing the user came here for. FORBIDDEN.
//
//   audio first, then document - a crash in between leaves audio that is
//     silenced and a transcript that still shows the text. Nothing claims to be
//     done, the user plainly sees the removal did not complete, and running it
//     again finishes the job (zeroing an already-zeroed range is a no-op).
//
// So: AUDIO FIRST, DOCUMENT SECOND. The document's claim about the audio is
// therefore true at the instant it becomes readable, and can only ever be
// "more true than stated" (audio silenced, text not yet removed) in between.
//
// ---------------------------------------------------------------------------
// NEITHER FILE IS EVER WRITTEN IN PLACE
// ---------------------------------------------------------------------------
// The document goes through tmp + rename, the same discipline as settings.ts,
// snippets.ts and the notes splice. The audio does too - and that is worth
// arguing, because zeroing bytes in place would need no second copy at all.
// It is refused precisely because it is interruptible: a kill halfway through
// leaves a file whose first half is scrubbed and whose second half still holds
// the passage, under the recording's real name, with nothing anywhere saying
// so. That is the "half-cleaned document that looks clean" this campaign
// forbids, in its most dangerous form. Copy-then-rename costs one extra pass
// over the file and the free space for it - stated to the user when it fails -
// and buys the property that at every instant the recording's audio is either
// entirely untouched or entirely scrubbed.

/** The suffix a scrub in progress wears. Like downloads.ts's PART_SUFFIX, it is
 * deliberately NOT a conventional ".tmp"/".part": the only file this module
 * will ever delete is one bearing this exact suffix inside a resolved history
 * folder, so a name no other program writes is what makes the sweep safe. */
export const REDACT_SUFFIX = ".flow-redact";

/** Read in 1 MiB slices. Big enough that a 500 MB wav is ~500 round trips
 * rather than half a million; small enough that no single allocation can matter
 * on a machine that is also transcribing. */
const CHUNK_BYTES = 1024 * 1024;

/** How far into the audio file we look for the RIFF `data` chunk header. */
const HEADER_PROBE_BYTES = 64 * 1024;

/** Hard bound on a document this module will rewrite.
 *
 * The Notes page reads a transcript through readHistoryDoc, which CAPS its read
 * at 5 MB for display. This module must never rewrite from a capped read: the
 * bytes past the cap would be silently dropped, which would delete the tail of
 * a long meeting while reporting a clean passage removal. So it reads the file
 * WHOLE, and refuses outright above this much rather than truncate. 32 MB of
 * timestamped text is several days of continuous speech; a real transcript is
 * orders of magnitude below it. */
export const MAX_REDACT_DOC_BYTES = 32 * 1024 * 1024;

/** What the user is told when nothing more specific is known. Same split as
 * downloads.ts: a readable sentence for the page, the raw Node error for the
 * log. */
const FAILED = "Flow could not remove that passage.";

export interface RedactDeps {
  historyRoot(): string;
  log?(msg: string): void;
}

/** An error carrying something the user can read, alongside detail for the log. */
class RedactFailure extends Error {
  readonly userMessage: string;
  constructor(userMessage: string, detail: string) {
    super(detail);
    this.name = "RedactFailure";
    this.userMessage = userMessage;
  }
}

/** Zero `[from, to)` of `src` into a fresh work file, copying everything else
 * byte for byte, and return the work file's path.
 *
 * Fully async (fs.promises), never readFileSync: the main process carries the
 * keyboard hook, and a synchronous pass over a multi-hundred-megabyte wav would
 * freeze dictation for exactly that long (invariant 4, and the same call
 * downloads.ts makes).
 *
 * The work file is opened with "wx" - exclusive create - so this can never
 * truncate something already sitting at that name, and so a failure can only
 * ever remove a file this call itself created. */
async function writeScrubbedCopy(
  src: string,
  work: string,
  ranges: Array<{ from: number; to: number }>,
  log?: (msg: string) => void,
): Promise<void> {
  const zeros = Buffer.alloc(CHUNK_BYTES);
  const buf = Buffer.alloc(CHUNK_BYTES);
  let inHandle: fs.promises.FileHandle | null = null;
  let outHandle: fs.promises.FileHandle | null = null;
  let created = false;
  try {
    outHandle = await fs.promises.open(work, "wx");
    created = true;
    inHandle = await fs.promises.open(src, "r");
    let at = 0;
    for (;;) {
      const { bytesRead } = await inHandle.read(buf, 0, CHUNK_BYTES, at);
      if (bytesRead === 0) break;
      // Overwrite, in the slice we are about to write, whatever part of it a
      // removed range covers. Done on the COPY: the source is only ever read.
      for (const r of ranges) {
        const from = Math.max(r.from, at);
        const to = Math.min(r.to, at + bytesRead);
        if (to > from) zeros.copy(buf, from - at, 0, to - from);
      }
      await outHandle.write(buf, 0, bytesRead);
      at += bytesRead;
    }
  } catch (err) {
    if (created) {
      try {
        await outHandle?.close();
        outHandle = null;
        await fs.promises.rm(work, { force: true });
      } catch (rmErr) {
        // The one failure the user has to clean up by hand: the scrub failed
        // AND its debris survived. Saying so beats swallowing it.
        log?.(`[redact] could not remove the work file ${work} after a failed scrub: ${rmErr}`);
      }
    }
    throw err;
  } finally {
    await inHandle?.close();
    await outHandle?.close();
  }
}

/** Delete work files a previous scrub never finished - what a crash, a forced
 * quit or an updater relaunch leaves behind. Only REDACT_SUFFIX names inside
 * the resolved recording folder are ever touched. Never throws: a folder we
 * cannot read is a reason to skip the sweep, not to fail the removal. */
async function sweepWorkFiles(dir: string, log?: (msg: string) => void): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(REDACT_SUFFIX)) continue;
    try {
      await fs.promises.unlink(path.join(dir, name));
      log?.(`[redact] removed an unfinished scrub left by a previous run: ${path.join(dir, name)}`);
    } catch (err) {
      log?.(`[redact] could not remove the leftover work file ${path.join(dir, name)}: ${err}`);
    }
  }
}

/** Silence `ranges` in the recording's .wav, atomically. Resolves once the
 * audio on disk is entirely scrubbed; rejects with the ORIGINAL file untouched
 * otherwise. */
async function silenceAudio(
  audioPath: string,
  ranges: readonly RedactionRange[],
  log?: (msg: string) => void,
): Promise<void> {
  const stat = await fs.promises.stat(audioPath);
  const head = Buffer.alloc(Math.min(HEADER_PROBE_BYTES, stat.size));
  const handle = await fs.promises.open(audioPath, "r");
  try {
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  const data = locateWavData(head, stat.size);
  if ("error" in data) {
    // Refusing the WHOLE removal, rather than editing the transcript and
    // leaving the audio alone: a document claiming a passage is gone over audio
    // that still plays it is the one outcome this feature exists to prevent.
    throw new RedactFailure(
      `Flow could not silence this recording's audio, so nothing was changed: ${data.error}.`,
      `unusable wav at ${audioPath}: ${data.error}`,
    );
  }
  const byteRanges = ranges.map((r) => byteRangeFor(r, data));
  const work = audioPath + REDACT_SUFFIX;
  await sweepWorkFiles(path.dirname(audioPath), log);
  await writeScrubbedCopy(audioPath, work, byteRanges, log);
  // The copy must weigh exactly what the source weighed: zeroing changes no
  // lengths, so anything else means a short write (a full disk) that would
  // otherwise land under the recording's own name as a truncated file.
  const got = (await fs.promises.stat(work)).size;
  if (got !== stat.size) {
    await fs.promises.rm(work, { force: true });
    throw new RedactFailure(
      "Flow could not silence this recording's audio: the copy came out incomplete, so it was discarded and nothing was changed.",
      `scrub size mismatch at ${work}: expected ${stat.size} bytes, wrote ${got}`,
    );
  }
  // rename REPLACES on both Windows and POSIX, which is exactly what is wanted
  // here (unlike downloads.ts, where the destination is a name the user may own
  // and link() is used to refuse a clobber): the destination is the very file
  // being scrubbed, and the swap is one indivisible filesystem step. At no
  // instant does the recording's audio hold a partially scrubbed copy.
  await fs.promises.rename(work, audioPath);
}

/** Read a transcript WHOLE, for rewriting. Never the capped read
 * readHistoryDoc does for display - see MAX_REDACT_DOC_BYTES. */
async function readDocForRewrite(docPath: string): Promise<string> {
  const size = (await fs.promises.stat(docPath)).size;
  if (size > MAX_REDACT_DOC_BYTES) {
    throw new RedactFailure(
      "This transcript is too large for Flow to rewrite safely, so nothing was changed.",
      `document ${docPath} is ${size} bytes, over the ${MAX_REDACT_DOC_BYTES} rewrite cap`,
    );
  }
  return fs.promises.readFile(docPath, "utf8");
}

export class Redactor {
  private deps: RedactDeps;
  /** One removal at a time, process-wide. Two concurrent removals on the same
   * capture would each plan against the ORIGINAL document and the second would
   * write its plan over the first's result, resurrecting a passage the user
   * had already destroyed. A flat gate is the honest fix: the operation takes
   * as long as one pass over a wav, and there is no sane reason to overlap. */
  private busy = false;

  constructor(deps: RedactDeps) {
    this.deps = deps;
  }

  /**
   * Remove the named passages, for real and for good.
   *
   * `expect` is not ceremony. The page parsed the transcript to show it, then a
   * human read a confirmation - seconds, sometimes minutes. In between, a notes
   * regeneration or a rescue at startup can rewrite the document and move every
   * index. Acting on a stale index would destroy a passage the user never
   * looked at, irreversibly. So the caller sends the start offset it saw for
   * each index, and a single mismatch refuses the whole operation.
   */
  async remove(id: string, expect: ReadonlyArray<{ index: number; startMs: number }>): Promise<RedactResult> {
    if (this.busy) return { ok: false, error: "Flow is already removing a passage. Wait for it to finish." };
    // The renderer only ever hands over an id and indices - never a path. The
    // resolution is main's, with the archive's own containment guarantees: a
    // forged or stale id is refused, and no write can ever land outside a
    // folder Flow itself established as a history root (the marker gate in
    // resolveHistoryEntry). This is the invariant that matters most in this
    // file: Flow never deletes a recording it was not managing.
    const entry = resolveHistoryEntry(id, this.deps.historyRoot());
    if (!entry || !entry.doc) return { ok: false, error: "recording not found" };
    if (!Array.isArray(expect) || expect.length === 0) return { ok: false, error: "no passage was selected" };

    this.busy = true;
    try {
      const doc = await readDocForRewrite(entry.doc);
      const passages = parseTranscriptPassages(doc);
      for (const want of expect) {
        const got = passages[want.index];
        if (!got || got.startMs !== want.startMs) {
          return {
            ok: false,
            error: "This transcript changed since you opened it, so nothing was removed. Reopen the capture and try again.",
          };
        }
      }
      const plan = planRedaction(
        doc,
        expect.map((e) => e.index),
        { hasAudio: entry.audio !== null, dateIso: today() },
      );
      if ("error" in plan) return { ok: false, error: plan.error };

      // AUDIO FIRST (module note): after this line the tombstone about to be
      // written is already true.
      if (entry.audio) await silenceAudio(entry.audio, plan.ranges, this.deps.log);

      // Then the document, atomically. A crash before the rename leaves the
      // original transcript intact over already-silenced audio: visibly
      // unfinished, never falsely finished.
      const tmp = entry.doc + ".tmp";
      try {
        await fs.promises.writeFile(tmp, plan.doc, "utf8");
        await fs.promises.rename(tmp, entry.doc);
      } catch (err) {
        try {
          await fs.promises.rm(tmp, { force: true });
        } catch {
          /* the cleanup failing changes nothing about the error being reported */
        }
        throw new RedactFailure(
          entry.audio
            ? "Flow silenced the audio but could not rewrite the transcript. The passage is still in the text: try again."
            : "Flow could not rewrite the transcript, so nothing was changed.",
          `could not rewrite ${entry.doc}: ${err}`,
        );
      }

      // Never the removed text, never a time range: this log is read by
      // whoever debugs a bug report, and the entire point of the operation is
      // that those bytes stop existing. A count and a file are enough to
      // reconstruct that the operation ran.
      this.deps.log?.(
        `[redact] removed ${plan.ranges.length} passage run(s) from ${entry.doc}` +
          (entry.audio ? " and silenced the matching audio" : " (no audio kept)") +
          (plan.notesDropped ? "; the derived notes were dropped" : ""),
      );
      return { ok: true, notesDropped: plan.notesDropped, audioSilenced: entry.audio !== null };
    } catch (err) {
      this.deps.log?.(`[redact] ${id}: ${err}`);
      return { ok: false, error: err instanceof RedactFailure ? err.userMessage : FAILED };
    } finally {
      this.busy = false;
    }
  }
}

/** Local calendar date for the tombstone. Local, not UTC: the line is read by
 * the person who made the removal, on this machine. */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
