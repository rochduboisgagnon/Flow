import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./settings";
import { generateShort } from "./llm/ollama";
import {
  buildFunctionPrompt,
  cleanModelOutput,
  compileFunctions,
  compileTrigger,
  defaultFunctions,
  detectCommand,
  matchSnippetCue,
  MAX_FUNCTIONS,
  MAX_ID_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_MODEL_CHARS,
  MAX_NAME_CHARS,
  MAX_REPORTED_LOSSES,
  MAX_TRIGGER_CHARS,
  MAX_TRIGGERS,
  type CommandMatch,
  type CompiledFunction,
  type VoiceFunction,
  type VoiceFunctionsResult,
} from "../shared/functions";
import { listSnippets } from "./snippets";
import type { Snippet } from "../shared/ipcContracts";

// V5 E2/E3: the voice-function library's FILE and the model call. The rules
// live in shared/functions.ts (pure, testable without an app); this module owns
// ~/.flow/functions.json, the runtime cache the dictation path reads, and the
// one place a transcript is ever handed to a language model.
//
// ---------------------------------------------------------------------------
// WHY A SEPARATE FILE, AGAIN
// ---------------------------------------------------------------------------
// Same reasoning as main/snippets.ts and main/dictionary.ts, and it has held
// twice: settings.json is rewritten WHOLESALE on every applySettings() call and
// its sanitizer falls back to full defaults on a corrupt byte, which is right
// for a dozen scalars and wrong for hand-written content. A function's
// instruction is a paragraph the user tuned; it does not have a default worth
// falling back to. So: its own file, a version guard, and a store that goes
// READ-ONLY rather than overwrite a file it did not fully understand.
//
// ---------------------------------------------------------------------------
// WHERE THE PROCESSING ACTUALLY HAPPENS, STATED PLAINLY
// ---------------------------------------------------------------------------
// On **Ollama, over loopback** (127.0.0.1:11434), and nowhere else. That is
// local in the sense that matters - nothing leaves the machine - but it is NOT
// the embedded model the plan calls D6, which is NOT BUILT. So:
//   - Ollama absent or stopped  -> functions are inert, the raw transcript is
//     inserted, and the Functions page says Ollama is what is missing.
//   - No model installed        -> same.
// Nothing in this module or in the page may describe the processing as
// "embedded" or "built in" while this is the implementation. The page reads the
// same availability answer the engine does (UI_OLLAMA_MODELS), so the sentence
// it shows and the behaviour it describes cannot drift.
//
// ---------------------------------------------------------------------------
// THE FALLBACK IS THE FEATURE (E3, non-negotiable)
// ---------------------------------------------------------------------------
// runCommand() returns null for EVERY failure - Ollama down, model missing,
// timeout, an empty answer, a runaway answer, an exception. The caller then
// inserts the raw transcript. A failed transformation must never cost the user
// what he just said, because there is nowhere to recover it from: Flow retains
// no dictation, by design.

export const CURRENT_VERSION = 1 as const;

/** How long a transformation may take before the raw text is inserted instead.
 *
 * 20 s is a deliberate compromise, argued: a 7B-class model on this machine
 * answers a two-paragraph rewrite in a few seconds, and the user is staring at
 * a cursor that has not moved the whole time. Longer would turn a slow model
 * into what looks like a hang; much shorter would make "write an email" fail on
 * a cold model (Ollama pays a load cost on the first call after an idle
 * period). It is a ceiling on WAITING, not a promise of speed. */
export const FUNCTION_TIMEOUT_MS = 20_000;

/** Context window asked of Ollama. A dictation payload is bounded at
 * MAX_PAYLOAD_CHARS (~2k tokens) and the answer can be longer than the input
 * (an email out of three sentences), so 8192 covers both ends with room. */
const FUNCTION_NUM_CTX = 8192;

/** Hard cap on tokens produced. Bounds the worst case a small model has: the
 * repetition loop, where it writes the same clause until something stops it.
 * ~1200 tokens is several paragraphs - far past any of the shipped seven - and
 * cleanModelOutput's MAX_OUTPUT_CHARS is the second net behind it. */
