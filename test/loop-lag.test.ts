import test from "node:test";
import assert from "node:assert/strict";
import {
  LoopLagSampler,
  realScheduler,
  LOOP_LAG_ACTIVE_PERIOD_MS,
  LOOP_LAG_IDLE_PERIOD_MS,
  type LagScheduler,
} from "../src/shared/loopLag";

// B11 (plan V2, trigger T1 of §3.6.6). The sampler takes its clock AND its
// timer through deps, so everything below runs an entire session in zero real
// time and asserts on exact numbers - no sleeps, no tolerances, no flake. The
// two tests at the bottom use the real timer on purpose: they are what proves
// the injected version is not measuring an imaginary loop.

class FakeScheduler implements LagScheduler {
  private t = 0;
  private timers = new Map<number, { period: number; fn: () => void }>();
  private nextId = 1;

  now(): number {
    return this.t;
  }

  every(periodMs: number, fn: () => void): () => void {
    const id = this.nextId++;
    this.timers.set(id, { period: periodMs, fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Move the clock to `at` and run the one live timer's callback. Asserts
   * there is exactly one: two timers feeding the same ring would double-count
   * every sample, which is precisely the bug re-arming could introduce. */
  fireAt(at: number): void {
    assert.equal(this.timers.size, 1, "exactly one timer must be live at any moment");
    this.t = at;
    [...this.timers.values()][0].fn();
  }

  get liveTimers(): number {
    return this.timers.size;
  }

  get livePeriod(): number | null {
    const only = [...this.timers.values()][0];
    return only ? only.period : null;
  }
}

function make(opts: { isActive?: () => boolean } = {}) {
  const scheduler = new FakeScheduler();
  const samples: number[] = [];
  const sampler = new LoopLagSampler({
    scheduler,
    onSample: (ms) => samples.push(ms),
    isActive: opts.isActive ?? (() => true),
    activePeriodMs: 20,
    idlePeriodMs: 500,
  });
  return { scheduler, samples, sampler };
}

// ---- what a sample IS ----

test("lag is observed minus EXPECTED, never the raw delta between two ticks", () => {
  const { scheduler, samples, sampler } = make();
  sampler.start(); // baseline taken at t=0, so the first appointment is t=20
  scheduler.fireAt(20); // exactly on time
  scheduler.fireAt(45); // appointment was 40: 5 ms late (the raw delta is 25)
  scheduler.fireAt(85); // appointment was 65: 20 ms late (the raw delta is 40)
  assert.deepEqual(samples, [0, 5, 20]);
  // Spelled out, because this is the single mistake the whole file guards:
  assert.ok(!samples.includes(25), "25 ms is the inter-tick delta, not the lag");
  assert.ok(!samples.includes(40), "40 ms is the inter-tick delta, not the lag");
});

test("a timer that fires a hair EARLY reports zero, never a negative", () => {
  const { scheduler, samples, sampler } = make();
  sampler.start();
  scheduler.fireAt(19); // one millisecond early
  assert.deepEqual(samples, [0]);
});

test("one long stall does not poison every later sample", () => {
  // The reason the appointment is derived from the PREVIOUS tick's real firing
  // time and not from an absolute grid: Node reschedules a repeating timer from
  // when it fired, so a grid anchored at start would report the stall forever.
  const { scheduler, samples, sampler } = make();
  sampler.start();
  scheduler.fireAt(520); // the loop was blocked: 500 ms late
  scheduler.fireAt(540); // back to normal
  scheduler.fireAt(560);
  assert.deepEqual(samples, [500, 0, 0]);
});

// ---- the two cadences (the cost decision, see shared/loopLag.ts) ----

test("the cadence follows isActive, and only one timer is ever live", () => {
  let active = true;
  const { scheduler, sampler } = make({ isActive: () => active });
  sampler.start();
  assert.equal(sampler.periodMs, 20);
  assert.equal(scheduler.livePeriod, 20);

  active = false;
  scheduler.fireAt(20); // this tick samples, then re-arms at the idle cadence
  assert.equal(sampler.periodMs, 500);
  assert.equal(scheduler.livePeriod, 500);
  assert.equal(scheduler.liveTimers, 1, "re-arming must replace the timer, not add one");

  active = true;
  scheduler.fireAt(520);
  assert.equal(sampler.periodMs, 20);
  assert.equal(scheduler.liveTimers, 1);
});

test("a cadence change rebaselines the appointment instead of inheriting the old one", () => {
  let active = true;
  const { scheduler, samples, sampler } = make({ isActive: () => active });
  sampler.start();
  active = false;
  scheduler.fireAt(20); // on time for the fast cadence; re-arms, appointment = 520
  scheduler.fireAt(530); // 10 ms late for the SLOW cadence
  assert.deepEqual(samples, [0, 10], "510 would mean the 20 ms appointment survived the switch");
});

test("start() is idempotent and stop() leaves nothing running", () => {
  const { scheduler, sampler } = make();
  sampler.start();
  sampler.start();
  assert.equal(scheduler.liveTimers, 1);
  assert.ok(sampler.running);
  sampler.stop();
  assert.equal(scheduler.liveTimers, 0);
  assert.equal(sampler.running, false);
  sampler.stop(); // stopping twice is not an error
  assert.equal(scheduler.liveTimers, 0);
});

test("the shipped cadences are the ones the panel and the CLI advertise", () => {
  assert.equal(LOOP_LAG_ACTIVE_PERIOD_MS, 20);
  assert.equal(LOOP_LAG_IDLE_PERIOD_MS, 500);
  // Defaults, when a caller passes neither.
  const scheduler = new FakeScheduler();
  const sampler = new LoopLagSampler({ scheduler, onSample: () => {}, isActive: () => true });
  sampler.start();
  assert.equal(sampler.periodMs, LOOP_LAG_ACTIVE_PERIOD_MS);
  sampler.stop();
});

// ---- the real timer: the part that proves the rest is not a simulation ----

test("realScheduler actually fires, and stopping it actually stops it", async () => {
  const sc = realScheduler();
  let ticks = 0;
  const stop = sc.every(5, () => ticks++);
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const afterStop = ticks;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(afterStop > 0, "the timer never fired");
  assert.equal(ticks, afterStop, "the timer kept firing after it was stopped");
});

test("a real blocked event loop shows up as real lag", async () => {
  const samples: number[] = [];
  const sampler = new LoopLagSampler({
    scheduler: realScheduler(),
    onSample: (ms) => samples.push(ms),
    isActive: () => true,
    activePeriodMs: 5,
    idlePeriodMs: 5,
  });
  sampler.start();
  await new Promise((r) => setTimeout(r, 30));
  // Block the loop the way a synchronous decode does: no await, no yield.
  const until = performance.now() + 150;
  while (performance.now() < until) {
    /* deliberately spinning */
  }
  await new Promise((r) => setTimeout(r, 30));
  sampler.stop();
  const worst = Math.max(...samples);
  assert.ok(samples.length > 0, "no samples were taken at all");
  assert.ok(worst > 80, `a 150 ms block should have shown up as lag; worst was ${worst.toFixed(1)} ms`);
});
