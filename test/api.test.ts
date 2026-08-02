import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { LocalApi } from "../src/main/api";
import { encodeWav } from "../src/shared/wav";

// The local API exercised over real HTTP with a mock transcriber: routes,
// discovery file, quiet-window semantics, and the transcribe round-trip.

interface Reply {
  code: number;
  body: Record<string, unknown>;
}

// Security scan F2 (2026-08-02): the API now requires its session token on
// EVERY request, not only on ones that admit to being browser-issued. So these
// helpers carry it by default, and `auth(api)` is called right after start() in
// each test - a reader can see at a glance that these requests are
// authenticated. A test exercising the REFUSAL passes "" explicitly, which
// makes the omission visible at the call site instead of being the default.
let TOKEN = "";
function auth(api: LocalApi): void {
  TOKEN = api.sessionToken();
}

// agent:false on every call: Node's default agent keeps sockets alive, and a
// pooled socket from a previous (closed) server on the same port would die
// with ECONNRESET instead of reconnecting.
function get(port: number, p: string, token: string = TOKEN): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: p, agent: false, headers: token ? { "X-Flow-Token": token } : {} }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({ code: res.statusCode ?? 0, body: JSON.parse(d) as Record<string, unknown> }),
        );
      })
      .on("error", reject);
  });
}

