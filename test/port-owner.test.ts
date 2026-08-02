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

// ---------------------------------------------------------------------------
// SECOND SCAN (F4, 3/3, 2026-08-02). The fix above did not hold, and it failed
// the same way the first scan's target had: the control sat on the nominal path
// and an attacker walked around it.
//
// The TCP table is printed whole. With Node's default 1 MiB maxBuffer, a local
// process that opens enough sockets pushes the output past the cap, execFile
// errors, and "could not tell" was returned - after which the caller sent the
// audio anyway. That is a security control an attacker can switch off on
// demand, which is worse than none, because it is believed.
// ---------------------------------------------------------------------------

test("F4 second pass: an output too large to read is a FAILURE, not a shrug", async () => {
  const seen: string[] = [];
  const r = await socketOwnedBy(8178, 4242, {
    platform: "win32",
    run: async () => {
      throw new Error("spawnSync netstat.exe ENOBUFS stdout maxBuffer length exceeded");
    },
    log: (m) => seen.push(m),
  });
  assert.equal(r, false, "an attacker-forced overflow must refuse, never resolve to unknown");
  assert.match(seen.join(" "), /REFUSED/, "and it must be said loudly, not logged as a shrug");
});

test("F4 second pass: an ordinary failure is still unknown, so a locked-down host is not bricked", async () => {
  const r = await socketOwnedBy(8178, 4242, {
    platform: "win32",
    run: async () => {
      throw new Error("spawn netstat.exe ENOENT");
    },
  });
  assert.equal(r, null, "the tool being absent is not evidence of an attack");
});

// ---------------------------------------------------------------------------
// F12 (second scan). Les tests ci-dessus ne prouvaient que l'ANALYSEUR : rien
// ne pilotait la branche du sidecar qui AGIT sur un refus. On pouvait donc
// supprimer le « refuser puis reessayer un autre port » sans qu'un seul test
// tombe.
//
// Ce qui est teste ici est le marqueur qui porte cette decision, parce que
// c'est lui qui distingue « ce port est pris » (essaie ailleurs) de « ce
// backend est mauvais » (condamne-le pour la session). Confondre les deux etait
// la regression que la revue des vagues 3-4 avait trouvee.
//
// HONNETE SUR CE QUI RESTE NON COUVERT : la branche elle-meme n'a pas de
// double de test, et c'est un choix. Le faux lanceur des tests demarre un VRAI
// enfant qui lie vraiment le port, donc le controle y repond `true` comme en
// production ; fabriquer un `false` demanderait une couture, c'est-a-dire un
// interrupteur pour eteindre un controle de securite. Cette ligne dit ou est le
// trou plutot que de le combler par quelque chose de pire.
// ---------------------------------------------------------------------------

test("F12: a stolen port is marked as a PORT fact, never as a bad backend", async () => {
  const { isPortStolen } = await import("../src/main/asr/sidecar");
  const stolen = Object.assign(new Error("another process owns port 8178"), {
    [Symbol.for("flow.portStolen")]: true,
  });
  assert.equal(isPortStolen(stolen), true);
  assert.equal(isPortStolen(new Error("whisper-server died during startup")), false, "un vrai echec de backend");
  assert.equal(isPortStolen(null), false);
  assert.equal(isPortStolen(undefined), false);
  assert.equal(isPortStolen("une chaine"), false);
});
