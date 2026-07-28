import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { IConfig, IGlobalKeyEvent } from "keyspy";
import { HotkeyAdapter, type HookListener } from "../src/main/hotkey";
import type { HookTimers, HookWatchdogPolicy } from "../src/shared/hookWatchdog";
import { hotpath, HOTPATH_ABANDON_REASON, type HotpathAbandonReason } from "../src/shared/hotpath";

// B4: the adapter around keyspy, driven against a FAKE key server.
//
// The real one spawns WinKeyServer.exe, so the whole point of this task - what
// happens when that process dies - could otherwise only be tested by killing a
// binary on a live Windows session. The seam (HotkeyAdapter's createListener
// option) is the same one main/asr/sidecar.ts already uses for spawnProc, and
// for the same reason.
//
// The fake models the ONE behaviour of keyspy that makes this subtle: its
// windows.onError callback fires on the child process's "close" event, which
// happens both when the process crashes AND when keyspy's own kill() kills it.
// A watchdog that cannot tell those apart restarts the hook while Flow is
// quitting, or counts a clean shutdown as a crash.

// ---- the canary on the dependency itself ----
// The premise of this whole task, asserted rather than trusted: if this fails,
// keyspy changed. Re-read its Windows backend before believing anything below.
const KEYSPY_WIN = fs.readFileSync(
  path.join(__dirname, "..", "node_modules", "keyspy", "dist", "platforms", "windows", "index.js"),
  "utf8",
);

test("B4-premise: keyspy's Windows backend installs its close handler ONLY when given an onError", () => {
  assert.match(
    KEYSPY_WIN,
    /if \(this\.config\.onError\)\s*\n?\s*this\.proc\.on\("close", this\.config\.onError\)/,
    "the conditional this task exists for",
  );
  // And it has no restart of its own, unlike the linux/mac backends.
  assert.ok(!/restart/i.test(KEYSPY_WIN), "the Windows backend never restarts its key server");
});

// ---- fakes ----

type Handler = (event: IGlobalKeyEvent) => boolean;

/** One generation of key server. `running` is the invariant under test: it must
 * never be true for two of these at the same time. */
class FakeKeyServer implements HookListener {
  static all: FakeKeyServer[] = [];
  static reset(): void {
    FakeKeyServer.all = [];
  }
  static get liveCount(): number {
    return FakeKeyServer.all.filter((s) => s.running).length;
  }
  static get last(): FakeKeyServer {
    return FakeKeyServer.all[FakeKeyServer.all.length - 1];
  }

  readonly config: IConfig;
  handler: Handler | null = null;
  running = false;
  closed = false;
  /** Set before the adapter builds this one to simulate a spawn failure. */
  static failNextAdd: Error | null = null;
  private failAdd: Error | null = null;

  constructor(config: IConfig) {
    this.config = config;
    this.failAdd = FakeKeyServer.failNextAdd;
    FakeKeyServer.failNextAdd = null;
    FakeKeyServer.all.push(this);
  }

  async addListener(listener: Handler): Promise<void> {
    if (this.failAdd) {
      const err = this.failAdd;
      this.close(1); // execFile emits "error" then "close"
      throw err;
    }
    this.handler = listener;
    this.running = true;
  }

  /** keyspy kills the child process, which CLOSES it - the same event a crash
   * produces. Modelling this is the whole reason stop() has to be careful. */
  kill(): void {
    this.close(0);
  }

  /** Somebody killed WinKeyServer.exe from outside (the B4 end criterion). */
  crash(code = 1): void {
    this.close(code);
  }

  private close(code: number): void {
    this.running = false;
    if (this.closed) return;
    this.closed = true;
    this.config.windows?.onError?.(code);
  }

  send(name: string, state: "DOWN" | "UP"): boolean {
    assert.ok(this.running, "a test delivered a key event to a listener that is not running");
    return this.handler!({ vKey: 0, name, state, scanCode: 0, _raw: "" } as IGlobalKeyEvent);
  }
}