function post(port: number, p: string, body: Uint8Array, token: string = TOKEN): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": body.length,
          ...(token ? { "X-Flow-Token": token } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({ code: res.statusCode ?? 0, body: JSON.parse(d) as Record<string, unknown> }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function longDepsStub() {
  const calls: string[] = [];
  return {
    calls,
    getSettings: () => {
      calls.push("getSettings");
      return { settings: { combo: ["CTRL", "WIN"] }, status: "ready" };
    },
    setSettings: (patch: Record<string, unknown>) => {
      calls.push("setSettings:" + Object.keys(patch).sort().join(","));
      return { ok: true };
    },
    recordShortcut: () => {
      calls.push("record");
      return Promise.resolve({ combo: ["CTRL", "WIN"] });
    },
    listMics: () => Promise.resolve([{ id: "m1", label: "Mic" }]),
    ollamaModels: () => Promise.resolve(["gemma3:4b"]),
    quit: () => {
      calls.push("quit");
    },
    longState: () => {
      calls.push("state");
      return { active: false };
    },
    longStart: (o: { dir?: string; title?: string; keepAudio?: boolean }) => {
      calls.push("start:" + (o.dir ?? "stage") + ":" + (o.keepAudio ? "audio" : "noaudio"));
      return { ok: true };
    },
    longStop: () => {
      calls.push("stop");
      return { ok: true };
    },
    longSave: (dir: string) => {
      calls.push("save:" + dir);
      return { ok: true, docPath: dir + "\\note.md" };
    },
    longMark: () => {
      calls.push("mark");
      return { ok: true };
    },
    longChunk: (pcm: Int16Array) => {
      calls.push("chunk:" + pcm.length);
      return { ok: true };
    },
    longGap: (seconds: number) => {
      calls.push("gap:" + seconds);
      return { ok: true };
    },
    longTranscript: (since: number) => {
      calls.push("transcript:" + since);
      return { text: "hello", nextSince: 5 };
    },
    longStartNative: (o: { title?: string; keepAudio?: boolean; captureSystem?: boolean }) => {
      calls.push("start-native:" + (o.captureSystem ? "sys" : "mic") + ":" + (o.keepAudio ? "audio" : "noaudio"));
      return { ok: true };
    },
    longNotesSplice: (docPath: string, _notes: string) => {
      calls.push("notes-splice:" + docPath);
      return { ok: true };
    },
    listHistory: () => [],
    resolveHistoryEntry: () => null,
    readHistoryDoc: () => null,
    canLoopback: () => true,
    hotpathSnapshot: () => {
      calls.push("hotpath-snapshot");
      return { completed: [], open: [], handlerLatenciesMs: [] };
    },
    // B5: the self-diagnostic. Async here too, because the real one enumerates
    // audio devices through a renderer.
    selfCheck: () => {
      calls.push("self-check");
      return Promise.resolve({ generatedAtIso: "2026-07-27T00:00:00.000Z", worst: "ok", lines: [] });
    },
  };
}

test("local API: status, readiness, transcribe, discovery file", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-test-${process.pid}.json`);
  let listening = false;
  const seen: Array<{ bytes: number }> = [];
  const api = new LocalApi({
    version: "9.9.9-test",
    isListening: () => listening,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: (wav) => {
      seen.push({ bytes: wav.length });
      return Promise.resolve({ text: "bonjour le test", ms: 42 });
    },
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const disco = JSON.parse(fs.readFileSync(info, "utf8"));
    assert.equal(disco.app, "agr-flow");
    assert.equal(disco.pid, process.pid);
    const port = disco.port as number;

    const status = await get(port, "/status");
    assert.equal(status.code, 200);
    assert.equal(status.body.app, "agr-flow");
    assert.equal(status.body.version, "9.9.9-test");
    assert.equal(status.body.engineWarm, true);
    assert.equal(status.body.listening, false);

    // Quiet window flips with the listening state (plan 8).
    assert.equal((await get(port, "/update-readiness")).body.ready, true);
    listening = true;
    assert.equal((await get(port, "/update-readiness")).body.ready, false);
    listening = false;

    const wav = encodeWav(new Int16Array(16_000));
    // A stale ?cleanup=1 from an old client is simply ignored (the pass was removed).
    const t = await post(port, "/transcribe?cleanup=1", wav);
    assert.equal(t.code, 200);
    assert.equal(t.body.text, "bonjour le test");
    assert.equal(t.body.ms, 42);
    assert.deepEqual(seen, [{ bytes: wav.length }]);

    // Settings surface (headless engine: the Manager drives these).
    assert.equal((await get(port, "/settings")).body.status, "ready");
    const patch = Buffer.from(JSON.stringify({ language: "fr" }));
    assert.equal((await post(port, "/settings", patch)).code, 200);
    assert.equal((await post(port, "/shortcut/record", new Uint8Array(0))).code, 200);
    assert.deepEqual((await get(port, "/mics")).body, [{ id: "m1", label: "Mic" }]);
    assert.deepEqual((await get(port, "/ollama/models")).body, { models: ["gemma3:4b"] });

    // B1: read-only diagnostics surface, same trust level as /status.
    const hp = await get(port, "/diagnostics/hotpath");
    assert.equal(hp.code, 200);
    assert.deepEqual(hp.body, { completed: [], open: [], handlerLatenciesMs: [] });

    // B5: same surface, and it must AWAIT its dep - a promise serialized as
    // "{}" would be a green-looking 200 carrying no diagnosis at all.
    const sc = await get(port, "/diagnostics/selfcheck");
    assert.equal(sc.code, 200);
    assert.deepEqual(sc.body, { generatedAtIso: "2026-07-27T00:00:00.000Z", worst: "ok", lines: [] });

    assert.equal((await get(port, "/nope")).code, 404);
  } finally {
    api.stop();
  }
  assert.equal(fs.existsSync(info), false, "stop() must remove its own discovery file");
});

test("long-form routes reach their deps with parsed arguments", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-test3-${process.pid}.json`);
  const stub = longDepsStub();
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => true,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...stub,
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    assert.equal((await get(port, "/long/state")).code, 200);
    const startBody = Buffer.from(JSON.stringify({ dir: "C:\\tmp", keepAudio: true }));
    // 2026-08-02, security scan (MEDIUM): a caller-supplied `dir` is REFUSED.
    // It let a process running as another local user make Flow write a .md
    // and a .wav wherever THIS user can write - the Startup folder included -
    // with privileges the caller did not have. Nothing legitimately sent it.
    assert.equal((await post(port, "/long/start", startBody)).code, 400, "a caller-named directory is refused");
    // v6 c7: no dir is valid now (the engine stages) -> 200, reaches the dep.
    assert.equal((await post(port, "/long/start", Buffer.from("{}"))).code, 200, "missing dir -> stages");
    assert.equal((await post(port, "/long/mark", new Uint8Array(0))).code, 200);
    // Raw PCM slice from the recording device: 100 Int16 samples = 200 bytes.
    const pcm = new Uint8Array(200);
    assert.equal((await post(port, "/long/chunk", pcm)).code, 200);
    assert.equal((await post(port, "/long/gap", Buffer.from(JSON.stringify({ seconds: 4.2 })))).code, 200);
    assert.equal((await post(port, "/long/stop", new Uint8Array(0))).code, 200);
    // v6 c7: save reaches the dep with the chosen dir; a missing dir -> 400.
    assert.equal((await post(port, "/long/save", Buffer.from(JSON.stringify({ dir: "D:\\Notes" })))).code, 200);
    assert.equal((await post(port, "/long/save", Buffer.from("{}"))).code, 400, "save without a dir -> 400");
    assert.deepEqual(stub.calls, [
      // No "start:C:\\tmp:audio": the refused request never reached the
      // dep at all, which is the property that matters - the guard is at the
      // door, not inside the room.
      "state", "start:stage:noaudio", "mark", "chunk:100", "gap:4.2", "stop", "save:D:\\Notes",
    ]);
    // A long recording flips the quiet window (plan 8).
    assert.equal((await get(port, "/update-readiness")).body.ready, false);
  } finally {
    api.stop();
  }
});

