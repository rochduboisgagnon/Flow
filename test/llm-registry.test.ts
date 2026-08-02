import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry, DETECT_TTL_MS } from "../src/main/llm/registry";
import type { Availability, LlmProvider } from "../src/main/llm/provider";

// ---------------------------------------------------------------------------
// P4 (vague P). Detection is resolving a name on the PATH, never running the
// program - and the concrete reason is the 30-second re-probe: liveAssist asks
// for availability every half-minute while its panel is open, so an
// availability that spawned a process would spawn one every 30 seconds for the
// whole length of a meeting.
// ---------------------------------------------------------------------------

function fake(
  id: "ollama" | "claude-cli" | "codex-cli",
  av: Availability,
  opts: { onAvailable?: () => void; short?: () => Promise<string | null>; locality?: "on-this-machine" | "sent-away" } = {},
): LlmProvider {
  return {
    id,
    locality: opts.locality ?? (id === "ollama" ? "on-this-machine" : "sent-away"),
    vendor: id === "ollama" ? "" : "Anthropic",
    available: async () => {
      opts.onAvailable?.();
      return av;
    },
    long: async () => "notes",
    short: opts.short ?? (async () => "ready"),
  };
}

test("P4: availability is cached - twenty probes ask the provider ONCE", async () => {
  let asked = 0;
  const r = new ProviderRegistry({
    providers: [fake("claude-cli", { found: true, responded: false }, { onAvailable: () => asked++ })],
    now: () => 1000,
  });
  for (let i = 0; i < 20; i++) await r.status("claude-cli");
  assert.equal(asked, 1, "this is the 30-second re-probe, and it must be a no-op");
});

test("P4: the cache expires, so installing a CLI does not need a restart", async () => {
  let asked = 0;
  let t = 1000;
  const r = new ProviderRegistry({
    providers: [fake("claude-cli", { found: true, responded: false }, { onAvailable: () => asked++ })],
    now: () => t,
  });
  await r.status("claude-cli");
  t += DETECT_TTL_MS + 1;
  await r.status("claude-cli");
  assert.equal(asked, 2);
});

test("P4: Re-scan empties the cache and asks again - moment three", async () => {
  let asked = 0;
  const r = new ProviderRegistry({
    providers: [fake("claude-cli", { found: true, responded: false }, { onAvailable: () => asked++ })],
    now: () => 1000, // frozen: only the rescan can cause a second ask
  });
  await r.status("claude-cli");
  await r.rescan();
  assert.equal(asked, 2, "installing a CLI is rare, and a stale cache then costs exactly one click");
});

test("P4: found and responded travel separately all the way to the page", async () => {
  const r = new ProviderRegistry({
    providers: [fake("claude-cli", { found: true, responded: false, detail: "not signed in" })],
  });
  const s = (await r.status("claude-cli"))!;
  assert.equal(s.found, true);
  assert.equal(s.responded, false, "a binary on disk without credentials is the normal fresh machine");
  assert.equal(s.detail, "not signed in");
});

test("P4: the page is told WHERE the text goes, by the provider and not by its name", async () => {
  const r = new ProviderRegistry({
    providers: [
      fake("ollama", { found: true, responded: true }),
      fake("claude-cli", { found: true, responded: false }),
    ],
  });
  const list = await r.list();
  assert.equal(list[0].locality, "on-this-machine");
  assert.equal(list[0].vendor, "");
  assert.equal(list[1].locality, "sent-away");
  assert.equal(list[1].vendor, "Anthropic", "a provider that sends text away must name the recipient");
});

test("P4: an unknown provider id falls back to the LOCAL one, never to a remote one", () => {
  const r = new ProviderRegistry({
    providers: [
      fake("ollama", { found: true, responded: true }),
      fake("claude-cli", { found: true, responded: true }),
    ],
  });
  // A settings file naming something absent must degrade to the machine. Falling
  // back to "the first available" would let a corrupt file send a meeting away.
  const p = r.resolve("codex-cli");
  assert.equal(p?.id, "ollama");
  assert.equal(p?.locality, "on-this-machine");
});

test("P4: Flow never elects a provider when several are present", async () => {
  const r = new ProviderRegistry({
    providers: [
      fake("ollama", { found: false, responded: false }),
      fake("claude-cli", { found: true, responded: true }),
      fake("codex-cli", { found: true, responded: true }),
    ],
  });
  const list = await r.list();
  // The registry reports. It has no "pick the best" method at all, and that
  // absence is the design: auto-electing something that bills a subscription
  // and sends a meeting to a third party is not this app's decision to make.
  assert.equal(list.length, 3);
  assert.ok(!("elect" in r), "there is deliberately no such thing here");
});

test("P4: Test makes ONE real short call and reports what came back", async () => {
  let calls = 0;
  const r = new ProviderRegistry({
    providers: [
      fake(
        "claude-cli",
        { found: true, responded: false },
        {
          short: async () => {
            calls++;
            return "ready";
          },
        },
      ),
    ],
  });
  assert.deepEqual(await r.test("claude-cli"), { ok: true });
  assert.equal(calls, 1, "one call, not a loop and not a warm-up");
});

test("P4: Test on a provider that is not installed never calls anything", async () => {
  let calls = 0;
  const r = new ProviderRegistry({
    providers: [
      fake(
        "claude-cli",
        { found: false, responded: false, detail: "claude-not-found" },
        {
          short: async () => {
            calls++;
            return "ready";
          },
        },
      ),
    ],
  });
  const res = await r.test("claude-cli");
  assert.equal(res.ok, false);
  assert.equal(res.detail, "claude-not-found");
  assert.equal(calls, 0);
});

test("P4: a Test that answers nothing is a failure, and says so without inventing a reason", async () => {
  const r = new ProviderRegistry({
    providers: [fake("claude-cli", { found: true, responded: false }, { short: async () => null })],
  });
  assert.deepEqual(await r.test("claude-cli"), { ok: false, detail: "no-answer" });
});

test("P4: a successful Test refreshes the cache - it IS the event that proves 'responded'", async () => {
  let responded = false;
  const provider: LlmProvider = {
    id: "claude-cli",
    locality: "sent-away",
    vendor: "Anthropic",
    available: async () => ({ found: true, responded }),
    long: async () => "x",
    short: async () => {
      responded = true;
      return "ready";
    },
  };
  const r = new ProviderRegistry({ providers: [provider], now: () => 1000 });
  assert.equal((await r.status("claude-cli"))!.responded, false);
  await r.test("claude-cli");
  // Frozen clock: only the cache invalidation inside test() can make this true.
  assert.equal((await r.status("claude-cli"))!.responded, true);
});
