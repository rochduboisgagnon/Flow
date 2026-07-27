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
  // An invalid value falls back to the default (v5 c1: French forced by default).
  assert.equal(sanitizeSettings({ language: "french" }).language, SETTINGS_DEFAULTS.language);
});

test("insertMode and summaryModel: valid values kept, junk falls back to defaults", () => {
  assert.equal(sanitizeSettings({ insertMode: "type" }).insertMode, "type");
  assert.equal(sanitizeSettings({ insertMode: "paste" }).insertMode, "paste");
  assert.equal(sanitizeSettings({ insertMode: "nonsense" }).insertMode, SETTINGS_DEFAULTS.insertMode);
  assert.equal(SETTINGS_DEFAULTS.insertMode, "paste");
  assert.equal(sanitizeSettings({ summaryModel: "gemma3:12b" }).summaryModel, "gemma3:12b");
  // A model name that looks like a path (contains a slash) is rejected.
  assert.equal(sanitizeSettings({ summaryModel: "../evil" }).summaryModel, SETTINGS_DEFAULTS.summaryModel);
  assert.equal(SETTINGS_DEFAULTS.summaryModel, "");
});

test("defaults are Ctrl+Win, large-v3-turbo, French forced, no sounds (v5)", () => {
  assert.deepEqual(SETTINGS_DEFAULTS.combo, ["CTRL", "WIN"]);
  assert.match(SETTINGS_DEFAULTS.model, /^ggml-large-v3-turbo/);
  assert.equal(SETTINGS_DEFAULTS.language, "fr");
  assert.equal(SETTINGS_DEFAULTS.sounds, false);
});

test("theme: valid preferences kept, junk falls back to dark (U0)", () => {
  assert.equal(sanitizeSettings({ theme: "light" }).theme, "light");
  assert.equal(sanitizeSettings({ theme: "system" }).theme, "system");
  assert.equal(sanitizeSettings({ theme: "dark" }).theme, "dark");
  assert.equal(sanitizeSettings({ theme: "blue" }).theme, "dark");
  assert.equal(sanitizeSettings({ theme: 3 }).theme, "dark");
  assert.equal(sanitizeSettings({ theme: null }).theme, "dark");
  assert.equal(SETTINGS_DEFAULTS.theme, "dark");
});

test("a settings.json written before U0 (no theme field) defaults to dark", () => {
  assert.equal(sanitizeSettings({ combo: ["CTRL", "WIN"], language: "fr" }).theme, "dark");
});