class FakeTimers implements HookTimers {
  private queue = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  now = 0;
  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.queue.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.queue]) {
      if (t.at <= this.now) {
        this.queue.delete(id);
        t.fn();
      }
    }
  }
  get pending(): number {
    return this.queue.size;
  }
}

const FAST_POLICY: HookWatchdogPolicy = { maxRestarts: 3, windowMs: 60_000, baseDelayMs: 10, maxDelayMs: 40 };

interface Harness {
  adapter: HotkeyAdapter;
  timers: FakeTimers;
  events: string[]; // "start" | "stop" | "cancel:<reason>"
  logs: string[];
  healthChanges: number;
}

function makeHarness(policy: HookWatchdogPolicy = FAST_POLICY): Harness {
  FakeKeyServer.reset();
  const timers = new FakeTimers();
  const events: string[] = [];
  const logs: string[] = [];
  const h: Harness = { adapter: null as unknown as HotkeyAdapter, timers, events, logs, healthChanges: 0 };
  h.adapter = new HotkeyAdapter(
    ["CTRL", "WIN"],
    {
      onStart: () => events.push("start"),
      onStop: () => events.push("stop"),
      onCancel: (reason: HotpathAbandonReason) => events.push(`cancel:${reason}`),
    },
    {
      log: (m) => logs.push(m),
      onHealthChange: () => h.healthChanges++,
      createListener: (config) => new FakeKeyServer(config),
      timers,
      policy,
    },
  );
  return h;
}

/** Hold the combo long enough to be a real press (MIN_HOLD_MS is 200 ms and the
 * matcher reads Date.now(), which the fake timers do not move). */
function pressCombo(server: FakeKeyServer): void {
  server.send("LEFT CTRL", "DOWN");
  server.send("LEFT META", "DOWN");
}

// ---- the fix itself ----

test("B4: keyspy is ALWAYS given an onError and an onInfo - without them nothing hears the death", async () => {
  const h = makeHarness();
  await h.adapter.start();
  const cfg = FakeKeyServer.last.config;
  assert.equal(typeof cfg.windows?.onError, "function", "the missing callback that made the bug invisible");
  assert.equal(typeof cfg.windows?.onInfo, "function", "and the key server's stderr, previously discarded");
  h.adapter.stop();
});

test("B4: killing the key server restarts it, and dictation works again", async () => {
  const h = makeHarness();
  await h.adapter.start();
  assert.equal(h.adapter.isArmed(), true);
  const first = FakeKeyServer.last;

  first.crash(1); // <- taskkill WinKeyServer.exe
  assert.equal(h.adapter.isArmed(), false, "the outage is visible IMMEDIATELY, not after a poll");
  assert.equal(h.adapter.health().state, "restarting");
  assert.equal(FakeKeyServer.liveCount, 0);

  h.timers.advance(FAST_POLICY.baseDelayMs);
  await Promise.resolve(); // arm() is async
  assert.equal(FakeKeyServer.all.length, 2, "a NEW listener, because keyspy cannot revive a dead one");
  assert.equal(h.adapter.isArmed(), true, "and the flag says so again");

  // The proof that matters: a press works after the restart.
  pressCombo(FakeKeyServer.last);
  assert.deepEqual(h.events, ["start"]);

  const health = h.adapter.health();
  assert.equal(health.deaths, 1);
  assert.equal(health.restarts, 1);
  assert.match(health.lastIncidentDetail ?? "", /code 1/);
  assert.ok(health.lastIncidentAt !== null && health.lastIncidentAt > 0);
  h.adapter.stop();
});

test("B4: a respawn NEVER leaves two live listeners (two swallow verdicts would be worse than the outage)", async () => {
  const h = makeHarness();
  await h.adapter.start();
  for (let i = 0; i < 3; i++) {
    assert.equal(FakeKeyServer.liveCount, 1, `exactly one listener before death ${i}`);
    FakeKeyServer.last.crash(1);
    assert.equal(FakeKeyServer.liveCount, 0, "and none at all while it is down");
    h.timers.advance(FAST_POLICY.maxDelayMs);
    await Promise.resolve();
  }
  assert.equal(FakeKeyServer.liveCount, 1, "still exactly one after three restarts");
  assert.equal(FakeKeyServer.all.length, 4);
  h.adapter.stop();
  assert.equal(FakeKeyServer.liveCount, 0);
});

