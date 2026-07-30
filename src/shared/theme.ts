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

// These are the --bg of U1's two CSS themes (U0 carried the older #171512 for
// dark while waiting for the stylesheet to follow). Whatever THEME_BG holds
// MUST always equal the --bg of the resolved theme: this is what Chromium
// paints during a resize or maximize, before the page itself has painted a
// single pixel.
export const THEME_BG: Record<ResolvedTheme, string> = {
  dark: "#1a1a1a",
  light: "#f6f4f0",
};

// U1: colors of the NATIVE min/max/close buttons (titleBarOverlay). `color` is
// the titlebar's background - kept identical to --bg so the overlay never reads
// as a separate band across the top of the window - and `symbolColor` is the
// theme's secondary ink (--ink2). Windows draws the hover states and the close
// button's red itself, so there is nothing else for us to specify here.
export const THEME_TITLEBAR: Record<ResolvedTheme, { color: string; symbolColor: string }> = {
  dark: { color: "#1a1a1a", symbolColor: "#c2b9ac" },
  light: { color: "#f6f4f0", symbolColor: "#56514b" },
};

/** Validation guard: an untrusted settings.json value narrowed to ThemePref. */
export function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "dark" || v === "light";
}
