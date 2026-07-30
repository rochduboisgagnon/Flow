import type { WhisperSidecar } from "./sidecar";
import {
  BATCH_ENGINE_IDLE_MS,
  BATCH_MODEL_SHARED,
  resolveBatchModel,
  type BatchEngineState,
} from "../../shared/asrRole";

// F1 (plan-standalone §7): the SECOND speech engine, the one batch work runs on.
//
// ---------------------------------------------------------------------------
// THE GUARANTEE THIS FILE EXISTS TO MAKE
//
// A press on the dictation shortcut NEVER waits for a model to load. Not once
// in ten, not once in a thousand. That is not a property of careful sequencing
// here - sequencing can be got wrong - it is a structural property of four
// facts, and each one is checkable by reading a single place:
//
//  1. The dictation path reads ONE variable. `processUtterance` (main/index.ts)
//     reads the module-level `sidecar` and nothing else. This file is not on
//     that path and is not reachable from it.
//  2. This class never mutates the dictation engine. It calls NOTHING on it:
//     not stop(), not ensureStarted(), not setLanguage(). The only thing it ever
//     does with the dictation engine is HAND IT BACK as a fallback (see
//     `fallback` below). Its own engine is a different WhisperSidecar instance,
//     which findFreePort puts on a different port.
//  3. `swapModel()` - the only code in the app that ever replaces `sidecar` - is
//     called from exactly one place, applySettings(), and only when
//     `settings.model` or `settings.forceCpu` changed. Changing
//     `settings.batchModel` sets neither flag, so it starts and stops nothing on
//     the dictation side.
//  4. A load failure here is not an error path that retries on the dictation
//     engine: it falls back to it AS IT IS, warm, unswapped.
//
// test/batch-engine.test.ts asserts 2 and 4 by IDENTITY (the same sidecar object
// before and after, and a stop() spy that is never called), which is the only
// form of that assertion a future refactor cannot quietly pass while breaking.
//
// ---------------------------------------------------------------------------
// WHAT IT COSTS, said here rather than discovered later
//
// While batch work runs on a separate model, TWO models are resident. On the
// Vulkan backend that is two allocations of VRAM (roughly 1.6 GB + 3 GB for the
// turbo/large-v3 pair). Three consequences, all deliberate:
//
//  - If the batch model cannot load - and exhausted VRAM is the realistic
//    reason, not a missing file - the batch job runs on the dictation engine.
//    It is slower or less accurate than the user asked for, it is logged and
//    counted, and it is never a failed job.
//  - The model is UNLOADED after BATCH_ENGINE_IDLE_MS of no batch work, so the
//    steady state of a machine that is not importing anything is one model, as
//    before.
//  - What this design does NOT fix: a dictation that happens DURING an import
//    still shares one GPU with it. The import already stands aside per segment
//    (see `userEngineClaim` in main/index.ts), but a segment already in flight
//    is not preempted. That was equally true with one shared model; F1 makes it
//    cost more memory, not more waiting.
// ---------------------------------------------------------------------------
//
// Electron-free on purpose, like WhisperSidecar itself: every dependency comes
// through the constructor, including the timer, so the idle unload is tested in
// milliseconds instead of five real minutes.

export interface BatchEngineTimer {
  /** Opaque handle; only ever passed back to clearTimer. */
  readonly id: unknown;
}

export interface BatchEngineDeps {
  /** The WARM dictation engine. Read and handed back as a fallback - see fact 2
   * of the module note. This closure is the ONLY window this class has onto it,
   * and it is deliberately a getter rather than the object: `sidecar` is
   * replaced by swapModel(), and a captured reference would hand batch work an
   * engine the user has since replaced. */
  dictationEngine: () => WhisperSidecar | null;
  /** The model file the DICTATION engine is running (settings.model). */
  dictationModel: () => string;
  /** settings.batchModel; "" = share the dictation engine. */
  batchModel: () => string;
  /** Downloads the model if it is missing, answers its path. The SAME function
   * the dictation engine uses, so a model fetched for one role is on disk for
   * the other. */
  ensureModel: (file: string) => Promise<string>;
  /** Builds a sidecar for a model path. Injected rather than constructed here so
   * the batch engine inherits, without restating them, every choice the
   * dictation engine already makes: the backend candidate list (and therefore
   * `forceCpu`), the beam size, the French seed, the dictionary prompt. */
  makeSidecar: (modelPath: string) => WhisperSidecar;
  setTimer: (fn: () => void, ms: number) => BatchEngineTimer;
  clearTimer: (t: BatchEngineTimer) => void;
  log?: (msg: string) => void;
  /** Called when batch work had to run on the dictation engine although a
   * separate batch model was configured. Wired to the named silent-failure
   * counter in main/index.ts: a batch model that quietly never loads is exactly
   * the kind of degradation this campaign counts as a defect when it leaves no
   * trace. */
  onFallback?: (reason: string) => void;
  idleMs?: number; // tests only; defaults to BATCH_ENGINE_IDLE_MS
}

