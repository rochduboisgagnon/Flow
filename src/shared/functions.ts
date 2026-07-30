// V5 E1/E2/E6: the voice-function engine's PURE half - what makes a dictated
// utterance a COMMAND instead of text, and what the model is asked to do with
// it. No disk, no Electron, no state: main/functions.ts owns the file, the
// caches and the model call; this module owns the rules. Same split as
// shared/dictionary.ts vs main/dictionary.ts, for the same reason - the parts
// worth arguing about are the parts that must be testable without an app.
//
// ===========================================================================
// THE ONE QUESTION THIS FILE ANSWERS: COMMAND, OR TEXT?
// ===========================================================================
// This is the whole risk of the wave, and it is asymmetric, so the design is
// asymmetric too:
//
//   A command that fails to fire is an INCONVENIENCE - the user's words land
//   at the cursor exactly as they always have, and he says it again.
//   Text transformed without being asked is a LOSS - what he actually said is
//   gone, replaced by a paraphrase from a model of unknown quality, and there
//   is nothing on disk to recover it from (Flow retains nothing, by design).
//
// So EVERY rule below is a reason to REFUSE, and detectCommand returns null on
// the slightest doubt. Five gates, all of which must pass:
//
//  1. HEAD-ANCHORED. The trigger must start at the utterance's FIRST token.
//     This alone closes the case the wave was warned about: dictating "...and
//     if you could translate this into English before Friday" mid-paragraph
//     matches nothing, because the trigger is not at token 0. There is no
//     indexOf over the text anywhere in this file.
//  2. WHOLE TOKENS. Matching runs on tokens (maximal [a-z0-9] runs after NFD +
//     diacritic strip + lowercase - the SAME normalization shared/textGate.ts
//     and shared/dictionary.ts use, so all three agree on what a word is). A
//     trigger can never match inside a longer word.
//  3. SEPARATION. A trigger phrase that flows straight into the rest of a
//     sentence was part of that sentence, not an order given to a tool. So the
//     trigger must be followed either by a real separator (":", ",", ".", ...,
//     a newline) or be SELF-DELIMITING - it ends on a captured parameter
//     ("traduis ceci en anglais") or on a deictic ("resume ceci", "fix this").
//     "Ecris un courriel pour Marc au sujet du contrat" therefore does NOT
//     fire; "Ecris un courriel : Marc, le contrat est signe" does.
//  4. A PAYLOAD THAT IS CONTENT. At least MIN_PAYLOAD_WORDS words and
//     MIN_PAYLOAD_CHARS characters after the trigger, and the first word must
//     not be a CONTINUATION word ("et", "puis", "and", "please", "s'il te
//     plait"...). "Traduis ca en anglais, s'il te plait." is a sentence
//     someone dictates INTO a message; it is not a command, and both the
//     continuation list and the length floor catch it.
//  5. OPT-IN. A function only participates when the user enabled it, and the
//     seven shipped ones (defaultFunctions) ship OFF. See the note there.
//
// What is deliberately NOT part of the decision: asking a model "was this a
// command?". That would add a model round trip to every single dictation
// (latency the wave's own rule 1 forbids), and it would answer the ambiguous
// cases with a guess - in a place where a guess costs the user his words.
//
// ===========================================================================
// COST: THIS RUNS ONCE PER UTTERANCE, ON THE PROCESS CARRYING THE KEY HOOK
// ===========================================================================
// tokenize() is one pass over the transcript. Matching walks the ENABLED
// triggers only, and each one stops at its first mismatched token - which for
// an utterance that is not a command is almost always token 0. A user with
// zero enabled functions pays a length check and nothing else: detectCommand
// returns null before tokenizing. Same requirement as applyDictionary, and for
// the same reason.

// ---------------------------------------------------------------------------
// The data model (E2)
// ---------------------------------------------------------------------------

/** The placeholder a trigger uses to capture its one parameter: the target
 * language. Written in the trigger itself ("traduis ceci en {lang}") so a
 * user-created function declares its parameter by using it, with no second
 * field to keep in sync. */
export const PARAM_PLACEHOLDER = "{lang}";

/** One transformation, as it lives in ~/.flow/functions.json and travels over
 * IPC. `model` is "" for "whatever the engine's function model is" - resolved
 * in main, never here. */
