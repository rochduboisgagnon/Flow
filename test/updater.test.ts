import test from "node:test";
import assert from "node:assert/strict";
import { FlowUpdater, type UpdaterTimers } from "../src/main/updater";
import type { ChannelEvent, CheckOutcome, UpdateChannel } from "../src/main/update/channel";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE SAS CALME, TESTE POUR LA PREMIERE FOIS.
//
// L'invariant central de src/main/updater.ts est ecrit en tete de ce fichier
// depuis la 1.0.0 : « an update NEVER installs while a dictation or a long
// recording is in flight ». Il n'avait AUCUN test direct. Deux canaris textuels
// (test/diagnostics-wiring.test.ts, test/quit-guard.test.ts) verifiaient que
// d'autres modules consultent le meme `engineBusy`, ce qui prouve le cablage et
// pas le comportement.
//
// La raison etait mecanique et non un oubli : updater.ts importait `electron` et
// `electron-updater` au niveau module, donc l'importer hors d'un vrai processus
// Electron echouait. L'extraction du MECANISME dans un canal injecte (le portage
// macOS avait besoin d'un second mecanisme derriere la meme politique) a rendu
// le fichier importable, et c'est le vrai gain de cette refonte.
// ---------------------------------------------------------------------------

/** Une horloge a manivelle : aucun test n'attend quatre heures. */
class FakeTimers implements UpdaterTimers {
  private once = new Map<number, { at: number; fn: () => void }>();
  private repeat = new Map<number, { every: number; next: number; fn: () => void }>();
  private nextId = 1;
  now = 0;

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.once.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.once.delete(handle as number);
  }
  every(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.repeat.set(id, { every: ms, next: this.now + ms, fn });
    return id;
  }
  clearEvery(handle: unknown): void {
    this.repeat.delete(handle as number);
  }

  /** Nombre de minuteurs encore armes : ce qui prouve qu'un stop() a tout rendu. */
  get armed(): number {
    return this.once.size + this.repeat.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    // Pas de saut : on avance jusqu'a chaque echeance, pour qu'un minuteur arme
    // PENDANT un rappel soit traite a sa vraie date et non tout de suite.
    for (;;) {
      const due = [...this.once.values()].map((t) => t.at).concat([...this.repeat.values()].map((t) => t.next));
      const next = due.filter((at) => at <= target).sort((a, b) => a - b)[0];
      if (next === undefined) break;
      this.now = next;
      for (const [id, t] of [...this.once]) {
        if (t.at <= this.now) {
          this.once.delete(id);
          t.fn();
        }
      }
      for (const [, t] of [...this.repeat]) {
        if (t.next <= this.now) {
          t.next = this.now + t.every;
          t.fn();
        }
      }
    }
    this.now = target;
  }
}

/** Un canal qui n'installe rien et COMPTE : le seul fait qui compte ici est
 * « install() a-t-il ete appele », parce que c'est le geste irreversible. */
class FakeChannel implements UpdateChannel {
  readonly kind = "fake";
  installs = 0;
  checks = 0;
  outcome: CheckOutcome = { ok: true, available: false, version: "2.5.0" };
  private cb: ((e: ChannelEvent) => void) | null = null;

  onEvent(cb: (e: ChannelEvent) => void): void {
    this.cb = cb;
  }
  async check(): Promise<CheckOutcome> {
    this.checks++;
    return this.outcome;
  }
  install(): void {
    this.installs++;
  }
  /** Ce que la vraie bibliothèque emettrait. */
  emit(e: ChannelEvent): void {
    this.cb?.(e);
  }
}

function build(over: Partial<{ busy: boolean; quiet: number }> = {}) {
  const state = { busy: over.busy ?? false, quiet: over.quiet ?? 10 * 60 * 1000 };
  const logs: string[] = [];
  const timers = new FakeTimers();
  const channel = new FakeChannel();
  const updater = new FlowUpdater({
    isBusy: () => state.busy,
    quietForMs: () => state.quiet,
    log: (m) => logs.push(m),
    isPackaged: () => true,
    currentVersion: () => "2.5.0",
    channel,
    timers,
  });
  return { updater, channel, timers, logs, state };
}

test("U-1: an update that is DOWNLOADED does not install while the engine is busy", () => {
  const { updater, channel, timers, state } = build({ busy: true });
  updater.start();

  channel.emit({ kind: "downloaded", version: "2.6.0" });
  assert.equal(updater.state().phase, "downloaded-waiting-quiet");
  // waitForQuiet() tries immediately, then every 30 s. Neither may install.
  assert.equal(channel.installs, 0, "installed while busy on the immediate try");
  timers.advance(10 * 60 * 1000);
  assert.equal(channel.installs, 0, "installed while busy after ten minutes of polling");

  // The engine goes free, but the CONFIRMATION pause has yet to hold.
  state.busy = false;
  timers.advance(30 * 1000); // one poll: arms the confirmation, installs nothing
  assert.equal(channel.installs, 0, "installed without the confirmation pause");
  timers.advance(30 * 1000); // the pause holds
  assert.equal(channel.installs, 1, "never installed even once the machine was quiet");
});

test("U-2: activity DURING the confirmation pause cancels the install, and the poll retries", () => {
  const { updater, channel, timers, state } = build();
  updater.start();
  channel.emit({ kind: "downloaded", version: "2.6.0" });

  // The immediate try arms the confirmation pause. Roch presses the hotkey.
  state.busy = true;
  state.quiet = 0;
  timers.advance(30 * 1000); // pause expires: re-tested, refused
  assert.equal(channel.installs, 0, "installed although a dictation started during the pause");

  // Silence returns, and the poll (still running) gets there on its own.
  state.busy = false;
  state.quiet = 10 * 60 * 1000;
  timers.advance(60 * 1000 + 1000);
  assert.equal(channel.installs, 1, "the poll never retried after a cancelled pause");
});

