import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_COMBO } from "../shared/constants";
import { DEFAULT_MODEL_FILE } from "./asr/modelStore";

// AGR Flow settings live in the user's own data folder (~/.agr-flow), OUTSIDE
// the install directory (plan §8): an update or reinstall never touches them.
// Same convention as AGR Pilot's ~/.agr-pilot.
//
// ONLY settings live here. Never any dictation content: the zero-retention
// rule (§5.4) means this file holds configuration, nothing the user ever said.

export interface FlowSettings {
  combo: string[]; // stored combo, e.g. ["CTRL","WIN"] (generic) or exact keys
  language: string; // "auto" or an ISO code ("fr", "en") to bias the model
  model: string; // ggml model file name served from AGR Flow's model store
  micDeviceId: string; // "" = system default microphone
  sounds: boolean; // audible start/stop cues
  cleanup: boolean; // optional Ollama pass (punctuation + voice commands)
  cleanupModel: string; // Ollama model name, e.g. "gemma3:4b"
  openPilotCombo: string[]; // v5 c2: global shortcut to open AGR Pilot ([] = off)
}

export const SETTINGS_DEFAULTS: FlowSettings = {
  combo: DEFAULT_COMBO,
  language: "fr", // v5 c1: force French (auto-detect is unreliable on 1-2 s clips, locked EN)
  model: DEFAULT_MODEL_FILE,
  micDeviceId: "",
  sounds: false, // v5 c5: no audible cues at all
  cleanup: false, // dictation never needs the LLM (plan: optional, off)
  cleanupModel: "",
  openPilotCombo: [], // v5 c2: off until the user records one
};

export function dataDir(): string {
  return path.join(os.homedir(), ".agr-flow");
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
  if (typeof r.sounds === "boolean") out.sounds = r.sounds;
  if (typeof r.cleanup === "boolean") out.cleanup = r.cleanup;
  if (typeof r.cleanupModel === "string" && /^[\w.:-]*$/.test(r.cleanupModel)) {
    out.cleanupModel = r.cleanupModel;
  }
  // v5 c2: openPilotCombo is 0-3 keys (empty = the shortcut is off).
  if (
    Array.isArray(r.openPilotCombo) &&
    r.openPilotCombo.length <= 3 &&
    r.openPilotCombo.every((k) => typeof k === "string" && k.trim().length > 0)
  ) {
    out.openPilotCombo = r.openPilotCombo.map((k) => (k as string).trim().toUpperCase());
  }
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