export interface VoiceFunction {
  id: string;
  name: string;
  enabled: boolean;
  /** Spoken forms that start a command. Fully editable, including on the
   * shipped seven: a trigger is a phrase in the user's own mouth. */
  triggers: string[];
  /** What the model is told to do. May contain PARAM_PLACEHOLDER, which is
   * substituted with the captured language. */
  instruction: string;
  /** "" = the engine's configured function model. */
  model: string;
  createdIso: string;
}

/** What the save channel accepts. An absent/empty id creates. */
export interface VoiceFunctionInput {
  id?: string;
  name: string;
  enabled: boolean;
  triggers: string[];
  instruction: string;
  model: string;
}

/** Every function channel answers with the WHOLE library, so a page can never
 * hold a stale list after a write it did not itself make (same contract as
 * SnippetsResult and DictResult). */
export interface VoiceFunctionsResult {
  ok: boolean;
  items: VoiceFunction[];
  error?: string; // human-readable, shown as-is by the page
}

// ---------------------------------------------------------------------------
// Bounds (documented, not guessed) - same discipline as main/snippets.ts
// ---------------------------------------------------------------------------
/** A trigger is a spoken phrase, not a paragraph. */
export const MAX_TRIGGER_CHARS = 120;
/** How many triggers one function may carry. Bilingual plus a few personal
 * phrasings is already generous, and every trigger is walked once per
 * utterance on the process that carries the keyboard hook. */
export const MAX_TRIGGERS = 12;
/** Words in one trigger. Bounds the per-trigger walk; nothing anybody says as
 * an order to a tool is ten words long. */
export const MAX_TRIGGER_WORDS = 10;
export const MAX_NAME_CHARS = 60;
/** An instruction is a prompt fragment, not a manual. */
export const MAX_INSTRUCTION_CHARS = 2_000;
export const MAX_MODEL_CHARS = 100;
export const MAX_FUNCTIONS = 100;
export const MAX_ID_CHARS = 100;
/** How many losses a read-only message names before it just counts the rest. */
export const MAX_REPORTED_LOSSES = 5;

/** Gate 4's floor, in words and characters. Below either, the utterance is
 * inserted as text. Three words because a two-word tail after a trigger is far
 * more often the end of a sentence than a thing worth transforming, and
 * because transforming two words is pointless even when it IS a command. */
export const MIN_PAYLOAD_WORDS = 3;
export const MIN_PAYLOAD_CHARS = 12;
/** Above this, the utterance is inserted as text rather than sent to a model:
 * ~1300 words is far past any dictation, and an unbounded payload is an
 * unbounded prompt. Refusing lands the user's own words, which is always the
 * safe direction. */
export const MAX_PAYLOAD_CHARS = 8_000;
/** A model that answers with more than this has run away (loops are the
 * classic small-model failure). Refusing means the raw text lands. */
export const MAX_OUTPUT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Tokenizing WITH offsets into the original string
// ---------------------------------------------------------------------------

export interface Token {
  /** normalized: lowercase, no diacritics, [a-z0-9] only */
  n: string;
  /** index in the ORIGINAL string where this token starts */
  start: number;
  /** index in the ORIGINAL string just past this token */
  end: number;
}

/** One normalized character, or "" when the character is not a word character.
 * Kept as a per-character function on purpose: NFD decomposition CHANGES THE
 * LENGTH of a string, so normalizing the whole transcript first and then
 * indexing into it would misalign every offset - and the offsets are what let
 * the payload keep the user's own casing and punctuation. */
function normChar(ch: string): string {
  const n = ch
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return /^[a-z0-9]+$/.test(n) ? n : "";
}

/** Cut `text` into maximal word tokens, each carrying its offsets in `text`. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let start = 0;
  // Iterated by code point (for..of) so an astral character counts as one
  // separator instead of two halves of a surrogate pair.
  let at = 0;
  for (const ch of text) {
    const n = normChar(ch);
    if (n) {
      if (cur === "") start = at;
      cur += n;
    } else if (cur !== "") {
      out.push({ n: cur, start, end: at });
      cur = "";
    }
    at += ch.length;
  }
  if (cur !== "") out.push({ n: cur, start, end: at });
  return out;
}

// ---------------------------------------------------------------------------
// Gate 3: separation
// ---------------------------------------------------------------------------

/** Characters that mean "the order stopped here and the content starts". A
 * spoken pause is what produces them - whisper punctuates a real break, which
 * is precisely the acoustic event that distinguishes an order from a clause. */
