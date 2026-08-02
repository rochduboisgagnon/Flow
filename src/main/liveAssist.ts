import fs from "node:fs";
import {
  ASSIST_MAX_SUGGESTIONS,
  ASSIST_MODEL_PROBE_MS,
  ASSIST_TAIL_BYTES,
  ASSIST_TIMEOUT_MS,
  assistPrompt,
  decideAssist,
  mustYield,
  parseAssistItems,
  slidingContext,
  speechBlocks,
  type AssistSnapshot,
  type AssistSuggestion,
  type AssistWait,
} from "../shared/liveAssist";
import type { LongStateSnapshot } from "../shared/longform";

// U8: live assistance during a recording - the timing half. Every RULE lives in
// shared/liveAssist.ts (pure, unit-tested); this class only owns the clock, the
// bounded tail read, the one HTTP call and the in-memory list.
//
// Three properties are structural here, not incidental:
//
//  - NO TIMER. Nothing in this class ticks. It is driven entirely by poll(),
//    which the Record page's panel calls while it is mounted. A page nobody is
//    looking at therefore costs the engine literally nothing - the same
//    discipline the Record page already applies to the transcript poll, and the
//    reason a hidden window can never have a language model running behind it.
//
//  - NOTHING TOUCHES DISK ON THE POLL PATH. The gate's inputs are all in-memory
//    (the recorder's own state snapshot plus two booleans from index.ts). The
//    document's tail is read once per ROUND, i.e. at most every 45 s, never at
//    the poll cadence.
//
//  - THE ENGINE ALWAYS WINS. A round never starts while a dictation, the
//    meeting's transcription, an import or a model download owns the engine
//    (decideAssist), and a round already in flight is ABORTED the moment any of
//    those appears - either through yieldToEngine(), called at the top of the
//    utterance pipeline, or on the next poll (mustYield).
//
// Zero retention holds: suggestions live in this object for the length of one
// recording. The only thing ever written is a suggestion the user explicitly
// keeps, through the recorder (one writer of the document, always), as a line
// that says "NOT spoken" before it says anything else.

export interface LiveAssistDeps {
  /** settings.liveAssist - read lazily, so a toggle applies to the very next
   * poll without this class holding a copy that can go stale. */
  enabled(): boolean;
  /** settings.summaryModel: the SAME local model choice the meeting summary
   * uses. Deliberately not a second setting - "which local model reads my
   * meeting" is one question, and asking it twice is how two answers end up
   * disagreeing. "" means "the first installed one". */
  preferredModel(): string;
  /** Installed local model names, or null when no local model server answers.
   * Injectable so tests never reach for a real Ollama. */
  listModels(): Promise<string[] | null>;
  /** The recorder's own snapshot - the SAME one the Record page and the HTTP
   * /long/state route read (index.ts's longStateDep), never a second view. */
  longState(): LongStateSnapshot;
  /** A dictation or a local-API utterance is being decoded right now. */
  dictating(): boolean;
  /** An audio import or a model download owns the engine. */
  otherEngineWork(): boolean;
  /** One short, abortable generation (LlmProvider.short). null on any failure.
   *
   * P1: this used to name Ollama. It does not any more, and the `model`
   * argument is now vestigial - the provider decides which model it uses,
   * because for a CLI provider there is nothing to choose. */
  generate(
    model: string,
    prompt: string,
    opts: { signal: AbortSignal; timeoutMs: number },
  ): Promise<string | null>;
  /** Write a KEPT suggestion into the recording's document. The recorder does
   * it (LongRecorder.keepSuggestion): the document has exactly one writer, and
   * a second one appending from here could tear the atomic rewrite finalize
   * performs. */
  keepInDocument(text: string, contextUpToMs: number): { ok: boolean; error?: string };
  log?(msg: string): void;
}

