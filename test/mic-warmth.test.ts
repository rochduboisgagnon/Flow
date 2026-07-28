import test from "node:test";
import assert from "node:assert/strict";
import {
  PcmRing,
  preRollSamples,
  warmPolicy,
  isMicPrewarm,
  PRE_ROLL_MS,
  WARM_HOLD_MS,
  MAX_FRAME_GAP_MS,
  UNKNOWN_DEVICE,
  deviceIsKnown,
  sameDevice,
  resolveWantedDevice,
  warmGraphIsUsable,
  mayAdoptWarmGraph,
  type DeviceLike,
  type WarmGraphVitals,
} from "../src/shared/micWarmth";

// B2 (plan V2): the microphone pre-warm and pre-roll POLICY. The audio graph
// itself lives in the overlay renderer and needs a real microphone, a real
// AudioContext and a real window; every RULE that bounds it lives here, where
// it can be proven without any of the three.
//
// What these tests defend is not performance - it is the four promises the
// Settings text makes to the user: bounded in time, bounded in size, never
// written down, erased when unused.

// ---- PcmRing: bounded in size, BY CONSTRUCTION ----

function frame(n: number, fill = 1): Float32Array {
  return new Float32Array(n).fill(fill);
}

test("PcmRing never holds more samples than its capacity, however much is pushed", () => {
  const ring = new PcmRing(1000);
  for (let i = 0; i < 500; i++) {
    ring.push(frame(128));
    assert.ok(ring.size <= 1000, `overflowed at push ${i}: ${ring.size}`);
  }
  assert.equal(ring.size, 1000, "at steady state it is exactly full, never more");
});

test("PcmRing trims the OLDEST frame partially rather than overshooting the cap", () => {
  // 100-sample cap, 60-sample frames: after three pushes the ring must hold the
  // most recent 100 samples, which means cutting into the oldest frame.
  const ring = new PcmRing(100);
  ring.push(frame(60, 1));
  ring.push(frame(60, 2));
  assert.equal(ring.size, 100);
  ring.push(frame(60, 3));
  assert.equal(ring.size, 100);
  const kept = ring.drain();
  const total = kept.reduce((n, f) => n + f.length, 0);
  assert.equal(total, 100);
  // The newest audio is the audio that survives: the tail must be the 3s.
  assert.equal(kept[kept.length - 1][0], 3);
});

test("PcmRing with capacity 0 - what the 'off' setting compiles down to - never holds a sample", () => {
  const ring = new PcmRing(0);
  for (let i = 0; i < 100; i++) ring.push(frame(128));
  assert.equal(ring.size, 0);
  assert.deepEqual(ring.drain(), [], "nothing to hand over, because nothing was ever kept");
});

test("PcmRing.drain hands the audio over AND empties itself in one step", () => {
  const ring = new PcmRing(1000);
  ring.push(frame(128));
  ring.push(frame(128));
  const first = ring.drain();
  assert.equal(first.length, 2);
  assert.equal(ring.size, 0, "a drained ring keeps no copy: the pre-roll is consumed exactly once");
  assert.deepEqual(ring.drain(), [], "and a second drain finds nothing");
});

test("PcmRing.clear erases everything without changing what the ring can hold", () => {
  const ring = new PcmRing(500);
  ring.push(frame(400));
  ring.clear();
  assert.equal(ring.size, 0);
  ring.push(frame(400));
  assert.equal(ring.size, 400, "still usable, still capped at 500");
});

test("PcmRing ignores empty frames instead of accumulating them", () => {
  const ring = new PcmRing(100);
  ring.push(new Float32Array(0));
  assert.equal(ring.size, 0);
});

// ---- PcmRing.setCapacity: the bound follows the POLICY, not the construction ----
//
// The V2 review's third finding. `new PcmRing(preRollSamples(policy?.preRollMs
// ?? 0, ...))` read the policy exactly once, at open time, so a policy that
// changed while a graph was alive was never applied to its ring.

test("a ring built while pre-warm was OFF starts holding audio the moment the policy turns on", () => {
  // The exact V2 scenario: the user flips "off" -> "always" DURING a press. The
  // graph outlives the press (that is what "always" means), so without this it
  // would be a microphone held open for the whole session behind a ring that
  // can never hold a single sample - lit, warm, and useless.
  const ring = new PcmRing(preRollSamples(0, 16_000)); // policy was null: capacity 0
  ring.push(frame(4000));
  assert.equal(ring.size, 0, "nothing was buffered while the setting was off");
  ring.setCapacity(preRollSamples(PRE_ROLL_MS, 16_000));
  assert.equal(ring.capacity, 8000);
  ring.push(frame(4000));
  assert.equal(ring.size, 4000, "the pre-roll is live from the instant the policy says so");
});