const SEPARATORS = new Set([":", ",", ".", ";", "!", "?", "-", "–", "—", "\n", "\r", "…"]);

/** Trigger endings that are self-delimiting: the phrase POINTS at what follows,
 * so it cannot be read as the start of an ordinary sentence. Kept short and
 * literal - this is the one list that LOOSENS a gate, so it earns no guesses. */
const DEICTIC_ENDINGS = new Set(["ceci", "cela", "ca", "this", "that", "it", "suivant", "following"]);

/** Words that mean the trigger phrase was part of a longer sentence rather
 * than an order: a payload starting with one of these is text.
 * "Traduis ca en anglais, s'il te plait." -> payload "s il te plait" -> "s"
 * is not here, but the length floor catches it; "Traduis ca en anglais et
 * envoie-le a Marc" -> payload starts with "et" -> refused here. */
const CONTINUATION_WORDS = new Set([
  // French
  "et", "puis", "ensuite", "aussi", "mais", "donc", "car", "pour", "afin",
  "avant", "apres", "quand", "si", "svp", "stp", "merci",
  // English
  "and", "then", "also", "but", "so", "because", "before", "after", "when",
  "if", "please", "thanks", "thank",
]);

// ---------------------------------------------------------------------------
// The language table (the one captured parameter)
// ---------------------------------------------------------------------------
/** Spoken language names -> the name handed to the model, in English (a local
 * model follows an English target name far more reliably than a French one).
 *
 * A trigger whose {lang} slot matches NOTHING here does not fire at all. That
 * is deliberate: the alternative is asking a model to "translate into
 * <whatever whisper heard>", which on a mis-transcription produces confident
 * nonsense in place of the user's words. An unknown target means his own
 * sentence lands instead - gate discipline, again. */
const LANGUAGES: ReadonlyMap<string, string> = new Map([
  ["anglais", "English"], ["english", "English"],
  ["francais", "French"], ["french", "French"],
  ["espagnol", "Spanish"], ["spanish", "Spanish"],
  ["allemand", "German"], ["german", "German"],
  ["italien", "Italian"], ["italian", "Italian"],
  ["portugais", "Portuguese"], ["portuguese", "Portuguese"],
  ["neerlandais", "Dutch"], ["dutch", "Dutch"],
  ["japonais", "Japanese"], ["japanese", "Japanese"],
  ["chinois", "Chinese"], ["chinese", "Chinese"], ["mandarin", "Mandarin Chinese"],
  ["coreen", "Korean"], ["korean", "Korean"],
  ["russe", "Russian"], ["russian", "Russian"],
  ["arabe", "Arabic"], ["arabic", "Arabic"],
  ["hindi", "Hindi"],
  ["polonais", "Polish"], ["polish", "Polish"],
  ["suedois", "Swedish"], ["swedish", "Swedish"],
  ["norvegien", "Norwegian"], ["norwegian", "Norwegian"],
  ["danois", "Danish"], ["danish", "Danish"],
  ["finnois", "Finnish"], ["finnish", "Finnish"],
  ["grec", "Greek"], ["greek", "Greek"],
  ["turc", "Turkish"], ["turkish", "Turkish"],
  ["hebreu", "Hebrew"], ["hebrew", "Hebrew"],
  ["vietnamien", "Vietnamese"], ["vietnamese", "Vietnamese"],
  ["thai", "Thai"],
  ["indonesien", "Indonesian"], ["indonesian", "Indonesian"],
  ["ukrainien", "Ukrainian"], ["ukrainian", "Ukrainian"],
  ["roumain", "Romanian"], ["romanian", "Romanian"],
  ["tcheque", "Czech"], ["czech", "Czech"],
  ["hongrois", "Hungarian"], ["hungarian", "Hungarian"],
  ["catalan", "Catalan"],
  ["latin", "Latin"],
  // Two-token forms, matched before their one-token prefixes by the
  // longest-first probe in matchParam().
  ["chinois simplifie", "Simplified Chinese"], ["simplified chinese", "Simplified Chinese"],
  ["chinois traditionnel", "Traditional Chinese"], ["traditional chinese", "Traditional Chinese"],
  ["portugais bresilien", "Brazilian Portuguese"], ["brazilian portuguese", "Brazilian Portuguese"],
  ["anglais britannique", "British English"], ["british english", "British English"],
  ["anglais americain", "American English"], ["american english", "American English"],
]);

