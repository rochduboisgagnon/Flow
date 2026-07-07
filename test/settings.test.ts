import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSettings, SETTINGS_DEFAULTS } from "../src/main/settings";

test("null / garbage input falls back to full defaults", () => {
  assert.deepEqual(sanitizeSettings(null), SETTINGS_DEFAULTS);
  assert.deepEqual(sanitizeSettings("nope"), SETTINGS_DEFAULTS);
  assert.deepEqual(sanitizeSettings(42), SETTINGS_DEFAULTS);
});

test("valid fields are kept, unknown fields dropped", () => {
  const s = sanitizeSettings({
    combo: ["right ctrl"],
    language: "fr",
    model: "ggml-base-q5_1.bin",
    micDeviceId: "abc123",
    sounds: false,
    evil: "ignored",
  });
  assert.deepEqual(s.combo, ["RIGHT CTRL"]);
  assert.equal(s.language, "fr");
  assert.equal(s.model, "ggml-base-q5_1.bin");
  assert.equal(s.micDeviceId, "abc123");
  assert.equal(s.sounds, false);
  assert.equal("evil" in s, false);
});

test("invalid combo shapes fall back to the Ctrl+Win default", () => {
  assert.deepEqual(sanitizeSettings({ combo: [] }).combo, SETTINGS_DEFAULTS.combo);
  assert.deepEqual(sanitizeSettings({ combo: ["a", "b", "c", "d"] }).combo, SETTINGS_DEFAULTS.combo);
  assert.deepEqual(sanitizeSettings({ combo: [1, 2] }).combo, SETTINGS_DEFAULTS.combo);
  assert.deepEqual(sanitizeSettings({ combo: ["  "] }).combo, SETTINGS_DEFAULTS.combo);
});

test("model names that look like paths are rejected", () => {
  assert.equal(
    sanitizeSettings({ model: "../../evil.bin" }).model,
    SETTINGS_DEFAULTS.model,
  );
  assert.equal(sanitizeSettings({ model: "C:\\x\\evil.bin" }).model, SETTINGS_DEFAULTS.model);
  assert.equal(sanitizeSettings({ model: "not-a-bin.txt" }).model, SETTINGS_DEFAULTS.model);
});

test("language accepts auto and short ISO codes only", () => {
  assert.equal(sanitizeSettings({ language: "auto" }).language, "auto");
  assert.equal(sanitizeSettings({ language: "en" }).language, "en");
  assert.equal(sanitizeSettings({ language: "french" }).language, "auto");
});

test("defaults are Ctrl+Win and the large-v3-turbo multilingual model (best French)", () => {
  assert.deepEqual(SETTINGS_DEFAULTS.combo, ["CTRL", "WIN"]);
  assert.match(SETTINGS_DEFAULTS.model, /^ggml-large-v3-turbo/);
});