test("lowering the capacity erases the excess IMMEDIATELY, not at the next release", () => {
  const ring = new PcmRing(8000);
  ring.push(frame(8000));
  assert.equal(ring.size, 8000);
  ring.setCapacity(1000);
  assert.equal(ring.size, 1000, "a privacy bound that only applies later is not a bound");
});

test("setting the capacity to 0 - the 'off' setting, applied in flight - erases everything", () => {
  const ring = new PcmRing(8000);
  ring.push(frame(8000));
  ring.setCapacity(0);
  assert.equal(ring.size, 0);
  assert.equal(ring.capacity, 0);
  ring.push(frame(4000));
  assert.equal(ring.size, 0, "and nothing is ever held again while it stays off");
  assert.deepEqual(ring.drain(), []);
});

test("setCapacity keeps the NEWEST audio, exactly as a push-driven trim does", () => {
  const ring = new PcmRing(300);
  ring.push(frame(100, 1));
  ring.push(frame(100, 2));
  ring.push(frame(100, 3));
  ring.setCapacity(100);
  const kept = ring.drain();
  assert.equal(kept.reduce((n, f) => n + f.length, 0), 100);
  assert.equal(kept[kept.length - 1][0], 3, "the half-second before the keypress, not the one before that");
});

test("a nonsense capacity is 0, never Infinity - the one direction that must never fail open", () => {
  for (const bad of [NaN, Infinity, -1, -0]) {
    const ring = new PcmRing(bad);
    ring.push(frame(128));
    assert.equal(ring.size, 0, `capacity ${String(bad)}`);
    const grown = new PcmRing(1000);
    grown.push(frame(128));
    grown.setCapacity(bad);
    assert.equal(grown.size, 0, `setCapacity(${String(bad)})`);
  }
});

// ---- warmGraphIsUsable: a warm graph is only warm while it is ALIVE ----
//
// The V2 review's first finding, and the blocking one. B2 adopted a warm graph
// on the strength of the object still existing - which was a sound inference
// while a graph was born and died inside one keypress, and stopped being one
// the moment B2 let it outlive the press. Unplug a headset, resume from sleep
// or restart the Windows audio service, and the cue plays, the ribbon animates,
// the phase says "listening" and the capture is empty. In "always" mode that
// repeats on every press until Flow is restarted.

const HEALTHY: WarmGraphVitals = {
  ended: false,
  trackReadyState: "live",
  trackMuted: false,
  contextState: "running",
  msSinceLastFrame: 8, // one render quantum at 16 kHz
};

test("a healthy warm graph is usable - the feature still exists", () => {
  assert.equal(warmGraphIsUsable(HEALTHY), true);
});

test("every single sign of death alone disqualifies a warm graph", () => {
  const dead: Array<[string, Partial<WarmGraphVitals>]> = [
    ["Flow already recorded its death (track.onended fired)", { ended: true }],
    ["the track ended - the device is gone", { trackReadyState: "ended" }],
    ["the track is muted - it renders silence, not audio", { trackMuted: true }],
    ["the context is suspended - it pulls no render quanta", { contextState: "suspended" }],
    ["the context is closed", { contextState: "closed" }],
    ["the context is interrupted", { contextState: "interrupted" }],
    ["no frame has arrived for far longer than any hiccup", { msSinceLastFrame: MAX_FRAME_GAP_MS + 1 }],
  ];
  for (const [why, patch] of dead) {
    assert.equal(warmGraphIsUsable({ ...HEALTHY, ...patch }), false, why);
  }
});

test("frames are the check the platform's own flags cannot make", () => {
  // Everything the platform is willing to SAY is perfect here; the graph has
  // simply stopped rendering. This is the U4 shape of the bug - a capture that
  // succeeds and contains nothing - and it is invisible to readyState.
  assert.equal(warmGraphIsUsable({ ...HEALTHY, msSinceLastFrame: 5_000 }), false);
  assert.equal(warmGraphIsUsable({ ...HEALTHY, msSinceLastFrame: MAX_FRAME_GAP_MS }), true, "the bound itself is fine");
  assert.equal(warmGraphIsUsable({ ...HEALTHY, msSinceLastFrame: NaN }), false, "an unmeasurable gap is not a small one");
  assert.ok(MAX_FRAME_GAP_MS >= 100 && MAX_FRAME_GAP_MS <= 1000, "far above a hiccup, far below a human pause");
});