/** The bounded tail of a file, plus whether it starts mid-document. */
function readTail(p: string, bytes = ASSIST_TAIL_BYTES): { text: string; truncated: boolean } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const len = size - from;
    if (len <= 0) return { text: "", truncated: false };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    // A tail cut at a byte boundary can start inside a multi-byte character;
    // speechBlocks() drops the first block when `truncated`, which is also what
    // discards those bytes.
    return { text: buf.toString("utf8"), truncated: from > 0 };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do about a failed close of a read-only handle */
      }
    }
  }
}

export class LiveAssistant {
  private deps: LiveAssistDeps;

  // ---- per-recording state, all in memory, all dropped at the next start ----
  private recordingId = ""; // startedIso of the recording on screen
  private suggestions: AssistSuggestion[] = [];
  private quietRounds = 0;
  private contextFromMs = 0;
  private contextUpToMs = 0;
  private lastRoundAt = 0;
  private roundSegments = -1; // segments already covered by a round's context
  private error = "";
  private seq = 0;

  // ---- the in-flight round ----
  private inFlight: AbortController | null = null;
  private wait: AssistWait = "off";

  // ---- the local-model probe, cached (see ASSIST_MODEL_PROBE_MS) ----
  private modelReady: boolean | null = null;
  private model = "";
  private probedAt = 0;
  private probing = false;

  constructor(deps: LiveAssistDeps) {
    this.deps = deps;
  }

  /**
   * The panel's heartbeat: answer with the current snapshot, and consider
   * starting a round.
   *
   * The side effect is the design, not a shortcut. Making the page's poll the
   * only thing that can start a round is what guarantees that closing the
   * window, or simply navigating to another page, stops the feature dead - no
   * timer to remember to clear, no state where a language model reads a meeting
   * behind an interface nobody has open.
   *
   * It NEVER awaits a round: the answer is built from what is already known and
   * returns immediately, so the poll costs the caller nothing beyond one
   * in-memory snapshot.
   */
  poll(): AssistSnapshot {
    const st = this.deps.longState();
    this.syncRecording(st);

    const enabled = this.deps.enabled();
    if (enabled) this.ensureModelProbe();
    else {
      // Turning it off releases the machine at once - it must not mean "after
      // the round in flight finishes".
      this.abort("switched off");
    }

    const verdict = decideAssist({
      enabled,
      modelReady: enabled ? this.modelReady : false,
      recordingActive: st.active,
      finalizing: st.finalizing,
      dictating: this.deps.dictating(),
      transcribing: st.pending > 0,
      otherEngineWork: this.deps.otherEngineWork(),
      generating: this.inFlight !== null,
      msSinceLastRound: this.lastRoundAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - this.lastRoundAt,
      newSegments: this.roundSegments < 0 ? st.segments : st.segments - this.roundSegments,
    });
    this.wait = enabled ? verdict.wait : "off";

    // The engine claimed the machine while a round was in flight: give it back
    // now rather than at the end of the round.
    if (this.inFlight !== null && mustYield(verdict.wait)) this.abort(verdict.wait);

    if (verdict.run) void this.runRound(st);
    return this.snapshot(st);
  }

  /**
   * "Suggest now", from the panel's button.
   *
   * Skips the cooldown and the "enough new speech" bar - both exist to keep the
   * panel calm on its own, and a person who just asked for a suggestion has
   * overridden that concern by asking. It does NOT skip the priority gate: if a
   * dictation or the meeting's transcription owns the engine, this refuses and
   * the panel says which one, because the alternative is a button that competes
   * with the transcription of the meeting it is supposed to be helping.
   */
  ask(): AssistSnapshot {
    const st = this.deps.longState();
    this.syncRecording(st);
    if (!this.deps.enabled()) {
      this.error = "Live suggestions are off.";
      return this.snapshot(st);
    }
    this.ensureModelProbe();
    const verdict = decideAssist({
      enabled: true,
      modelReady: this.modelReady,
      recordingActive: st.active,
      finalizing: st.finalizing,
      dictating: this.deps.dictating(),
      transcribing: st.pending > 0,
      otherEngineWork: this.deps.otherEngineWork(),
      generating: this.inFlight !== null,
      // The two bars a deliberate press is allowed to jump.
      msSinceLastRound: Number.MAX_SAFE_INTEGER,
      newSegments: Number.MAX_SAFE_INTEGER,
    });
    this.wait = verdict.wait;
    if (verdict.run) {
      this.error = "";
      void this.runRound(st);
    }
    return this.snapshot(st);
  }