test("U-3: an update the USER asked for skips the confirmation pause, but never a dictation", async () => {
  const { updater, channel, timers, state } = build({ busy: true, quiet: 0 });
  channel.outcome = { ok: true, available: true, version: "2.6.0" };

  const answer = await updater.checkNow();
  assert.equal(answer.ok, true);
  assert.match(answer.message, /2\.6\.0/);

  channel.emit({ kind: "downloaded", version: "2.6.0" });
  // Asked for, but the engine is dictating: the guarantee that actually matters.
  assert.equal(channel.installs, 0, "a requested update walked over a live dictation");

  // Free now. `quietForMs` is still 0 - and that is the point: a human is
  // sitting there waiting, so the confirmation pause does not apply to them.
  state.busy = false;
  timers.advance(30 * 1000);
  assert.equal(channel.installs, 1, "a requested update still waited out the confirmation pause");
});

test("U-4: the timers are all released BEFORE the process is asked to die", () => {
  const { updater, channel, timers } = build();
  updater.start();
  channel.emit({ kind: "downloaded", version: "2.6.0" });
  timers.advance(60 * 1000 + 1000);
  assert.equal(channel.installs, 1);
  // Nothing may still be armed once install() has been called: the process is
  // about to be replaced, and a surviving interval would poll into a swap.
  assert.equal(timers.armed, 0, "a timer was still armed when install() was called");
});

test("U-5: a straggling progress event cannot demote the phase the UI must not lose", () => {
  const { updater, channel } = build();
  channel.emit({ kind: "available", version: "2.6.0" });
  channel.emit({ kind: "progress", pct: 40 });
  assert.equal(updater.state().phase, "downloading");
  assert.equal(updater.state().pct, 40);
  channel.emit({ kind: "downloaded", version: "2.6.0" });
  channel.emit({ kind: "progress", pct: 60 }); // late, from the same download
  assert.equal(updater.state().phase, "downloaded-waiting-quiet", "a late progress event demoted the phase");
  assert.equal(updater.state().pct, 100);
});

test("U-6: a platform with no published package leaves the updater inert, and SAYS so", async () => {
  const logs: string[] = [];
  const timers = new FakeTimers();
  const updater = new FlowUpdater({
    isBusy: () => false,
    quietForMs: () => 10 * 60 * 1000,
    log: (m) => logs.push(m),
    isPackaged: () => true,
    currentVersion: () => "2.5.0",
    channel: null, // updateChannelFor() returned null for this platform
    timers,
  });
  updater.start();
  assert.equal(timers.armed, 0, "an updater with no channel armed a timer anyway");
  const answer = await updater.checkNow();
  assert.equal(answer.ok, false);
  // « Jamais un controle mort qui a l'air vivant » : le refus doit dire POURQUOI,
  // et ne doit pas se faire passer pour un build de developpement.
  assert.match(answer.message, /platform/i);
  assert.doesNotMatch(answer.message, /development build/i);
  assert.ok(
    logs.some((l) => /no update channel|aucun canal/i.test(l)),
    `nothing was logged about the missing channel: ${JSON.stringify(logs)}`,
  );
});

test("U-7: a development build stays inert for the whole session, with its own message", async () => {
  const logs: string[] = [];
  const timers = new FakeTimers();
  const channel = new FakeChannel();
  const updater = new FlowUpdater({
    isBusy: () => false,
    quietForMs: () => 10 * 60 * 1000,
    log: (m) => logs.push(m),
    isPackaged: () => false,
    currentVersion: () => "2.5.0",
    channel,
    timers,
  });
  updater.start();
  assert.equal(timers.armed, 0);
  const answer = await updater.checkNow();
  assert.equal(answer.ok, false);
  assert.match(answer.message, /development build/i);
  assert.equal(channel.checks, 0, "a development build reached the network");
});

test("U-8: a failed check reports the reason and does not pretend to be up to date", async () => {
  const { updater, channel } = build();
  channel.outcome = { ok: false, message: "net::ERR_NAME_NOT_RESOLVED" };
  const answer = await updater.checkNow();
  assert.equal(answer.ok, false);
  assert.match(answer.message, /ERR_NAME_NOT_RESOLVED/);
  assert.notEqual(updater.state().phase, "up-to-date");
});

test("U-9: with something already in flight, the button answers from state instead of re-checking", async () => {
  const { updater, channel } = build();
  channel.emit({ kind: "available", version: "2.6.0" });
  channel.emit({ kind: "progress", pct: 63 });
  const answer = await updater.checkNow();
  assert.equal(answer.ok, true);
  assert.match(answer.message, /63/);
  assert.equal(channel.checks, 0, "re-checked the feed while a download was already running");
});

test("U-10: the steady cadence keeps checking, and stops dead when stop() is called", () => {
  const { updater, channel, timers } = build();
  updater.start();
  assert.equal(channel.checks, 0, "checked the network before the boot delay elapsed");
  timers.advance(2 * 60 * 1000); // BOOT_DELAY_MS
  assert.equal(channel.checks, 1);
  timers.advance(4 * 60 * 60 * 1000); // CHECK_EVERY_MS
  assert.equal(channel.checks, 2);
  updater.stop();
  timers.advance(24 * 60 * 60 * 1000);
  assert.equal(channel.checks, 2, "kept checking after stop()");
  assert.equal(timers.armed, 0);
});