// ---- device identity: the setting is NOT the microphone ----
//
// The V2 review's second finding. The `micDeviceId` setting defaults to "",
// meaning "whatever Windows calls the default" - a value that stays "" while
// the device behind it changes. Comparing settings answers "did the user pick
// another microphone", never "is this still the same microphone".

function device(deviceId: string, groupId: string, kind = "audioinput"): DeviceLike {
  return { deviceId, groupId, kind };
}

/** A machine with a headset (group g-head) and a built-in mic (group g-built),
 * where Windows currently calls `defaultGroup` the default input. Chromium
 * exposes the default TWICE: a synthetic "default" entry plus the real one. */
function machine(defaultGroup: string): DeviceLike[] {
  return [
    device("default", defaultGroup),
    device("communications", defaultGroup),
    device("id-head", "g-head"),
    device("id-built", "g-built"),
    device("id-cam", "g-cam", "videoinput"),
  ];
}

test("resolveWantedDevice translates the synthetic 'default' entry into the REAL device behind it", () => {
  assert.deepEqual(resolveWantedDevice(machine("g-head"), ""), { deviceId: "id-head", groupId: "g-head" });
});

test("when Windows changes its default input, the SAME setting resolves to a DIFFERENT microphone", () => {
  // This is the whole finding, in two lines. The setting is "" both times.
  const before = resolveWantedDevice(machine("g-head"), "");
  const after = resolveWantedDevice(machine("g-built"), "");
  assert.notDeepEqual(before, after);
  assert.equal(sameDevice(before, after), false, "'the same setting' must never read as 'the same microphone'");
});

test("resolveWantedDevice honours an explicitly picked device that is still present", () => {
  assert.deepEqual(resolveWantedDevice(machine("g-built"), "id-head"), { deviceId: "id-head", groupId: "g-head" });
});

test("a picked device that has disappeared resolves to the default - what getUserMedia would actually open", () => {
  // The constraint is `{ ideal: deviceId }` precisely so an unplugged choice
  // falls back instead of failing the capture; the resolution has to agree with
  // it, or a user whose mic is gone would be sent down the cold path forever.
  assert.deepEqual(resolveWantedDevice(machine("g-built"), "id-gone"), { deviceId: "id-built", groupId: "g-built" });
});

test("resolveWantedDevice ignores anything that is not a microphone", () => {
  assert.deepEqual(resolveWantedDevice([device("id-cam", "g-cam", "videoinput")], ""), UNKNOWN_DEVICE);
  assert.deepEqual(resolveWantedDevice([], ""), UNKNOWN_DEVICE);
});

test("resolveWantedDevice falls back to the only real input when there is no 'default' entry", () => {
  assert.deepEqual(resolveWantedDevice([device("id-head", "g-head")], ""), { deviceId: "id-head", groupId: "g-head" });
});

test("sameDevice compares groupId first, because 'default' and the real entry are the same microphone", () => {
  assert.equal(sameDevice({ deviceId: "default", groupId: "g-head" }, { deviceId: "id-head", groupId: "g-head" }), true);
  assert.equal(sameDevice({ deviceId: "id-head", groupId: "g-head" }, { deviceId: "id-head", groupId: "g-built" }), false);
});

test("sameDevice falls back to deviceId only when a groupId is missing, and never matches the unknown", () => {
  assert.equal(sameDevice({ deviceId: "id-head", groupId: "" }, { deviceId: "id-head", groupId: "" }), true);
  assert.equal(sameDevice(UNKNOWN_DEVICE, UNKNOWN_DEVICE), false, "two ignorances are not an agreement");
  assert.equal(deviceIsKnown(UNKNOWN_DEVICE), false);
  assert.equal(deviceIsKnown({ deviceId: "", groupId: "g-head" }), true);
});

// ---- mayAdoptWarmGraph: the ONE rule, exercised end to end ----

const HEAD = { deviceId: "id-head", groupId: "g-head" };
const BUILT = { deviceId: "id-built", groupId: "g-built" };

function adoption(patch: Partial<Parameters<typeof mayAdoptWarmGraph>[0]> = {}) {
  return mayAdoptWarmGraph({
    graphWantedDeviceId: "",
    graphDevice: HEAD,
    wantedDeviceId: "",
    resolved: HEAD,
    vitals: HEALTHY,
    ...patch,
  });
}

test("a warm graph that is alive, on the right microphone, is adopted", () => {
  assert.equal(adoption(), true);
});

test("a graph whose track has died is NEVER adopted, whatever the setting says", () => {
  assert.equal(adoption({ vitals: { ...HEALTHY, trackReadyState: "ended" } }), false);
  assert.equal(adoption({ vitals: { ...HEALTHY, ended: true } }), false);
  assert.equal(adoption({ vitals: { ...HEALTHY, contextState: "closed" } }), false);
  assert.equal(adoption({ vitals: { ...HEALTHY, msSinceLastFrame: 3_000 } }), false);
});

