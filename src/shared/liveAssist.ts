// U8: live assistance during a recording - the pure half.
//
// What this feature is, in one sentence: while a meeting is being recorded and
// transcribed, a LOCAL language model reads the last few minutes of the
// transcript and proposes at most three short items - a note worth writing
// down, a question worth asking, a short answer to what was just asked.
//
// Everything in this module is pure and unit-tested directly (test/live-assist.
// test.ts): the priority gate, the bounded context window, the prompt, the
// parsing of the model's answer, and the ONE line format a kept suggestion
// takes in the recording's document. main/liveAssist.ts owns the timing, the
// HTTP call and the in-memory list; it holds no rule of its own.
//
// Four decisions govern the whole thing, and none of them is a preference:
//
//  1. OFF by default. A panel that reads other people's speech to propose
//     replies is the most intrusive thing this app can do; it is switched on by
//     hand, and the switch's wording states the cost before the benefit.
//  2. Nothing new is retained. Suggestions live in memory for the duration of
//     the recording. Only the ones the user explicitly KEEPS are written, and
//     then only into the recording's own document (never a sidecar file, so the
//     future connector reads one artifact and not two that can diverge).
//  3. The engine order is fixed: dictation first, the meeting's own
//     transcription second, suggestions last. decideAssist() is where that
//     order is enforced, and it is the reason this file exists separately from
//     the class that calls it.
//  4. A suggestion can never pass for speech. sanitizeSuggestionText()
//     collapses the model's output to ONE line and strips anything that could
//     read as a transcript stamp; suggestionLine() then writes it as a
//     blockquote that says "NOT spoken" before it says anything else.

import { hms } from "./longform";

// ---- budgets, all of them constant with respect to meeting length ----

/** Minimum wall time between two completed rounds. Deliberately slow: on this
 * panel, MOVEMENT is the real cost (it pulls the eye at the exact moment
 * attention belongs on the person talking), not the computation. */
export const ASSIST_MIN_INTERVAL_MS = 45_000;

/** How far back a round looks. A one-hour meeting must not grow the prompt, the
 * latency or the GPU cost of a round - so the window SLIDES and never widens. */
export const ASSIST_CONTEXT_MS = 240_000;

/** Hard ceiling on the excerpt handed to the model, independent of the window
 * above (four minutes of fast speech is bigger than four minutes of a pause). */
export const ASSIST_CONTEXT_MAX_CHARS = 3_000;

/** How much of the document's tail is read to build a round's context. Bigger
 * than the char cap on purpose: the tail also carries the non-speech lines that
 * get dropped. This read happens once per ROUND (>= 45 s apart), never on the
 * poll path. */
export const ASSIST_TAIL_BYTES = 24_576;

/** Newly transcribed segments required before another round runs. Segments are
 * ~7 s of speech (shared/longform.ts's SEGMENT_TARGET_MS), so this asks for
 * roughly a quarter minute of new material - and it is read from the recorder's
 * in-memory counter, which is why the poll path touches no disk at all. */
export const ASSIST_MIN_NEW_SEGMENTS = 2;

/** Items a single round may produce. Three is the most a person can glance at
 * without reading, which is the only glance this panel is allowed to ask for. */
export const ASSIST_MAX_ITEMS = 3;

/** Characters kept per item. Past this, an item stops being glanceable. */
export const ASSIST_MAX_ITEM_CHARS = 200;

/** Suggestions kept on screen. Older ones fall off the bottom; nothing about
 * them is ever written to disk. */
export const ASSIST_MAX_SUGGESTIONS = 6;

/** A round that has not answered by then is abandoned. A local model that slow
 * is contending for the GPU with the transcription, and the transcription wins. */
export const ASSIST_TIMEOUT_MS = 25_000;

/** How long a "is a local model available" probe answer is trusted. */
export const ASSIST_MODEL_PROBE_MS = 30_000;

// ---- what the panel is waiting for ----