/** The language names a page can show, deduplicated and sorted. Exported so
 * the Functions page never hand-writes a list that could drift from the one the
 * engine actually accepts. */
export function knownLanguageTargets(): string[] {
  return [...new Set(LANGUAGES.values())].sort((a, b) => a.localeCompare(b));
}

/** How many tokens a {lang} slot may consume. */
const MAX_PARAM_TOKENS = 2;

// ---------------------------------------------------------------------------
// Compiling a trigger
// ---------------------------------------------------------------------------

/** A trigger as the matcher walks it: words before the parameter, words after
 * it, and whether it has one at all. `hasParam` is DERIVED from the presence of
 * PARAM_PLACEHOLDER - there is no second field to contradict it. */
export interface CompiledTrigger {
  /** the trigger exactly as the user wrote it, for display and for reporting */
  raw: string;
  before: string[];
  hasParam: boolean;
  after: string[];
  /** Gate 3: the trigger ends on its parameter or on a deictic, so a plain
   * space after it is enough. */
  selfDelimiting: boolean;
  /** Tokens the trigger contributes itself, parameter excluded. Used to prefer
   * the LONGEST match when two triggers both fit. */
  words: number;
}

export function compileTrigger(raw: string): CompiledTrigger | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf(PARAM_PLACEHOLDER);
  const hasParam = at >= 0;
  const beforeSrc = hasParam ? trimmed.slice(0, at) : trimmed;
  const afterSrc = hasParam ? trimmed.slice(at + PARAM_PLACEHOLDER.length) : "";
  const before = tokenize(beforeSrc).map((t) => t.n);
  const after = tokenize(afterSrc).map((t) => t.n);
  if (before.length === 0 && after.length === 0) return null; // a trigger of nothing but a placeholder
  if (before.length + after.length > MAX_TRIGGER_WORDS) return null;
  const lastWord = after.length > 0 ? after[after.length - 1] : before[before.length - 1];
  // Ends on the parameter (nothing after it), or on a deictic word.
  const selfDelimiting = (hasParam && after.length === 0) || DEICTIC_ENDINGS.has(lastWord);
  return { raw: trimmed, before, hasParam, after, selfDelimiting, words: before.length + after.length };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** A recognized command. `payload` keeps the user's ORIGINAL casing,
 * punctuation and accents - only the trigger is removed (E1's rule 2: the
 * trigger never appears in the result). */
export interface CommandMatch {
  functionId: string;
  functionName: string;
  /** The trigger form that fired, as written in the library. */
  trigger: string;
  /** The captured language, already in the form handed to the model; "" when
   * the trigger takes no parameter. */
  param: string;
  payload: string;
}

/** Why an utterance was NOT taken as a command. Only ever used to explain a
 * DRY RUN on the Functions page - the dictation path needs no reason, it just
 * inserts the text. Closed vocabulary so the page cannot invent a sentence the
 * engine does not actually implement. */
export type NoMatchReason =
  | "no-enabled-functions"
  | "no-trigger-at-head"
  | "not-separated"
  | "payload-too-short"
  | "payload-continues-the-sentence"
  | "payload-too-long";

export interface DetectResult {
  match: CommandMatch | null;
  reason?: NoMatchReason;
}

/** Try to consume a {lang} slot at `i`, longest form first. */
function matchParam(tokens: readonly Token[], i: number): { name: string; next: number } | null {
  for (let take = Math.min(MAX_PARAM_TOKENS, tokens.length - i); take >= 1; take--) {
    const phrase = tokens
      .slice(i, i + take)
      .map((t) => t.n)
      .join(" ");
    const name = LANGUAGES.get(phrase);
    if (name !== undefined) return { name, next: i + take };
  }
  return null;
}

