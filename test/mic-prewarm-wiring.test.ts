import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SETTINGS_DEFAULTS, sanitizeSettings } from "../src/main/settings";

// B2 (plan V2): the microphone pre-warm, the pre-roll, and the two overlay-side
// measurements B1 could not take.
//
// WHY SOURCE TEXT. The audio graph lives in src/renderer/overlay.tsx, which
// mounts a React root into a DOM and drives getUserMedia, an AudioContext and
// an AudioWorklet - none of which exist in this test process, and none of which
// can be faked into existence without rewriting the file around a seam it does
// not need. Same constraint and same technique as test/overlay-cue-guarantee.ts
// and test/quit-guard.test.ts: read the source and assert the SHAPE of what is
// there. The pure half of this feature - what the ring may hold, what each
// setting means - is exercised for real in test/mic-warmth.test.ts.
//
// What this file exists to protect is not speed. It is the four promises the
// Settings text makes about a microphone Flow holds open when the user is not
// dictating, plus the honesty of the two new numbers.

function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}
const OVERLAY_TSX = readSrc("src", "renderer", "overlay.tsx");
const OVERLAY_TS = readSrc("src", "main", "overlay.ts");
const INDEX_SRC = readSrc("src", "main", "index.ts");
const HOTKEY_SRC = readSrc("src", "main", "hotkey.ts");
const PROBE_SRC = readSrc("src", "main", "focus", "probe.ts");
const SETTINGS_PAGE = readSrc("src", "renderer", "ui", "pages", "Settings.tsx");

function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not find "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

// ---- privacy rule 1: the pre-roll never leaves memory ----

test("the pre-roll ring is only ever pushed to, drained into a capture, or cleared", () => {
  // If a fifth verb ever appears on `ring`, this fails - which is the point.
  // Anything that could copy, encode, send or persist those samples has to be
  // an explicit decision somebody argues for, never a line that slipped in.
  const verbs = [...OVERLAY_TSX.matchAll(/\bring\.(\w+)/g)].map((m) => m[1]);
  assert.ok(verbs.length > 0, "the ring must actually be used");
  for (const v of verbs) {
    assert.ok(["push", "drain", "clear"].includes(v), `unexpected operation on the pre-roll ring: ring.${v}()`);
  }
});

