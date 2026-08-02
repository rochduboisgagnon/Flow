import type { Availability, LlmProvider, ProviderId } from "./provider";

// ---------------------------------------------------------------------------
// P4 (vague P) : la détection, et les trois seuls moments où elle a lieu.
//
// THE RULE THE WHOLE FILE FOLLOWS: detecting is resolving a name on the PATH.
// It is NEVER running the program.
//
// The measurement behind it: `claude --version` costs one to two seconds of
// Node runtime startup; resolving `claude.exe` on the PATH costs a handful of
// statSync calls. That is the whole difference between "Flow got slower to
// start" and "it cost nothing".
//
// WHEN. Never at startup. Three moments, and only these:
//   1. opening Settings > Local AI;
//   2. the first real call of a provider, when the cache is empty;
//   3. pressing Re-scan, because installing a CLI is a rare event and a stale
//      cache then costs exactly one click.
//
// THE 30-SECOND TRAP, which is the concrete reason and not an aesthetic one:
// liveAssist re-probes availability every 30 s while its panel is open
// (ASSIST_MODEL_PROBE_MS). If availability were implemented by an execution,
// that would be one process spawned every half-minute for the whole length of a
// meeting. The cache below is what makes that re-probe a no-op.
//
// FLOW NEVER ELECTS A PROVIDER. If claude and codex are both present, the
// setting keeps its value and its default stays the local model. Auto-electing
// something that bills a subscription and sends a meeting to a third party is
// precisely the decision this application has no right to make for someone.
// ---------------------------------------------------------------------------

/** What the Settings page renders for one provider. */
export interface ProviderStatus {
  id: ProviderId;
  /** Where the text goes if this one is chosen. The page reads THIS. */
  locality: "on-this-machine" | "sent-away";
  /** "" for a local provider. */
  vendor: string;
  /** A name resolved. NOT "it works". */
  found: boolean;
  /** A real call really came back, at some point in this session. */
  responded: boolean;
  /** A closed-vocabulary hint, never a raw error and never a path. */
  detail?: string;
}

export interface RegistryDeps {
  providers: LlmProvider[];
  /** Injectable clock, so the cache TTL is testable without waiting. */
  now?(): number;
  log?(msg: string): void;
}

/**
 * How long a detection answer is reused.
 *
 * Not zero, because of the 30-second re-probe above. Not infinite, because a
 * user who installs Claude Code while Flow is open should not have to restart
 * the app - and if they open the tab, that is one of the three moments.
 */
export const DETECT_TTL_MS = 60_000;

export class ProviderRegistry {
  private deps: RegistryDeps;
  private cache = new Map<ProviderId, { at: number; status: ProviderStatus }>();

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  get(id: ProviderId): LlmProvider | undefined {
    return this.deps.providers.find((p) => p.id === id);
  }

  /**
   * The chosen provider, or the local one.
   *
   * The fallback is deliberately the LOCAL provider and never "the first
   * available": a settings file naming a provider that is not installed must
   * degrade to the machine, not to whatever remote thing happens to be there.
   */
  resolve(id: ProviderId): LlmProvider | undefined {
    return this.get(id) ?? this.deps.providers.find((p) => p.locality === "on-this-machine");
  }

  /** Detection for one provider, from cache when it is fresh. */
  async status(id: ProviderId, force = false): Promise<ProviderStatus | null> {
    const p = this.get(id);
    if (!p) return null;
    const hit = this.cache.get(id);
    if (!force && hit && this.now() - hit.at < DETECT_TTL_MS) return hit.status;
    const av: Availability = await p.available();
    const status: ProviderStatus = {
      id: p.id,
      locality: p.locality,
      vendor: p.vendor,
      found: av.found,
      responded: av.responded,
      detail: av.detail,
    };
    this.cache.set(id, { at: this.now(), status });
    return status;
  }

  /** What the tab shows: every provider, in declaration order. */
  async list(force = false): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = [];
    for (const p of this.deps.providers) {
      const s = await this.status(p.id, force);
      if (s) out.push(s);
    }
    return out;
  }

  /** Moment 3: the Re-scan button. Empties the cache and asks again. */
  async rescan(): Promise<ProviderStatus[]> {
    this.cache.clear();
    this.deps.log?.("[llm] re-scanning providers");
    return this.list(true);
  }

  /**
   * The Test button: ONE real, short call, and it reports what came back.
   *
   * This is the only place in this file that runs anything, and that is the
   * point - "found" and "works" are different claims, and the second one costs
   * a call. A `claude.exe` present but not signed in is the normal state of a
   * fresh machine, and it is exactly what this button exists to reveal before a
   * meeting does.
   */
  async test(id: ProviderId, timeoutMs = 30_000): Promise<{ ok: boolean; detail?: string }> {
    const p = this.get(id);
    if (!p) return { ok: false, detail: "unknown-provider" };
    const av = await p.available();
    if (!av.found) return { ok: false, detail: av.detail ?? "not-found" };
    const ctrl = new AbortController();
    const answer = await p.short("Reply with the single word: ready.", {
      signal: ctrl.signal,
      timeoutMs,
    });
    // The cache is refreshed on the way out: a successful Test is precisely the
    // event that turns "found" into "responded", and the page must see it.
    this.cache.delete(id);
    if (!answer) return { ok: false, detail: "no-answer" };
    return { ok: true };
  }
}
