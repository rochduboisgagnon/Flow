import test from "node:test";
import assert from "node:assert/strict";
import {
  buildServerArgs,
  buildInferenceBody,
  parseInferenceResponse,
  pickThreads,
  computeAudioCtx,
  wavDurationSec,
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
  assert.ok(s.includes('name="response_format"\r\n\r\nverbose_json'));
  assert.ok(s.endsWith("--BOUND--\r\n"));
  // The raw WAV must sit unmodified between header and fields.
  const start = body.indexOf(Buffer.from([82, 73, 70, 70]));
  assert.ok(start > 0);
  assert.deepEqual([...body.subarray(start, start + wav.length)], [...wav]);
});

test("response parsing trims model padding (plain json fallback)", () => {
  assert.equal(parseInferenceResponse('{"text":"  Bonjour le monde. \\n"}'), "Bonjour le monde.");
});

test("verbose_json: segments the model scores as non-speech are dropped", () => {
  const raw = JSON.stringify({
    text: " Bonjour. Sous-titres realises par Amara.org",
    segments: [
      { text: " Bonjour.", no_speech_prob: 0.02 },
      { text: " Sous-titres realises par Amara.org", no_speech_prob: 0.91 },
    ],
  });
  assert.equal(parseInferenceResponse(raw), "Bonjour.");
});

test("verbose_json: segments without a no_speech_prob field are kept", () => {
  const raw = JSON.stringify({
    text: "ignored",
    segments: [{ text: " Un. " }, { text: "  Deux." }],
  });
  assert.equal(parseInferenceResponse(raw), "Un. Deux.");
});

test("verbose_json: all segments silent gives an empty string", () => {
  const raw = JSON.stringify({
    text: " phantom",
    segments: [{ text: " phantom", no_speech_prob: 0.99 }],
  });
  assert.equal(parseInferenceResponse(raw), "");
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

test("audio_ctx scales with duration, floored and capped", () => {
  assert.equal(computeAudioCtx(0.5), 256); // floor: very short clips
  assert.equal(computeAudioCtx(2.4), 256); // ceil(120)+128 = 248, floored to 256
  assert.equal(computeAudioCtx(6), 428); // ceil(300)+128
  assert.equal(computeAudioCtx(60), 1500); // capped at whisper's full window
});

test("audio_ctx lands in the multipart body", () => {
  const body = buildInferenceBody("B", new Uint8Array([1, 2]), "auto", 300).toString("latin1");
  assert.ok(body.includes('name="audio_ctx"\r\n\r\n300'));
  const noCtx = buildInferenceBody("B", new Uint8Array([1, 2]), "auto").toString("latin1");
  assert.ok(!noCtx.includes("audio_ctx"));
});

test("wav duration math from byte length", () => {
  assert.equal(wavDurationSec(44 + 32_000), 1);
  assert.equal(wavDurationSec(44), 0);
  assert.equal(wavDurationSec(10), 0);
});
