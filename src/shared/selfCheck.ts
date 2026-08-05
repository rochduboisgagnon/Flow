// The startup / on-demand self-diagnostic (plan V2, B5), kept PURE (no fs, no
// Electron) for the same reason as hookWatchdog.ts and logQueue.ts: the JUDGMENT
// - is this green, amber or red, and what should the user do about it - is the
// part worth testing, and it must be testable without an installed app, a
// microphone or a GPU. main/index.ts only GATHERS the facts (see SelfCheckFacts)
// and hands them here.
//
// WHY THIS EXISTS. Every fact below was already knowable somewhere in the app,
// and not one of them was ever presented together: hook health lived in the
// adapter, the engine's state in a status STRING, the model in the download
// state, the API port in a field of the UI payload, and whether the data folder
// could even be written to was known by nobody until a write failed. So an
// install that was broken in one specific way looked exactly like an install
// that was broken in any other way: "it does not work". Six lines, each naming
// WHAT was checked, WHAT was observed, and WHAT TO DO when it is red, turn that
// into three seconds of reading.
//
// ZERO RETENTION (plan §5.4): every field below is a state name, a count, a
// device count, a port, a model FILE name or a folder path. Never anything the
// user dictated, and never a microphone or window LABEL (a window title is
// content - the focus probe's answers are deliberately not part of this).

import type { HookHealth } from "./hookWatchdog";
import { ACCESSIBILITY_FIX, ACCESSIBILITY_WHY, type AccessibilityVerdict } from "./accessibility";

export type SelfCheckId =
  | "keyboard-hook"
  | "microphone"
  | "speech-engine"
  | "speech-model"
  | "local-api"
  | "data-folder";

/** "unknown" is a real answer, not a missing one: it means Flow could not yet
 * establish the fact (the renderer that enumerates microphones may still be
 * loading). Reporting it as green would be a lie and as red a false alarm. */
export type SelfCheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface SelfCheckLine {
  id: SelfCheckId;
  /** What is being checked, in the words a bug report needs. */
  label: string;
  status: SelfCheckStatus;
  /** What was actually observed, stated as a fact. */
  detail: string;
  /** What to DO about it. Present for everything that is not "ok" - a red line
   * with no next step is just a nicer way of saying "it does not work". */
  fix?: string;
}

export interface SelfCheckReport {
  generatedAtIso: string;
  /** The most severe line's status: what a single badge should show. */
  worst: SelfCheckStatus;
  lines: SelfCheckLine[];
}

/** Everything main observes, in raw form. Deliberately all plain data: a fact
 * this module cannot establish (no microphone enumeration yet, no answer from
 * the disk) arrives as null and comes back as "unknown", never as a guess. */
export interface SelfCheckFacts {
  /** The keyboard hook's own record (B4). */
  hook: HookHealth;
  /** 2026-08-04 : ce que macOS repond sur l'autorisation Accessibilite, et
   * « unknown » partout ou la question ne se pose pas.
   *
   * Il est dans les FAITS du self-check et pas seulement dans l'interface parce
   * qu'un rapport de self-check est ce qu'on colle dans un message quand « ca ne
   * marche pas » : sans ce fait, le rapport d'un Mac dont la permission est
   * refusee est indistinguable de celui d'un Mac en pleine sante. */
  access: AccessibilityVerdict;
  /** Audio input devices the renderer could enumerate. null = NOT ESTABLISHED,
   * which is a different fact from 0: the window that enumerates devices may
   * simply not have loaded yet, and an empty answer from it proves nothing. */
  micCount: number | null;
  /** Why the enumeration could not be done, when that is known. */
  micError?: string;
  /** A whisper-server backend is running with the model loaded, RIGHT NOW.
   *
   * Adverse review V2, constat 2: this must be fed from the sidecar's own
   * `onState` callback ("warm" -> true, "down"/"error" -> false), never from
   * "does a WhisperSidecar object exist". The object is legitimately assigned
   * before its startup is awaited (and, on a failed startup, can be left
   * assigned with nothing behind it) - `instance !== null` answers "was a
   * warm-up attempted", which is a different question this line does not ask,
   * and answering "ok" from it turns a broken engine into a green light. See
   * main/index.ts's newSidecar() for the callback this must be wired to. */
  engineWarm: boolean;
  /** Basename of the active backend binary, "" while selecting. */
  backend: string;
  modelFile: string;
  /** The model file is on disk; null = could not be checked. */
  modelPresent: boolean | null;
  /** Adverse review V2, constat 3: this is the ONLY signal engineLine()/
   * modelLine() have for "still downloading, nothing is wrong" versus "gave
   * up" - so it must be kept live for EVERY path that can fetch a model, the
   * very first boot's warm-up included, not only a later model swap. If the
   * app's first-ever launch (a 550 MB download, per SELF_CHECK_STARTUP_DELAY_MS
   * in main/index.ts) never moves this off "idle" while the fetch is in
   * flight, the self-check has no way to tell that download apart from a
   * model that is simply missing, and reports a working first run as FAIL. */
  modelState: { status: "idle" | "downloading" | "ready" | "error"; pct?: number; message?: string };
  /** The loopback control API's bound port, 0 when it is not listening. */
  apiPort: number;
  dataDir: string;
  /** A real write was attempted and succeeded; null = could not be tested. */
  dataDirWritable: boolean | null;
  dataDirError?: string;
  /** Wall-clock stamp for the report. Passed in rather than read here, so a
   * test gets a deterministic report (same discipline as hookWatchdog's `now`). */
  nowIso: string;
}