  /**
   * Keep a suggestion: write it into the recording's document.
   *
   * Only while the capture is ACTIVE, and that bound is not conservatism. Once
   * stop() has run, finalize() reads the whole document and rewrites it in one
   * atomic swap (header + notes + transcript); an append landing in that window
   * would be silently dropped, and an append after it would sit past the end of
   * a finished document. The panel keeps showing the suggestions either way -
   * they are simply no longer keepable, and it says so.
   */
  keep(rawId: unknown): AssistSnapshot {
    const st = this.deps.longState();
    this.syncRecording(st);
    const id = typeof rawId === "string" ? rawId : "";
    const found = this.suggestions.find((s) => s.id === id);
    if (!found) {
      this.error = "That suggestion is no longer on screen.";
      return this.snapshot(st);
    }
    if (found.kept) return this.snapshot(st);
    if (!st.active) {
      this.error = "The recording is over: its document is finished and Flow will not append to it.";
      return this.snapshot(st);
    }
    const r = this.deps.keepInDocument(found.text, found.contextUpToMs);
    if (r.ok) {
      found.kept = true;
      this.error = "";
      this.deps.log?.("[assist] a suggestion was kept in the document");
    } else {
      this.error = r.error ?? "Flow could not write that into the document.";
    }
    return this.snapshot(st);
  }

  /** Drop a suggestion from the panel. Nothing was ever written, so there is
   * nothing to undo - this only clears the screen. */
  dismiss(rawId: unknown): AssistSnapshot {
    const id = typeof rawId === "string" ? rawId : "";
    this.suggestions = this.suggestions.filter((s) => s.id !== id);
    return this.snapshot(this.deps.longState());
  }

  /**
   * The speech engine is about to work: drop any round in flight.
   *
   * Called at the top of the shared utterance pipeline (main/index.ts's
   * processUtterance), which covers BOTH the push-to-talk path and the local
   * HTTP endpoint. Costs one null check when nothing is in flight, which is the
   * overwhelmingly common case and the reason it is safe to call from there at
   * all: that function runs on the process carrying the keyboard hook.
   */
  yieldToEngine(): void {
    if (this.inFlight === null) return;
    this.abort("the speech engine needs the machine");
  }

  /** Quitting: nothing to persist, just let go of the socket. */
  stop(): void {
    this.abort("shutting down");
  }

  private abort(reason: string): void {
    const ac = this.inFlight;
    if (ac === null) return;
    this.inFlight = null;
    ac.abort();
    this.deps.log?.(`[assist] round dropped: ${reason}`);
  }

  /** A different recording than the one on screen: everything derived from the
   * previous one is meaningless, including the offsets. Same hazard the Record
   * page's `recordingRef` guards for - a recording started from the tray, the
   * local API or a connector must not inherit the previous one's state. */
  private syncRecording(st: LongStateSnapshot): void {
    if (st.startedIso === this.recordingId) return;
    this.recordingId = st.startedIso;
    this.suggestions = [];
    this.quietRounds = 0;
    this.contextFromMs = 0;
    this.contextUpToMs = 0;
    this.lastRoundAt = 0;
    this.roundSegments = -1;
    this.error = "";
    this.abort("a different recording started");
  }

