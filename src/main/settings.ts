// B2 : plus de `fs` ni de `path` ici. C'etait tout le point de la vague -
// ce module n'ecrit plus rien sur le disque de personne.
import os from "node:os";
import { DEFAULT_COMBO } from "../shared/constants";
import { DEFAULT_MODEL_FILE } from "./asr/modelStore";
import { resolveDataDir } from "./migrate";
import { isThemePref, type ThemePref } from "../shared/theme";
import { BATCH_MODEL_SHARED } from "../shared/asrRole";

// Flow settings live in the user's own data folder (~/.flow), OUTSIDE the
// install directory (plan §8): an update or reinstall never touches them.
// Same convention as AGR Pilot's ~/.agr-pilot-server.
//
// ONLY settings live here. Never any dictation content: the zero-retention
// rule (§5.4) means this file holds configuration, nothing the user ever said.

export interface FlowSettings {
  combo: string[]; // stored combo, e.g. ["CTRL","WIN"] (generic) or exact keys
  language: string; // "auto" or an ISO code ("fr", "en") to bias the model
  model: string; // ggml model file name served from AGR Flow's model store - the DICTATION engine's model
  /** F1: the model BATCH work runs on - a meeting being recorded, an imported
   * file. "" (the default) means "share the warm dictation engine", which is
   * exactly what every settings.json written before this wave resolves to, so an
   * upgrade changes nothing until the user picks a model on purpose.
   *
   * The key is deliberately NOT a rename of `model`: `model` stays the dictation
   * engine's file, so a settings.json from any earlier version keeps meaning what
   * it meant, and nobody's engine choice is silently reinterpreted. See
   * shared/asrRole.ts for the policy and main/asr/batchEngine.ts for the reason a
   * dictation can never pay for this setting. */
  batchModel: string;
  micDeviceId: string; // "" = system default microphone
  sounds: boolean; // audible start/stop cues
  summaryModel: string; // Ollama model for meeting summaries; "" = first installed model
  forceCpu: boolean; // R1: escape hatch for capricious GPUs (skip the Vulkan backend)
  insertMode: "paste" | "type"; // how dictation lands in an editable field: clipboard paste (default) or typed keystrokes for paste-hostile apps
  theme: ThemePref; // U0: "system" | "dark" | "light", resolved in index.ts against nativeTheme
  /** B2: how much microphone-open time the user is willing to trade for never
   * losing a first word. The ONE setting that makes Flow hold the microphone
   * outside a press, so it is a named choice with honest wording in Settings >
   * Dictation rather than a hidden optimisation. See shared/micWarmth.ts for
   * what each value means and for the four rules that bound all of them. */
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
  /** U7a: keep aggregated dictation counters (words per day, words per minute,
   * day streaks) in ~/.flow/stats.json. ON by default: the file holds sums per
   * DAY and nothing else - never a word of what was dictated, never an excerpt,
   * never the timestamp of one utterance - so the honest default for a feature
   * the user asked for is on, with an off switch that stops the writing.
   * See shared/stats.ts for the policy this implements. */
  stats: boolean;
  /** U7a: ALSO record WHICH application each dictation landed in. OFF at
   * install, and deliberately a second switch rather than a detail of the one
   * above: the focus probe has always SEEN the foreground app's name without
   * ever storing it, and a day-by-day log of which apps you dictate into
   * describes working habits that are arguably more sensitive than the text.
   * Turning it back off ERASES what was collected (mergeDays strips the field
   * from every day it writes), it does not merely pause the collection. */
  statsPerApp: boolean;
}

