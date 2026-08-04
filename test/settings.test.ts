import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSettings, SETTINGS_DEFAULTS } from "../src/main/settings";
import { defaultComboFor } from "../src/shared/constants";

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
  // `model` is the one field that is NOT kept: dictation is pinned since
  // 2026-07-30, and a stored value can only ever slow it back down. It is
  // carried over to batch work instead - proved in its own test below.
  assert.equal(s.model, "ggml-large-v3-turbo-q5_0.bin");
  assert.equal(s.micDeviceId, "abc123");
  assert.equal(s.sounds, false);
  assert.equal("evil" in s, false);
});

test("invalid combo shapes fall back to the platform default", () => {
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

test("defaults are Ctrl+Shift, large-v3-turbo, French forced, and the press is audible", () => {
  // 2026-08-04, decision de Roch : Ctrl+Shift sur Windows, Fn+Shift sur macOS. Les
  // deux couts de Ctrl+Shift lui ont ete mesures et dits avant qu'il tranche (la
  // bascule de disposition de clavier de Windows, et les raccourcis Ctrl+Shift+X
  // des applications) ; ils sont ecrits au-dessus de `defaultComboFor`.
  assert.deepEqual(SETTINGS_DEFAULTS.combo, ["CTRL", "SHIFT"]);
  assert.deepEqual(defaultComboFor("win32"), ["CTRL", "SHIFT"]);
  assert.deepEqual(defaultComboFor("darwin"), ["FN", "SHIFT"], "le clavier Mac a son propre defaut");
  assert.match(SETTINGS_DEFAULTS.model, /^ggml-large-v3-turbo/);
  assert.equal(SETTINGS_DEFAULTS.language, "fr");
  // 2026-08-04, a la demande de Roch. Le raisonnement du renversement est ecrit
  // au-dessus du defaut lui-meme (main/settings.ts) : on dicte dans une AUTRE
  // application, donc la pastille est hors du champ de vision et le son est la
  // seule confirmation qui arrive quand on regarde ailleurs.
  assert.equal(SETTINGS_DEFAULTS.sounds, true);
});

test("theme: valid preferences kept, junk falls back to the default (U0/U1)", () => {
  assert.equal(sanitizeSettings({ theme: "light" }).theme, "light");
  assert.equal(sanitizeSettings({ theme: "system" }).theme, "system");
  assert.equal(sanitizeSettings({ theme: "dark" }).theme, "dark");
  assert.equal(sanitizeSettings({ theme: "blue" }).theme, "system");
  assert.equal(sanitizeSettings({ theme: 3 }).theme, "system");
  assert.equal(sanitizeSettings({ theme: null }).theme, "system");
  assert.equal(SETTINGS_DEFAULTS.theme, "system");
});

test("a settings.json written before U0 (no theme field) follows Windows (U1)", () => {
  assert.equal(sanitizeSettings({ combo: ["CTRL", "WIN"], language: "fr" }).theme, "system");
});

// Roch 2026-07-27: Flow starts with Windows by default, registered ONCE. The
// flag is what makes "default on" different from "forced on at every boot":
// a user who turns the toggle off must stay off.
test("loginItemInitialized: absent means the one-time registration still owes a run", () => {
  assert.equal(SETTINGS_DEFAULTS.loginItemInitialized, false);
  assert.equal(sanitizeSettings({ combo: ["CTRL", "WIN"] }).loginItemInitialized, false);
});

test("loginItemInitialized: once recorded, it survives a reload (never re-registers)", () => {
  assert.equal(sanitizeSettings({ loginItemInitialized: true }).loginItemInitialized, true);
  // Junk must not silently re-arm the registration on a corrupt file.
  assert.equal(sanitizeSettings({ loginItemInitialized: "yes" }).loginItemInitialized, false);
});

// U2a: historyDir retired (the recordings folder is fixed under dataDir()/history).
// A settings.json saved by an older build may still carry the field - it must be
// dropped silently, like any other unknown key, never thrown on.
test("U2a: a legacy historyDir field is dropped tolerantly, not thrown on", () => {
  const s = sanitizeSettings({ combo: ["CTRL", "WIN"], historyDir: "D:\\Recordings\\History" });
  assert.equal("historyDir" in s, false);
  assert.deepEqual(s, sanitizeSettings({ combo: ["CTRL", "WIN"] }), "identical to a settings.json without the field");
});

// U7a: the two halves of the statistics policy (Roch, 2026-07-27). The DEFAULTS
// are the policy: counters on, per-application attribution off. An upgrade must
// land on exactly that, and no malformed value may ever turn attribution on.
test("U7a: a settings.json written before the statistics wave gives counters ON and attribution OFF", () => {
  const upgraded = sanitizeSettings({ combo: ["CTRL", "WIN"], language: "fr", theme: "system" });
  assert.equal(upgraded.stats, true);
  assert.equal(upgraded.statsPerApp, false);
  assert.equal(SETTINGS_DEFAULTS.stats, true);
  assert.equal(SETTINGS_DEFAULTS.statsPerApp, false);
});

test("U7a: both statistics switches are literal booleans - junk falls back to the default", () => {
  assert.equal(sanitizeSettings({ stats: false }).stats, false);
  assert.equal(sanitizeSettings({ statsPerApp: true }).statsPerApp, true);
  // The safe direction for a privacy switch: anything unreadable reads as OFF
  // for attribution, and as ON for the plain counters (their own default).
  assert.equal(sanitizeSettings({ statsPerApp: "true" }).statsPerApp, false);
  assert.equal(sanitizeSettings({ statsPerApp: 1 }).statsPerApp, false);
  assert.equal(sanitizeSettings({ statsPerApp: null }).statsPerApp, false);
  assert.equal(sanitizeSettings({ stats: "false" }).stats, true);
  assert.equal(sanitizeSettings({ stats: 0 }).stats, true);
});

// F1 (plan-standalone §7): the batch model. The whole upgrade story is that there
// ISN'T one - a settings.json from any earlier version resolves to "share the
// dictation engine", which is byte for byte the behaviour it already had.
// 2026-07-30: the dictation model is PINNED and no longer a setting. Dictating
// on large-v3 measured 16 547 ms per utterance on a real machine. These two
// tests now pin the MIGRATION, which has to do two things at once.
test("the stored dictation model is dropped: dictation is pinned, whatever settings.json says", () => {
  const upgraded = sanitizeSettings({ combo: ["CTRL", "WIN"], model: "ggml-large-v3-q5_0.bin" });
  assert.equal(upgraded.model, SETTINGS_DEFAULTS.model, "a stored choice cannot slow dictation down again");
  assert.equal(upgraded.model, "ggml-large-v3-turbo-q5_0.bin");
});

test("but the accuracy that choice was BUYING moves to batch work, it is not thrown away", () => {
  // Someone on large-v3 wanted accuracy. Dictation is where it cost 16 seconds;
  // a meeting is where it costs nothing. Dropping the field alone would have
  // silently downgraded their meetings too - a regression hidden inside a fix.
  const upgraded = sanitizeSettings({ model: "ggml-large-v3-q5_0.bin" });
  assert.equal(upgraded.batchModel, "ggml-large-v3-q5_0.bin");
});

test("an EXPLICIT batch choice always wins over that inference", () => {
  const explicit = sanitizeSettings({ model: "ggml-large-v3-q5_0.bin", batchModel: "ggml-medium-q5_0.bin" });
  assert.equal(explicit.batchModel, "ggml-medium-q5_0.bin", "what the user picked beats what we inferred");
});

test("a machine already on the pinned model gets no phantom batch model", () => {
  const clean = sanitizeSettings({ model: "ggml-large-v3-turbo-q5_0.bin" });
  assert.equal(clean.batchModel, "", "\"\" = batch work shares the dictation engine, as before");
  assert.equal(SETTINGS_DEFAULTS.batchModel, "");
});

test("F1: batchModel accepts a model filename or the empty string, and nothing else", () => {
  assert.equal(sanitizeSettings({ batchModel: "ggml-large-v3-q5_0.bin" }).batchModel, "ggml-large-v3-q5_0.bin");
  assert.equal(sanitizeSettings({ batchModel: "" }).batchModel, "");
  // The safe direction is unambiguous here: anything unreadable means ONE engine,
  // never "spawn a second whisper-server on a name nobody validated".
  assert.equal(sanitizeSettings({ batchModel: "../../etc/passwd" }).batchModel, "");
  assert.equal(sanitizeSettings({ batchModel: "C:\\models\\x.bin" }).batchModel, "");
  assert.equal(sanitizeSettings({ batchModel: "model.exe" }).batchModel, "");
  assert.equal(sanitizeSettings({ batchModel: 42 }).batchModel, "");
  assert.equal(sanitizeSettings({ batchModel: null }).batchModel, "");
});

// ---------------------------------------------------------------------------
// P5 (vague P). The one real product decision of the wave.
// ---------------------------------------------------------------------------