test("B4: a hold in flight is cancelled by the death - never a hot microphone behind a key nobody can lift", async () => {
  const h = makeHarness();
  await h.adapter.start();
  pressCombo(FakeKeyServer.last);
  assert.deepEqual(h.events, ["start"]);

  FakeKeyServer.last.crash(1); // the UP event will never arrive: it died with the hook
  assert.deepEqual(h.events, ["start", `cancel:${HOTPATH_ABANDON_REASON.hookDied}`]);
  h.adapter.stop();
});

test("B4: after a restart there is no PHANTOM press - a lost press is fine, an invented one is not", async () => {
  const h = makeHarness();
  await h.adapter.start();
  pressCombo(FakeKeyServer.last);
  FakeKeyServer.last.crash(1);
  h.events.length = 0;

  h.timers.advance(FAST_POLICY.baseDelayMs);
  await Promise.resolve();

  // The user lets the keys go. The NEW listener never saw them go down, so it
  // must treat these as strays - not as the release of a capture, and not as
  // half of a double-tap that would start a hands-free session nobody asked for.
  FakeKeyServer.last.send("LEFT META", "UP");
  FakeKeyServer.last.send("LEFT CTRL", "UP");
  assert.deepEqual(h.events, [], "no start, no stop, no cancel out of thin air");
  h.adapter.stop();
});

test("B4: the crash-loop guard stops - an abandoned hook says so instead of burning the CPU", async () => {
  const eventsBefore = hotpath.snapshot().events.length;
  const h = makeHarness();
  await h.adapter.start();
  for (let i = 0; i <= FAST_POLICY.maxRestarts; i++) {
    FakeKeyServer.last.crash(1);
    h.timers.advance(FAST_POLICY.maxDelayMs);
    await Promise.resolve();
  }
  assert.equal(h.adapter.health().state, "abandoned");
  assert.equal(h.adapter.isArmed(), false);
  assert.equal(h.timers.pending, 0, "nothing is scheduled any more: that is what terminal means");
  assert.equal(FakeKeyServer.liveCount, 0);
  assert.equal(h.adapter.health().deaths, FAST_POLICY.maxRestarts + 1);
  assert.ok(
    h.logs.some((l) => /giving up/.test(l)),
    "and the journal says it in words",
  );
  const kinds = hotpath
    .snapshot()
    .events.slice(eventsBefore)
    .map((e) => e.kind);
  assert.equal(kinds[kinds.length - 1], "hook-abandoned", "the traces record the moment Flow stopped trying");

  // The listener count must stop growing too - an abandoned watchdog that kept
  // spawning would be the crash loop it exists to prevent.
  const built = FakeKeyServer.all.length;
  h.timers.advance(FAST_POLICY.maxDelayMs * 100);
  assert.equal(FakeKeyServer.all.length, built);
  h.adapter.stop();
});

test("B4: stopping Flow is not a crash - keyspy's kill() fires the very same callback", async () => {
  const h = makeHarness();
  await h.adapter.start();
  h.adapter.stop();
  assert.equal(h.adapter.health().deaths, 0, "quitting must never be counted as an incident");
  assert.equal(h.adapter.health().state, "stopped");
  h.timers.advance(FAST_POLICY.maxDelayMs * 10);
  assert.equal(FakeKeyServer.all.length, 1, "and above all, it must not respawn a listener on the way out");
  assert.equal(FakeKeyServer.liveCount, 0);
});