const FUNCTION_NUM_PREDICT = 1_200;

export interface FunctionsFile {
  version: typeof CURRENT_VERSION;
  items: VoiceFunction[];
}

export interface ParsedFunctions {
  file: FunctionsFile;
  /** Set when the input could not be trusted, at the FILE level (wrong shape or
   * version - `items` is then empty) or at the ITEM level (an entry dropped, a
   * field truncated). Either way it is the single predicate the overwrite guard
   * reads: we never write over a file we did not fully understand. */
  error?: string;
  /** True only for "there is no functions.json at all" - the seeding trigger.
   * Never true for a file holding `items: []`: a user who deleted every
   * function must not have the shipped seven handed back at the next launch. */
  missing?: boolean;
}

function readStoredFunction(raw: unknown, at: number): { fn?: VoiceFunction; losses: string[] } {
  const where = `entry #${at + 1}`;
  if (typeof raw !== "object" || raw === null) return { losses: [`${where} is not an object`] };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) return { losses: [`${where} has no usable id`] };
  const id = r.id.trim();
  if (typeof r.name !== "string") return { losses: [`${where} (id ${id}) has no name string`] };
  if (typeof r.instruction !== "string") return { losses: [`${where} (id ${id}) has no instruction string`] };
  if (!Array.isArray(r.triggers)) return { losses: [`${where} (id ${id}) has no triggers array`] };

  const losses: string[] = [];
  if (id.length > MAX_ID_CHARS) losses.push(`${where} has an id over ${MAX_ID_CHARS} chars`);
  if (r.name.length > MAX_NAME_CHARS) losses.push(`${where} (id ${id}) has a name over ${MAX_NAME_CHARS} chars`);
  if (r.instruction.length > MAX_INSTRUCTION_CHARS) {
    losses.push(`${where} (id ${id}) has an instruction over ${MAX_INSTRUCTION_CHARS} chars`);
  }
  if (r.triggers.length > MAX_TRIGGERS) {
    losses.push(`${where} (id ${id}) has ${r.triggers.length} triggers, over the ${MAX_TRIGGERS} cap`);
  }
  const triggers: string[] = [];
  for (const t of r.triggers.slice(0, MAX_TRIGGERS)) {
    if (typeof t !== "string") {
      losses.push(`${where} (id ${id}) has a trigger that is not a string`);
      continue;
    }
    if (t.length > MAX_TRIGGER_CHARS) losses.push(`${where} (id ${id}) has a trigger over ${MAX_TRIGGER_CHARS} chars`);
    triggers.push(t.slice(0, MAX_TRIGGER_CHARS));
  }
  const model = typeof r.model === "string" ? r.model.slice(0, MAX_MODEL_CHARS) : "";
  return {
    fn: {
      id: id.slice(0, MAX_ID_CHARS),
      name: r.name.slice(0, MAX_NAME_CHARS),
      // Absent = enabled, matching every other store in this app; but the
      // SHIPPED library writes `false` explicitly (see defaultFunctions), so
      // this default only ever applies to a hand-edited file.
      enabled: r.enabled !== false,
      triggers,
      instruction: r.instruction.slice(0, MAX_INSTRUCTION_CHARS),
      model,
      createdIso: typeof r.createdIso === "string" ? r.createdIso : new Date(0).toISOString(),
    },
    losses,
  };
}

/** Pure: an already-JSON.parsed value into a trustworthy FunctionsFile, or a
 * documented refusal. Tolerant at the ITEM level, never at the version level -
 * see main/snippets.ts's module note for the full argument, which applies here
 * word for word. */