test("U5a: /long/history/doc returns the readHistoryDoc dep's payload as-is, and 404 when it returns null", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-histdoc-${process.pid}.json`);
  const seen: string[] = [];
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    readHistoryDoc: (id: string) => {
      seen.push(id);
      return id === "good-id" ? { title: "Client Kickoff", date: "2026-07-27", text: "hello" } : null;
    },
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    const ok = await get(port, "/long/history/doc?id=good-id");
    assert.equal(ok.code, 200);
    assert.deepEqual(ok.body, { title: "Client Kickoff", date: "2026-07-27", text: "hello" });

    const missing = await get(port, "/long/history/doc?id=bad-id");
    assert.equal(missing.code, 404);
    assert.deepEqual(seen, ["good-id", "bad-id"], "the route passes the raw id straight through to the dep");
  } finally {
    api.stop();
  }
});

test("U5a: /long/history returns listHistory()'s items wrapped as { items }", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-histlist-${process.pid}.json`);
  const item = { id: "x", date: "2026-07-27", title: "t", hasAudio: true, audioBytes: 12, docBytes: 34, savedMs: 1 };
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    listHistory: () => [item],
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    const res = await get(port, "/long/history");
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { items: [item] });
  } finally {
    api.stop();
  }
});

// Audit 2026-07-11 (S1): a POST carrying a browser Origin / Sec-Fetch-Site header is a drive-by
// cross-origin request and must be refused; sibling apps (server-to-server) send neither header.
function postHdr(port: number, p: string, extra: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: p, method: "POST", agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": 2, ...extra } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, body: JSON.parse(d) as Record<string, unknown> }));
      },
    );
    req.on("error", reject);
    req.write("{}");
    req.end();
  });
}

// Renamed after the adverse review of F2: the old name ("CSRF guard: a browser
// Origin / Sec-Fetch-Site on a POST is refused") described a control that no
// longer exists. Those two headers are not read anywhere in api.ts now; the
// requests below are refused for want of a token, and a test whose name points
// at the wrong control is how a suite starts lying while staying green.
test("the drive-by page is refused - and it is the TOKEN that refuses it, not the headers", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-csrf-${process.pid}.json`);
  const stub = longDepsStub();
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...stub,
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    // A drive-by page: fetch() always attaches Origin cross-origin -> refused, dep never runs.
    const withOrigin = await postHdr(port, "/quit", { Origin: "https://evil.example" });
    assert.equal(withOrigin.code, 403);
    // Modern browsers also attach Sec-Fetch-Site on every request -> refused.
    const withSecFetch = await postHdr(port, "/settings", { "Sec-Fetch-Site": "cross-site" });
    assert.equal(withSecFetch.code, 403);
    assert.deepEqual(stub.calls, [], "no state-changing dep must run for a refused request");

    // F2 (2026-08-02): what refuses those two is now the MISSING TOKEN, not the
    // headers - and this test has to prove that, or it is green for a reason it
    // no longer states. Same request, same headers, WITH the token: accepted.
    // A hostile page cannot reach this line, because it cannot read the
    // discovery file the token lives in.
    const withOriginAndToken = await postHdr(port, "/settings", {
      "Sec-Fetch-Site": "cross-site",
      "X-Flow-Token": api.sessionToken(),
    });
    assert.equal(withOriginAndToken.code, 200, "the header is not what refuses; the missing token is");
    assert.deepEqual(stub.calls, ["setSettings:"], "and the dep DID run this time");
    // ...and the token is also accepted in the query string, for Flow's own
    // <audio> element - the one caller that cannot set a header.
    assert.equal((await get(port, `/status?t=${encodeURIComponent(api.sessionToken())}`, "")).code, 200);
    assert.equal((await get(port, "/status")).code, 200);
    // A sibling app (no Origin / Sec-Fetch header) now needs the token too.
    assert.equal((await post(port, "/long/stop", new Uint8Array(0))).code, 200);
    assert.deepEqual(stub.calls, ["setSettings:", "stop"]);
  } finally {
    api.stop();
  }
});

test("transcribe errors surface as 500, never crash the server", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-test2-${process.pid}.json`);
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => false,
    transcribe: () => Promise.reject(new Error("engine down")),
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    const r = await post(port, "/transcribe", encodeWav(new Int16Array(100)));
    assert.equal(r.code, 500);
    assert.match(String(r.body.error), /engine down/);
    // The server is still alive after the failure.
    assert.equal((await get(port, "/status")).code, 200);
  } finally {
    api.stop();
  }
});

