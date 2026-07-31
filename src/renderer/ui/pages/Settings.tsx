import React, { useEffect, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import { Toggle, Row } from "../components";

// Settings (wave U1 restyle): the eight tabs' LOGIC is transplanted verbatim
// from the pre-split main.tsx - same window.flowui calls, same state shapes.
// Only the markup moved to the mockup's .row .l/.c pattern, plus ONE new
// control: Theme in General (the wave that ships the light theme).

type SettingsTab =
  | "general" | "dictation" | "audio" | "engine" | "localai"
  | "storage" | "updates" | "about";

type Patch = (p: Record<string, unknown>) => Promise<void>;

export function SettingsPage({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabs: Array<[SettingsTab, string]> = [
    ["general", "General"], ["dictation", "Dictation"], ["audio", "Audio"],
    ["engine", "Engine"], ["localai", "Local AI"], ["storage", "Storage & Privacy"],
    ["updates", "Updates"], ["about", "About"],
  ];
  return (
    <>
      <h2>Settings</h2>
      <p className="sub">Every setting lives here, and nowhere else.</p>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "general" ? <TabGeneral s={s} patch={patch} /> : null}
      {tab === "dictation" ? <TabDictation s={s} patch={patch} /> : null}
      {tab === "audio" ? <TabAudio s={s} patch={patch} /> : null}
      {tab === "engine" ? <TabEngine s={s} patch={patch} /> : null}
      {tab === "localai" ? <TabLocalAi s={s} patch={patch} /> : null}
      {tab === "storage" ? <TabStorage s={s} patch={patch} /> : null}
      {tab === "updates" ? <TabUpdates s={s} /> : null}
      {tab === "about" ? <TabAbout s={s} /> : null}
    </>
  );
}

function TabGeneral({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => { void window.flowui.getLoginItem().then(setLogin); }, []);
  return (
    <div className="rows">
      <Row label="Theme" help="System follows Windows. The dictation pill stays dark in both themes: it floats over other apps, not over Flow.">
        <select value={s.settings.theme} onChange={(e) => void patch({ theme: e.target.value })} aria-label="Theme">
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Row>
      <Row label="Launch at login" help="Start Flow quietly (engine + tray, no window) when you sign in to Windows. Recommended: dictation only works while Flow is running.">
        {login === null ? <span className="sub" style={{ margin: 0 }}>...</span> : (
          <Toggle label="Launch at login" on={login} onChange={(v) => void window.flowui.setLoginItem(v).then(setLogin)} />
        )}
      </Row>
      <Row label="Window behavior" help="Closing this window hides it. Flow keeps running in the notification area; quit from the tray menu.">
        <span />
      </Row>
    </div>
  );
}


function TabDictation({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [rec, setRec] = useState(false);
  async function record() {
    setRec(true);
    try { await window.flowui.recordShortcut(); } finally { setRec(false); }
  }
  return (
    <div className="rows">
      <Row label="Shortcut" help="Hold to talk; release to insert. While recording a new one, every key is captured - press your combo, Esc cancels, Backspace clears.">
        <span className="kbd">{s.comboLabel}</span>
        <button className="btn" disabled={rec} onClick={() => void record()}>{rec ? "Press your keys..." : "Change"}</button>
      </Row>
      <Row label="Hands-free mode" help="Double-tap the shortcut to keep the microphone open; double-tap again to stop. Built in - nothing to configure.">
        <span />
      </Row>
      <Row label="Insertion mode" help="Paste inserts through the clipboard and restores it after. Type presses each key instead - for apps that block pasting - and never touches the clipboard.">
        <select value={s.settings.insertMode} onChange={(e) => void patch({ insertMode: e.target.value })} aria-label="Insertion mode">
          <option value="paste">Paste (default)</option>
          <option value="type">Type keystrokes</option>
        </select>
      </Row>
      <Row label="Start/stop sound" help="A soft synthesized cue on press and release. No third-party audio, fully generated on your machine.">
        <Toggle label="Start/stop sound" on={s.settings.sounds} onChange={(v) => void patch({ sounds: v })} />
      </Row>
      {/* B2: the honest version of the trade. The help text names the cost
          (Windows' microphone indicator), the bound (half a second, in memory,
          never on disk) and the benefit, per option - because the whole reason
          this setting exists is that the answer is genuinely personal. */}
      {/* 2026-07-30: the pre-warm SELECTOR is gone. One behaviour, no choice.
          "always" was the mode that failed the human check - it left the Windows
          microphone indicator lit through a session lock, the app holding the
          mic open through a gesture that means "stop listening". "off" clipped
          the first word and only existed as an escape hatch from "always".
          What is left is the middle option, which was always the right one. The
          row stays so that someone who used to set this finds the answer where
          the control was, rather than wondering what happened to their choice. */}
      <Row
        label="Microphone"
        help="Stays ready a few seconds after each dictation so your first word is never clipped. Windows shows its microphone indicator meanwhile. Nothing reaches the disk, the buffer is erased after use, and locking the session releases it."
      >
        <span className="pinned">Always ready &#183; nothing to configure</span>
      </Row>
    </div>
  );
}

function TabAudio({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [mics, setMics] = useState<Array<{ id: string; label: string }> | null>(null);
  useEffect(() => { void window.flowui.listMics().then(setMics); }, []);
  return (
    <div className="rows">
      <Row label="Microphone" help="Which microphone dictation and recordings use. If your pick is unplugged, Flow falls back to the system default.">
        {mics === null ? <span className="sub" style={{ margin: 0 }}>Looking for microphones...</span> : (
          <select value={s.settings.micDeviceId} onChange={(e) => void patch({ micDeviceId: e.target.value })} aria-label="Microphone">
            <option value="">System default</option>
            {mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
      </Row>
      <Row label="System-audio capture" help={s.canLoopback
        ? "Available. Long recordings can mix what the PC plays (a meeting call) with your microphone - no picker, no bot."
        : "Not available on this OS."}>
        <span />
      </Row>
    </div>
  );
}

// F1: the wording of the two-model split, and it is written under one hard
// constraint from this campaign - a sentence that describes engine behaviour must
// name the code that implements it, and a number must have been measured.
//
// So: no WER figure and no latency figure appear here. Flow's own bench
// (npm run bench:wer) has no French voice on the reference machine, which makes
// every number it currently prints unusable for a claim (see the campaign
// journal's rank-7 lesson). What IS said is what the code does, and each
// sentence points at the function that does it:
//
//  - "batch work" means a recorded meeting and an imported file, which are the
//    two callers of BatchEngine.transcribe (main/index.ts wires both).
//  - "a dictation never waits for it to load" is main/asr/batchEngine.ts's module
//    note, fact by fact, and test/batch-engine.test.ts asserts it by identity.
//  - "two models in memory at once" is the cost that file states, in the same
//    place, rather than leaving it to be discovered.
// 2026-07-30: this help text was 191 words. Nobody reads 191 words to pick a
// dropdown value. What a reader actually needs is the trade in one line; the
// reasoning that used to live here is in main/asr/batchEngine.ts, where a
// maintainer will look for it and a user never will.
const BATCH_MODEL_HELP =
  "Meetings and imports can afford a slower, more accurate model - nobody is waiting on them. Dictation never uses this one."

function TabEngine({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const batch = s.batchEngine;
  const batchLabel = s.models.find((m) => m.file === batch.model)?.label ?? batch.model;
  return (
    <div className="rows">
      {/* 2026-07-30: the dictation model selector is GONE, on purpose. Dictating
          on large-v3 measured 16 547 ms per utterance on a real machine - the
          app failed at the one thing it exists to do, and the setting is what
          let it happen. It is pinned now, and this row states what runs rather
          than offering a dial that can only make things worse.
          The row is kept (not deleted) because a user who upgrades and wonders
          where the choice went deserves an answer on the screen where it was. */}
      {/* No description: there is nothing to decide. The row states what runs,
          which is the only thing left worth showing. */}
      <Row label="Dictation model">
        <span className="pinned">Large v3 Turbo &#183; multilingual</span>
      </Row>
      <Row label="Meetings and imports" help={BATCH_MODEL_HELP}>
        <select value={s.settings.batchModel} onChange={(e) => void patch({ batchModel: e.target.value })} aria-label="Model for meetings and imports">
          <option value="">Same as the dictation model (default)</option>
          {s.models.map((m) => <option key={m.file} value={m.file}>{m.label} ({m.size})</option>)}
        </select>
      </Row>
      {/* F1: shown ONLY when a second model is actually configured, and it reads
          the engine's own derived state (BatchEngine.state()) rather than
          restating the setting - a row that said "loaded" because a dropdown said
          so would be the exact class of false interface sentence this campaign
          treats as blocking. */}
      {batch.status === "loading" ? (
        <Row label="Batch model" help={`Flow loads ${batchLabel} the first time a meeting or an import needs it, not now - so a machine that never records anything never pays for this setting.`}>
          <span className="note-amber">Loads on demand</span>
        </Row>
      ) : null}
      {batch.status === "ready" ? (
        <Row label="Batch model" help={`${batchLabel} is loaded and serving meetings and imports. It is unloaded after five idle minutes. Your dictation model is loaded separately and was not touched.`}>
          <span className="num">Loaded</span>
        </Row>
      ) : null}
      {batch.status === "failed" ? (
        <Row label="Batch model unavailable" help={`${batchLabel} could not be loaded: ${batch.message ?? "unknown error"}. Meetings and imports are running on the dictation model instead - nothing is lost, it is just not the model you picked. If the machine has a GPU, the usual cause is no video memory left for a second model: pick a smaller one here, or turn on Force CPU below.`}>
          <span className="note-err">Using the dictation model</span>
        </Row>
      ) : null}
      {s.modelState.status === "downloading" ? (
        <Row label="Downloading model" help="Dictation keeps using the previous model until the new one is ready.">
          <span className="note-amber num">{s.modelState.pct ?? 0}%</span>
        </Row>
      ) : null}
      {s.modelState.status === "error" ? (
        <Row label="Model download failed" help={s.modelState.message ?? "Unknown error"}>
          <span className="note-err">The previous model keeps working.</span>
        </Row>
      ) : null}
      <Row label="Language" help="Forcing a language beats auto-detection on short clips. Auto lets the model decide per utterance.">
        <select value={s.settings.language} onChange={(e) => void patch({ language: e.target.value })} aria-label="Language">
          <option value="fr">French</option>
          <option value="en">English</option>
          <option value="auto">Auto-detect</option>
        </select>
      </Row>
      <Row label="Force CPU" help="Skip the GPU (Vulkan) backend entirely. Applies right away (the engine reloads). Slower, but an escape hatch for capricious GPU drivers.">
        <Toggle label="Force CPU" on={s.settings.forceCpu} onChange={(v) => void patch({ forceCpu: v })} />
      </Row>
    </div>
  );
}

// U8: the wording of the most intrusive switch in Flow, written to the same rule
// as PREWARM_HELP above - the COST comes before the benefit, because a privacy
// trade the user cannot read is a privacy trade they did not make. Three things
// it must say and does: whose speech is being read, that nothing leaves the
// machine, and that Flow does not embed a model of its own yet.
const LIVE_ASSIST_HELP =
  // 2026-07-30: this was 190 words across four paragraphs, on a toggle. The
  // reasoning was worth writing down once - it is the one feature that reads
  // what OTHER people say - but a settings row is not where anyone reads it.
  // The argument now lives in shared/liveAssist.ts; here, the trade in a line.
  "Off by default. A local model reads the last minutes of a meeting and suggests notes or replies. It reads what other people say, and they never agreed to anything. Nothing leaves this machine, and the recording always wins. Needs Ollama - Flow has no model of its own yet.";

function TabLocalAi({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [models, setModels] = useState<string[] | null | "loading">("loading");
  useEffect(() => { void window.flowui.ollamaModels().then((m) => setModels(m)); }, []);
  const opts = Array.isArray(models) ? models : [];
  return (
    <div className="rows">
      <Row label="Meeting summary model" help="The local Ollama model that writes meeting summaries after a long recording. Optional: without it, recordings still produce the full timestamped transcript.">
        {models === "loading" ? <span className="sub" style={{ margin: 0 }}>Checking Ollama...</span>
          : models === null ? <span className="sub" style={{ margin: 0 }}>Ollama not detected on this machine. Optional.</span>
          : (
            <select value={s.settings.summaryModel} onChange={(e) => void patch({ summaryModel: e.target.value })} aria-label="Meeting summary model">
              <option value="">Automatic (first available)</option>
              {opts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
      </Row>
      {/* U8: the most intrusive switch in the app, so it follows PREWARM_HELP's
          rule to the letter - the COST is stated before the benefit, and the
          missing piece (Flow embeds no model of its own yet) is named rather
          than glossed. */}
      <Row label="Live suggestions while recording" help={LIVE_ASSIST_HELP}>
        <Toggle
          label="Live suggestions while recording"
          on={s.settings.liveAssist}
          onChange={(v) => void patch({ liveAssist: v })}
        />
      </Row>
    </div>
  );
}

// U2a: the recordings folder is FIXED under Flow's own data folder - no
// picker, no Reset. Two truths about where recordings live was exactly the
// confusion a fixed folder ends (decision: Roch).
function TabStorage({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const legacy = s.legacyHistory;
  return (
    <div className="rows">
      <Row
        label="Recordings folder"
        help={
          "Lives inside Flow's data folder, not configurable. " +
          (s.historyPurgeSuspended
            ? "Automatic cleanup is paused on this machine: nothing here is ever deleted until you resume it below."
            : "Kept 90 days, then purged.")
        }
      >
        <span className="mono">{s.dataDir + "\\history"}</span>
        <button className="btn" aria-label="Open recordings folder" onClick={() => void window.flowui.openPath("history")}>Open</button>
      </Row>
      {/* U2b: shown ONLY to the few users who had picked their own folder before
          it became fixed. Removing the setting silently would have made their
          past recordings look deleted while they sit untouched on disk.
          U2c: the wording follows what main actually FOUND on disk, and the
          Open button only exists when there is something to open. */}
      {legacy ? (
        <Row
          label="Recordings made before this update"
          help={
            legacy.exists
              ? "This folder used to be configurable, and you had chosen your own. It no longer is - but nothing was moved or deleted: everything you recorded back then is still in this folder, which Flow just checked is there."
              : "This folder used to be configurable, and you had chosen your own. Flow no longer finds it at this path - it was moved, renamed or is on a drive that is not connected. Flow never deleted anything there."
          }
        >
          <span className="mono">{legacy.dir}</span>
          {legacy.exists ? (
            <button className="btn" aria-label="Open the old folder" onClick={() => void window.flowui.openPath("legacy-history")}>Open the old folder</button>
          ) : null}
        </Row>
      ) : null}
      {/* U2c: because Flow was filing recordings elsewhere back then, the folder
          above is not the only frozen one - the fixed folder is too, and its
          dated subfolders are all older than the 90-day retention. Flow does not
          clean up what it was not managing, so the purge stays off until this
          button says otherwise. Clearing the folder above is the same decision:
          the machine stops being a special case. */}
      {s.historyPurgeSuspended ? (
        <Row
          label="Automatic cleanup"
          help="Paused since this update, because Flow found recordings it had not filed itself. Resuming it applies the normal rule to the recordings folder above: anything older than 90 days is deleted, from now on and at every start."
        >
          <button
            className="btn"
            aria-label="Resume automatic cleanup"
            onClick={() => void patch({ historyPurgeSuspended: false, legacyHistoryDir: "" })}
          >
            Resume 90-day cleanup
          </button>
        </Row>
      ) : null}
      {/* Review U6/U7 (major): this row claimed there was "nothing to purge" on
          the ONE screen whose subject is retention - while two waves had since
          added files that do persist. Nothing of what is DICTATED is kept, and
          that part was and stays true; what is kept is counters and settings,
          and a screen about retention has to name them. */}
      {/* 2026-07-30: this row said "none of what you dictate is kept", which
          stopped being true the moment the history landed. Corrected here at
          the same time as the README and the module note - the third place in
          this campaign where a code change quietly falsified a written promise,
          and the reason the rule is now to grep for the promise before shipping
          the change. */}
      <Row label="Dictation retention" help="Text kept a month and listed on Home, erasable there. The audio is never written anywhere. Nothing leaves this machine.">
        <span />
      </Row>
      <Row label="What Flow does keep" help="Your settings, your dictionary, your long recordings, a month of dictations, and word counters. Everything else is dropped.">
        <span />
      </Row>
    </div>
  );
}

function TabUpdates({ s }: { s: UiStatePayload }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await window.flowui.checkUpdates();
      setMsg(r.message);
    } finally { setBusy(false); }
  }
  return (
    <div className="rows">
      <Row label="Current version" help="Flow updates itself from GitHub Releases. Updates never install while you are dictating or recording.">
        <b className="num" style={{ fontSize: 16.2 }}>{s.version}</b>
      </Row>
      {/* 2026-07-30: the row used to show ONE sentence from the last click and
          then go quiet for up to a minute while the download and the quiet
          window ran. With nothing moving, the reasonable thing to do is click
          again - which is the report this fixes. It now reads the live phase. */}
      <Row label="Check for updates" help={updateHelp(s, msg)}>
        <button className="btn amber" disabled={busy || s.update.phase === "downloading"} onClick={() => void check()}>
          {busy ? "Checking..." : s.update.phase === "downloading" ? `${s.update.pct}%` : "Check now"}
        </button>
      </Row>
      {s.update.phase === "downloading" ? (
        <div className="progress" style={{ marginTop: -6 }}><div style={{ width: `${s.update.pct}%` }} /></div>
      ) : null}
    </div>
  );
}

/** What the Updates row says, from the LIVE phase rather than the last click. */
function updateHelp(s: UiStatePayload, msg: string | null): string {
  switch (s.update.phase) {
    case "downloading":
      return `Downloading version ${s.update.version}. Flow restarts on its own when it is done.`;
    case "downloaded-waiting-quiet":
      return `Version ${s.update.version} is ready. Flow restarts as soon as you are not dictating or recording.`;
    case "error":
      return "The last check failed. Your version keeps working; try again in a moment.";
    default:
      return msg ?? "Checks GitHub for a newer release.";
  }
}

function TabAbout({ s }: { s: UiStatePayload }) {
  return (
    <div className="rows">
      <Row label="Flow" help="Local, on-device voice transcription. By AGR Labs. MIT license.">
        <b className="num" style={{ fontSize: 16.2 }}>{s.version}</b>
      </Row>
      <Row label="Source code" help="github.com/rochduboisgagnon/Flow">
        <button className="btn" onClick={() => void window.flowui.openPath("repo")}>Open on GitHub</button>
      </Row>
      <Row label="Engine log" help="The rotating diagnostic log. Nothing you dictate is ever written to it.">
        <button className="btn" onClick={() => void window.flowui.openPath("log")}>Open log</button>
      </Row>
    </div>
  );
}