export class BatchEngine {
  private deps: BatchEngineDeps;
  private sc: WhisperSidecar | null = null;
  /** Which model `sc` was built for. Compared on every call, because the user
   * can change the batch model while an engine for the previous one is warm. */
  private scModel = "";
  private starting: Promise<void> | null = null;
  private startingModel = "";
  private inFlight = 0;
  private idle: BatchEngineTimer | null = null;
  private failure: string | null = null;
  /** The model the last failure was about. A failure must not be sticky across
   * a settings change: the user picking a different (or smaller) model is
   * exactly the gesture that deserves a fresh attempt. */
  private failureModel = "";

  constructor(deps: BatchEngineDeps) {
    this.deps = deps;
  }

  /** The ONE call a batch caller makes. Deliberately a wrapper around
   * transcribe rather than a getter that hands out the sidecar: this class has
   * to know when work is in flight, or the idle unload could kill a
   * whisper-server in the middle of a twenty-second decode.
   *
   * `allowEmptyDemote: false` is baked in and not a parameter, because BOTH
   * batch callers passed it for the same documented reason: a meeting segment or
   * an imported file legitimately contains music, applause and ambience, and
   * demoting a healthy GPU over a genuinely silent stretch is a silent
   * app-wide slowdown. A hard failure still demotes, exactly as before. */
  async transcribe(wav: Uint8Array): Promise<{ text: string; ms: number }> {
    const sc = await this.engineFor();
    this.inFlight++;
    // Disarm while working: the timer is only ever a decision about an IDLE
    // engine, and re-arming happens in the finally below.
    this.disarmIdle();
    try {
      return await sc.transcribe(wav, { allowEmptyDemote: false });
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.armIdle();
    }
  }

  /** Which engine this batch call runs on. Never throws for a batch-model
   * problem - only for "there is no speech engine at all", which is the same
   * error both callers already produced before F1. */
  private async engineFor(): Promise<WhisperSidecar> {
    const wanted = resolveBatchModel(this.deps.dictationModel(), this.deps.batchModel());
    if (wanted === BATCH_MODEL_SHARED) {
      // The default path, and the cheap one: no second process ever existed, or
      // the user has just stopped asking for one - in which case the engine that
      // is still warm for the old batch model is now dead weight.
      if (this.sc) this.release("the batch model no longer differs from the dictation model");
      return this.fallback("configured to share the dictation engine");
    }
    if (this.sc && this.scModel === wanted) return this.sc;
    // A previous attempt on THIS model failed. Do not re-attempt per segment: a
    // 1.1 GB download that fails, or a GPU that has no room left, fails the same
    // way for every one of the hundreds of segments a meeting produces, and
    // retrying each time would turn one honest log line into a flood while the
    // recording falls behind.
    if (this.failure !== null && this.failureModel === wanted) {
      return this.fallback(`the batch engine is unavailable (${this.failure})`);
    }
    if (this.sc && this.scModel !== wanted) {
      this.release(`the batch model changed to ${wanted}`);
    }
    try {
      await this.startFor(wanted);
    } catch (err) {
      this.failure = String(err instanceof Error ? err.message : err);
      this.failureModel = wanted;
      this.deps.log?.(
        `[asr/batch] ${wanted} could not start (${this.failure}); batch work runs on the dictation engine instead`,
      );
      return this.fallback(`the batch engine failed to start (${this.failure})`);
    }
    // Re-read after the await: the user can change the batch model while a
    // 1.1 GB download is in flight, and handing back an engine for the model
    // they just stopped asking for would be worse than one slow call on the
    // dictation engine. The NEXT call starts the right one.
    if (!this.sc || this.scModel !== resolveBatchModel(this.deps.dictationModel(), this.deps.batchModel())) {
      return this.fallback("the batch model changed while its engine was loading");
    }
    return this.sc;
  }

