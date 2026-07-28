import test from "node:test";
import assert from "node:assert/strict";
import type { IConfig, IGlobalKeyEvent } from "keyspy";
import { HotkeyAdapter, type HookListener } from "../src/main/hotkey";
import type { HookTimers, HookWatchdogPolicy } from "../src/shared/hookWatchdog";
import type { HotpathAbandonReason } from "../src/shared/hotpath";

// B9 (plan V2): the VOLUNTARY rebuild of the keyboard hook, and the teardown of
// a hold the keyboard can no longer end.
//
// Why a rebuild nobody asked for is a feature and not churn: Microsoft
// documents that Windows silently removes a low-level hook that overran its
// budget and that "there is no way for the application to know whether the hook
// is removed". The key server PROCESS stays alive and healthy, so B4's
// watchdog - which listens for that process to close - hears nothing at all.
// A resume from sleep is when this is most likely (the process was frozen mid
// callback), and rebuilding is the only instrument that exists.
//
// The fake key server below is the same seam and the same shape as
// test/hotkey-restart.test.ts's, kept local to this file on purpose: these are
// two independent tasks against the same adapter and neither should be able to
// break the other's harness.

type Handler = (event: IGlobalKeyEvent) => boolean;

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

  constructor(config: IConfig) {
    this.config = config;
    FakeKeyServer.all.push(this);
  }

  async addListener(listener: Handler): Promise<void> {
    this.handler = listener;
    this.running = true;
  }

  /** keyspy kills the child process, which CLOSES it - the same event a crash
   * produces. A voluntary rebuild goes through this too, which is precisely the
   * thing that must not be counted as an incident. */
  kill(): void {
    this.running = false;
    if (this.closed) return;
    this.closed = true;
    this.config.windows?.onError?.(0);
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
  events: string[];
  logs: string[];
}

function makeHarness(): Harness {
  FakeKeyServer.reset();
  const timers = new FakeTimers();
  const events: string[] = [];
  const logs: string[] = [];
  const adapter = new HotkeyAdapter(
    ["CTRL", "WIN"],
    {
      onStart: () => events.push("start"),
      onStop: () => events.push("stop"),
      onCancel: (reason: HotpathAbandonReason) => events.push(`cancel:${reason}`),
    },
    {
      log: (m) => logs.push(m),
      createListener: (config) => new FakeKeyServer(config),
      timers,
      policy: FAST_POLICY,
    },
  );
  return { adapter, timers, events, logs };
}

function pressCombo(server: FakeKeyServer): void {
  server.send("LEFT CTRL", "DOWN");
  server.send("LEFT META", "DOWN");
}

// ---- rearm() ----

test("B9: rearm() builds a NEW key server and leaves exactly one alive", async () => {
  const h = makeHarness();
  await h.adapter.start();
  assert.equal(FakeKeyServer.all.length, 1);

  await h.adapter.rearm();
  assert.equal(FakeKeyServer.all.length, 2, "a rebuild cannot revive a listener, it replaces it");
  assert.equal(FakeKeyServer.liveCount, 1, "two live listeners would mean two swallow verdicts per keypress");
  assert.equal(h.adapter.isArmed(), true);
  h.adapter.stop();
});

test("B9: dictation works after a voluntary rebuild", async () => {
  const h = makeHarness();
  await h.adapter.start();
  await h.adapter.rearm();
  pressCombo(FakeKeyServer.last);
  assert.deepEqual(h.events, ["start"], "the whole point: the shortcut answers again");
  h.adapter.stop();
});

test("B9: a voluntary rebuild is NOT an incident - it must not inflate the numbers the user reads", async () => {
  const h = makeHarness();
  await h.adapter.start();
  await h.adapter.rearm();
  const health = h.adapter.health();
  assert.equal(health.deaths, 0, "killing our own listener on purpose is not a death");
  assert.equal(health.restarts, 0, "and it is not a recovery from one either");
  assert.equal(health.state, "armed");
  assert.equal(health.lastIncidentAt, null);
  h.adapter.stop();
});

test("B9: no phantom press survives a rebuild - the new listener never saw the keys go down", async () => {
  const h = makeHarness();
  await h.adapter.start();
  pressCombo(FakeKeyServer.last);
  h.events.length = 0;

  await h.adapter.rearm();
  // The user lets the keys go on the NEW listener.
  FakeKeyServer.last.send("LEFT META", "UP");
  FakeKeyServer.last.send("LEFT CTRL", "UP");
  assert.deepEqual(h.events, [], "a lost press is acceptable; an invented stop or double-tap is not");
  h.adapter.stop();
});

test("B9: rearm() after stop() does nothing - a wake during shutdown must not resurrect the hook", async () => {
  const h = makeHarness();
  await h.adapter.start();
  h.adapter.stop();
  const built = FakeKeyServer.all.length;
  await h.adapter.rearm();
  assert.equal(FakeKeyServer.all.length, built, "no new key server");
  assert.equal(FakeKeyServer.liveCount, 0);
  assert.equal(h.adapter.health().state, "stopped");
});

test("B9: a rebuild leaves the tray pause exactly where it was", async () => {
  const h = makeHarness();
  await h.adapter.start();
  h.adapter.suspend(true); // the user paused dictation for 30 minutes
  await h.adapter.rearm();
  assert.equal(FakeKeyServer.last.send("LEFT CTRL", "DOWN"), false, "still paused: keys pass through untouched");
  assert.deepEqual(h.events, []);
  h.adapter.stop();
});

// ---- interruptHold() ----

test("B9: interruptHold() reports a live hold and forgets it", async () => {
  const h = makeHarness();
  await h.adapter.start();
  pressCombo(FakeKeyServer.last);
  assert.deepEqual(h.events, ["start"]);

  assert.equal(h.adapter.interruptHold(), true, "the caller needs to know whether to tear a capture down");
  // The state is gone: a late UP is a stray, not the end of a capture.
  FakeKeyServer.last.send("LEFT META", "UP");
  FakeKeyServer.last.send("LEFT CTRL", "UP");
  assert.deepEqual(h.events, ["start"], "no stop, no cancel invented after the fact");
  h.adapter.stop();
});

test("B9: interruptHold() with nothing in flight is a no-op that says so", async () => {
  const h = makeHarness();
  await h.adapter.start();
  assert.equal(h.adapter.interruptHold(), false);
  assert.deepEqual(h.events, []);
  h.adapter.stop();
});

test("B9: interruptHold() claims no abandon reason - none of the closed vocabulary is true here", async () => {
  const h = makeHarness();
  await h.adapter.start();
  pressCombo(FakeKeyServer.last);
  h.events.length = 0;
  h.adapter.interruptHold();
  assert.deepEqual(
    h.events,
    [],
    "onCancel is NOT called: every reason names a keyboard or engine cause, and the machine sleeping is neither",
  );
  h.adapter.stop();
});

test("B9: interrupt then rebuild - the sequence a resume actually performs", async () => {
  const h = makeHarness();
  await h.adapter.start();
  pressCombo(FakeKeyServer.last); // the user was dictating when the lid closed

  assert.equal(h.adapter.interruptHold(), true);
  await h.adapter.rearm();

  assert.equal(FakeKeyServer.liveCount, 1);
  assert.equal(h.adapter.health().deaths, 0);
  // And the shortcut is genuinely usable again, from a clean state.
  pressCombo(FakeKeyServer.last);
  assert.deepEqual(h.events, ["start", "start"]);
  h.adapter.stop();
});
