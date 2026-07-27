import test from "node:test";
import assert from "node:assert/strict";
import { resolveTheme, isThemePref, THEME_BG } from "../src/shared/theme";

test("resolveTheme: dark/light override regardless of the OS signal", () => {
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("light", false), "light");
});

test("resolveTheme: system defers to the OS signal", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("isThemePref accepts only the three valid preferences", () => {
  assert.equal(isThemePref("system"), true);
  assert.equal(isThemePref("dark"), true);
  assert.equal(isThemePref("light"), true);
  assert.equal(isThemePref("blue"), false);
  assert.equal(isThemePref(3), false);
  assert.equal(isThemePref(null), false);
  assert.equal(isThemePref(undefined), false);
});

test("THEME_BG carries exactly dark and light, both #rrggbb", () => {
  assert.deepEqual(Object.keys(THEME_BG).sort(), ["dark", "light"]);
  assert.match(THEME_BG.dark, /^#[0-9a-f]{6}$/);
  assert.match(THEME_BG.light, /^#[0-9a-f]{6}$/);
});