  /** Ask once whether a local model exists, then trust the answer for a while.
   * Fire-and-forget: the panel shows "checking" until it lands. */
  private ensureModelProbe(): void {
    if (this.probing) return;
    if (this.modelReady !== null && Date.now() - this.probedAt < ASSIST_MODEL_PROBE_MS) return;
    this.probing = true;
    void this.deps
      .listModels()
      .then((models) => {
        const preferred = this.deps.preferredModel();
        const list = models ?? [];
        // A configured model that is no longer installed must not silently
        // become "whatever is first": say no model rather than read a meeting
        // with one the user did not choose.
        this.model = preferred ? (list.includes(preferred) ? preferred : "") : (list[0] ?? "");
        this.modelReady = this.model !== "";
      })
      .catch(() => {
        this.model = "";
        this.modelReady = false;
      })
      .finally(() => {
        this.probedAt = Date.now();
        this.probing = false;
      });
  }

  private async runRound(st: LongStateSnapshot): Promise<void> {
    const model = this.model;
    if (!model) return;
    // Claim the round BEFORE the first await: two polls a fraction of a second
    // apart must not both get past the `generating` gate.
    const ac = new AbortController();
    this.inFlight = ac;
    // Mark the material this round covers now, not at the end: a round that
    // takes twenty seconds must not then look at the same segments again.
    this.roundSegments = st.segments;
    try {
      const tail = readTail(st.docPath);
      const ctx = slidingContext(speechBlocks(tail.text, tail.truncated));
      if (!ctx.text) {
        this.deps.log?.("[assist] nothing transcribed yet to look at");
        return;
      }
      const raw = await this.deps.generate(model, assistPrompt(ctx), {
        signal: ac.signal,
        timeoutMs: ASSIST_TIMEOUT_MS,
      });
      // Aborted mid-flight: the answer belongs to a moment that has passed, and
      // the machine was reclaimed by something with a higher claim. Drop it.
      if (ac.signal.aborted) return;
      this.contextFromMs = ctx.fromMs;
      this.contextUpToMs = ctx.upToMs;
      if (raw === null) {
        this.error = "The local model did not answer this time. Nothing was lost; the transcript is unaffected.";
        return;
      }
      this.error = "";
      const items = parseAssistItems(raw);
      if (items.length === 0) {
        this.quietRounds++;
        this.deps.log?.("[assist] round had nothing to suggest");
        return;
      }
      const createdIso = new Date().toISOString();
      const fresh: AssistSuggestion[] = items.map((text) => ({
        id: `s${++this.seq}`,
        text,
        contextFromMs: ctx.fromMs,
        contextUpToMs: ctx.upToMs,
        createdIso,
        kept: false,
      }));
      // Newest first, and the list is CAPPED: the panel is a small stable area,
      // not a feed. Kept ones are not privileged - they are already in the
      // document, which is the copy that matters.
      this.suggestions = [...fresh, ...this.suggestions].slice(0, ASSIST_MAX_SUGGESTIONS);
    } catch (err) {
      this.error = String(err);
      this.deps.log?.(`[assist] round failed: ${err}`);
    } finally {
      // The cooldown starts when a round ENDS, including when it was aborted or
      // failed: a round that just lost a fight with the engine retrying
      // immediately is how a quiet feature turns into a busy one.
      this.lastRoundAt = Date.now();
      if (this.inFlight === ac) this.inFlight = null;
    }
  }

  private snapshot(st: LongStateSnapshot): AssistSnapshot {
    const enabled = this.deps.enabled();
    return {
      ok: true,
      enabled,
      modelReady: enabled ? this.modelReady : false,
      model: enabled ? this.model : "",
      recording: st.active,
      wait: this.wait,
      // Copied out: the page must never hold a reference this class mutates
      // between two polls.
      suggestions: this.suggestions.map((s) => ({ ...s })),
      contextFromMs: this.contextFromMs,
      contextUpToMs: this.contextUpToMs,
      quietRounds: this.quietRounds,
      error: this.error,
    };
  }
}
