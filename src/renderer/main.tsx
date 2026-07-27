// Flow main window (plan V1, A1/A2). One React tree, three families kept
// strictly apart (plan §2.1): DO sections, LIBRARY sections, and ONE Settings
// menu holding every setting. Sections shipping in later waves show an honest
// placeholder - no dead buttons.
//
// State discipline: the window renders ONE snapshot pushed by the engine
// (UiStatePayload). Anything slow (model download, engine warm-up, update
// check) carries its own progress/error text - nothing pretends to be instant.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UiStatePayload } from "../shared/ipcContracts";
import "./main.css";

type Section =
  | "home" | "record" | "import" | "notes" | "stats" | "diagnostics"
  | "dictionary" | "functions" | "snippets" | "settings";

type SettingsTab =
  | "general" | "dictation" | "audio" | "engine" | "localai"
  | "storage" | "updates" | "about";

// ---- tiny stroke icons (charte: 1.5px strokes, no fills, no emoji) ----
function Icon({ d, d2 }: { d: string; d2?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
      {d2 ? <path d={d2} /> : null}
    </svg>
  );
}
const IC = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  record: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z",
  record2: "M5 11v1a7 7 0 0 0 14 0v-1M12 19v3",
  import: "M12 3v12m0 0 4-4m-4 4-4-4M4 21h16",
  notes: "M6 2h9l5 5v15H6zM14 2v6h6",
  stats: "M4 21V10M10 21V4M16 21v-7M22 21H2",
  diag: "M2 12h4l3 8 4-16 3 8h6",
  dict: "M4 20V5a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h13",
  func: "M13 2 4 14h6l-1 8 9-12h-6z",
  snip: "M9 3v18M4 8h14a3 3 0 0 1 0 6H4",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  gear2: "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.06-.4.1-.8.1-1.2z",
};

// ---- small controls ----
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // Space must not scroll the settings page
          onChange(!on);
        }
      }}
    >
      <div className="knob" />
    </div>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div>
        <div className="label">{label}</div>
        {help ? <div className="help">{help}</div> : null}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="sub">{blurb}</p>
      <div className="placeholder">
        <span className="soon">Arrives in an upcoming update</span>
        <div>This part of Flow is planned and on its way. The engine underneath is already running; only this page is still to come.</div>
      </div>
    </>
  );
}

// ---- sections ----
function Home({ s }: { s: UiStatePayload }) {
  // Typed flags from the engine (audit): the string is display-only.
  const hookDead = !s.hookOk;
  const engineErr = s.modelState.status === "error" || (!s.engineWarm && s.modelState.status !== "downloading");
  const last = s.recent[0];
  return (
    <>
      <h1>Home</h1>
      <p className="sub">Local, on-device voice transcription. Nothing ever leaves this machine.</p>
      <div className="cards">
        <div className="card">
          <h3>Dictation</h3>
          <div className="big">
            <span className={"dot " + (hookDead ? "err" : s.listening ? "on" : "off")} />
            {hookDead ? "Keyboard hook unavailable" : s.paused ? "Paused" : s.listening ? "Listening" : "Armed"}
          </div>
          <div className="muted">Hold <span className="kbd">{s.comboLabel}</span> anywhere and speak. Double-tap for hands-free.</div>
        </div>
        <div className="card">
          <h3>Speech engine</h3>
          <div className="big">
            <span className={"dot " + (engineErr ? "err" : s.engineWarm ? "on" : "off")} />
            {s.status}
          </div>
          <div className="muted">
            {s.backend ? `Backend: ${s.backend}` : "Backend: selecting..."} - model {s.settings.model.replace("ggml-", "").replace(".bin", "")}
          </div>
          {s.modelState.status === "downloading" ? (
            <div className="progress"><div style={{ width: `${s.modelState.pct ?? 0}%` }} /></div>
          ) : null}
        </div>
        <div className="card">
          <h3>Long recording</h3>
          <div className="big">
            <span className={"dot " + (s.recording ? "on" : "off")} />
            {s.recording ? "Recording in progress" : "Idle"}
          </div>
          <div className="muted">
            {last
              ? `Last capture: ${last.title} - ${new Date(last.startedIso).toLocaleString()} (${Math.round(last.durationMs / 60000)} min)`
              : "No capture yet."}
          </div>
        </div>
      </div>
    </>
  );
}

