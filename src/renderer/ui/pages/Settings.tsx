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

function TabEngine({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  return (
    <div className="rows">
      <Row label="Speech model" help="Bigger models transcribe better and load slower. The model downloads once into Flow's own data folder; switching applies live.">
        <select value={s.settings.model} onChange={(e) => void patch({ model: e.target.value })} aria-label="Speech model">
          {s.models.map((m) => <option key={m.file} value={m.file}>{m.label} ({m.size})</option>)}
        </select>
      </Row>
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
    </div>
  );
}

function TabStorage({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  async function browse() {
    const dir = await window.flowui.pickFolder();
    if (dir) await patch({ historyDir: dir });
  }
  return (
    <div className="rows">
      <Row label="Recordings folder" help={"Where unsaved long recordings are kept for 90 days, then purged. Current: " + (s.settings.historyDir || "Flow's data folder (default)")}>
        <button className="btn" onClick={() => void browse()}>Choose...</button>
        {s.settings.historyDir ? <button className="btn" onClick={() => void patch({ historyDir: "" })}>Reset</button> : null}
        <button className="btn" aria-label="Open recordings folder" onClick={() => void window.flowui.openPath("history")}>Open</button>
      </Row>
      <Row label="Dictation retention" help="None, by design. Dictated audio and text live only for the one utterance, then every reference is dropped. There is nothing to purge.">
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
        <b className="num" style={{ fontSize: 15 }}>{s.version}</b>
      </Row>
      <Row label="Check for updates" help={msg ?? "Checks GitHub for a newer release."}>
        <button className="btn amber" disabled={busy} onClick={() => void check()}>{busy ? "Checking..." : "Check now"}</button>
      </Row>
    </div>
  );
}

function TabAbout({ s }: { s: UiStatePayload }) {
  return (
    <div className="rows">
      <Row label="Flow" help="Local, on-device voice transcription. By AGR Labs. MIT license.">
        <b className="num" style={{ fontSize: 15 }}>{s.version}</b>
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
