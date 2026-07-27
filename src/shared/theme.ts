// Theme resolution: PURE (no electron import) so it is importable from both
// main (which owns nativeTheme) and the test suite without a renderer or an
// app instance. main/index.ts is the only place that reads the OS signal
// (nativeTheme.shouldUseDarkColors) and feeds it in here as `systemPrefersDark`.

export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

/** "system" defers to the OS; "dark"/"light" are the user overriding it. */
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

// U0: the dark value is today's --bg from main.css, unchanged (this wave must
// be visually invisible). U1 (maquette tokens) will move it to #191613 and add
// the light variant to the stylesheet. Whatever THEME_BG holds MUST always
// equal the --bg of the resolved theme: this is what Chromium paints during a
// resize or maximize, before the page itself has painted a single pixel.
export const THEME_BG: Record<ResolvedTheme, string> = {
  dark: "#171512",
  light: "#f6f4f0",
};

/** Validation guard: an untrusted settings.json value narrowed to ThemePref. */
export function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "dark" || v === "light";
}
