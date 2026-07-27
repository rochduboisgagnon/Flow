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
  historyDir: string; // C10: recording history root; "" = default (dataDir()/history)
  insertMode: "paste" | "type"; // how dictation lands in an editable field: clipboard paste (default) or typed keystrokes for paste-hostile apps
  theme: ThemePref; // U0: "system" | "dark" | "light", resolved in index.ts against nativeTheme
}

export const SETTINGS_DEFAULTS: FlowSettings = {
  combo: DEFAULT_COMBO,
  language: "fr", // v5 c1: force French (auto-detect is unreliable on 1-2 s clips, locked EN)
  model: DEFAULT_MODEL_FILE,
  micDeviceId: "",
  sounds: false, // v5 c5: no audible cues at all
  summaryModel: "", // "" = the first installed Ollama model
  forceCpu: false, // R1: Vulkan first by default; on = CPU only
  historyDir: "", // C10: default location (dataDir()/history)
  insertMode: "paste", // clipboard paste + restore; "type" keystrokes the text (paste-hostile apps, never touches the clipboard)
  theme: "dark", // U0: dark = today's fixed appearance; the wave that ships the light theme will flip this default to "system"
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
  if (typeof r.historyDir === "string") out.historyDir = r.historyDir; // C10: same permissiveness as micDeviceId
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
