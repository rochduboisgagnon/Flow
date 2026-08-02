import test from "node:test";
import assert from "node:assert/strict";
import { parseOwningPid, socketOwnedBy } from "../src/main/asr/portOwner";

// ---------------------------------------------------------------------------
// Security scan F4 + F5 (2026-08-02). The speech engine's port is chosen by
// probe-then-release, so nobody owns it during spawn + model load. waitReady
// then accepted whoever answered HTTP there, and inferOnce posted every
// utterance to them and typed back whatever they returned.
//
// The control is: the socket must belong to the process we spawned. These tests
// pin its three-valued contract, because the difference between "no" and "I
// cannot tell" is the whole design - one must stop everything, the other must
// not brick dictation on a locked-down machine.
// ---------------------------------------------------------------------------

const WIN = { platform: "win32" };

/** The shape of real `netstat -ano -p TCP` output. */
function netstat(port: number, pid: number, state = "LISTENING"): string {
  return [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    `  TCP    0.0.0.0:135            0.0.0.0:0              ${state}       2500`,
    `  TCP    127.0.0.1:${port}         0.0.0.0:0              ${state}       ${pid}`,
    "  TCP    127.0.0.1:52001        142.250.1.1:443        ESTABLISHED     7788",
    "",
  ].join("\r\n");
}

test("F4: the child owns the socket -> accepted", async () => {
  const r = await socketOwnedBy(8178, 4242, { ...WIN, run: async () => netstat(8178, 4242) });
  assert.equal(r, true);
});

test("F4: a DIFFERENT process owns the socket -> refused, not tolerated", async () => {
  const r = await socketOwnedBy(8178, 4242, { ...WIN, run: async () => netstat(8178, 9999) });
  assert.equal(r, false, "this is the squatter, and false is what stops the audio reaching them");
});

test("F4: nothing listening on our port -> unknown, never a silent yes", async () => {
  const r = await socketOwnedBy(8178, 4242, { ...WIN, run: async () => netstat(9999, 111) });
  assert.equal(r, null);
});

test("F4: the query failing -> unknown, and dictation is not bricked", async () => {
  const seen: string[] = [];
  const r = await socketOwnedBy(8178, 4242, {
    ...WIN,
    run: async () => {
      throw new Error("netstat.exe not found");
    },
    log: (m) => seen.push(m),
  });
  assert.equal(r, null);
  assert.equal(seen.length, 1, "a check that could not run is said out loud, not swallowed");
});

test("F4: no pid, or no port, is unknown - never an accidental match", async () => {
  assert.equal(await socketOwnedBy(8178, undefined, WIN), null);
  assert.equal(await socketOwnedBy(0, 4242, WIN), null);
});

test("F4: off Windows we cannot tell, and we say so rather than guessing", async () => {
  let ran = false;
  const r = await socketOwnedBy(8178, 4242, {
    platform: "linux",
    run: async () => {
      ran = true;
      return netstat(8178, 4242);
    },
  });
  assert.equal(r, null);
  assert.equal(ran, false, "and we do not shell out to a tool that is not there");
});

test("F4: the parser is strict - an unrecognised shape is unknown, not zero", () => {
  assert.equal(parseOwningPid(netstat(8178, 4242), 8178), 4242);
  assert.equal(parseOwningPid("", 8178), null);
  assert.equal(parseOwningPid("netstat: command not found", 8178), null);
  assert.equal(parseOwningPid(netstat(8178, 0), 8178), null, "pid 0 is not a process we spawned");
});

test("F4: the parser does not read the State column - netstat IS localized", () => {
  // The same table on French Windows. Reading the State word would have made
  // this check work in English and silently stop working everywhere else.
  const fr = netstat(8178, 4242, "À L'ÉCOUTE");
  assert.equal(parseOwningPid(fr, 8178), 4242);
});

test("F4: an OUTBOUND connection from that port is not a listener", () => {
  const out = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:8178         142.250.1.1:443        ESTABLISHED     9999",
  ].join("\r\n");
  assert.equal(parseOwningPid(out, 8178), null, "a peer other than 0.0.0.0:0 is not a listening socket");
});

test("F4: a port that merely shares a prefix is not a match", () => {
  assert.equal(parseOwningPid(netstat(81780, 4242), 8178), null);
});