// fail beats warn beats unknown beats ok. "unknown" outranks "ok" on purpose:
// a report that cannot see the microphone must not present itself as all-green.
const RANK: Record<SelfCheckStatus, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

export function worstStatus(lines: SelfCheckLine[]): SelfCheckStatus {
  let worst: SelfCheckStatus = "ok";
  for (const l of lines) if (RANK[l.status] > RANK[worst]) worst = l.status;
  return worst;
}

function hookLine(hook: HookHealth, access: AccessibilityVerdict): SelfCheckLine {
  const history =
    hook.deaths > 0
      ? ` It has been interrupted ${hook.deaths} time(s) this session and recovered ${hook.restarts} time(s).`
      : "";
  // 2026-08-04 : UNE SEULE ligne pour cette panne, et elle remplace celle du
  // crochet plutot que de s'ajouter a elle.
  //
  // Deux raisons. La premiere : sur macOS une autorisation absente est ce qui fait
  // taire le serveur de touches, donc l'etat du crochet en est la CONSEQUENCE, et
  // deux lignes rouges pour une cause unique est la facon dont un rapport devient
  // du bruit qu'on arrete de lire. La seconde est plus grave : quand la permission
  // manque, l'etat du crochet est le plus souvent « armed », donc cette ligne
  // serait VERTE au-dessus d'un raccourci qui ne repond pas.
  if (access === "missing") {
    return {
      id: "keyboard-hook",
      label: "Keyboard shortcut (the low-level hook)",
      status: "fail",
      detail:
        `macOS has not granted Flow the Accessibility permission, so no key press reaches it. ` +
        `The hook itself reports "${hook.state}", which is why this failure is otherwise invisible. ` +
        `${ACCESSIBILITY_WHY}${history}`,
      fix: ACCESSIBILITY_FIX,
    };
  }
  switch (hook.state) {
    case "armed":
      // Deliberately still OK: the shortcut works RIGHT NOW, which is the
      // question this line asks. The history rides along in the detail so a
      // recovered outage is never erased, only put in its place.
      return {
        id: "keyboard-hook",
        label: "Keyboard shortcut (the low-level hook)",
        status: "ok",
        detail: `Armed and receiving key events.${history}`,
      };
    case "restarting":
      return {
        id: "keyboard-hook",
        label: "Keyboard shortcut (the low-level hook)",
        status: "warn",
        detail: `The key server died and Flow is restarting it.${history}`,
        fix: "Wait a few seconds. If it keeps happening, check whether security software is blocking low-level keyboard hooks.",
      };
    case "abandoned":
      return {
        id: "keyboard-hook",
        label: "Keyboard shortcut (the low-level hook)",
        status: "fail",
        detail: `The key server kept dying, so Flow stopped restarting it. Dictation cannot be triggered.${history}`,
        fix: "Restart Flow. If it dies again, check whether security software blocks low-level keyboard hooks, and read flow.log.",
      };
    case "starting":
      return {
        id: "keyboard-hook",
        label: "Keyboard shortcut (the low-level hook)",
        status: "unknown",
        detail: "Flow is still arming the keyboard hook.",
        fix: "Run this check again in a second.",
      };
    default:
      return {
        id: "keyboard-hook",
        label: "Keyboard shortcut (the low-level hook)",
        status: "warn",
        detail: "The keyboard hook is stopped.",
        fix: "Restart Flow.",
      };
  }
}

function micLine(facts: SelfCheckFacts): SelfCheckLine {
  const label = "Microphone (can Flow see an input device)";
  if (facts.micCount === null) {
    return {
      id: "microphone",
      label,
      status: "unknown",
      detail: facts.micError
        ? `Flow could not enumerate audio inputs: ${facts.micError}`
        : "Flow has not been able to enumerate audio inputs yet.",
      fix: "Run this check again in a few seconds; the window that enumerates devices may still be loading.",
    };
  }
  if (facts.micCount === 0) {
    return {
      id: "microphone",
      label,
      status: "fail",
      detail: "No audio input device is visible to Flow.",
      fix: "Plug in a microphone, then check Windows Settings > Privacy & security > Microphone and allow desktop apps.",
    };
  }
  return {
    id: "microphone",
    label,
    status: "ok",
    detail: `${facts.micCount} audio input device(s) visible.`,
  };
}