/** Why no suggestion is being produced right now. Every value has a sentence in
 * ASSIST_WAIT_TEXT below, because "the panel is quiet" must never be a state the
 * user has to interpret. The ORDER of the union is the order decideAssist()
 * tests them, which is also the engine's priority order. */
export type AssistWait =
  | "off" // the setting is off (the default)
  | "checking" // still finding out whether a local model exists
  | "no-model" // no local model on this machine
  | "idle" // no recording is running
  | "finishing" // the recording is being finalized
  | "dictation" // a dictation (or the phone-mic endpoint) owns the speech engine
  | "transcribing" // the meeting's own transcription is behind
  | "engine" // an import or a model download owns the engine
  | "thinking" // a round is in flight
  | "cooldown" // the deliberate pause between rounds
  | "waiting-speech" // not enough new speech since the last round
  | "ready"; // about to run

/** One honest sentence per state, in ONE place: the page imports these rather
 * than inventing wording, so what the engine decided and what the user reads
 * cannot drift apart (the same discipline shared/micWarmth.ts follows for the
 * pre-warm policy). */
export const ASSIST_WAIT_TEXT: Record<AssistWait, string> = {
  off: "Live suggestions are off. When you turn them on, a local model reads the last few minutes of the transcript and proposes notes or replies.",
  checking: "Looking for a local model on this machine...",
  "no-model": "No local model found on this machine. Suggestions need Ollama running here, with a model installed - pick one in Settings > Local AI. Flow does not embed its own model yet, so this stays off until then.",
  idle: "Suggestions start once a recording is running.",
  finishing: "The recording is being finished. No new suggestions from here.",
  dictation: "Waiting: a dictation is using the speech engine. Dictation always goes first.",
  transcribing: "Waiting: the meeting's own transcription is catching up. It always goes before suggestions.",
  engine: "Waiting: the engine is busy with an audio import or a model download.",
  thinking: "Reading the last few minutes of the transcript...",
  cooldown: "Next look in a moment. Suggestions are deliberately slow - movement on this panel costs more attention than it looks like it does.",
  "waiting-speech": "Waiting for a bit more of the conversation to be transcribed.",
  ready: "",
};

// ---- shapes that cross IPC ----

/** One suggestion, as it lives in memory and travels to the page.
 *
 * The two offsets are not decoration: they are what stops this panel from
 * implying real time. The engine transcribes in ~7 s segments, so an item is
 * ALWAYS about speech that is some seconds old, and the page says which stretch
 * of the recording it was derived from rather than letting the user assume
 * "now". */
export interface AssistSuggestion {
  id: string;
  /** Already sanitized to one line (see sanitizeSuggestionText). */
  text: string;
  contextFromMs: number;
  contextUpToMs: number;
  createdIso: string;
  /** True once the user put it in the recording's document. */
  kept: boolean;
}

/** Everything the panel renders, in one coherent answer - the same "one
 * snapshot" rule as LongStateSnapshot. */
export interface AssistSnapshot {
  ok: boolean;
  /** The setting (~/.flow/settings.json's liveAssist). */
  enabled: boolean;
  /** null = not probed yet. Three states, never two: "no model" and "we have
   * not looked" are different sentences. */
  modelReady: boolean | null;
  /** The local model a round would actually use, "" when there is none. Shown
   * verbatim: the user is entitled to know WHICH model read their meeting. */
  model: string;
  /** A capture is running - the only state in which a suggestion can be kept. */
  recording: boolean;
  wait: AssistWait;
  suggestions: AssistSuggestion[];
  /** The stretch the last completed round looked at. Both 0 before the first. */
  contextFromMs: number;
  contextUpToMs: number;
  /** Rounds that answered "nothing worth suggesting". Displayed, because an
   * assistant that knows how to say nothing is the one worth trusting. */
  quietRounds: number;
  error: string;
}

/** What a refused sender (uiBridge's fromMain gate) or an unwired engine gets
 * back: off, no model, no suggestions. Shaped like every real answer so the page
 * never has to tell "refused" from "genuinely idle" - and the safe direction for
 * a switch that reads a meeting is the one where a malformed answer never claims
 * it is on. */