interface TriggerHit {
  param: string;
  /** index of the first token AFTER the trigger */
  next: number;
  /** offset in the original text just past the trigger's last token */
  end: number;
}

/** Walk one compiled trigger against the head of `tokens`. */
function matchTriggerAtHead(t: CompiledTrigger, tokens: readonly Token[]): TriggerHit | null {
  let i = 0;
  for (const w of t.before) {
    if (i >= tokens.length || tokens[i].n !== w) return null;
    i++;
  }
  let param = "";
  if (t.hasParam) {
    const p = matchParam(tokens, i);
    if (!p) return null;
    param = p.name;
    i = p.next;
  }
  for (const w of t.after) {
    if (i >= tokens.length || tokens[i].n !== w) return null;
    i++;
  }
  if (i === 0) return null;
  return { param, next: i, end: tokens[i - 1].end };
}

/** One enabled function, with its triggers already compiled. Built once per
 * library change in main/functions.ts, never per utterance. */
export interface CompiledFunction {
  id: string;
  name: string;
  triggers: CompiledTrigger[];
}

export function compileFunctions(items: readonly VoiceFunction[]): CompiledFunction[] {
  const out: CompiledFunction[] = [];
  for (const fn of items) {
    if (!fn.enabled) continue; // E2: a disabled function is INERT - it is not even compiled
    const triggers = fn.triggers.map(compileTrigger).filter((t): t is CompiledTrigger => t !== null);
    if (triggers.length === 0) continue; // nothing to listen for
    out.push({ id: fn.id, name: fn.name, triggers });
  }
  return out;
}

/**
 * THE decision (see the module note): is this utterance a command?
 *
 * Returns `{match: null}` on the slightest doubt, with a reason a dry run can
 * show. The five gates are applied in the order that lets the cheapest refusal
 * happen first.
 */
export function detectCommand(text: string, functions: readonly CompiledFunction[]): DetectResult {
  if (functions.length === 0) return { match: null, reason: "no-enabled-functions" };
  const tokens = tokenize(text);
  if (tokens.length === 0) return { match: null, reason: "no-trigger-at-head" };

  // Gates 1 and 2, over every enabled trigger: keep the LONGEST match, so
  // "traduis ceci en {lang}" wins over a user's shorter "traduis {lang}", and
  // a specific phrase is never shadowed by a generic one.
  let best: { fn: CompiledFunction; trig: CompiledTrigger; hit: TriggerHit } | null = null;
  for (const fn of functions) {
    for (const trig of fn.triggers) {
      const hit = matchTriggerAtHead(trig, tokens);
      if (!hit) continue;
      if (best === null || hit.next > best.hit.next || (hit.next === best.hit.next && trig.words > best.trig.words)) {
        best = { fn, trig, hit };
      }
    }
  }
  if (best === null) return { match: null, reason: "no-trigger-at-head" };

  // Gate 4a: a trigger with nothing after it is not a command, it is someone
  // dictating that phrase. Checked before the separator gate because it is the
  // more fundamental refusal.
  if (best.hit.next >= tokens.length) return { match: null, reason: "payload-too-short" };

  // Gate 3: separation.
  const gap = text.slice(best.hit.end, tokens[best.hit.next].start);
  if (!best.trig.selfDelimiting && ![...gap].some((c) => SEPARATORS.has(c))) {
    return { match: null, reason: "not-separated" };
  }

  // Gate 4b: a payload that is content.
  const payloadTokens = tokens.length - best.hit.next;
  const payload = text.slice(tokens[best.hit.next].start).trim();
  if (payloadTokens < MIN_PAYLOAD_WORDS || payload.length < MIN_PAYLOAD_CHARS) {
    return { match: null, reason: "payload-too-short" };
  }
  if (CONTINUATION_WORDS.has(tokens[best.hit.next].n)) {
    return { match: null, reason: "payload-continues-the-sentence" };
  }
  if (payload.length > MAX_PAYLOAD_CHARS) return { match: null, reason: "payload-too-long" };

  return {
    match: {
      functionId: best.fn.id,
      functionName: best.fn.name,
      trigger: best.trig.raw,
      param: best.hit.param,
      payload,
    },
  };
}