function engineLine(facts: SelfCheckFacts): SelfCheckLine {
  const label = "Speech engine (whisper-server, warm and loaded)";
  if (facts.modelState.status === "downloading") {
    return {
      id: "speech-engine",
      label,
      status: "warn",
      detail: `The speech model is still downloading (${facts.modelState.pct ?? 0}%). Dictation will work once it finishes.`,
      fix: "Leave Flow running until the download completes.",
    };
  }
  if (facts.engineWarm) {
    return {
      id: "speech-engine",
      label,
      status: "ok",
      detail: facts.backend ? `Warm, running ${facts.backend}.` : "Warm.",
    };
  }
  if (facts.modelState.status === "error") {
    return {
      id: "speech-engine",
      label,
      status: "fail",
      detail: `The speech engine failed: ${facts.modelState.message ?? "no detail"}`,
      fix: "Open Settings > Engine and try another model, or turn on 'force CPU' if the GPU backend is at fault.",
    };
  }
  return {
    id: "speech-engine",
    label,
    status: "fail",
    detail: "No speech engine is running: a dictation would be captured and then have nothing to transcribe it.",
    fix: "Read flow.log (Settings > Updates & About > Open log) for the backend selection lines, and try 'force CPU' in Settings > Engine.",
  };
}

function modelLine(facts: SelfCheckFacts): SelfCheckLine {
  const label = "Speech model (the file on disk)";
  if (facts.modelPresent === null) {
    return {
      id: "speech-model",
      label,
      status: "unknown",
      detail: `Flow could not check whether ${facts.modelFile} is on disk.`,
      fix: "Open Settings > Storage & Privacy > Open Flow's folder and check that the models folder is reachable.",
    };
  }
  if (facts.modelPresent) {
    return { id: "speech-model", label, status: "ok", detail: `${facts.modelFile} is present.` };
  }
  if (facts.modelState.status === "downloading") {
    return {
      id: "speech-model",
      label,
      status: "warn",
      detail: `${facts.modelFile} is being downloaded (${facts.modelState.pct ?? 0}%).`,
      fix: "Leave Flow running until the download completes.",
    };
  }
  return {
    id: "speech-model",
    label,
    status: "fail",
    detail: `${facts.modelFile} is not on disk.`,
    fix: "Open Settings > Engine and select a model: Flow downloads it once, into its own data folder.",
  };
}

function apiLine(facts: SelfCheckFacts): SelfCheckLine {
  const label = "Local API (loopback, for companion apps)";
  if (facts.apiPort > 0) {
    return {
      id: "local-api",
      label,
      status: "ok",
      detail: `Listening on 127.0.0.1:${facts.apiPort}, loopback only.`,
    };
  }
  // WARN, never FAIL: dictation itself does not go through this API. Marking it
  // red would send someone hunting a port while their actual problem was a
  // microphone.
  return {
    id: "local-api",
    label,
    status: "warn",
    detail: "Not listening. Dictation still works; companion apps (AGR Pilot) cannot reach Flow.",
    fix: "Another program may be holding Flow's loopback ports. Restart Flow; if it persists, check what is bound to 8176/8296/8396.",
  };
}

function dataDirLine(facts: SelfCheckFacts): SelfCheckLine {
  const label = "Data folder (settings, log, recordings)";
  if (facts.dataDirWritable === null) {
    return {
      id: "data-folder",
      label,
      status: "unknown",
      detail: `Flow could not test whether it can write to ${facts.dataDir}.`,
      fix: "Open Settings > Storage & Privacy > Open Flow's folder and check that it exists and is reachable.",
    };
  }
  if (facts.dataDirWritable) {
    return { id: "data-folder", label, status: "ok", detail: `Writable: ${facts.dataDir}` };
  }
  return {
    id: "data-folder",
    label,
    status: "fail",
    detail: `Flow cannot write to ${facts.dataDir}${facts.dataDirError ? `: ${facts.dataDirError}` : ""}`,
    fix: "Settings, the log and recordings all live there. Check the folder's permissions, and that it is not on a disconnected network drive.",
  };
}

/** The whole verdict, in a fixed order: the shortcut first, because a dead hook
 * makes every line under it irrelevant, then the chain a dictation actually
 * travels (microphone -> engine -> model), then the two supporting facts. */
export function evaluateSelfCheck(facts: SelfCheckFacts): SelfCheckReport {
  const lines: SelfCheckLine[] = [
    hookLine(facts.hook, facts.access),
    micLine(facts),
    engineLine(facts),
    modelLine(facts),
    apiLine(facts),
    dataDirLine(facts),
  ];
  return { generatedAtIso: facts.nowIso, worst: worstStatus(lines), lines };
}

const TAG: Record<SelfCheckStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", unknown: "?   " };

/** The report as log lines (plan B5: "il tourne au démarrage, résultat
 * journalisé"). Pure, so what a user reads in flow.log and what the Diagnostics
 * panel shows can never tell different stories about the same facts. */
export function formatSelfCheckForLog(report: SelfCheckReport): string[] {
  const out = [`[selfcheck] ${report.generatedAtIso} - worst: ${report.worst.toUpperCase()}`];
  for (const l of report.lines) {
    out.push(`[selfcheck] ${TAG[l.status]} ${l.label}: ${l.detail}${l.fix ? ` -> ${l.fix}` : ""}`);
  }
  return out;
}