export function parseFunctionsFile(raw: unknown): ParsedFunctions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: "functions.json is not a JSON object; left untouched, starting with an empty library",
    };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== CURRENT_VERSION) {
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: `functions.json has version ${JSON.stringify(r.version)}, which this build does not understand; left untouched, library starts empty`,
    };
  }
  const losses: string[] = [];
  if (r.items !== undefined && !Array.isArray(r.items)) losses.push("the items field is not an array");
  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items: VoiceFunction[] = [];
  for (const [at, it] of rawItems.entries()) {
    if (items.length >= MAX_FUNCTIONS) {
      losses.push(`the file holds ${rawItems.length} entries, over the ${MAX_FUNCTIONS} cap`);
      break;
    }
    const read = readStoredFunction(it, at);
    losses.push(...read.losses);
    if (read.fn) items.push(read.fn);
  }
  if (losses.length > 0) {
    const shown = losses.slice(0, MAX_REPORTED_LOSSES).join("; ");
    const rest = losses.length - MAX_REPORTED_LOSSES;
    return {
      file: { version: CURRENT_VERSION, items },
      error: `functions.json did not load intact, so the library is READ-ONLY until it is fixed (saving now would make the loss permanent): ${shown}${rest > 0 ? `; and ${rest} more` : ""}`,
    };
  }
  return { file: { version: CURRENT_VERSION, items } };
}

/** Pure: what a save does to an items array. Exported disk-free so the
 * id-lookup-vs-mint rule and the bounds are unit-testable without touching
 * ~/.flow (mirrors applySnippetSave). */
export function applyFunctionSave(
  items: readonly VoiceFunction[],
  rawInput: unknown,
): { items: VoiceFunction[] } | { error: string } {
  const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
  const requestedId = typeof input.id === "string" ? input.id.trim() : "";
  const name = (typeof input.name === "string" ? input.name : "").trim().slice(0, MAX_NAME_CHARS);
  const instruction = (typeof input.instruction === "string" ? input.instruction : "")
    .trim()
    .slice(0, MAX_INSTRUCTION_CHARS);
  const model = (typeof input.model === "string" ? input.model : "").trim().slice(0, MAX_MODEL_CHARS);
  const enabled = input.enabled === true;
  const rawTriggers = Array.isArray(input.triggers) ? input.triggers : [];
  if (rawTriggers.length > MAX_TRIGGERS) {
    return { error: `a function may carry at most ${MAX_TRIGGERS} triggers` };
  }
  const triggers: string[] = [];
  for (const t of rawTriggers) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TRIGGER_CHARS) {
      return { error: `a trigger may not exceed ${MAX_TRIGGER_CHARS} characters` };
    }
    // Refused at the WRITE boundary rather than dropped at match time: a
    // trigger the engine will never be able to hear is a dead control, and the
    // user must be told now instead of wondering later why nothing fires.
    if (compileTrigger(trimmed) === null) {
      return { error: `"${trimmed}" cannot be used as a trigger: it needs at least one spoken word besides ${"{lang}"}, and at most 10 words` };
    }
    triggers.push(trimmed);
  }
  if (!name) return { error: "a function needs a name" };
  if (triggers.length === 0) return { error: "a function needs at least one trigger" };
  if (!instruction) return { error: "a function needs an instruction: what the model should do with what you said" };

  if (requestedId) {
    const at = items.findIndex((it) => it.id === requestedId);
    // The id is a LOOKUP key only, never a creation key (same rule as
    // applySnippetSave): a stale or forged id fails loudly.
    if (at < 0) return { error: `function ${requestedId} was not found` };
    const next = items.slice();
    next[at] = { ...items[at], name, enabled, triggers, instruction, model };
    return { items: next };
  }
  if (items.length >= MAX_FUNCTIONS) return { error: `the function library is full (${MAX_FUNCTIONS} max)` };
  return {
    items: [
      ...items,
      { id: randomUUID(), name, enabled, triggers, instruction, model, createdIso: new Date().toISOString() },
    ],
  };
}

/** Pure: what a delete does. Deleting an id that is already gone is a no-op,
 * not an error - idempotent, matching what a page holding a possibly stale list
 * expects. */
export function applyFunctionDelete(items: readonly VoiceFunction[], rawId: unknown): VoiceFunction[] {
  const id = typeof rawId === "string" ? rawId : "";
  return items.filter((it) => it.id !== id);
}