export const SETTINGS_DEFAULTS: FlowSettings = {
  combo: DEFAULT_COMBO,
  language: "fr", // v5 c1: force French (auto-detect is unreliable on 1-2 s clips, locked EN)
  model: DEFAULT_MODEL_FILE,
  // F1: "" = batch work shares the warm dictation engine. The default is the
  // no-second-process, no-second-download, no-extra-VRAM path, and it is the one
  // an upgrade lands on.
  batchModel: BATCH_MODEL_SHARED,
  micDeviceId: "",
  sounds: false, // v5 c5: no audible cues at all
  summaryModel: "", // "" = the first installed Ollama model
  // P5: the default is the machine. It is never a remote provider, not even
  // when one is installed and the local one is not.
  forceCpu: false, // R1: Vulkan first by default; on = CPU only
  insertMode: "paste", // clipboard paste + restore; "type" keystrokes the text (paste-hostile apps, never touches the clipboard)
  theme: "system", // U1: follow Windows now that both themes exist; dark stays one click away
  // B2: on by default, in its middle setting. A dictation app that clips the
  // first word is broken in the way users actually notice, and the default has
  // to be the one that works; the exposure it costs is bounded in seconds, said
  // plainly in Settings, and turned off in one click.
  loginItemInitialized: false, // false = the one-time "start with Windows" registration has not run yet
  legacyHistoryDir: "", // "" = this machine never had its own recordings folder
  // U7a: the two halves of the statistics policy, and the ONLY place their
  // defaults are stated. A settings.json written before this wave carries
  // neither field, so the tolerant merge below leaves both at these values:
  // counters ON, per-application attribution OFF. That is the upgrade path,
  // and it is the same one a fresh install takes.
  stats: true,
  statsPerApp: false,
  // U8: off, and an upgrade never turns it on - a settings.json written before
  // this wave carries no such field, so the tolerant merge leaves it here.
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

// ---------------------------------------------------------------------------
// B2 : `settingsPath()` a disparu, et avec elle settings.json.
//
// Les reglages vivent dans le compte, pas sur cette machine. Ce qui reste dans
// ~/.flow est ce qui decrit CET ordinateur et rien d'autre : le jeton de
// session, la geometrie de la fenetre, le journal, et le fichier de decouverte
// de l'API.
//
// LES DEUX FONCTIONS CI-DESSOUS GARDENT LEUR SIGNATURE, et c'est ce qui rend
// cette vague tenable : `loadSettings()` et `saveSettings()` ont une trentaine
// d'appelants entre index.ts, api.ts et uiBridge.ts. Changer ce qu'il y a
// DERRIERE plutot que ce qu'elles rendent evite de recrire ces trente sites -
// et un site de plus recrit est un site de plus ou se glisse une erreur.
//
// `sanitizeSettings` reste sur le chemin, exactement comme avant. La source
// n'est plus un fichier mais elle reste une donnee qu'on n'a pas ecrite :
// Supabase rend du JSON arbitraire, et un reglage malforme ne doit pas plus
// empecher Flow de demarrer aujourd'hui qu'hier.
// ---------------------------------------------------------------------------

/** Ce que settings.ts sait faire de son magasin, et rien de plus. La copie de
 * travail (main/data/workingCopy.ts) l'implemente. */
export interface SettingsBacking {
  readSettings(): Record<string, unknown>;
  writeSettings(next: Record<string, unknown>): void;
}

let backing: SettingsBacking | null = null;

/** Installe le magasin, une fois, au demarrage.
 *
 * AVANT CET APPEL, ET APRES UNE DECONNEXION, il n'y a pas de magasin du tout -
 * `loadSettings()` rend alors les valeurs par defaut et `saveSettings()` ne
 * fait rien. C'est volontaire : ecrire les reglages de personne quelque part
 * serait pire que de ne pas les ecrire. */
export function useSettingsBacking(b: SettingsBacking | null): void {
  backing = b;
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
  // 2026-07-30 (validation humaine): the dictation model is PINNED and is no
  // longer a setting. Roch dictated on large-v3 and measured 16.5 SECONDS per
  // utterance on his own machine - the app was unusable for the one thing it
  // exists to do. His instruction was "the same for everyone, no option, the
  // best one for ALL languages". So this field is now read only to be DROPPED:
  // whatever a stored settings.json says, dictation runs on DEFAULT_MODEL_FILE.
  //
  // Deliberately not deleted from the type: a machine upgrading from 1.11.0 has
  // `model` on disk, and silently ignoring it here is what performs the
  // migration. The accuracy that a bigger model buys is not lost either - it
  // moved to `batchModel`, where meetings and imports run and nobody is waiting.
  out.model = DEFAULT_MODEL_FILE;
  // ...but the accuracy the user had CHOSEN is not thrown away. Someone running
  // large-v3 for dictation was buying accuracy at a latency they had not
  // measured; dropping the field alone would silently downgrade their MEETINGS
  // too, which is the one place that accuracy was free. So an old non-default
  // dictation model is carried over to batch work - unless they already picked
  // one there, in which case their explicit choice wins over this inference.
  const priorDictationModel =
    typeof r.model === "string" && /^[\w.-]+\.bin$/.test(r.model) ? r.model : "";
  const carryOver = priorDictationModel && priorDictationModel !== DEFAULT_MODEL_FILE;
  // F1: the SAME filename shape as `model` above, plus the empty string, which
  // is the "share the dictation engine" value. Anything else falls back to the
  // default, and the safe direction here is unambiguous: a malformed field can
  // only ever mean "one engine", never "spawn a second whisper-server on a name
  // nobody validated".
  if (typeof r.batchModel === "string" && (r.batchModel === "" || /^[\w.-]+\.bin$/.test(r.batchModel))) {
    out.batchModel = r.batchModel === "" && carryOver ? priorDictationModel : r.batchModel;
  } else if (carryOver) {
    // No batchModel field at all (a settings.json from before the split) plus a
    // deliberate old dictation model: the same inference applies.
    out.batchModel = priorDictationModel;
  }
  if (typeof r.micDeviceId === "string") out.micDeviceId = r.micDeviceId;
  // B3d : `historyDir` et `historyPurgeSuspended` sont partis avec le dossier
  // d'enregistrements. `legacyHistoryDir`, lui, RESTE : c'est le pointeur vers
  // les reunions d'avant, et c'est desormais la seule chose que Flow sache dire
  // a leur sujet.
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
  // 2026-07-30: micPrewarm is gone - one behaviour, no setting. A stored
  // value is read by nothing, which IS the migration: a machine that had
  // "always" (the mode that left the Windows mic indicator lit through a
  // session lock) comes back on the single guarded behaviour without being
  // asked, and a machine that had "off" stops clipping its first word.
  if (typeof r.loginItemInitialized === "boolean") out.loginItemInitialized = r.loginItemInitialized;
  // U2c: a remembered FACT and the safety flag it justifies. Trimmed only - the
  // value is a path this app never writes into, so there is nothing to validate
  // beyond "is it a string"; a wrong-typed field falls back to "no legacy folder",
  // which is the safe direction (no note, no claim about anyone's data).
  if (typeof r.legacyHistoryDir === "string") out.legacyHistoryDir = r.legacyHistoryDir.trim();
  // U7a: literal booleans only, exactly like sounds/forceCpu above. A truthy
  // string ("false" is truthy) or a missing field falls back to the default,
  // which for statsPerApp is OFF - the safe direction for a privacy switch is
  // the one where a malformed file never turns attribution on.
  if (typeof r.stats === "boolean") out.stats = r.stats;
  if (typeof r.statsPerApp === "boolean") out.statsPerApp = r.statsPerApp;
  // U8: a literal boolean only, for the same reason as statsPerApp above and
  // more so - the safe direction for a switch that lets a model read a meeting
  // is the one where a malformed file can never turn it on.
  return out;
}

/** Les reglages du compte connecte, ou les defauts quand personne ne l'est.
 *
 * SYNCHRONE, et ce n'est pas negociable : cette fonction est appelee sur le
 * chemin chaud de la dictee. La copie de travail sert depuis la RAM. */
export function loadSettings(): FlowSettings {
  return sanitizeSettings(backing?.readSettings() ?? null);
}

/** Enregistre. L'envoi vers Supabase part EN ARRIERE-PLAN : cette fonction
 * rend la main tout de suite, et l'ancienne ecriture atomique (tmp + rename)
 * a disparu avec le fichier qu'elle protegeait. */
export function saveSettings(s: FlowSettings): void {
  backing?.writeSettings({ ...s, combo: [...s.combo] });
}