/** The human sentence for a refusal. Kept HERE, beside the reasons, so the
 * page cannot describe a gate the engine does not implement. */
export function explainNoMatch(reason: NoMatchReason): string {
  switch (reason) {
    case "no-enabled-functions":
      return "No function is enabled, so this text would be inserted exactly as dictated.";
    case "no-trigger-at-head":
      return "No enabled trigger starts this text. A trigger only counts at the very beginning of an utterance, never inside a sentence.";
    case "not-separated":
      return "The trigger runs straight into the rest of the sentence, so it reads as dictation. Separate them with a pause (a colon, a comma or a full stop) - or use a trigger that ends on its target, like \"translate this into English\".";
    case "payload-too-short":
      return `There is nothing substantial after the trigger (at least ${MIN_PAYLOAD_WORDS} words and ${MIN_PAYLOAD_CHARS} characters are required), so this reads as dictation.`;
    case "payload-continues-the-sentence":
      return "What follows the trigger starts with a linking word, so the trigger was part of a longer sentence rather than an order.";
    case "payload-too-long":
      return `This is over the ${MAX_PAYLOAD_CHARS}-character limit for a transformation, so it would be inserted as dictated.`;
  }
}

// ---------------------------------------------------------------------------
// E6: the same engine, for snippets
// ---------------------------------------------------------------------------

/** What a snippet cue must satisfy to fire, and it is the strictest rule in
 * this file: the WHOLE utterance must be the cue, nothing before, nothing
 * after. A snippet is not "command + payload" - it IS the utterance - so
 * there is no ambiguity left to resolve: saying "insere ma signature" fires,
 * and saying "insere ma signature en bas du courriel" does not (it is a
 * sentence about the signature, and it lands as text).
 *
 * Cost: the comparison is on the normalized token join, so trailing
 * punctuation, capitalization and accents from the transcript never matter.
 */
