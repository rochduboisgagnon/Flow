import { listOllamaModels, summarize, generateShort } from "./ollama";

// ---------------------------------------------------------------------------
// P1 (vague P, 2026-08-02) : la frontière derrière laquelle vit « qui réfléchit
// pour Flow ».
//
// WHAT THIS IS NOT, first, because the sentence that opened this wave can be
// read two ways and one of them would move the user's speech off their machine:
//
//   Speech to text  -> whisper.cpp, on this machine, ALWAYS. Not behind this
//                      interface. Not a setting. Not negotiable.
//   Meeting notes and summaries, live assistance -> here.
//
// Three model calls live at four sites (longform.finalize, audioImport,
// liveAssist, and the Settings model list). Before this file they all knew the
// word "Ollama". After it, none of them do.
//
// WHY TWO VERBS AND NOT ONE. ollama.ts already won this argument in prose and
// it is repeated here because a future reader will be tempted: `long` wants
// five minutes and a big context; `short` wants twenty-five seconds, two
// hundred tokens, and above all the ability to be dropped mid-flight. Merging
// them behind a parameter guarantees that one day live assistance inherits the
// five-minute budget.
//
// WHY `null` ON EVERY FAILURE. It is already the contract of both functions,
// and both callers already handle it correctly: the document ships with the
// transcript alone, the panel says "nothing this round". Moving to exceptions
// would ripple error handling through the two most-reviewed functions in the
// repo for no gain.
//
// WHAT THIS INTERFACE DELIBERATELY LACKS: no streaming, no tools, no
// conversation continuity, no general "list the models". Flow asks a question
// and reads an answer. Session continuity is what makes AGR Pilot complicated
// (`--resume`, "Session ID already in use", the per-id lock); Flow has no use
// for it, and taking it would import that whole class of failures for nothing.
// ---------------------------------------------------------------------------

/** Where the text goes. The UI reads THIS, never a hard-coded string, so a
 * provider added later cannot forget to declare itself. */
export type Locality = "on-this-machine" | "sent-away";

export type ProviderId = "ollama" | "claude-cli" | "codex-cli";

/**
 * Two DIFFERENT claims, and the page must never make the second having checked
 * only the first.
 *
 * `found` means a name resolved (a binary on PATH, a server that answered its
 * cheap probe). `responded` means a real call actually came back. A `claude.cmd`
 * present but not signed in is the normal state of a fresh machine, and telling
 * someone it is "ready" would be a lie they discover during a meeting.
 */
export interface Availability {
  found: boolean;
  responded: boolean;
  /** For the page, in the closed vocabulary of the caller. Never a raw error
   * string, never a path: this crosses into the UI and into logs. */
  detail?: string;
}

export interface LlmProvider {
  id: ProviderId;
  locality: Locality;
  /** "" when locality is on-this-machine. The name the UI shows when it has to
   * say where the text is going. */
  vendor: string;
  /** Cheap and cached. NEVER an execution: liveAssist re-probes every 30 s
   * while its panel is open, and a provider that spawned a process there would
   * spawn one every 30 seconds for the length of a meeting. */
  available(): Promise<Availability>;
  /** Summaries. Minutes are fine here; nobody is waiting on a finalize. */
  long(prompt: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string | null>;
  /** Live assistance. `signal` is REQUIRED, and it is the whole point: the
   * engine always wins. */
  short(prompt: string, opts: { signal: AbortSignal; timeoutMs: number }): Promise<string | null>;
}

export interface OllamaProviderDeps {
  /** settings.summaryModel. Empty means "whatever is installed". */
  preferredModel(): string;
  /** Injected so tests never reach for a real Ollama. */
  listModels?(): Promise<string[] | null>;
}

/**
 * The local provider, and the reference behaviour every other one is measured
 * against.
 *
 * Not one line of ollama.ts changed to make this: it keeps its timeouts, its
 * keep_alive, its context sizes and its null contract, and this class only
 * chooses the model and forwards. That is the point of P1 - if adapting the
 * existing behaviour had required touching it, the boundary would have been in
 * the wrong place.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = "ollama" as const;
  readonly locality: Locality = "on-this-machine";
  readonly vendor = "";
  private deps: OllamaProviderDeps;

  constructor(deps: OllamaProviderDeps) {
    this.deps = deps;
  }

  /**
   * Which model this provider would actually use.
   *
   * The rule is lifted verbatim from where it lived before (longform.finalize
   * and audioImport had the SAME three lines, which is exactly the kind of
   * duplication this file exists to end): the user's choice, else the first
   * installed model, else nothing.
   */
  async resolveModel(): Promise<string> {
    const preferred = this.deps.preferredModel() || "";
    if (preferred) return preferred;
    const installed = this.deps.listModels ? await this.deps.listModels() : await listOllamaModels();
    return installed?.[0] ?? "";
  }

  async available(): Promise<Availability> {
    const model = await this.resolveModel();
    // For Ollama, "found" and "responded" collapse honestly: /api/tags IS a
    // real call to the real server. There is no equivalent here of a binary
    // sitting on disk without credentials.
    if (!model) return { found: false, responded: false, detail: "no local model installed" };
    return { found: true, responded: true };
  }

  async long(prompt: string): Promise<string | null> {
    const model = await this.resolveModel();
    if (!model) return null;
    return summarize(model, prompt);
  }

  async short(
    prompt: string,
    opts: { signal: AbortSignal; timeoutMs: number; numCtx?: number; numPredict?: number },
  ): Promise<string | null> {
    const model = await this.resolveModel();
    if (!model) return null;
    return generateShort(model, prompt, opts);
  }
}

/**
 * The installed Ollama model names, re-exported HERE rather than imported from
 * `llm/ollama` by the rest of the app.
 *
 * It is deliberately NOT on the LlmProvider interface. "List the models" is a
 * question only Ollama can answer: Claude Code's model is fixed to Sonnet by
 * this design, and a second model selector would be exactly the setting too
 * many. So the Settings page keeps its Ollama dropdown, and it reaches it
 * through the provider module - which is what keeps the name "ollama" out of
 * `index.ts`, `longform.ts` and everywhere else.
 */
export { listOllamaModels };