test("A10: start() never overwrites a discovery file advertising a LIVE foreign engine", async () => {
  // The migration reads that file to find the old engine; a boot that clobbers
  // it erases the only record of a living process (adversarial review, critical).
  //
  // F5 (second scan): "live" now means the PID is alive AND its port is really
  // taken. A PID alone cannot answer the question - pidAlive() returns true on
  // EPERM, so any process of another account that inherited that number read as
  // "the previous engine", and this session then ran with NO discovery file and
  // therefore no published token. Sibling apps locked out, silently, until the
  // next restart. So this test holds the port for real.
  const info = path.join(os.tmpdir(), `agrflow-api-keep-${process.pid}.json`);
  const held = await new Promise<import("node:http").Server>((resolve) => {
    const srv = http.createServer();
    srv.listen(65_001, "127.0.0.1", () => resolve(srv));
  });
  // process.ppid: alive for the whole test run, and definitely not process.pid.
  const foreign = { app: "agr-flow", port: 65_001, pid: process.ppid, version: "0.22.0" };
  fs.writeFileSync(info, JSON.stringify(foreign));
  const api = new LocalApi({
    version: "9.9.9-test",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const kept = JSON.parse(fs.readFileSync(info, "utf8"));
    assert.equal(kept.pid, process.ppid, "the live foreign engine's record survived our boot");
    assert.equal(kept.port, 65_001);
  } finally {
    held.close();
    api.stop();
    try { fs.unlinkSync(info); } catch { /* kept on purpose: not ours */ }
  }
});

test("A10: start() DOES replace a stale discovery file from a dead pid", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-stale-${process.pid}.json`);
  fs.writeFileSync(info, JSON.stringify({ app: "agr-flow", port: 65_002, pid: 999_999_999, version: "0.22.0" }));
  const api = new LocalApi({
    version: "9.9.9-test",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const now = JSON.parse(fs.readFileSync(info, "utf8"));
    assert.equal(now.pid, process.pid, "a dead process's leftover is ours to replace");
  } finally {
    api.stop();
  }
});


// ---------------------------------------------------------------------------
// 2026-07-31, security pass. The drive-by guard used to stop at state-changing
// methods, so GET was open - and GET is what serves /long/history/doc and
// /long/history/audio: meeting transcripts and their audio. Nothing in this
// file stopped a page the user happened to visit from requesting them; only the
// browser's own same-origin policy kept it from READING the answer.
//
// The fix could not simply widen the header check, and that is the interesting
// part: Flow's OWN Notes page plays audio through an <audio> element pointing
// at this API, which is a browser request and does carry Sec-Fetch-* headers.
// Widening the check would have killed audio playback - the U3 mistake exactly,
// a control scoped one notch too far, breaking a feature no test covers.
// ---------------------------------------------------------------------------

function getHdr(port: number, p: string, extra: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: p, agent: false, headers: extra }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, body: JSON.parse(d) as Record<string, unknown> }));
      })
      .on("error", reject);
  });
}

async function tokenApi(): Promise<{ api: LocalApi; port: number; token: string }> {
  const info = path.join(os.tmpdir(), `agrflow-api-tok-${process.pid}-${Math.random()}.json`);
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
  return { api, port, token: api.sessionToken() };
}

test("a drive-by page can no longer READ - a GET with browser headers is refused", async () => {
  const { api, port } = await tokenApi();
  try {
    for (const p of ["/status", "/long/history", "/settings"]) {
      const r = await getHdr(port, p, { "Sec-Fetch-Site": "cross-site" });
      assert.equal(r.code, 403, `${p} must refuse a browser read without the token`);
    }
  } finally {
    api.stop();
  }
});

test("THE ONE THAT WOULD HAVE CAUGHT THE BREAKAGE: Flow's own window still reads", async () => {
  // The Notes page's <audio> element sends Sec-Fetch-* like any browser. It is
  // allowed because it carries the token, and this test is the reason the fix
  // is a token rather than a wider header check.
  const { api, port, token } = await tokenApi();
  try {
    const r = await getHdr(port, `/status?t=${encodeURIComponent(token)}`, { "Sec-Fetch-Site": "cross-site" });
    assert.equal(r.code, 200, "Flow's own renderer must keep working, headers and all");
  } finally {
    api.stop();
  }
});

test("a WRONG token is refused, and so is a truncated one", async () => {
  const { api, port, token } = await tokenApi();
  try {
    for (const bad of ["", "x", token.slice(0, -1), token + "x", token.toUpperCase()]) {
      const r = await getHdr(port, `/status?t=${encodeURIComponent(bad)}`, { Origin: "https://evil.example" });
      assert.equal(r.code, 403, `refused: ${JSON.stringify(bad)}`);
    }
  } finally {
    api.stop();
  }
});

// ---------------------------------------------------------------------------
// F2 (MEDIUM, 3/3, security scan 2026-08-02). The test that used to live here
// asserted the OPPOSITE - that sibling apps need no token - and called requiring
// one "a breaking change disguised as a security fix". The scan showed that
// sentence was the vulnerability: a control that only questions callers who
// admit to being browsers questions nobody, because omitting a header is free.
//
// These two tests are the pair. The first is the exploit, and it must fail
// against today's code. The second is the reason the first can be closed
// without breaking the phone.
// ---------------------------------------------------------------------------

test("F2: the bypass - a plain local client with no browser headers is refused", async () => {
  const { api, port } = await tokenApi();
  try {
    // Byte for byte the request in the scan's exploit scenario: a valid Host,
    // no Origin, no Sec-Fetch-*, no token. It used to return every one of these.
    for (const p of [
      "/status",
      "/long/history", // the meeting index
      "/long/state",
      "/long/transcript", // a meeting being recorded RIGHT NOW
      "/settings",
    ]) {
      const r = await get(port, p, "");
      assert.equal(r.code, 403, `${p} must refuse an unauthenticated local caller`);
    }
    // And the state-changing ones, which is where it stops being a read.
    assert.equal((await post(port, "/long/start-native", new Uint8Array(0), "")).code, 403, "must not start a mic capture");
    assert.equal((await post(port, "/long/notes-splice", new Uint8Array(0), "")).code, 403, "F10 rides on F2");
    assert.equal((await post(port, "/quit", new Uint8Array(0), "")).code, 403);
  } finally {
    api.stop();
  }
});

test("F2: the discovery file publishes the token, which is what keeps the phone working", async () => {
  // The sibling apps (AGR Pilot's server drives the whole /long/* recording flow
  // from the phone) already read this file for the port. Requiring a token is
  // only survivable because the token is in the same file, one field over.
  const info = path.join(os.tmpdir(), `agrflow-api-disco-${process.pid}-${Math.random()}.json`);
  const api = new LocalApi({
    version: "0.0.0",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  try {
    const disco = JSON.parse(fs.readFileSync(info, "utf8")) as { port: number; token: string };
    assert.equal(typeof disco.token, "string");
    assert.ok(disco.token.length >= 32, "a published token still has to be unguessable");
    assert.equal(disco.token, api.sessionToken(), "the file must carry THIS session's token");
    // A sibling app doing exactly what Pilot does: read the file, send the token.
    assert.equal((await get(disco.port, "/status", disco.token)).code, 200);
    assert.equal((await get(disco.port, "/long/history", disco.token)).code, 200);
  } finally {
    api.stop();
  }
});

test("two sessions never share a token", async () => {
  const a = await tokenApi();
  const b = await tokenApi();
  try {
    assert.notEqual(a.token, b.token);
    assert.ok(a.token.length >= 32, "long enough not to be guessed");
    const r = await getHdr(a.port, `/status?t=${encodeURIComponent(b.token)}`, { Origin: "https://evil.example" });
    assert.equal(r.code, 403, "another session's token is just a wrong token");
  } finally {
    a.api.stop();
    b.api.stop();
  }
});

// ---------------------------------------------------------------------------
// 2026-08-02, security scan (HIGH). The session token added the day before was
// BYPASSABLE, and this is the test that would have said so.
//
// The bypass is DNS rebinding. The token was only demanded when a request
// looked browser-issued - which the attacker answers by OMISSION. Per Fetch
// Metadata, `Sec-Fetch-*` is appended only for a "potentially trustworthy" URL:
// http://127.0.0.1:8176 qualifies, http://attacker.tld:8176 does not, EVEN WHEN
// IT RESOLVES TO 127.0.0.1. A page served from a rebound hostname and reloaded
// on this port becomes same-origin with the API, sends neither Origin (it is a
// same-origin GET) nor Sec-Fetch-Site, is judged "not a browser", is never
// asked for a token - and same-origin policy then lets it READ every response:
// the meeting list, every transcript, every .wav, and the live transcript of a
// meeting being recorded at that moment.
//
// The Host header is the one thing the two cases cannot share. That is why the
// fix is a Host allowlist and not another header check.
// ---------------------------------------------------------------------------

// Carries the token (F2), so that what these tests prove is the HOST check and
// nothing else. A rebinding request refused for want of a token would be a green
// test measuring the wrong control.
function getHost(port: number, p: string, hostHeader: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: p, agent: false, headers: { Host: hostHeader, "X-Flow-Token": TOKEN } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, body: JSON.parse(d) as Record<string, unknown> }));
      })
      .on("error", reject);
  });
}

test("DNS REBINDING: a rebound hostname is refused, with no token and no browser headers", async () => {
  const { api, port } = await tokenApi();
  try {
    // Exactly the request the rebinding page makes: no Origin, no Sec-Fetch-*,
    // and a Host that is the attacker's own name. Before the fix this reached
    // every read route.
    for (const p of ["/long/history", "/status", "/settings", "/long/transcript?since=0"]) {
      const r = await getHost(port, p, "rebind.attacker.example:" + port);
      assert.equal(r.code, 403, `${p} must refuse a rebound Host`);
    }
  } finally {
    api.stop();
  }
});

test("and the token alone would NOT have saved it - the guard never asked for one", async () => {
  // The point of the finding: a request shaped like this was judged
  // "not a browser", so the token check was skipped entirely. This asserts the
  // Host check fires even when the request is otherwise indistinguishable from
  // a legitimate sibling app's call.
  const { api, port } = await tokenApi();
  try {
    const r = await getHost(port, "/long/history", "evil.example");
    assert.equal(r.code, 403);
  } finally {
    api.stop();
  }
});

test("the real local clients still pass: 127.0.0.1 and localhost, on the bound port", async () => {
  const { api, port } = await tokenApi();
  try {
    assert.equal((await getHost(port, "/status", `127.0.0.1:${port}`)).code, 200);
    assert.equal((await getHost(port, "/status", `localhost:${port}`)).code, 200);
  } finally {
    api.stop();
  }
});

test("a right host on the WRONG port is refused too", async () => {
  // Rebinding aside, a Host naming another port means the request was not meant
  // for this server, and answering it would be answering someone else's mail.
  const { api, port } = await tokenApi();
  try {
    assert.equal((await getHost(port, "/status", "127.0.0.1:9999")).code, 403);
    assert.equal((await getHost(port, "/status", "127.0.0.1")).code, 403);
  } finally {
    api.stop();
  }
});


test("F5: a live PID whose port is FREE does not deprive this session of its token", async () => {
  // The scenario the second scan named: a stale discovery file naming a PID that
  // Windows has since handed to somebody else. Before this, we read "the
  // previous engine is alive", published no discovery file, and every sibling
  // app stayed locked out with no message until the next restart.
  //
  // The port is what tells the truth: nobody listening means nobody is there,
  // whatever the PID says.
  const info = path.join(os.tmpdir(), `agrflow-api-recycled-${process.pid}.json`);
  const stale = { app: "agr-flow", port: 65_099, pid: process.ppid, version: "0.22.0" };
  fs.writeFileSync(info, JSON.stringify(stale));
  const api = new LocalApi({
    version: "9.9.9-test",
    isListening: () => false,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: () => Promise.resolve({ text: "", ms: 0 }),
    ...longDepsStub(),
    infoPathOverride: info,
  });
  await api.start();
  auth(api);
  try {
    const now = JSON.parse(fs.readFileSync(info, "utf8")) as { pid: number; token?: string };
    assert.equal(now.pid, process.pid, "the file is ours: the advertised engine was not there");
    assert.equal(now.token, api.sessionToken(), "and the token IS published, which is the whole point");
  } finally {
    api.stop();
    fs.rmSync(info, { force: true });
  }
});
