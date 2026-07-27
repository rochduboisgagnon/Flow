import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveTheme, isThemePref, THEME_BG, THEME_TITLEBAR } from "../src/shared/theme";
import { TITLEBAR_H } from "../src/shared/constants";

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

// Review U1j: THEME_BG / THEME_TITLEBAR / TITLEBAR_H are duplicated between
// TypeScript (what the main process paints natively) and main.css (what the
// page paints), with "MUST equal" comments on both sides and no enforcement.
// A drifted pair means a wrong-color flash on every resize, or native caption
// buttons floating over the content. Same discipline as scripts/check-icon.cjs:
// the duplication is allowed, the DIVERGENCE is not.
test("main.css tokens match the TypeScript theme constants", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "main.css"), "utf8");
  const lightAt = css.indexOf("html.light");
  assert.ok(lightAt > 0, "html.light block not found in main.css");
  const dark = css.slice(0, lightAt);
  const light = css.slice(lightAt);
  const token = (block: string, name: string): string => {
    const m = block.match(new RegExp("--" + name + ":\\s*([^;]+);"));
    assert.ok(m, `--${name} not found in the expected block`);
    return m![1].trim();
  };
  assert.equal(token(dark, "bg"), THEME_BG.dark);
  assert.equal(token(light, "bg"), THEME_BG.light);
  // The native caption glyphs use each theme's secondary ink.
  assert.equal(token(dark, "ink2"), THEME_TITLEBAR.dark.symbolColor);
  assert.equal(token(light, "ink2"), THEME_TITLEBAR.light.symbolColor);
  // The overlay bar color is the page ground: an overlay that differs from
  // --bg reads as a stray band across the top of the window.
  assert.equal(THEME_TITLEBAR.dark.color, THEME_BG.dark);
  assert.equal(THEME_TITLEBAR.light.color, THEME_BG.light);
  assert.equal(token(dark, "titlebar-h"), `${TITLEBAR_H}px`);
});