test("B4: the tray pause is not an outage (and an outage is not a pause)", async () => {
  const h = makeHarness();
  await h.adapter.start();
  h.adapter.suspend(true);
  assert.equal(h.adapter.isArmed(), true, "a paused hook is still armed: the user chose this");
  assert.equal(h.adapter.health().deaths, 0);
  assert.equal(FakeKeyServer.liveCount, 1, "and the listener stays up, so the shortcut recorder still works");

  // Keys pass through untouched while suspended...
  assert.equal(FakeKeyServer.last.send("LEFT CTRL", "DOWN"), false);
  assert.deepEqual(h.events, []);

  // ...and a death DURING a pause is still a death.
  FakeKeyServer.last.crash(1);
  assert.equal(h.adapter.health().deaths, 1);
  assert.equal(h.adapter.isArmed(), false);
  h.adapter.stop();
});

test("B4: a death cancels the shortcut recorder instead of letting it swallow the keyboard", async () => {
  const h = makeHarness();
  await h.adapter.start();
  const recording = h.adapter.record();
  FakeKeyServer.last.send("LEFT CTRL", "DOWN"); // gesture under way, every key swallowed

  FakeKeyServer.last.crash(1);
  assert.equal(await recording, null, "the recorder resolves at once rather than waiting out its 10 s timeout");

  // After the restart the keyboard is free again: the recorder is gone, so a
  // key is no longer swallowed system-wide.
  h.timers.advance(FAST_POLICY.baseDelayMs);
  await Promise.resolve();
  assert.equal(FakeKeyServer.last.send("A", "DOWN"), false, "an unrelated key must reach the OS again");
  h.adapter.stop();
});

test("B4: a key server that cannot spawn at all goes through the same policy", async () => {
  const h = makeHarness();
  FakeKeyServer.failNextAdd = new Error("ENOENT: WinKeyServer.exe");
  await assert.rejects(() => h.adapter.start(), /ENOENT/);
  assert.equal(h.adapter.isArmed(), false);
  assert.equal(h.adapter.health().deaths, 1, "counted once, not twice (the close event follows the error)");
  assert.match(h.adapter.health().lastIncidentDetail ?? "", /start failed/);

  h.timers.advance(FAST_POLICY.baseDelayMs);
  await Promise.resolve();
  assert.equal(h.adapter.isArmed(), true, "and the retry brings it up");
  h.adapter.stop();
});

test("B4: health changes are announced immediately - the tray tooltip cannot wait 30 s", async () => {
  const h = makeHarness();
  await h.adapter.start();
  const afterArm = h.healthChanges;
  assert.ok(afterArm >= 1, "the first arm is itself a change");
  FakeKeyServer.last.crash(1);
  assert.equal(h.healthChanges, afterArm + 1, "the death is announced on the spot");
  h.timers.advance(FAST_POLICY.baseDelayMs);
  await Promise.resolve();
  assert.equal(h.healthChanges, afterArm + 2, "and so is the recovery");
  h.adapter.stop();
});

test("B4: the key server's stderr reaches the log, but cannot flood it", async () => {
  const h = makeHarness();
  await h.adapter.start();
  const onInfo = FakeKeyServer.last.config.windows!.onInfo!;
  onInfo("  \n"); // blank lines are not diagnostics
  assert.equal(h.logs.filter((l) => /key server:/.test(l)).length, 0);
  for (let i = 0; i < 100; i++) onInfo(`noise ${i}`);
  const infoLines = h.logs.filter((l) => /key server:/.test(l)).length;
  assert.ok(infoLines > 0, "the diagnostic that used to be discarded is now readable");
  assert.ok(
    infoLines <= 20,
    "but flowLog appends SYNCHRONOUSLY on the thread that owes Windows a hook verdict: it is capped",
  );
  h.adapter.stop();
});

test("B4: a hook death and its recovery appear in the hot-path traces (B1's ring)", async () => {
  const before = hotpath.snapshot().events.length;
  const h = makeHarness();
  await h.adapter.start();
  FakeKeyServer.last.crash(1);
  h.timers.advance(FAST_POLICY.baseDelayMs);
  await Promise.resolve();
  const kinds = hotpath
    .snapshot()
    .events.slice(before)
    .map((e) => e.kind);
  assert.deepEqual(kinds, ["hook-died", "hook-restarted"]);
  h.adapter.stop();
});