test("a change of DEFAULT device is not confused with 'the same microphone'", () => {
  // Setting unchanged ("" both sides), graph still perfectly healthy, and the
  // answer is still no: the graph is bound to the headset, and "" now means the
  // built-in mic. Before the fix this read as a match and the user went on
  // dictating into a device they had stopped using.
  assert.equal(adoption({ graphDevice: HEAD, resolved: BUILT }), false);
  assert.equal(adoption({ graphDevice: HEAD, resolved: HEAD }), true, "and an unchanged default still adopts");
});

test("the synthetic 'default' id a track may report is still the device behind it", () => {
  assert.equal(adoption({ graphDevice: { deviceId: "default", groupId: "g-head" }, resolved: HEAD }), true);
});

test("a user who picks another microphone in Settings is answered by the SETTING, immediately", () => {
  assert.equal(adoption({ graphWantedDeviceId: "", wantedDeviceId: "id-built" }), false);
  assert.equal(adoption({ graphWantedDeviceId: "id-head", wantedDeviceId: "id-head", graphDevice: HEAD, resolved: HEAD }), true);
});

test("when the device list is unknown, the rule degrades to the setting - it never invents a match", () => {
  // enumerateDevices threw, or no getUserMedia has been granted yet and every
  // id is blank. Refusing everything would silently disable the feature;
  // pretending to have compared would be the bug this rule exists to kill.
  assert.equal(adoption({ resolved: null }), true, "degrades to B2's setting-only behaviour");
  assert.equal(adoption({ resolved: UNKNOWN_DEVICE }), true);
  assert.equal(adoption({ graphDevice: UNKNOWN_DEVICE, resolved: BUILT }), true, "nothing to compare against");
  assert.equal(adoption({ resolved: null, vitals: { ...HEALTHY, trackReadyState: "ended" } }), false, "liveness still applies");
});

// ---- preRollSamples: never generous ----

test("preRollSamples converts milliseconds to samples and FLOORS", () => {
  assert.equal(preRollSamples(500, 16_000), 8000);
  assert.equal(preRollSamples(1, 16_000), 16);
  // 0.7 ms at 16 kHz is 11.2 samples: 11, never 12. The pre-roll must never be
  // longer than the duration the user was told about.
  assert.equal(preRollSamples(0.7, 16_000), 11);
});

test("preRollSamples answers 0 for anything that is not a positive duration", () => {
  assert.equal(preRollSamples(0, 16_000), 0);
  assert.equal(preRollSamples(-100, 16_000), 0);
  assert.equal(preRollSamples(NaN, 16_000), 0);
  assert.equal(preRollSamples(Infinity, 16_000), 0);
});

// ---- warmPolicy: the ONE translation from setting to behaviour ----

test("warmPolicy('off') is null - no warm microphone and no ring to hold anything", () => {
  assert.equal(warmPolicy("off", ""), null);
  assert.equal(warmPolicy("off", "some-device-id"), null);
});

test("warmPolicy('after') holds the microphone for a bounded time, with the plan's pre-roll", () => {
  const p = warmPolicy("after", "device-1");
  assert.deepEqual(p, { micDeviceId: "device-1", preRollMs: PRE_ROLL_MS, holdMs: WARM_HOLD_MS });
  assert.equal(PRE_ROLL_MS, 500, "the plan's §3.4 number");
  assert.ok(typeof p?.holdMs === "number" && p.holdMs > 0 && p.holdMs <= 10_000);
});

test("warmPolicy('always') expresses 'never release' as null, never as a huge number", () => {
  const p = warmPolicy("always", "");
  assert.equal(p?.holdMs, null, "a distinct value: no arithmetic can turn it into a finite delay");
  assert.equal(p?.preRollMs, PRE_ROLL_MS, "the pre-roll is the same size in every mode");
});

test("warmPolicy carries the chosen microphone through, so a device change can release the graph", () => {
  assert.equal(warmPolicy("after", "abc")?.micDeviceId, "abc");
  assert.equal(warmPolicy("always", "")?.micDeviceId, "", "'' means the system default, and is a real value");
});

test("isMicPrewarm accepts exactly the three modes and nothing else", () => {
  for (const ok of ["off", "after", "always"]) assert.equal(isMicPrewarm(ok), true, ok);
  for (const bad of ["", "on", "true", null, undefined, 1, {}]) assert.equal(isMicPrewarm(bad), false);
});
