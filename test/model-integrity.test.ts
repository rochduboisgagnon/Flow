import test from "node:test";
import assert from "node:assert/strict";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL_FILE,
  MODEL_BYTES,
  MODEL_SHA256,
  redirectAllowed,
} from "../src/main/asr/modelStore";

// ---------------------------------------------------------------------------
// Security scan F8 (MEDIUM, 2026-08-02). The speech model was fetched from a
// BRANCH url and accepted on a 20 MB size floor - so whoever controlled the
// upstream account, its branch, or any redirect hop chose the exact bytes this
// app hands to a native C++ parser, and then types at the user's cursor.
//
// Nothing here touches the network. These tests pin the SHAPE of the fix; the
// numbers themselves were verified against HuggingFace and against the two
// models on disk at the time they were committed (see modelStore.ts).
// ---------------------------------------------------------------------------

test("F8: every offered model has a committed hash and an exact size", () => {
  for (const m of AVAILABLE_MODELS) {
    assert.ok(MODEL_SHA256[m.file], `${m.file} is offered in the UI but has no committed SHA-256`);
    assert.match(MODEL_SHA256[m.file], /^[0-9a-f]{64}$/, `${m.file}: not a SHA-256`);
    assert.ok(MODEL_BYTES[m.file] > 0, `${m.file} has no committed size`);
  }
  assert.ok(MODEL_SHA256[DEFAULT_MODEL_FILE], "the dictation model above all others");
});

test("F8: the two tables cover exactly the same files - a half-updated pair is the bug", () => {
  assert.deepEqual(Object.keys(MODEL_SHA256).sort(), Object.keys(MODEL_BYTES).sort());
});

test("F8: no two models share a hash (a copy-paste in the table would disable the check)", () => {
  const seen = new Set(Object.values(MODEL_SHA256));
  assert.equal(seen.size, Object.keys(MODEL_SHA256).length);
});

test("F8: a redirect must stay on the pinned hosts, over https", () => {
  // The REAL CDN host a HuggingFace model download lands on, checked live when
  // this was written. If the allowlist rejected it, every download would break -
  // which is the way a security control most often does damage.
  assert.equal(redirectAllowed("https://us.aws.cdn.hf.co/repos/x/y.bin"), true);
  assert.equal(redirectAllowed("https://huggingface.co/ggerganov/whisper.cpp/resolve/abc/m.bin"), true);
  assert.equal(redirectAllowed("https://cdn-lfs.huggingface.co/repos/z"), true);
});

test("F8: a redirect off the domain, or down to http, is refused", () => {
  for (const bad of [
    "https://attacker.example/model.bin",
    "http://huggingface.co/model.bin", // never step down from https
    "https://huggingface.co.attacker.example/model.bin", // the suffix trick
    "https://hf.co.evil.tld/model.bin",
    "ftp://huggingface.co/model.bin",
    "not a url at all",
    "",
  ]) {
    assert.equal(redirectAllowed(bad), false, `${bad} must be refused`);
  }
});

test("F8: the suffix rule is anchored on a dot, not on a substring", () => {
  // "evilhf.co" ends with "hf.co" as a STRING. It must not end with it as a HOST.
  assert.equal(redirectAllowed("https://evilhf.co/model.bin"), false);
  assert.equal(redirectAllowed("https://nothuggingface.co/model.bin"), false);
});