function Diagnostics({ s }: { s: UiStatePayload }) {
  return (
    <>
      <h1>Diagnostics</h1>
      <p className="sub">What the engine is doing right now. Full activation-path timings arrive in the next wave.</p>
      <table className="diag">
        <tbody>
          <tr><td>App version</td><td>{s.version}</td></tr>
          <tr><td>Engine status</td><td>{s.status}</td></tr>
          <tr><td>Speech backend</td><td>{s.backend || "(selecting)"}</td></tr>
          <tr><td>Model file</td><td className="mono">{s.settings.model}</td></tr>
          <tr><td>Model state</td><td>{s.modelState.status}{s.modelState.status === "downloading" ? ` (${s.modelState.pct ?? 0}%)` : ""}{s.modelState.message ? ` - ${s.modelState.message}` : ""}</td></tr>
          <tr><td>Local API port</td><td className="mono">{s.apiPort || "(starting)"}</td></tr>
          <tr><td>System-audio capture</td><td>{s.canLoopback ? "available (Windows loopback)" : "not available on this OS"}</td></tr>
          <tr><td>Data folder</td><td><span className="mono">{s.dataDir}</span>{" "}<button className="btn" aria-label="Open data folder" onClick={() => void window.flowui.openPath("data")}>Open</button></td></tr>
          <tr><td>Engine log</td><td><span className="mono">{s.logPath}</span>{" "}<button className="btn" aria-label="Open engine log" onClick={() => void window.flowui.openPath("log")}>Open</button></td></tr>
        </tbody>
      </table>
    </>
  );
}

// ---- settings tabs ----
function SettingsView({ s, patch }: { s: UiStatePayload; patch: (p: Record<string, unknown>) => Promise<void> }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabs: Array<[SettingsTab, string]> = [
    ["general", "General"], ["dictation", "Dictation"], ["audio", "Audio"],
    ["engine", "Engine"], ["localai", "Local AI"], ["storage", "Storage & Privacy"],
    ["updates", "Updates"], ["about", "About"],
  ];
  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Every setting lives here, and nowhere else.</p>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "general" ? <TabGeneral /> : null}
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

function TabGeneral() {
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => { void window.flowui.getLoginItem().then(setLogin); }, []);
  return (
    <div className="rows">
      <Row label="Launch at login" help="Start Flow quietly (engine + tray, no window) when you sign in to Windows. Recommended: dictation only works while Flow is running.">
        {login === null ? <span className="muted">...</span> : (
          <Toggle label="Launch at login" on={login} onChange={(v) => void window.flowui.setLoginItem(v).then(setLogin)} />
        )}
      </Row>
      <Row label="Window behavior" help="Closing this window hides it. Flow keeps running in the notification area; quit from the tray menu.">
        <span />
      </Row>
    </div>
  );
}