export function matchSnippetCue<T extends { cue: string; enabled: boolean }>(
  text: string,
  snippets: readonly T[],
): T | null {
  const spoken = tokenize(text)
    .map((t) => t.n)
    .join(" ");
  if (!spoken) return null;
  for (const s of snippets) {
    if (!s.enabled) continue;
    const cue = tokenize(s.cue)
      .map((t) => t.n)
      .join(" ");
    if (cue && cue === spoken) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// E3: the prompt, and what comes back
// ---------------------------------------------------------------------------

/** Rules appended to EVERY function prompt. They exist because a small local
 * model's default behaviour is to chat: it explains what it is about to do,
 * wraps the answer in quotes, or asks a follow-up question. Any of those
 * landing at the cursor is a worse outcome than the raw transcript, so the
 * prompt states the contract and cleanModelOutput enforces what it can. */
const OUTPUT_RULES = [
  "Rules you must follow:",
  "- Output ONLY the resulting text. No preamble, no explanation, no commentary, no quotes around it, no markdown fences.",
  "- Never invent facts, names, numbers or dates that are not in the input.",
  "- Keep the input's own language unless the instruction above tells you to change it.",
  "- If the input is already in the requested form, return it unchanged.",
].join("\n");

/** Build the prompt for one command. The payload is delimited by a marker
 * rather than quoted, so text containing quotes cannot end the block early. */
export function buildFunctionPrompt(instruction: string, param: string, payload: string): string {
  const filled = param ? instruction.split(PARAM_PLACEHOLDER).join(param) : instruction;
  return [
    filled.trim(),
    "",
    OUTPUT_RULES,
    "",
    "### INPUT",
    payload,
    "### END INPUT",
    "",
    "Now output the result, and nothing else.",
  ].join("\n");
}

/** What a model actually returned, made safe to insert - or null, which means
 * "insert the raw transcript instead".
 *
 * Deliberately CONSERVATIVE. It strips only what is unambiguously packaging
 * (a fenced code block wrapping the whole answer, one matching pair of quotes
 * around the whole answer) and refuses anything empty or past
 * MAX_OUTPUT_CHARS. It does NOT try to detect and remove chatter like "Sure,
 * here is the translation:" - a heuristic aggressive enough to catch that is
 * aggressive enough to eat a legitimate first line, and the failure would be
 * invisible. A model that chats gets its whole answer refused by nothing here;
 * that is a quality problem for E9 to measure, not a place to guess. */
export function cleanModelOutput(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  // A whole-answer code fence: ```lang\n...\n```
  const fence = /^```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  // One matching pair of quotes around the WHOLE answer, and only when there
  // is no other quote of the same kind inside (otherwise the answer legitimately
  // contains quoted speech and the outer pair is part of it).
  for (const [open, close] of [['"', '"'], ["'", "'"], ["“", "”"], ["«", "»"]]) {
    if (t.length > 1 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length);
      if (!inner.includes(open) && !inner.includes(close)) {
        t = inner.trim();
        break;
      }
    }
  }
  if (!t) return null;
  if (t.length > MAX_OUTPUT_CHARS) return null;
  return t;
}

// ---------------------------------------------------------------------------
// E2: the shipped library
// ---------------------------------------------------------------------------

/** The seven functions of plan §6.3.
 *
 * THEY SHIP DISABLED, and that is a decision rather than an oversight. The
 * plan's own rule (§6.1) is "never a silent transformation", and the wave's
 * governing instruction is that doubt must always resolve toward inserting the
 * text. A shipped-on library would mean that on the very first launch, a
 * sentence that happens to open with "resume ceci :" is paraphrased by
 * whichever model Ollama happens to have installed - a model this project has
 * NOT yet measured for the job (that is task E9, still open). The cost of
 * shipping off is one click per function, on a page whose entire purpose is to
 * make that click; the cost of shipping on is the one outcome the wave is not
 * allowed to produce.
 *
 * The instructions are in English because a local model follows an English
 * instruction more reliably than a French one; the TRIGGERS are bilingual, and
 * every field is editable afterwards.
 */
export function defaultFunctions(mintId: () => string, createdIso: string): VoiceFunction[] {
  const make = (name: string, triggers: string[], instruction: string): VoiceFunction => ({
    id: mintId(),
    name,
    enabled: false,
    triggers,
    instruction,
    model: "",
    createdIso,
  });
  return [
    make(
      "Translate",
      [`traduis ceci en ${PARAM_PLACEHOLDER}`, `traduis ca en ${PARAM_PLACEHOLDER}`, `translate this into ${PARAM_PLACEHOLDER}`, `translate this to ${PARAM_PLACEHOLDER}`],
      `Translate the input into ${PARAM_PLACEHOLDER}. Keep the register, the tone and the formatting of the original. Translate everything, including proper nouns' surrounding grammar, but never translate a person's name or a product name.`,
    ),
    make(
      "Write an email",
      ["ecris un courriel", "ecris un email", "write an email", "draft an email"],
      "Turn the input into a finished email: a Subject line, a greeting, a body in short paragraphs, and a sign-off. Use only what the input says - if the recipient's name, a date or a number is not stated, leave it out rather than inventing or bracketing a placeholder.",
    ),
    make(
      "Short reply",
      ["reponds court", "reponse courte", "short reply", "reply briefly"],
      "Turn the input into a brief chat-style reply: at most three sentences, no greeting, no sign-off, plain and direct.",
    ),
    make(
      "Summarize",
      ["resume ceci", "resume ca", "summarize this", "summarise this"],
      "Summarize the input in at most five lines. Keep every figure, name and date that appears in it; add nothing.",
    ),
    make(
      "Bullet list",
      ["fais-en une liste", "mets ca en liste", "make this a list", "turn this into a list"],
      "Restructure the input as a bullet list, one idea per bullet, using \"- \" as the marker. Keep the wording close to the original and do not add items.",
    ),
    make(
      "Fix only",
      ["corrige ceci", "corrige ca", "fix this", "clean this up"],
      "Correct spelling, accents, agreement and punctuation ONLY. Do not rephrase, do not reorder, do not change the register, do not shorten and do not lengthen. If a sentence is already correct, return it byte for byte.",
    ),
    make(
      "Turn into actions",
      ["transforme en taches", "transforme ca en taches", "turn this into actions", "turn this into tasks"],
      "Turn the input into a list of action items, one per line, as \"- [ ] action\". When the input names an owner or a deadline for an action, append it as \" (owner: X)\" or \" (due: Y)\". Never invent an owner or a deadline that was not said.",
    ),
  ];
}