export const ASSIST_UNAVAILABLE: AssistSnapshot = {
  ok: false,
  enabled: false,
  modelReady: false,
  model: "",
  recording: false,
  wait: "off",
  suggestions: [],
  contextFromMs: 0,
  contextUpToMs: 0,
  quietRounds: 0,
  error: "unavailable",
};

// ---- the priority gate ----

export interface AssistGateInput {
  enabled: boolean;
  /** null = the local-model probe has not answered yet. */
  modelReady: boolean | null;
  recordingActive: boolean;
  finalizing: boolean;
  /** A dictation OR an utterance from the local HTTP endpoint is being decoded. */
  dictating: boolean;
  /** The meeting's own ASR queue is not empty. */
  transcribing: boolean;
  /** An audio import or a model download owns the engine. */
  otherEngineWork: boolean;
  /** A round is already in flight. */
  generating: boolean;
  msSinceLastRound: number;
  /** Segments transcribed since the last round's context was built. */
  newSegments: number;
}

export interface AssistGateVerdict {
  run: boolean;
  wait: AssistWait;
}

/**
 * The whole priority policy of this feature, in one pure function.
 *
 * "Dictation first, the meeting's transcription second, the assistance last"
 * (plan-design §15.3) is not a comment here, it is the ORDER of the tests
 * below, and every one of them is a separate test case. A missed suggestion
 * costs nothing; a meeting whose transcription falls behind is lost for good.
 *
 * It also answers the question the wave has to answer even when it refuses:
 * `wait` is always a state with a sentence, so the panel can say why it is
 * quiet instead of sitting there looking broken.
 */
export function decideAssist(i: AssistGateInput): AssistGateVerdict {
  if (!i.enabled) return { run: false, wait: "off" };
  if (i.modelReady === null) return { run: false, wait: "checking" };
  if (!i.modelReady) return { run: false, wait: "no-model" };
  // finalizing is tested before "idle": both have recordingActive false, and
  // "the recording is being finished" is the more informative of the two.
  if (i.finalizing) return { run: false, wait: "finishing" };
  if (!i.recordingActive) return { run: false, wait: "idle" };
  // The three engine claims, in the order they outrank each other.
  if (i.dictating) return { run: false, wait: "dictation" };
  if (i.transcribing) return { run: false, wait: "transcribing" };
  if (i.otherEngineWork) return { run: false, wait: "engine" };
  if (i.generating) return { run: false, wait: "thinking" };
  if (i.msSinceLastRound < ASSIST_MIN_INTERVAL_MS) return { run: false, wait: "cooldown" };
  if (i.newSegments < ASSIST_MIN_NEW_SEGMENTS) return { run: false, wait: "waiting-speech" };
  return { run: true, wait: "ready" };
}

/** True when a verdict means "give the machine back NOW" - the states that
 * outrank a round already in flight. main/liveAssist.ts aborts the in-flight
 * HTTP request on any of these rather than letting a local model hold the GPU
 * while whisper needs it. */
export function mustYield(wait: AssistWait): boolean {
  return wait === "dictation" || wait === "transcribing" || wait === "engine" || wait === "finishing";
}

// ---- reading the transcript back ----

/** One transcribed block of the recording's document. */
export interface SpeechBlock {
  offsetMs: number;
  text: string;
}

const STAMP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+([\s\S]*)$/;

/**
 * The transcribed speech in a chunk of the recording's document - and NOTHING
 * else.
 *
 * Only blocks opening with the recorder's own `[hh:mm:ss] ` stamp
 * (shared/longform.ts's transcriptLine) survive. Everything else is dropped on
 * purpose, and one of the drops is load-bearing: a KEPT suggestion is written
 * as a `> [...]` blockquote, so an assistant that read the whole document back
 * would feed itself its own output as if someone had said it. Marks, honest
 * gaps, dropped-segment notices and the front matter go the same way - none of
 * them is speech.
 *
 * `truncated` says the chunk starts mid-document (the tail read): the first
 * block is then incomplete - and, at a byte boundary, possibly not even valid
 * UTF-8 - so it is discarded rather than guessed at.
 */