function TabDictation({ s, patch }: { s: UiStatePayload; patch: (p: Record<string, unknown>) => Promise<void> }) {
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
        <select value={s.settings.insertMode} onChange={(e) => void patch({ insertMode: e.target.value })}>
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

function TabAudio({ s, patch }: { s: UiStatePayload; patch: (p: Record<string, unknown>) => Promise<void> }) {
  const [mics, setMics] = useState<Array<{ id: string; label: string }> | null>(null);
  useEffect(() => { void window.flowui.listMics().then(setMics); }, []);
  return (
    <div className="rows">
      <Row label="Microphone" help="Which microphone dictation and recordings use. If your pick is unplugged, Flow falls back to the system default.">
        {mics === null ? <span className="muted">Looking for microphones...</span> : (
          <select value={s.settings.micDeviceId} onChange={(e) => void patch({ micDeviceId: e.target.value })}>
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

function TabEngine({ s, patch }: { s: UiStatePayload; patch: (p: Record<string, unknown>) => Promise<void> }) {
  return (
    <div className="rows">
      <Row label="Speech model" help="Bigger models transcribe better and load slower. The model downloads once into Flow's own data folder; switching applies live.">
        <select value={s.settings.model} onChange={(e) => void patch({ model: e.target.value })}>
          {s.models.map((m) => <option key={m.file} value={m.file}>{m.label} ({m.size})</option>)}
        </select>
      </Row>
      {s.modelState.status === "downloading" ? (
        <Row label="Downloading model" help="Dictation keeps using the previous model until the new one is ready.">
          <span className="note-amber">{s.modelState.pct ?? 0}%</span>
        </Row>
      ) : null}
      {s.modelState.status === "error" ? (
        <Row label="Model download failed" help={s.modelState.message ?? "Unknown error"}>
          <span className="note-err">The previous model keeps working.</span>
        </Row>
      ) : null}
      <Row label="Language" help="Forcing a language beats auto-detection on short clips. Auto lets the model decide per utterance.">
        <select value={s.settings.language} onChange={(e) => void patch({ language: e.target.value })}>
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

function TabLocalAi({ s, patch }: { s: UiStatePayload; patch: (p: Record<string, unknown>) => Promise<void> }) {
  const [models, setModels] = useState<string[] | null | "loading">("loading");
  useEffect(() => { void window.flowui.ollamaModels().then((m) => setModels(m)); }, []);
  const opts = Array.isArray(models) ? models : [];
  return (
    <div className="rows">
      <Row label="Meeting summary model" help="The local Ollama model that writes meeting summaries after a long recording. Optional: without it, recordings still produce the full timestamped transcript.">
        {models === "loading" ? <span className="muted">Checking Ollama...</span>
          : models === null ? <span className="muted">Ollama not detected on this machine. Optional.</span>
          : (
            <select value={s.settings.summaryModel} onChange={(e) => void patch({ summaryModel: e.target.value })}>
              <option value="">Automatic (first available)</option>
              {opts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
      </Row>
    </div>
  );
}

function TabStorage({ s, patch }: { s: UiStatePayload; patch: (p: Record<string, unknown>) => Promise<void> }) {
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
        <span className="big">{s.version}</span>
      </Row>
      <Row label="Check for updates" help={msg ?? "Checks GitHub for a newer release."}>
        <button className="btn primary" disabled={busy} onClick={() => void check()}>{busy ? "Checking..." : "Check now"}</button>
      </Row>
    </div>
  );
}

function TabAbout({ s }: { s: UiStatePayload }) {
  return (
    <div className="rows">
      <Row label="Flow" help="Local, on-device voice transcription. By AGR Labs. MIT license.">
        <span className="big">{s.version}</span>
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

// ---- app shell ----
function App() {
  const [s, setS] = useState<UiStatePayload | null>(null);
  const [section, setSection] = useState<Section>("home");
  const offRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void window.flowui.getState().then((st) => { if (st) setS(st); });
    offRef.current = window.flowui.onState(setS);
    return () => { offRef.current?.(); };
  }, []);

  async function patch(p: Record<string, unknown>) {
    const st = await window.flowui.setSettings(p);
    if (st) setS(st);
  }

  const nav = (id: Section, label: string, icon: { d: string; d2?: string }) => (
    <button className={"nav" + (section === id ? " active" : "")} onClick={() => setSection(id)}>
      <Icon d={icon.d} d2={icon.d2} />{label}
    </button>
  );

  return (
    <div className="app">
      <div className="rail">
        <div className="brand">
          <div>
            <div className="name">Flow</div>
            <div className="by">by AGR Labs</div>
          </div>
        </div>
        {nav("home", "Home", { d: IC.home })}
        {nav("record", "Record", { d: IC.record, d2: IC.record2 })}
        {nav("import", "Import", { d: IC.import })}
        {nav("notes", "Notes", { d: IC.notes })}
        {nav("stats", "Statistics", { d: IC.stats })}
        {nav("diagnostics", "Diagnostics", { d: IC.diag })}
        <div className="group-label">Library</div>
        {nav("dictionary", "Dictionary", { d: IC.dict })}
        {nav("functions", "Functions", { d: IC.func })}
        {nav("snippets", "Snippets", { d: IC.snip })}
        <div className="spacer" />
        {nav("settings", "Settings", { d: IC.gear, d2: IC.gear2 })}
      </div>
      <div className="content">
        {s === null ? <p className="sub">Connecting to the engine...</p> : (
          <>
            {section === "home" ? <Home s={s} /> : null}
            {section === "record" ? <Placeholder title="Record" blurb="Capture a meeting from this PC: your microphone, the system audio, or both." /> : null}
            {section === "import" ? <Placeholder title="Import" blurb="Drop audio files - a phone memo, a downloaded recording - and turn them into notes." /> : null}
            {section === "notes" ? <Placeholder title="Notes" blurb="Browse, read and search every capture Flow has produced." /> : null}
            {section === "stats" ? <Placeholder title="Statistics" blurb="Words dictated, streaks, top applications. Counters only - never your text." /> : null}
            {section === "diagnostics" ? <Diagnostics s={s} /> : null}
            {section === "dictionary" ? <Placeholder title="Dictionary" blurb="Teach the engine your names, acronyms and jargon." /> : null}
            {section === "functions" ? <Placeholder title="Functions" blurb="Spoken commands that transform what follows: translate, write an email, summarize." /> : null}
            {section === "snippets" ? <Placeholder title="Snippets" blurb="Say a cue, insert a full block of text." /> : null}
            {section === "settings" ? <SettingsView s={s} patch={patch} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
