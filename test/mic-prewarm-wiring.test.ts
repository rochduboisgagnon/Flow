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
const README = readSrc("README.md");

function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not find "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

// ---- privacy rule 1: the pre-roll never leaves memory ----

test("the pre-roll ring is only ever pushed to, drained into a capture, cleared, or re-bounded", () => {
  // If a fifth verb ever appears on `ring`, this fails - which is the point.
  // Anything that could copy, encode, send or persist those samples has to be
  // an explicit decision somebody argues for, never a line that slipped in.
  // `setCapacity` IS such a decision (V2 review, finding 3): the bound has to
  // follow the policy in force, not the one that happened to hold when the
  // graph was built - see the test further down.
  const verbs = [...OVERLAY_TSX.matchAll(/\bring\.(\w+)/g)].map((m) => m[1]);
  assert.ok(verbs.length > 0, "the ring must actually be used");
  for (const v of verbs) {
    assert.ok(
      ["push", "drain", "clear", "setCapacity"].includes(v),
      `unexpected operation on the pre-roll ring: ring.${v}()`,
    );
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

test("the ring's capacity KEEPS following the policy after the graph is built", () => {
  // V2 review, finding 3. Reading the policy once, at construction, meant a
  // setting changed during a press was never applied to the ring that press
  // left behind: "off" -> "always" mid-dictation produced a microphone held
  // open for the whole session behind a ring that could hold nothing.
  const apply = slice(OVERLAY_TSX, "function applyWarm(", "function start(");
  assert.match(
    apply,
    /mic\.ring\.setCapacity\(preRollSamples\(next\.preRollMs, SAMPLE_RATE\)\)/,
    "the bound must be re-derived from the policy being applied, not from the one that built the graph",
  );
  const capacityCalls = [...OVERLAY_TSX.matchAll(/setCapacity\(([^)]*\)?[^)]*)\)/g)].map((m) => m[1]);
  for (const arg of capacityCalls) {
    assert.match(arg, /preRollSamples\(/, `a capacity that does not come from the policy: setCapacity(${arg})`);
  }
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
  const adoptAt = start.indexOf("mic.sink === null && graphStillFits(mic, wanted)");
  assert.ok(adoptAt > 0, "the adoption branch must key on warmth AND a graph that is proven still good");
  const adopt = start.slice(adoptAt, start.indexOf("if (mic) releaseMic()"));
  assert.match(adopt, /mic\.ring\.drain\(\)/, "the pre-roll is prepended to the capture");
  assert.doesNotMatch(adopt, /await|getUserMedia|new AudioContext/, "the warm path must not await anything");
});

test("a warm graph for a microphone the user no longer wants is released, not dictated through", () => {
  const start = slice(OVERLAY_TSX, "function start(cfg?: CaptureStartPayload)", "function endCapture()");
  assert.match(start, /if \(mic\) releaseMic\(\);/);
});

// ---- V2 review, finding 1 (blocking): a warm graph is only warm while it LIVES ----
//
// B2 adopted a warm graph on the strength of the object still existing. That
// was a sound inference while a graph was born and died inside one keypress -
// and B2 is precisely the change that made a graph outlive its press. The rule
// itself is pure and exercised for real in test/mic-warmth.test.ts; what is
// asserted here is that the renderer actually ASKS it, and asks it everywhere.

test("the press revalidates the warm graph instead of inferring it from the object existing", () => {
  const start = slice(OVERLAY_TSX, "function start(cfg?: CaptureStartPayload)", "function endCapture()");
  assert.match(start, /graphStillFits\(mic, wanted\)/);
  assert.doesNotMatch(
    start,
    /mic\.micDeviceId === wanted/,
    "the old setting-only guard must be gone, not merely supplemented",
  );
});

test("the SAME rule decides the press and the policy push - one question, one answer", () => {
  const fits = slice(OVERLAY_TSX, "function graphStillFits(", "async function openMic(");
  assert.match(fits, /mayAdoptWarmGraph\(\{/, "the decision lives in the pure, tested rule");
  assert.match(fits, /vitals: vitalsOf\(g\)/, "read off the live objects, never cached");
  assert.match(fits, /resolved: resolvedDevice/);
  const apply = slice(OVERLAY_TSX, "function applyWarm(", "function start(");
  assert.match(
    apply,
    /if \(mic && !graphStillFits\(mic, next\.micDeviceId\)\) releaseMic\(\)/,
    "a graph nobody could dictate through must not be kept open either",
  );
  assert.equal(
    (OVERLAY_TSX.match(/mayAdoptWarmGraph\(/g) ?? []).length,
    1,
    "two places deciding whether a graph is still good is how the first version got a dead one adopted",
  );
});

test("the vitals are read from the TRACK and the CONTEXT, never from a remembered flag", () => {
  const vitals = slice(OVERLAY_TSX, "function vitalsOf(g: MicGraph)", "\n}");
  assert.match(vitals, /trackReadyState: g\.track\.readyState/);
  assert.match(vitals, /trackMuted: g\.track\.muted/);
  assert.match(vitals, /contextState: g\.ctx\.state/);
  assert.match(vitals, /msSinceLastFrame: performance\.now\(\) - g\.lastFrameAt/);
});

test("every delivered frame stamps the graph as alive, before anything decides what to do with it", () => {
  const handler = slice(OVERLAY_TSX, "g.node.port.onmessage = (ev", "// No connection to ctx.destination");
  const stampAt = handler.indexOf("g.lastFrameAt = performance.now()");
  const branchAt = handler.indexOf("if (!g.sink)");
  assert.ok(stampAt > 0, "without this, 'the graph is still rendering' is not a fact anyone holds");
  assert.ok(stampAt < branchAt, "proof of life belongs to the graph, not to whichever mode it is in");
});

test("the death of the device ARRIVES as an event; it is not discovered at the next press", () => {
  const open = slice(OVERLAY_TSX, "async function openMic(", "/** B2: close the microphone NOW");
  assert.match(open, /track\.onended = \(\) => \{/, "a headset unplug must not wait for a keypress to be noticed");
  assert.match(open, /g\.ended = true;/);
  assert.match(open, /ctx\.onstatechange = \(\) => \{/, "a context that stops running renders no audio at all");
  const ended = slice(open, "track.onended = () => {", "ctx.onstatechange");
  assert.match(ended, /if \(mic !== g \|\| g\.sink !== null\) return;/, "a live capture is ended by its own path");
  assert.match(ended, /releaseMic\(\);/);
  assert.match(ended, /applyWarm\(policy\)/, "and the policy decides whether a replacement is opened at all");
});

test("releasing detaches the listeners it installed, so a dead graph cannot ask for a successor", () => {
  const release = slice(OVERLAY_TSX, "function releaseMic()", "function armRelease()");
  assert.match(release, /g\.track\.onended = null/, "stop() fires it - a graph already gone must stay gone");
  assert.match(release, /g\.ctx\.onstatechange = null/, "close() fires it");
  assert.match(release, /g\.ended = true/, "anything still holding a reference must not adopt this");
});

// ---- V2 review, finding 2: the setting is not the microphone ----

test("the graph remembers the REAL device it bound to, not just the string that asked for it", () => {
  assert.match(OVERLAY_TSX, /const bound = track\.getSettings\(\);/);
  assert.match(
    OVERLAY_TSX,
    /device: \{ deviceId: bound\.deviceId \?\? "", groupId: bound\.groupId \?\? "" \}/,
    "'' is the SETTING for 'the system default' and stays '' while the device behind it changes",
  );
  assert.match(OVERLAY_TSX, /wantedDeviceId: deviceId/, "the setting is kept too - it answers a different question");
});

test("a default-device change is heard, because nothing about the TRACK ever reports it", () => {
  assert.match(
    OVERLAY_TSX,
    /navigator\.mediaDevices\?\.addEventListener\("devicechange", onDeviceChange\)/,
    "an open track does not migrate when Windows switches default: it keeps feeding the old microphone",
  );
  const handler = slice(OVERLAY_TSX, "const onDeviceChange = () => {", "navigator.mediaDevices?.addEventListener");
  assert.match(handler, /refreshResolvedDevice\(\)/, "re-resolve what the setting now means");
  assert.match(handler, /if \(mic && mic\.sink !== null\) return;/, "a live dictation is never disturbed");
  assert.match(handler, /applyWarm\(policy\)/, "and the same rule as everywhere else decides what to keep");
  assert.match(
    OVERLAY_TSX,
    /navigator\.mediaDevices\?\.removeEventListener\("devicechange", onDeviceChange\)/,
    "the listener is removed with the window that owns it",
  );
});

test("what '' resolves to is refreshed off the hot path, and never guessed when unknown", () => {
  const refresh = slice(OVERLAY_TSX, "async function refreshResolvedDevice()", "/** B2 revised");
  assert.match(refresh, /resolveWantedDevice\(devices, policy\?\.micDeviceId \?\? mic\?\.wantedDeviceId \?\? ""\)/);
  assert.match(refresh, /resolvedDevice = null;/, "not knowing is a state, handled in the rule - never a false match");
  const open = slice(OVERLAY_TSX, "async function openMic(", "/** B2: close the microphone NOW");
  assert.match(
    open,
    /void refreshResolvedDevice\(\);/,
    "device ids are blank until a getUserMedia is granted: refresh right after one, and await nothing",
  );
});

// ---- V2 review, finding 4: a null policy must release NOW ----

test("a null policy releases the microphone on the spot, never on a timer", () => {
  // This is the channel an outside order uses (CAPTURE_COOL): the lock screen,
  // sleep, the tray's "pause dictation". A user who has just said "stop
  // listening" must not watch Windows' microphone indicator stay lit for
  // another few seconds - that is the literal sense of a privacy breach.
  const apply = slice(OVERLAY_TSX, "function applyWarm(", "function start(");
  const nullBranch = slice(apply, "if (!next) {", "return;");
  assert.match(nullBranch, /releaseMic\(\);/);
  assert.doesNotMatch(nullBranch, /setTimeout|holdMs|armRelease/, "nothing about a null policy may be deferred");
  const release = slice(OVERLAY_TSX, "function releaseMic()", "function armRelease()");
  assert.match(release, /clearTimeout\(releaseTimer\)/, "a pending hold timer must not survive the order");
  assert.match(release, /gen\+\+/, "nor may an acquisition still in flight install itself afterwards");
});

test("the window losing its renderer releases the microphone rather than leaking it", () => {
  const cleanup = OVERLAY_TSX.slice(OVERLAY_TSX.indexOf("return () => {", OVERLAY_TSX.indexOf("onCaptureWarm")));
  assert.match(cleanup, /releaseMic\(\);/);
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
  // 2026-08-04 : `probe?.warm()` et non `probe.warm()`. La sonde lance
  // powershell.exe, donc elle n'est pas construite sur une plateforme qui n'en a
  // pas, et elle reste nulle PAR CONSTRUCTION plutot que par accident (voir la
  // garde de plateforme dans index.ts). Ce que ce test defend est intact : elle est
  // prechauffee la ou elle est construite, jamais paresseusement a la premiere
  // pression.
  assert.match(INDEX_SRC, /void probe\?\.warm\(\);/);
  const boot = slice(INDEX_SRC, "probe = new FocusProbe(", "logLegacyHistoryState()");
  assert.match(boot, /void probe\?\.warm\(\);/, "warmed where it is built, not lazily on the first press");
});

test("the pre-warm policy is derived in exactly ONE place", () => {
  // Shape-tolerant on purpose. The BODY may grow a suspension (V2 finding 4:
  // the lock screen, sleep and the tray's pause have to be able to force a
  // null policy without touching the user's setting); what may never grow is a
  // SECOND place that decides how long Flow may hold a microphone.
  const body = slice(INDEX_SRC, "function applyMicWarmth(): void {", "\n}");
  assert.match(body, /overlay\.setWarmPolicy\(/, "the one function that pushes the policy");
  assert.match(body, /warmPolicy\(settings\.micDeviceId\)/, "one policy, derived here, with no mode to read");
  const calls = INDEX_SRC.match(/applyMicWarmth\(\)/g) ?? [];
  assert.ok(calls.length >= 4, `expected boot + settings change + pre-arm + the definition, got ${calls.length}`);
  assert.equal(
    (INDEX_SRC.match(/warmPolicy\(/g) ?? []).length,
    1,
    "the policy must be computed once, not recomputed at each call site",
  );
});

test("changing the MICROPHONE takes effect immediately, not at the next restart", () => {
  // The prewarm mode is gone, so the only thing left that can change the warm
  // graph from the settings page is which device it holds. It still has to
  // apply live: a graph left open on a microphone the user just stopped using
  // is both the wrong input and an indicator lit for no reason.
  const apply = slice(INDEX_SRC, "function applySettings(", "async function startPtt()");
  assert.match(apply, /next\.micDeviceId !== settings\.micDeviceId/);
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

// ---- the setting itself: there is none any more ----
//
// 2026-07-30, after a human check. `micPrewarm` is removed: one behaviour, no
// choice. These tests now pin the REMOVAL, because a setting is far easier to
// bring back by accident than to delete on purpose.

test("micPrewarm is gone from the settings shape entirely", () => {
  assert.equal("micPrewarm" in SETTINGS_DEFAULTS, false, "not a default any more");
  assert.equal("micPrewarm" in sanitizeSettings({}), false);
});

test("a stored micPrewarm is IGNORED - that silence is the migration", () => {
  // A machine that had "always" is what failed the human check: its Windows
  // microphone indicator stayed lit through a session lock. Reading the field
  // back would restore exactly that. Ignoring it puts every machine on the one
  // guarded behaviour without asking, and a machine that had "off" stops
  // clipping its first word into the bargain.
  for (const stored of ["always", "off", "after", "yes please", true, null]) {
    const out = sanitizeSettings({ micPrewarm: stored }) as unknown as Record<string, unknown>;
    assert.equal("micPrewarm" in out, false, `stored ${JSON.stringify(stored)} must not survive`);
  }
});

// ---- V2 review, finding 5 (blocking): a public promise that went false ----
//
// Not a code defect. The README said, in these words: "Dictation is never
// stored. No history, no database, no in-memory buffer kept around." The
// SHIPPED DEFAULT (micPrewarm: "after") keeps an in-memory audio buffer between
// dictations. The sentence was true when it was written and the feature made it
// false; the feature is worth keeping and the sentence is not.

test("the README no longer claims the thing the shipped default makes untrue", () => {
  assert.doesNotMatch(
    README,
    /no in-memory buffer/i,
    "the default holds one, so this sentence is false as written - say what the buffer IS instead",
  );
  assert.doesNotMatch(README, /Dictation is never stored\./, "replaced by a claim that survives reading the code");
});

test("the README describes the buffer the default ships with: what, why, how bounded, how to kill it", () => {
  // The buffer is unconditional now, so there is no default left to guard.
  assert.match(README, /half a second|half-second/i, "the size, in words a user can check against the setting");
  assert.match(README, /in memory|in RAM/i, "where it lives");
  assert.match(README, /never (be )?written to disk|never written to disk/i, "and where it does NOT");
  assert.match(README, /erased/i, "and that it does not survive the dictation it feeds");
  assert.match(README, /first word/i, "why it exists at all - the alternative is losing it");
  assert.match(README, /microphone indicator/i, "the visible cost, stated rather than discovered");
  assert.match(
    README,
    /no longer a switch|There is no longer a switch/i,
    "and the truth that there is NO way out any more - the section used to promise a one-click Off that no longer exists, which is exactly the kind of stale promise this suite exists to catch",
  );
});

test("the README ANNOUNCES that its central promise changed, rather than quietly editing it", () => {
  // This test was written after the V2 review to stop the README promising
  // something the code had stopped doing. On 2026-07-30 it caught its author:
  // the dictation history made "no history, no transcript on disk" false, and
  // it failed on the very commit that introduced the feature. That is the test
  // working, so it now guards the NEW promise the same way.
  //
  // The rule it encodes: a promise that changes and does not say so was never a
  // promise. Deleting the old sentence silently would have been the cheapest
  // way to look honest while being less so.
  // The old sentence may still APPEAR - the rewrite quotes it, which is how it
  // announces the change. What must be gone is the sentence used as a CLAIM:
  // the bolded bullet a reader skims and takes as the current promise.
  // Forbidding the string outright punished the honest rewrite for being
  // honest, which it did on the first attempt at this very test.
  assert.doesNotMatch(
    README,
    /- \*\*Dictation is never written down\.\*\*/,
    "the old claim must no longer be MADE - quoting it is fine, asserting it is not",
  );
  assert.match(README, /2026-07-30/, "and the README must DATE the change rather than pretend there was none");
  assert.match(README, /central claim/i, "naming what it was, so a reader sees what they are no longer promised");
});

test("what the README still claims absolutely is the part that is still absolute", () => {
  // Two promises now, and only one is total. That distinction is what makes the
  // rewrite honest rather than a retreat.
  assert.match(README, /audio is still never written/i, "the audio promise did not move");
  assert.match(README, /rolling month/i, "and the text promise states its bound");
  assert.match(README, /erases|erase/i, "with the way out named");
  assert.match(README, /leaves this machine|sent anywhere|no cloud/i, "and the promise that never moves");
});

test("Settings still names the COST of the buffer, now that there is no option to weigh", () => {
  // There used to be one help sentence per mode, each stating its cost before
  // its benefit. The modes are gone, but the reason those sentences existed is
  // not: a privacy trade the user cannot read is a trade they did not make -
  // and it matters MORE now, because they can no longer decline it.
  // 2026-08-04, DEUXIEME DEPLACEMENT DE LA JOURNEE, ET C'EST LE SUJET DE CE TEST.
  //
  // La rangee a d'abord ete renommee (« Microphone » designait deja le selecteur
  // de peripherique dans le meme onglet), puis Roch l'a fait retirer : « enleve
  // microphone readiness, ca ne sert absolument a rien de le mettre ». Il avait
  // raison sur la rangee - elle ne reglait rien.
  //
  // CE TEST N'A PAS ETE SUPPRIME AVEC ELLE, et c'est deliberé. Ce qu'il exige
  // n'est pas qu'une rangee existe dans un onglet donne : c'est que le COUT du
  // prechauffage du micro soit ECRIT quelque part que l'utilisateur lit. La
  // phrase a donc demenage dans Storage & Privacy, dont c'est le sujet, et
  // l'ancre suit. Supprimer le test parce que son ancre a bouge aurait transforme
  // un deplacement d'interface en perte de divulgation.
  const help = slice(SETTINGS_PAGE, 'label="The microphone stays ready between dictations"', "</Row>");
  assert.match(help, /microphone indicator/i, "Windows' indicator is the visible cost, and it is stated");
  assert.match(help, /(never|nothing)[^.]*disk/i, "and where the buffer does NOT go");
  assert.match(help, /erased/i, "and that it does not outlive the dictation it feeds");
  assert.match(help, /lock|sleep|tray/i, "and the three gestures that release the microphone outright");
  assert.doesNotMatch(
    SETTINGS_PAGE,
    /aria-label="Microphone pre-warm"/,
    "the control itself must be GONE, not merely hidden - a disabled dropdown would suggest it could come back",
  );
});