export function speechBlocks(chunk: string, truncated = false): SpeechBlock[] {
  const parts = chunk.split(/\n\s*\n/);
  if (truncated && parts.length > 0) parts.shift();
  const out: SpeechBlock[] = [];
  for (const part of parts) {
    const m = STAMP_RE.exec(part.trim());
    if (!m) continue;
    const text = m[4].replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({
      offsetMs: ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000,
      text,
    });
  }
  return out;
}

export interface AssistContext {
  /** The excerpt handed to the model, oldest first. "" when there is none. */
  text: string;
  fromMs: number;
  upToMs: number;
  blocks: number;
}

/**
 * The sliding, doubly-bounded excerpt a round works on: the last
 * `windowMs` of speech, then trimmed from the FRONT to `maxChars`.
 *
 * Bounded twice because either bound alone leaks: a time window says nothing
 * about how much was said inside it, and a char cap alone would happily reach
 * back an hour through a quiet stretch. Together they make the prompt - and
 * therefore the latency and the GPU cost - the same size at minute 90 as at
 * minute 3, which is the property plan-design §15.2 asks for by name.
 */
export function slidingContext(
  blocks: SpeechBlock[],
  windowMs = ASSIST_CONTEXT_MS,
  maxChars = ASSIST_CONTEXT_MAX_CHARS,
): AssistContext {
  if (blocks.length === 0) return { text: "", fromMs: 0, upToMs: 0, blocks: 0 };
  const last = blocks[blocks.length - 1].offsetMs;
  const floor = Math.max(0, last - windowMs);
  let kept = blocks.filter((b) => b.offsetMs >= floor);
  // Trim from the front (oldest first) until the excerpt fits: the newest words
  // are the ones a suggestion has to be about.
  let size = kept.reduce((n, b) => n + b.text.length + 1, 0);
  while (kept.length > 1 && size > maxChars) {
    size -= kept[0].text.length + 1;
    kept = kept.slice(1);
  }
  let text = kept.map((b) => b.text).join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return {
    text,
    fromMs: kept[0].offsetMs,
    upToMs: kept[kept.length - 1].offsetMs,
    blocks: kept.length,
  };
}

// ---- the prompt ----

/** The single word the model is told to answer when an excerpt is not worth
 * suggesting anything about. Borrowed straight from the Granola review (docs/
 * analyse-granola: "the silence is a feature"): a tool that always produces
 * something becomes noise, one that knows how to say nothing becomes reliable. */
export const ASSIST_NOTHING = "NOTHING";

/** The prompt for one round. Bounded by construction: everything variable in it
 * is `context.text`, which slidingContext() already capped. */
export function assistPrompt(context: AssistContext): string {
  return [
    "You are helping someone who is IN a meeting right now. Below is the last few minutes of that meeting, transcribed on this machine.",
    "",
    `Answer with AT MOST ${ASSIST_MAX_ITEMS} items, ONE PER LINE, each starting with "- " and each shorter than 140 characters. Every item must be one of:`,
    "- a note worth writing down (a decision, a number, an owner, a deadline);",
    "- a question worth asking next;",
    "- a short answer to a question that was just asked.",
    "",
    "Rules: base every item ONLY on the excerpt below - never invent a name, a number, a date or a fact. Write in the SAME LANGUAGE as the excerpt. No preamble, no heading, no explanation, no quotes.",
    `If nothing in this excerpt is worth suggesting, answer with the single word ${ASSIST_NOTHING} and nothing else.`,
    "",
    "Excerpt:",
    context.text,
  ].join("\n");
}

// ---- reading the model's answer back ----

const LIST_MARKER_RE = /^\s*(?:[-*•+]|\d+[.)])\s+/;
const LEADING_STAMP_RE = /^\s*(?:>+\s*)?\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/;