export function functionsPath(): string {
  return path.join(dataDir(), "functions.json");
}

export function loadFunctionsFile(): ParsedFunctions {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(functionsPath(), "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { file: { version: CURRENT_VERSION, items: [] }, missing: true };
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: `functions.json could not be read (${err instanceof Error ? err.message : String(err)}); left untouched, starting with an empty library [${functionsPath()}]`,
    };
  }
  const parsed = parseFunctionsFile(raw);
  if (parsed.error !== undefined) return { ...parsed, error: `${parsed.error} [${functionsPath()}]` };
  return parsed;
}

/** Atomic write (tmp + rename), mirror of settings.ts / snippets.ts /
 * dictionary.ts. Refuses to clobber a file this build did not fully understand;
 * the guard reads the ParsedFunctions the CALLER already produced for this same
 * operation (see main/snippets.ts's saveSnippetsFile for why a second read
 * bought no stronger promise). */
function saveFunctionsFile(
  onDisk: ParsedFunctions,
  file: FunctionsFile,
): { ok: true } | { ok: false; error: string } {
  if (onDisk.error) return { ok: false, error: `refusing to overwrite functions.json: ${onDisk.error}` };
  const p = functionsPath();
  const tmp = p + ".tmp";
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true }); // best effort: never leave a half-written .tmp behind
    } catch {
      /* the cleanup failing changes nothing about the error we are reporting */
    }
    return {
      ok: false,
      error: `functions.json could not be written (${err instanceof Error ? err.message : String(err)}); the library on disk is unchanged [${p}]`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The runtime cache the dictation path reads
// ---------------------------------------------------------------------------
// Same shape and the same reason as main/dictionary.ts's: detectCommand runs
// once per utterance on the process that carries the keyboard hook, so it must
// never re-read and re-parse a JSON file to get there. Invalidated on every
// write, so a toggle on the Functions page takes effect on the very next
// dictation with no restart.

interface FunctionsCache {
  items: readonly VoiceFunction[];
  compiled: CompiledFunction[];
}
let cache: FunctionsCache | null = null;

function setCache(items: readonly VoiceFunction[]): FunctionsCache {
  cache = { items, compiled: compileFunctions(items) };
  return cache;
}

function ensureCache(): FunctionsCache {
  return cache ?? setCache(loadFunctionsFile().file.items);
}

/** The enabled, compiled library. Never throws: it is read from the dictation
 * path, where an exception would cost the user his utterance. */
export function enabledFunctions(): CompiledFunction[] {
  try {
    return ensureCache().compiled;
  } catch {
    return [];
  }
}

/** Look one function up by id, for the executor and the dry run. */
export function findFunction(id: string): VoiceFunction | undefined {
  try {
    return ensureCache().items.find((f) => f.id === id);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// IPC-facing operations (every one answers with the WHOLE library)
// ---------------------------------------------------------------------------

export function listFunctions(): VoiceFunctionsResult {
  const { file, error } = loadFunctionsFile();
  setCache(file.items);
  return { ok: error === undefined, items: file.items, error };
}

export function saveFunction(rawInput: unknown): VoiceFunctionsResult {
  const onDisk = loadFunctionsFile();
  const { file, error } = onDisk;
  if (error) return { ok: false, items: file.items, error };
  const applied = applyFunctionSave(file.items, rawInput);
  if ("error" in applied) return { ok: false, items: file.items, error: applied.error };
  const saved = saveFunctionsFile(onDisk, { version: CURRENT_VERSION, items: applied.items });
  if (!saved.ok) return { ok: false, items: file.items, error: saved.error };
  setCache(applied.items);
  return { ok: true, items: applied.items };
}

export function deleteFunction(rawId: unknown): VoiceFunctionsResult {
  const onDisk = loadFunctionsFile();
  const { file, error } = onDisk;
  if (error) return { ok: false, items: file.items, error };
  const next = applyFunctionDelete(file.items, rawId);
  if (next.length === file.items.length) return { ok: true, items: file.items }; // idempotent no-op
  const saved = saveFunctionsFile(onDisk, { version: CURRENT_VERSION, items: next });
  if (!saved.ok) return { ok: false, items: file.items, error: saved.error };
  setCache(next);
  return { ok: true, items: next };
}

/**
 * Boot: warm the cache and, on a machine that has never had a functions.json,
 * write the shipped seven exactly once.
 *
 * The trigger is `missing` (ENOENT), never "items is empty" - identical to
 * primeDictionary, and for the identical reason: a user who deletes every
 * function leaves a file holding `items: []`, and the next launch must respect
 * that instead of handing him his deleted functions back. A failed seed write
 * is not fatal: the defaults serve this run in memory and the write is retried
 * at the next launch.
 */
export function primeFunctions(log?: (msg: string) => void): void {
  const onDisk = loadFunctionsFile();
  if (onDisk.error) {
    setCache(onDisk.file.items);
    log?.(`[functions] ${onDisk.error}`);
    return;
  }
  if (!onDisk.missing) {
    setCache(onDisk.file.items);
    return;
  }
  const seeded = defaultFunctions(() => randomUUID(), new Date().toISOString());
  setCache(seeded);
  const saved = saveFunctionsFile(onDisk, { version: CURRENT_VERSION, items: seeded });
  log?.(
    saved.ok
      ? `[functions] seeded ${seeded.length} functions, all disabled (turn them on in Functions)`
      : `[functions] could not write the shipped library, using it in memory for this run: ${saved.error}`,
  );
}

// ---------------------------------------------------------------------------
// E3: running a command
// ---------------------------------------------------------------------------

/** Why a transformation did not happen. Closed vocabulary so a log line or a
 * page can never invent a cause. */
export type FunctionFailure = "no-llm" | "timeout-or-error" | "empty-or-runaway" | "unknown-function";

export interface FunctionRun {
  /** The transformed text, or null - and null ALWAYS means "insert the raw
   * transcript instead" (the E3 contract). */
  text: string | null;
  failure?: FunctionFailure;
  ms: number;
}

export interface RunDeps {
  /** The model to use when the function names none. "" is legal and means "the
   * first model Ollama has installed" - resolved by the caller, not here. */
  fallbackModel(): string;
  /** Injected so tests never reach the network, and so the one place that talks
   * to a model stays swappable when the plan's LlmProvider (G1) arrives.
   * Defaults to llm/ollama.ts's generateShort - deliberately REUSED rather than
   * given a near-identical twin of its own: it is already the bounded,
   * abortable POST this needs, and its 0.3 temperature (against the 0.2 the
   * summary path uses) is accepted here because every prompt this module builds
   * ends with an explicit "output only the result" contract. */
  ask?(model: string, prompt: string, timeoutMs: number, numCtx: number): Promise<string | null>;
  now?(): number;
  /** Called immediately before and after the model is asked - and ONLY then, so
   * the caller's instrumentation brackets exactly the model's own time and
   * nothing else. The dictation path uses this pair to keep a transformation's
   * seconds OUT of the release-to-text budget (see shared/hotpath.ts's
   * functionStarted). Both are optional and must never throw. */
  onModelStart?(): void;
  onModelEnd?(): void;
}

/**
 * Hand one recognized command to the model. Returns `{text: null}` for every
 * failure mode there is - that is the whole point (see the module note): a
 * function that fails must cost the user nothing but the transformation.
 */
export async function runCommand(match: CommandMatch, deps: RunDeps): Promise<FunctionRun> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const fn = findFunction(match.functionId);
  if (!fn) return { text: null, failure: "unknown-function", ms: 0 };
  const model = fn.model || deps.fallbackModel();
  // No model name at all means Ollama answered with no installed models (or is
  // not running): there is nothing to ask, and saying so is better than a
  // request that will fail in a less legible way.
  if (!model) return { text: null, failure: "no-llm", ms: now() - started };
  const prompt = buildFunctionPrompt(fn.instruction, match.param, match.payload);
  const ask =
    deps.ask ??
    ((m: string, p: string, timeoutMs: number, numCtx: number) =>
      generateShort(m, p, { timeoutMs, numCtx, numPredict: FUNCTION_NUM_PREDICT }));
  let raw: string | null;
  deps.onModelStart?.();
  try {
    raw = await ask(model, prompt, FUNCTION_TIMEOUT_MS, FUNCTION_NUM_CTX);
  } catch {
    // generateShort() already answers null instead of throwing; this covers an
    // injected ask() and any future provider that does not.
    raw = null;
  } finally {
    // In a finally so a provider that throws still closes the bracket: an
    // unclosed one would leave a functionStarted mark with no functionFinished,
    // and computeIntervals would silently stop deducting the model's time.
    deps.onModelEnd?.();
  }
  if (raw === null) return { text: null, failure: "timeout-or-error", ms: now() - started };
  const cleaned = cleanModelOutput(raw);
  if (cleaned === null) return { text: null, failure: "empty-or-runaway", ms: now() - started };
  return { text: cleaned, ms: now() - started };
}

// ---------------------------------------------------------------------------
// What the dictation path actually calls
// ---------------------------------------------------------------------------

/** What to do with a finished transcript. `kind` is what the caller inserts:
 *  - "plain": the transcript, untouched. The overwhelmingly common case, and
 *    the one every failure falls back to.
 *  - "snippet": a stored block replaced the utterance (E6). `html` present
 *    means it may be pasted as rich text.
 *  - "function": a model transformed it (E3).
 * `note` is a line for flow.log - it names what happened, never the text. */
export interface VoiceOutcome {
  kind: "plain" | "snippet" | "function";
  text: string;
  html?: string;
  note?: string;
  failure?: FunctionFailure;
  /** Set for "function": how long the model took, so the caller can exclude it
   * from the release-to-text budget instead of reporting a false breach. */
  ms?: number;
}

export interface VoiceDeps extends RunDeps {
  /** Injected so a test can drive the whole decision without ~/.flow. */
  functions?(): CompiledFunction[];
  snippets?(): Snippet[];
}

/**
 * The single entry point the dictation path uses: given the final transcript,
 * decide whether it was an utterance, a snippet cue, or a command - and produce
 * exactly what should land at the cursor.
 *
 * ORDER, and why: snippets first. A snippet cue must match the WHOLE utterance
 * (shared/functions.ts's matchSnippetCue), so it is the most specific possible
 * claim on a transcript, it costs no model call, and it can never overlap a
 * command - which by construction has a payload after its trigger. Testing it
 * first also means a user whose cue happens to begin with a function trigger
 * gets the deterministic, instant behaviour rather than the model.
 */
export async function applyVoiceCommands(text: string, deps: VoiceDeps): Promise<VoiceOutcome> {
  const snips = (() => {
    try {
      return deps.snippets ? deps.snippets() : listSnippets().items;
    } catch {
      return [];
    }
  })();
  const snip = matchSnippetCue(text, snips);
  if (snip) {
    return {
      kind: "snippet",
      text: snip.text,
      html: snip.format === "html" ? snip.html : undefined,
      note: `[functions] snippet cue matched, inserted a stored block (${snip.text.length} chars)`,
    };
  }

  const fns = deps.functions ? deps.functions() : enabledFunctions();
  const { match } = detectCommand(text, fns);
  if (!match) return { kind: "plain", text };

  const run = await runCommand(match, deps);
  if (run.text === null) {
    // The non-negotiable fallback. The user's own words land, and the log names
    // the cause - it must never be silent, because the visible symptom is
    // "my function did nothing" and nothing else would explain it.
    return {
      kind: "plain",
      text,
      failure: run.failure,
      ms: run.ms,
      note: `[functions] "${match.functionName}" did not run (${run.failure}) after ${run.ms} ms; the raw transcript was inserted instead`,
    };
  }
  return {
    kind: "function",
    text: run.text,
    ms: run.ms,
    note: `[functions] "${match.functionName}" ran in ${run.ms} ms (${match.payload.length} chars in, ${run.text.length} out)`,
  };
}