test("the overlay renderer touches no disk, no network and no storage at all", () => {
  for (const forbidden of [
    /require\(\s*["']fs["']\s*\)/,
    /\bfetch\s*\(/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /XMLHttpRequest/,
    /new\s+WebSocket/,
  ]) {
    assert.doesNotMatch(OVERLAY_TSX, forbidden, `overlay.tsx must not contain ${forbidden}`);
  }
});

test("the only audio that leaves the overlay is a finished dictation's WAV", () => {
  // sendCaptureDone is the ONE channel carrying samples out of this window.
  // sendCaptureTiming carries two numbers; sendCaptureError carries a message.
  const senders = [...OVERLAY_TSX.matchAll(/api\.send(\w+)|window\.agrflow\.send(\w+)/g)]
    .map((m) => m[1] ?? m[2])
    .filter((v, i, a) => a.indexOf(v) === i);
  assert.deepEqual(
    senders.sort(),
    ["CaptureDone", "CaptureError", "CaptureTiming"],
    "a new sender out of the window that owns the microphone is a decision, not a detail",
  );
});

// ---- privacy rule 2: bounded in size, and off means off ----

test("the ring's capacity comes from the policy, so the 'off' setting builds a zero-capacity ring", () => {
  assert.match(
    OVERLAY_TSX,
    /ring:\s*new PcmRing\(preRollSamples\(policy\?\.preRollMs \?\? 0, SAMPLE_RATE\)\)/,
    "no policy must mean no capacity - not a ring that is emptied often",
  );
});

test("a warm-but-idle graph pushes to the ring and does nothing else with the audio", () => {
  const handler = slice(OVERLAY_TSX, "g.node.port.onmessage = (ev", "// No connection to ctx.destination");
  const idleBranch = slice(handler, "if (!g.sink) {", "g.sink.push(frame)");
  assert.match(idleBranch, /g\.ring\.push\(frame\)/);
  assert.match(idleBranch, /return;/, "the idle branch must return before any analysis of the audio");
  assert.doesNotMatch(idleBranch, /levelRef/, "idle audio is not levelled");
  assert.doesNotMatch(idleBranch, /encodeWav|floatTo16BitPcm|send/, "idle audio is not encoded or sent");
});

// ---- privacy rule 3: bounded in time, and erased when unused ----

test("releasing the microphone stops the tracks AND erases the pre-roll", () => {
  const release = slice(OVERLAY_TSX, "function releaseMic()", "function armRelease()");
  assert.match(release, /g\.ring\.clear\(\)/, "the pre-roll never outlives the microphone that filled it");
  assert.match(release, /g\.stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/, "the indicator must actually go out");
  assert.match(release, /g\.ctx\.close\(\)/);
  assert.match(release, /gen\+\+/, "an acquisition in flight must not install itself after a release");
  assert.match(release, /onmessage = null/, "no frame handler may survive its graph");
});

test("ending a capture erases the pre-roll that seeded it", () => {
  const end = slice(OVERLAY_TSX, "function endCapture()", "function stop()");
  assert.match(end, /g\.ring\.clear\(\)/);
  assert.match(end, /g\.sink = null/);
  assert.match(
    end,
    /applyWarm\(policy\)/,
    "the hold window - or the immediate close - is re-decided from the CURRENT policy, every time",
  );
});

test("a policy change made DURING a press is settled at the end of it, not ignored", () => {
  // applyWarm defers while a capture owns the microphone (asserted above), so
  // something has to pick that decision back up. If this ever stops being
  // applyWarm, a user who switches microphone mid-dictation keeps the old one
  // warm and lit for the whole hold window.
  const end = slice(OVERLAY_TSX, "function endCapture()", "function stop()");
  assert.match(end, /applyWarm\(policy\)/);
});

test("with no policy, the microphone is closed the instant a capture ends", () => {
  const arm = slice(OVERLAY_TSX, "function armRelease()", "function applyWarm(");
  const offBranch = slice(arm, "if (!policy)", "}");
  assert.match(offBranch, /releaseMic\(\)/, "'off' must mean the mic is only ever open while holding");
  assert.match(arm, /policy\.holdMs === null/, "'always' is the only mode that never arms the timer");
  assert.match(arm, /setTimeout\(/, "'after' releases on a timer, not on the next press");
});

test("a cool command never cuts a dictation that is already running", () => {
  const apply = slice(OVERLAY_TSX, "function applyWarm(", "function start(");
  const guardAt = apply.indexOf("mic.sink !== null");
  const releaseAt = apply.indexOf("releaseMic()");
  assert.ok(guardAt > 0, "applyWarm must check whether a capture owns the microphone");
  assert.ok(releaseAt > guardAt, "and it must return BEFORE it could release one");
  assert.match(apply.slice(guardAt), /^[^\n]*\n?\s*return;/m);
});

// ---- the pre-roll is what makes the first word unloseable ----

test("a warm graph is adopted synchronously - no acquisition between the key and the audio", () => {
  const start = slice(OVERLAY_TSX, "function start(cfg?: CaptureStartPayload)", "function endCapture()");
  const adoptAt = start.indexOf("mic.sink === null && mic.micDeviceId === wanted");
  assert.ok(adoptAt > 0, "the adoption branch must key on BOTH warmth and the chosen device");
  const adopt = start.slice(adoptAt, start.indexOf("if (mic) releaseMic()"));
  assert.match(adopt, /mic\.ring\.drain\(\)/, "the pre-roll is prepended to the capture");
  assert.doesNotMatch(adopt, /await|getUserMedia|new AudioContext/, "the warm path must not await anything");
});

test("a warm graph for a microphone the user no longer wants is released, not dictated through", () => {
  const start = slice(OVERLAY_TSX, "function start(cfg?: CaptureStartPayload)", "function endCapture()");
  assert.match(start, /if \(mic\) releaseMic\(\);/);
});

test("the start cue still fires before anything else, exactly as B3 left it", () => {
  const start = slice(OVERLAY_TSX, "function start(cfg?: CaptureStartPayload)", "const wanted =");
  const cueAt = start.indexOf('playCue("start")');
  assert.ok(cueAt > 0, "the cue must still be in start()");
  assert.ok(start.indexOf("mic") === -1 || start.indexOf("mic") > cueAt, "and nothing microphone-related may precede it");
});

// ---- the two measurements B1 could not take ----

test("the overlay reports DURATIONS on its own clock, never timestamps", () => {
  assert.match(OVERLAY_TSX, /timing = \{ startedAt: performance\.now\(\)/);
  assert.match(OVERLAY_TSX, /timing\.sampleMs = performance\.now\(\) - timing\.startedAt/);
  assert.match(OVERLAY_TSX, /timing\.paintMs = now - timing\.startedAt/);
  const send = slice(OVERLAY_TSX, "function reportTiming()", "\n}");
  assert.match(send, /firstPaintMs: timing\.paintMs, firstSampleMs: timing\.sampleMs/);
  assert.doesNotMatch(send, /Date\.now|startedAt\s*[,}]/, "an absolute instant from this process must never cross over");
});

test("a warm press reports 0 for 'microphone capturing': the audio predates the key", () => {
  const start = slice(OVERLAY_TSX, "function start(cfg?: CaptureStartPayload)", "function endCapture()");
  assert.match(start, /if \(seed\.length > 0\)/, "only when the pre-roll actually held something");
  assert.match(start, /timing\.sampleMs = 0/);
});

test("both numbers are only sent once both are known, and a failure to send is swallowed", () => {
  const report = slice(OVERLAY_TSX, "function reportTiming()", "\n}");
  assert.match(report, /timing\.sent \|\| timing\.paintMs === null \|\| timing\.sampleMs === null/);
  assert.match(report, /timing\.sent = true/, "exactly one message per press");
  assert.match(report, /catch \{/, "diagnostics must never be able to break a dictation");
});

test("main folds the two durations in through hotpath, never by comparing clocks", () => {
  assert.match(INDEX_SRC, /ipcMain\.on\(CAPTURE_TIMING/);
  const handler = slice(INDEX_SRC, "ipcMain.on(CAPTURE_TIMING", "});");
  assert.match(handler, /hotpath\.markOverlayTimings\(payload\.firstPaintMs, payload\.firstSampleMs\)/);
  assert.doesNotMatch(handler, /performance\.now|Date\.now/, "main must not stamp a renderer-side event itself");
});

// ---- the wiring in main ----

test("the focus probe is pre-warmed at startup, off the dictation path", () => {
  assert.match(PROBE_SRC, /async warm\(\): Promise<void>/);
  assert.match(INDEX_SRC, /void probe\.warm\(\);/);
  const boot = slice(INDEX_SRC, "probe = new FocusProbe(", "logLegacyHistoryState()");
  assert.match(boot, /void probe\.warm\(\);/, "warmed where it is built, not lazily on the first press");
});

test("the pre-warm policy is derived in exactly ONE place", () => {
  assert.match(INDEX_SRC, /function applyMicWarmth\(\): void \{\s*\n\s*overlay\.setWarmPolicy\(warmPolicy\(settings\.micPrewarm, settings\.micDeviceId\)\);/);
  const calls = INDEX_SRC.match(/applyMicWarmth\(\)/g) ?? [];
  assert.ok(calls.length >= 4, `expected boot + settings change + pre-arm + the definition, got ${calls.length}`);
  assert.equal(
    (INDEX_SRC.match(/warmPolicy\(/g) ?? []).length,
    1,
    "the policy must be computed once, not recomputed at each call site",
  );
});

test("turning the setting off takes effect immediately, not at the next restart", () => {
  const apply = slice(INDEX_SRC, "function applySettings(", "async function startPtt()");
  assert.match(apply, /next\.micPrewarm !== settings\.micPrewarm \|\| next\.micDeviceId !== settings\.micDeviceId/);
  assert.match(apply, /if \(warmthChanged\) applyMicWarmth\(\);/);
});

test("the pre-arm callback is optional and fires on the rising edge only", () => {
  assert.match(HOTKEY_SRC, /onPreArm\?\(\): void;/, "an adapter built without it must still dictate");
  const handle = slice(HOTKEY_SRC, "private handleKey =", "/** Shortcut recorder");
  assert.match(handle, /const armed = this\.matcher\.preArmed\(\);/);
  assert.match(handle, /if \(armed && !this\.wasPreArmed\) this\.cbs\.onPreArm\?\.\(\);/);
  const armedAt = handle.indexOf("const armed =");
  const latencyAt = handle.indexOf("hotpath.sampleHandlerLatency");
  assert.ok(
    armedAt < latencyAt,
    "the pre-arm runs INSIDE the hook callback, so its cost must be inside the number that measures that callback",
  );
});

test("the warm policy survives a renderer reload", () => {
  const load = slice(OVERLAY_TS, 'webContents.on("did-finish-load"', "if (dev) this.win.loadURL");
  const warmAt = load.indexOf("setWarmPolicy");
  const startAt = load.indexOf("this.startCapture(cfg)");
  assert.ok(warmAt > 0, "a reloaded overlay with no policy would silently stop pre-warming");
  assert.ok(startAt > warmAt, "the policy is applied before a press that beat the load");
  assert.match(load, /this\.warmPolicy !== undefined/, "never set is not the same as set to off");
});

test("sending the warm policy can never throw into the keyboard hook's callback", () => {
  const setter = slice(OVERLAY_TS, "setWarmPolicy(cfg: CaptureWarmPayload | null)", "startCapture(cfg: CaptureStartPayload)");
  assert.match(setter, /try \{/);
  assert.match(setter, /overlaySendFailed/, "the catch must be named, not silent");
  assert.match(setter, /setImmediate\(/, "flowLog writes to disk: never on that stack");
});

// ---- the setting itself ----

test("the default is the middle setting: bounded warmth, not off and not always", () => {
  assert.equal(SETTINGS_DEFAULTS.micPrewarm, "after");
});

test("a corrupt or missing micPrewarm falls back to the default rather than to a wilder mode", () => {
  assert.equal(sanitizeSettings({}).micPrewarm, "after");
  assert.equal(sanitizeSettings({ micPrewarm: "yes please" }).micPrewarm, "after");
  assert.equal(sanitizeSettings({ micPrewarm: true }).micPrewarm, "after");
  assert.equal(sanitizeSettings({ micPrewarm: "off" }).micPrewarm, "off");
  assert.equal(sanitizeSettings({ micPrewarm: "always" }).micPrewarm, "always");
});

test("Settings > Dictation names the cost of every option, not just the benefit", () => {
  const help = slice(SETTINGS_PAGE, "const PREWARM_HELP", "function TabDictation");
  assert.match(help, /off:[\s\S]*?can be clipped/, "'off' must say what it costs the user");
  assert.match(help, /after:[\s\S]*?microphone indicator/, "'after' must name Windows' indicator");
  assert.match(help, /always:[\s\S]*?stays lit/, "'always' must be blunt about it");
  for (const mode of ["after", "always"]) {
    const line = slice(help, `${mode}:`, "\n");
    assert.match(line, /(never|nothing)[^.]*disk/i, `${mode} must state where the buffer does NOT go`);
  }
  assert.match(SETTINGS_PAGE, /aria-label="Microphone pre-warm"/);
});
