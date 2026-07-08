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
    canLoopback: () => true,
  };
}

test("local API: status, readiness, transcribe, discovery file", async () => {
  const info = path.join(os.tmpdir(), `agrflow-api-test-${process.pid}.json`);
  let listening = false;
  const seen: Array<{ bytes: number; cleanup: boolean }> = [];
  const api = new LocalApi({
    version: "9.9.9-test",
    isListening: () => listening,
    isRecording: () => false,
    isEngineWarm: () => true,
    transcribe: (wav, cleanup) => {
      seen.push({ bytes: wav.length, cleanup });
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
    const t = await post(port, "/transcribe?cleanup=1", wav);
    assert.equal(t.code, 200);
    assert.equal(t.body.text, "bonjour le test");
    assert.equal(t.body.ms, 42);
    assert.deepEqual(seen, [{ bytes: wav.length, cleanup: true }]);

    // Settings surface (headless engine: the Manager drives these).
    assert.equal((await get(port, "/settings")).body.status, "ready");
    const patch = Buffer.from(JSON.stringify({ language: "fr" }));
    assert.equal((await post(port, "/settings", patch)).code, 200);
    assert.equal((await post(port, "/shortcut/record", new Uint8Array(0))).code, 200);
    assert.deepEqual((await get(port, "/mics")).body, [{ id: "m1", label: "Mic" }]);
    assert.deepEqual((await get(port, "/ollama/models")).body, { models: ["gemma3:4b"] });

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
