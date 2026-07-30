import { listSnippets } from "./snippets";
import type { Snippet } from "../shared/ipcContracts";
import { matchSnippetCue } from "../shared/snippetCue";

// SNIPPET CUES on the dictation path. Say a snippet's cue out loud, and its
// stored block is inserted instead of the words you said.
//
// 2026-07-30: this file is what is LEFT of main/functions.ts after voice
// functions were removed from Flow at Roch's request. The two features shared
// one entry point on the dictation path, which made it easy to read them as
// one thing. They were not:
//
//  - A snippet cue is a LOOKUP. The text you get back is text you typed into
//    Flow yourself, so nothing can be invented and nothing leaves the machine.
//  - A voice function was a MODEL CALL. It sent the transcript somewhere to be
//    rewritten, and its whole difficulty was making sure ordinary dictation
//    could never be mistaken for a command - a problem that took two blocking
//    review findings and a failed human test before it was even close.
//
// Removing the second does not touch the first, and this file exists so that
// the difference is structural rather than a matter of reading carefully.

export interface CueOutcome {
  /** What to insert. On a miss this is the transcript, unchanged. */
  text: string;
  /** A rich snippet's HTML, when the matched block has one. */
  html?: string;
  /** Set only on a hit, for the log. Never contains the dictated words. */
  note?: string;
}

export interface CueDeps {
  /** Test seam. Production reads the snippet library. */
  snippets?: () => readonly Snippet[];
}

/**
 * The dictation path's one call. It cannot fail: on any error, and on any miss,
 * the transcript comes back untouched.
 *
 * That guarantee is the reason the try/catch swallows rather than reports. A
 * snippet library that will not load is a real problem, but it is not this
 * function's problem, and turning it into one would mean a dictation lost to a
 * file the user cannot see.
 */
export function applySnippetCue(text: string, deps: CueDeps = {}): CueOutcome {
  const snips = (() => {
    try {
      return deps.snippets ? deps.snippets() : listSnippets().items;
    } catch {
      return [];
    }
  })();
  const snip = matchSnippetCue(text, snips);
  if (!snip) return { text };
  return {
    text: snip.text,
    html: snip.format === "html" ? snip.html : undefined,
    // The COUNT, never the content - the same rule every log line in this app
    // follows about dictated text.
    note: `[snippet] cue matched, inserted a stored block (${snip.text.length} chars)`,
  };
}
