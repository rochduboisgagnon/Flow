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

// agent:false on every call: Node's default agent keeps sockets alive, and a
// pooled socket from a previous (closed) server on the same port would die
// with ECONNRESET instead of reconnecting.
function get(port: number, p: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: p, agent: false }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({ code: res.statusCode ?? 0, body: JSON.parse(d) as Record<string, unknown> }),
        );
      })
      .on("error", reject);
  });
}

function post(port: number, p: string, body: Uint8Array): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        agent: false,
        headers: { "Content-Type": "audio/wav", "Content-Length": body.length },
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
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    assert.equal((await get(port, "/long/state")).code, 200);
    const startBody = Buffer.from(JSON.stringify({ dir: "C:\\tmp", keepAudio: true }));
    assert.equal((await post(port, "/long/start", startBody)).code, 200);
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
      "state", "start:C:\\tmp:audio", "start:stage:noaudio", "mark", "chunk:100", "gap:4.2", "stop", "save:D:\\Notes",
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

test("CSRF guard: a browser Origin / Sec-Fetch-Site on a POST is refused (403)", async () => {
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
  try {
    const port = (JSON.parse(fs.readFileSync(info, "utf8")) as { port: number }).port;
    // A drive-by page: fetch() always attaches Origin cross-origin -> refused, dep never runs.
    const withOrigin = await postHdr(port, "/quit", { Origin: "https://evil.example" });
    assert.equal(withOrigin.code, 403);
    // Modern browsers also attach Sec-Fetch-Site on every request -> refused.
    const withSecFetch = await postHdr(port, "/settings", { "Sec-Fetch-Site": "cross-site" });
    assert.equal(withSecFetch.code, 403);
    assert.deepEqual(stub.calls, [], "no state-changing dep must run for a refused request");
    // A GET status stays reachable (reads are not state-changing).
    assert.equal((await get(port, "/status")).code, 200);
    // A sibling app (no Origin / Sec-Fetch header) is unaffected.
    assert.equal((await post(port, "/long/stop", new Uint8Array(0))).code, 200);
    assert.deepEqual(stub.calls, ["stop"]);
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

test("A10: start() never overwrites a discovery file advertising a LIVE foreign pid", async () => {
  // The migration reads that file to find the old engine; a boot that clobbers
  // it erases the only record of a living process (adversarial review, critical).
  const info = path.join(os.tmpdir(), `agrflow-api-keep-${process.pid}.json`);
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
  try {
    const kept = JSON.parse(fs.readFileSync(info, "utf8"));
    assert.equal(kept.pid, process.ppid, "the live foreign engine's record survived our boot");
    assert.equal(kept.port, 65_001);
  } finally {
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
  try {
    const now = JSON.parse(fs.readFileSync(info, "utf8"));
    assert.equal(now.pid, process.pid, "a dead process's leftover is ours to replace");
  } finally {
    api.stop();
  }
});
