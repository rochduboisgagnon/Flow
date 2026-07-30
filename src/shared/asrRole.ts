// F1 (plan-standalone §7): the speech engine has TWO jobs, and they want
// opposite models.
//
// A dictation is a two-second clip whose whole value is that the text is there
// the instant you let go of the key. A batch job - a meeting being recorded, an
// imported file - is minutes or hours of audio nobody is waiting on with a
// finger on a shortcut. Until this module existed there was ONE `settings.model`
// serving both, so choosing accuracy for a meeting made every dictation pay for
// it, and choosing speed for dictation made every meeting worse.
//
// PURE and Electron-free: the whole policy is these few lines, so the decision
// "does this machine need a second whisper-server at all" is unit-tested without
// spawning anything, and the main-process holder (main/asr/batchEngine.ts) is
// left holding only process lifecycle.
//
// WHAT THIS MODULE DOES NOT DECIDE, on purpose: nothing here can cause the
// DICTATION engine to reload. It answers one question - which model file batch
// work should run on - and the caller is structurally incapable of applying that
// answer to the dictation engine (see batchEngine.ts's module note for the four
// facts that make that a guarantee rather than a hope).

/** The two jobs a whisper model is asked to do in Flow. Named rather than
 * boolean, because "which engine" is a question a log line and a Diagnostics
 * row both have to be able to state. */
export type AsrRole = "dictation" | "batch";

/** `settings.batchModel === ""` means "do not run a second model at all: batch
 * work shares the warm dictation engine". It is the DEFAULT, and it is what a
 * settings.json written before this wave resolves to, so an upgrade changes the
 * behaviour of exactly nothing until the user picks a model on purpose. */
export const BATCH_MODEL_SHARED = "";

/** Which model file batch work should actually run on.
 *
 * Returns "" for "share the dictation engine" - which is BOTH the explicit
 * default AND what an accidentally-identical pair resolves to. Collapsing those
 * two cases here rather than at the call site is the point: a user who sets the
 * batch model to the same file the dictation engine already runs must not get a
 * second whisper-server holding a second copy of the same weights. */
export function resolveBatchModel(dictationModel: string, batchModel: string): string {
  const wanted = batchModel.trim();
  if (wanted === BATCH_MODEL_SHARED) return BATCH_MODEL_SHARED;
  if (wanted === dictationModel.trim()) return BATCH_MODEL_SHARED;
  return wanted;
}

/** Does this configuration need a SECOND whisper-server process?
 *
 * The one thing a caller is allowed to ask before paying anything. False is the
 * cheap path and the default: no extra process, no extra download, no extra
 * gigabyte of VRAM, and batch work runs on the engine that is already warm. */
export function needsSeparateBatchEngine(dictationModel: string, batchModel: string): boolean {
  return resolveBatchModel(dictationModel, batchModel) !== BATCH_MODEL_SHARED;
}

/** How long the batch engine may sit idle before its model is unloaded.
 *
 * Five minutes, and the number is a compromise between two real costs rather
 * than a round figure. Too short and a quiet stretch in a meeting - nobody
 * speaks, so no segment reaches the engine - unloads a 1.1 GB model that is
 * about to be needed again, costing the next segment a 10-30 s reload it would
 * report as a transcription gap. Too long and an import that finished half an
 * hour ago is still holding VRAM the dictation engine's GPU backend has to
 * share.
 *
 * The timer is only ever armed when NOTHING is in flight (batchEngine.ts counts
 * them), so this can never interrupt a transcription that is running. */
export const BATCH_ENGINE_IDLE_MS = 5 * 60_000;

/** What the UI is allowed to say about the batch engine, as a typed state
 * rather than a string a page could invent.
 *
 * "shared" is not an error and not a degradation: it is the default, and it
 * means batch work is running on the warm dictation engine because that is what
 * the settings ask for. */
export interface BatchEngineState {
  /** The model file batch work runs on; "" when it shares the dictation
   * engine. */
  model: string;
  status: "shared" | "loading" | "ready" | "failed";
  /** Present only on "failed": why, in one sentence, so the Settings row can
   * say what happened instead of going quiet. A failed batch engine is NOT a
   * failed batch job - the work runs on the dictation engine instead. */
  message?: string;
}
