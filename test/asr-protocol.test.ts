import test from "node:test";
import assert from "node:assert/strict";
import {
  buildServerArgs,
  buildInferenceBody,
  parseInferenceResponse,
  pickThreads,
} from "../src/main/asr/protocol";

test("server args: loopback only, model and port pinned", () => {
  const args = buildServerArgs("C:/m/ggml-small-q5_1.bin", 8181, 6);
  assert.deepEqual(args, [
    "--model",
    "C:/m/ggml-small-q5_1.bin",
    "--host",
    "127.0.0.1",
    "--port",
    "8181",
    "--threads",
    "6",
  ]);
});

test("multipart body: wav bytes intact, fields and closing boundary present", () => {
  const wav = new Uint8Array([82, 73, 70, 70, 0, 255, 128, 1]); // "RIFF" + binary bytes
  const body = buildInferenceBody("BOUND", wav, "auto");
  const s = body.toString("latin1");
  assert.ok(s.startsWith("--BOUND\r\n"));
  assert.ok(s.includes('name="file"; filename="utterance.wav"'));
  assert.ok(s.includes('name="language"\r\n\r\nauto'));
  assert.ok(s.includes('name="response_format"\r\n\r\njson'));
  assert.ok(s.endsWith("--BOUND--\r\n"));
  // The raw WAV must sit unmodified between header and fields.
  const start = body.indexOf(Buffer.from([82, 73, 70, 70]));
  assert.ok(start > 0);
  assert.deepEqual([...body.subarray(start, start + wav.length)], [...wav]);
});

test("response parsing trims model padding", () => {
  assert.equal(parseInferenceResponse('{"text":"  Bonjour le monde. \\n"}'), "Bonjour le monde.");
});

test("response without text field throws", () => {
  assert.throws(() => parseInferenceResponse('{"error":"boom"}'));
  assert.throws(() => parseInferenceResponse("null"));
});

test("thread pick keeps headroom and caps at 8", () => {
  assert.equal(pickThreads(4), 2);
  assert.equal(pickThreads(16), 8);
  assert.equal(pickThreads(1), 1);
});