  /** Start (or join an in-flight start of) the batch engine for `model`.
   * Idempotent for concurrent callers, which matters: a meeting pushes segments
   * faster than a model loads, so the first minute of a recording can call this
   * a dozen times before the first one has finished. */
  private startFor(model: string): Promise<void> {
    if (this.starting && this.startingModel === model) return this.starting;
    this.startingModel = model;
    this.starting = (async () => {
      this.deps.log?.(`[asr/batch] loading ${model} for batch work (dictation keeps its own engine)`);
      const modelPath = await this.deps.ensureModel(model);
      const next = this.deps.makeSidecar(modelPath);
      try {
        await next.ensureStarted();
      } catch (err) {
        // Leave nothing running that nobody holds a reference to: a
        // whisper-server that started and then failed its decode probe still
        // owns a port and, on the GPU path, still owns VRAM.
        next.stop();
        throw err;
      }
      this.sc = next;
      this.scModel = model;
      this.failure = null;
      this.failureModel = "";
      this.deps.log?.(`[asr/batch] ${model} warm; batch work no longer competes with dictation for the model`);
    })().finally(() => {
      this.starting = null;
      this.startingModel = "";
    });
    return this.starting;
  }

  /** The dictation engine, as it is. Never restarted, never swapped, never
   * reconfigured - see fact 2 of the module note. */
  private fallback(reason: string): WhisperSidecar {
    const sc = this.deps.dictationEngine();
    if (!sc) throw new Error("the speech engine is not ready yet");
    // Counted only when the user actually asked for a separate engine and did
    // not get it. The default ("shared") is not a degradation and must not
    // inflate a failure counter.
    if (resolveBatchModel(this.deps.dictationModel(), this.deps.batchModel()) !== BATCH_MODEL_SHARED) {
      this.deps.onFallback?.(reason);
    }
    return sc;
  }

  private armIdle(): void {
    if (!this.sc || this.idle) return;
    this.idle = this.deps.setTimer(() => {
      this.idle = null;
      // Re-check: a call may have arrived between the timer firing and this
      // callback running, and unloading a model out from under work in flight is
      // the one thing this timer must never do.
      if (this.inFlight === 0) this.release("idle");
    }, this.deps.idleMs ?? BATCH_ENGINE_IDLE_MS);
  }

  private disarmIdle(): void {
    if (!this.idle) return;
    this.deps.clearTimer(this.idle);
    this.idle = null;
  }

  private release(reason: string): void {
    this.disarmIdle();
    if (!this.sc) return;
    this.deps.log?.(`[asr/batch] unloading ${this.scModel} (${reason})`);
    this.sc.stop();
    this.sc = null;
    this.scModel = "";
  }

  /** What the Settings row and the log are allowed to say. Derived, never
   * remembered: a status the UI could hold while the engine moved underneath it
   * is the class of interface sentence this campaign treats as a defect. */
  state(): BatchEngineState {
    const wanted = resolveBatchModel(this.deps.dictationModel(), this.deps.batchModel());
    if (wanted === BATCH_MODEL_SHARED) return { model: "", status: "shared" };
    if (this.failure !== null && this.failureModel === wanted) {
      return { model: wanted, status: "failed", message: this.failure };
    }
    if (this.sc && this.scModel === wanted) return { model: wanted, status: "ready" };
    // Not started yet is reported as "loading" rather than as its own state:
    // from the reader's point of view "Flow will load this when batch work needs
    // it" and "Flow is loading it right now" are the same fact, and inventing a
    // fourth state for the difference would only give a page something else to
    // get wrong.
    return { model: wanted, status: "loading" };
  }

  /** The batch model (or the backend list, via forceCpu) changed in Settings.
   *
   * Drops the warm batch engine so the next batch call builds the right one. Only
   * when nothing is in flight: a settings change must never abort a segment that
   * is decoding right now, and a call already running is a call the user is
   * waiting on. When work IS in flight, engineFor() notices the mismatch on the
   * next call and swaps then - which is why this method is an OPTIMISATION (do
   * not sit on a gigabyte the user stopped asking for) and not the mechanism. */
  settingsChanged(): void {
    if (this.inFlight === 0) this.release("the batch engine's settings changed");
    // A previous failure must not survive the gesture most likely to fix it -
    // picking a smaller model, or forcing CPU when the GPU had no room.
    this.failure = null;
    this.failureModel = "";
  }

  /** Quit / shutdown. Stops only what this class started. */
  stop(): void {
    this.release("shutting down");
  }
}
