import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_COMBO } from "../shared/constants";
import { DEFAULT_MODEL_FILE } from "./asr/modelStore";
import { resolveDataDir } from "./migrate";
import { isThemePref, type ThemePref } from "../shared/theme";

// Flow settings live in the user's own data folder (~/.flow), OUTSIDE the
// install directory (plan §8): an update or reinstall never touches them.
// Same convention as AGR Pilot's ~/.agr-pilot-server.
//
// ONLY settings live here. Never any dictation content: the zero-retention
// rule (§5.4) means this file holds configuration, nothing the user ever said.

export interface FlowSettings {
  combo: string[]; // stored combo, e.g. ["CTRL","WIN"] (generic) or exact keys
  language: string; // "auto" or an ISO code ("fr", "en") to bias the model
  model: string; // ggml model file name served from AGR Flow's model store
  micDeviceId: string; // "" = system default microphone
  sounds: boolean; // audible start/stop cues
  summaryModel: string; // Ollama model for meeting summaries; "" = first installed model
  forceCpu: boolean; // R1: escape hatch for capricious GPUs (skip the Vulkan backend)
  insertMode: "paste" | "type"; // how dictation lands in an editable field: clipboard paste (default) or typed keystrokes for paste-hostile apps
  theme: ThemePref; // U0: "system" | "dark" | "light", resolved in index.ts against nativeTheme
  /** Roch 2026-07-27: Flow registers itself at login ON FIRST RUN, because a
   * dictation daemon that is not running dictates nothing (the Manager's
   * watchdog used to do this). This flag records that the one-time
   * registration happened, so a user who deliberately turns the toggle OFF is
   * never overridden at the next boot. Never reset it. */
  loginItemInitialized: boolean;
  /** U2c: the recordings folder this machine had CHOSEN back when the folder
   * was a setting. Stored as a FACT, never as configuration - no code reads it
   * to decide where to write anything. Two reasons it must be PERSISTED rather
   * than recomputed at each boot: the migration is the only code that ever sees
   * the raw `historyDir`, and the very first applySettings() of the run erases
   * that field for good (sanitizeSettings drops it). "" = nothing to say, which
   * is the case on the overwhelming majority of machines. */
  legacyHistoryDir: string;
  /** U2c: the 90-day retention purge is SUSPENDED on this machine. Set once,
   * together with the field above, when we learn the (now fixed) history folder
   * is not the one Flow was actually filing into: its dated folders are then a
   * frozen archive Flow never managed, and Flow never deletes recordings it was
   * not managing (non-negotiable rule: Roch). Settings > Storage is the only
   * way back to false. */
  historyPurgeSuspended: boolean;
}

export const SETTINGS_DEFAULTS: FlowSettings = {
  combo: DEFAULT_COMBO,
  language: "fr", // v5 c1: force French (auto-detect is unreliable on 1-2 s clips, locked EN)
  model: DEFAULT_MODEL_FILE,
  micDeviceId: "",
  sounds: false, // v5 c5: no audible cues at all
  summaryModel: "", // "" = the first installed Ollama model
  forceCpu: false, // R1: Vulkan first by default; on = CPU only
  insertMode: "paste", // clipboard paste + restore; "type" keystrokes the text (paste-hostile apps, never touches the clipboard)
  theme: "system", // U1: follow Windows now that both themes exist; dark stays one click away
  loginItemInitialized: false, // false = the one-time "start with Windows" registration has not run yet
  legacyHistoryDir: "", // "" = this machine never had its own recordings folder
  historyPurgeSuspended: false, // retention runs normally until we learn otherwise
};

// A5: the folder is ~/.flow since 1.0.0, but a machine coming from an AGR
// Manager install may still be on ~/.agr-flow (the rename is retried at every
// boot until it succeeds). Resolve it ONCE per process: the answer must not
// change between two calls inside the same run, or the log, the settings and
// the history index would drift into different folders.
//
// The resolution is read-only (existsSync only) - importing this module must
// never create anything on disk, because pure unit tests import it. Creating
// the folder stays saveSettings' job. runMigration() runs before the first
// call, so the cached value is always the post-migration one.
let cachedDataDir: string | null = null;

export function dataDir(): string {
  if (cachedDataDir === null) cachedDataDir = resolveDataDir(os.homedir());
  return cachedDataDir;
}

export function settingsPath(): string {
  return path.join(dataDir(), "settings.json");
}

/** Tolerant merge: unknown fields dropped, wrong types fall back to defaults.
 * A corrupt settings file must never prevent the app from starting. */
export function sanitizeSettings(raw: unknown): FlowSettings {
  const out: FlowSettings = { ...SETTINGS_DEFAULTS, combo: [...SETTINGS_DEFAULTS.combo] };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (
    Array.isArray(r.combo) &&
    r.combo.length >= 1 &&
    r.combo.length <= 3 &&
    r.combo.every((k) => typeof k === "string" && k.trim().length > 0)
  ) {
    out.combo = r.combo.map((k) => (k as string).trim().toUpperCase());
  }
  if (typeof r.language === "string" && /^[a-z]{2,3}$|^auto$/.test(r.language)) {
    out.language = r.language;
  }
  if (typeof r.model === "string" && /^[\w.-]+\.bin$/.test(r.model)) {
    out.model = r.model;
  }
  if (typeof r.micDeviceId === "string") out.micDeviceId = r.micDeviceId;
  // U2a: historyDir is gone (the recordings folder is fixed under dataDir()/history).
  // A leftover historyDir from an older settings.json falls through unread here -
  // the tolerant merge drops unknown fields by construction, same as any other
  // retired setting.
  if (typeof r.sounds === "boolean") out.sounds = r.sounds;
  if (typeof r.forceCpu === "boolean") out.forceCpu = r.forceCpu;
  if (typeof r.summaryModel === "string" && /^[\w.:-]*$/.test(r.summaryModel)) {
    out.summaryModel = r.summaryModel;
  }
  // Audit: cleanupModel was the removed dictation-cleanup pass's setting. A
  // 0.22.0 settings.json may still carry one that served as the SUMMARY
  // fallback - recover it once into summaryModel instead of dropping intent.
  if (
    !out.summaryModel &&
    typeof r.cleanupModel === "string" &&
    /^[\w.:-]+$/.test(r.cleanupModel)
  ) {
    out.summaryModel = r.cleanupModel;
  }
  if (r.insertMode === "type" || r.insertMode === "paste") out.insertMode = r.insertMode;
  if (isThemePref(r.theme)) out.theme = r.theme;
  if (typeof r.loginItemInitialized === "boolean") out.loginItemInitialized = r.loginItemInitialized;
  // U2c: a remembered FACT and the safety flag it justifies. Trimmed only - the
  // value is a path this app never writes into, so there is nothing to validate
  // beyond "is it a string"; a wrong-typed field falls back to "no legacy folder",
  // which is the safe direction (no note, no claim about anyone's data).
  if (typeof r.legacyHistoryDir === "string") out.legacyHistoryDir = r.legacyHistoryDir.trim();
  if (typeof r.historyPurgeSuspended === "boolean") out.historyPurgeSuspended = r.historyPurgeSuspended;
  return out;
}

export function loadSettings(): FlowSettings {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return sanitizeSettings(raw);
  } catch {
    return sanitizeSettings(null); // first run or unreadable file -> defaults
  }
}

/** Atomic write (tmp + rename): a crash mid-save must not corrupt settings. */
export function saveSettings(s: FlowSettings): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = settingsPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, settingsPath());
}