/**
 * Reduce one model line to something that CANNOT be mistaken for speech, and
 * cannot forge document structure.
 *
 * This is the first of the two layers behind decision 4 (see the module note),
 * and it is not defensive programming for its own sake: the model's output is
 * free text, it may contain newlines, and a line like `[00:12:04] we agreed to
 * ship` pasted into a transcript would be indistinguishable from something a
 * person said. So: all whitespace collapses to single spaces (no newline
 * survives, so no second line can ever be forged), any leading blockquote
 * marker, list marker or timestamp stamp is peeled off - repeatedly, because
 * one strip can reveal another - and the result is capped.
 */
export function sanitizeSuggestionText(raw: string): string {
  let t = String(raw).replace(/\s+/g, " ").trim();
  for (let pass = 0; pass < 4; pass++) {
    const before = t;
    t = t.replace(/^\s*>+\s*/, "");
    t = t.replace(LIST_MARKER_RE, "");
    t = t.replace(LEADING_STAMP_RE, "");
    t = t.replace(/^["'`]+/, "").replace(/^#+\s*/, "");
    if (t === before) break;
  }
  t = t.replace(/["'`]+$/, "").trim();
  if (t.length > ASSIST_MAX_ITEM_CHARS) t = t.slice(0, ASSIST_MAX_ITEM_CHARS - 3).trimEnd() + "...";
  return t;
}

/**
 * The items of one round, from whatever the model actually wrote.
 *
 * Returns an EMPTY array both when the model said ASSIST_NOTHING and when its
 * answer contained nothing usable - the two are the same outcome for the page
 * ("this round had nothing to say"), and inventing a suggestion out of an
 * unparseable answer is exactly the noise this feature must not add.
 */
export function parseAssistItems(raw: string): string[] {
  const whole = String(raw).trim();
  if (!whole) return [];
  // The refusal, whether it came back bare, bulleted or with a period.
  if (new RegExp(`^[-*\\s]*${ASSIST_NOTHING}[.!\\s]*$`, "i").test(whole)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of whole.split(/\r?\n/)) {
    const t = sanitizeSuggestionText(line);
    if (!t) continue;
    if (t.toUpperCase() === ASSIST_NOTHING) continue;
    // A single-word answer is never a note, a question or a reply.
    if (!/\s/.test(t) && t.length < 12) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= ASSIST_MAX_ITEMS) break;
  }
  return out;
}

// ---- the ONE line a kept suggestion takes in the document ----

/**
 * How a suggestion the user KEPT is written into the recording's document.
 *
 * Deliberately the same blockquote family as markLine() and gapLine()
 * (shared/longform.ts): those are the document's existing idiom for "this line
 * is not something anyone said". The recorder's speech lines open with
 * `[hh:mm:ss] `; this one opens with `> [Flow suggestion`, and the words "NOT
 * spoken" come before the text itself - so the distinction survives a human
 * skim, a grep, a markdown render and the notes prompt that reads the document
 * back at finalize.
 *
 * It carries TWO times, and both matter: when the user kept it, and the point
 * of the conversation it was derived from. Those are never the same instant -
 * the model works on already-transcribed speech - and a document that showed
 * only one of them would quietly imply they were.
 *
 * It lives here rather than in shared/longform.ts on purpose: this is the U8
 * feature's own format, and main/longform.ts imports it the same way it imports
 * markLine.
 */
export function suggestionLine(offsetMs: number, contextUpToMs: number, text: string): string {
  const one = sanitizeSuggestionText(text).replace(/[[\]]/g, "");
  return (
    `> [Flow suggestion kept at ${hms(offsetMs)} - NOT spoken by anyone: written by the local model ` +
    `from what was said up to ${hms(contextUpToMs)}: ${one}]\n\n`
  );
}

/** True for a line suggestionLine() produced. Used by the tests that prove a
 * kept suggestion is never read back as speech, and by nothing else - the
 * document is never parsed for these at runtime. */
export function isSuggestionLine(line: string): boolean {
  return /^>\s*\[Flow suggestion kept at /.test(line.trim());
}
