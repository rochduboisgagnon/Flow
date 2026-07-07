import React, { useEffect, useState } from "react";
import { comboLabel } from "../shared/combo";
import type { ModelStatePayload, ModelChoice } from "../shared/ipcContracts";

// Settings window: shortcut (recorded through the low-level hook itself),
// microphone, model, languages, sounds. Every change applies LIVE and is
// persisted in ~/.agr-flow, outside the install.

interface SettingsShape {
  combo: string[];
  language: string;
  model: string;
  micDeviceId: string;
  sounds: boolean;
}

const LANGUAGES: Array<[string, string]> = [
  ["auto", "Auto - all languages"],
  ["fr", "Francais"],
  ["en", "English"],
  ["es", "Espanol"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["pt", "Portugues"],
];

const S = {
  page: {
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    background: "#0b0d10",
    color: "#e9edf2",
    minHeight: "100vh",
    margin: 0,
    padding: "24px 28px 32px",
    boxSizing: "border-box" as const,
    fontSize: 13,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "12px 0",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  label: { fontWeight: 600 as const },
  hint: { color: "#8b93a0", fontSize: 11.5, marginTop: 3 },
  select: {
    background: "#151a21",
    color: "#e9edf2",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 7,
    padding: "6px 10px",
    fontSize: 12.5,
    maxWidth: 260,
  },
  btn: {
    background: "#1b2330",
    color: "#e9edf2",
    border: "1px solid rgba(52,227,160,0.4)",
    borderRadius: 7,
    padding: "6px 14px",
    fontSize: 12.5,
    cursor: "pointer" as const,
  },
  kbd: {
    background: "#151a21",
    border: "1px solid rgba(255,255,255,0.18)",
    borderBottom: "2px solid rgba(255,255,255,0.28)",
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 12.5,
    fontWeight: 600 as const,
  },
};

export function App() {
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [models, setModels] = useState<readonly ModelChoice[]>([]);
  const [mics, setMics] = useState<Array<[string, string]>>([]);
  const [micBlocked, setMicBlocked] = useState(false);
  const [recording, setRecording] = useState(false);
  const [modelState, setModelState] = useState<ModelStatePayload>({ status: "idle" });

  useEffect(() => {
    void window.agrflow.getSettings().then((b) => {
      setSettings(b.settings);
      setModels(b.models);
    });
    window.agrflow.onModelState(setModelState);
    // Microphone labels only exist after one granted getUserMedia; grab a
    // stream for a moment, enumerate, and release it immediately. A failure
    // here doubles as the onboarding check (banner below).
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        stream.getTracks().forEach((t) => t.stop());
        setMics(
          devices
            .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
            .map((d) => [d.deviceId, d.label || "Microphone"]),
        );
        setMicBlocked(false);
      } catch {
        setMics([]);
        setMicBlocked(true); // denied or no device: guide instead of failing silently
      }
    })();
  }, []);

  if (!settings) return <div style={S.page}>Loading...</div>;

  const patch = (p: Partial<SettingsShape>) => {
    setSettings({ ...settings, ...p });
    void window.agrflow.setSettings(p).then(setSettings);
  };

  const record = async () => {
    setRecording(true);
    const combo = await window.agrflow.recordShortcut();
    setRecording(false);
    if (combo) setSettings({ ...settings, combo });
  };

  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>AGR Flow</h1>
        <span
          title="Audio and text never leave this machine. Nothing is ever stored."
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: "#34e3a0",
            border: "1px solid rgba(52,227,160,0.45)",
            borderRadius: 999,
            padding: "2px 9px",
          }}
        >
          100% LOCAL
        </span>
      </div>
      <p style={{ ...S.hint, marginTop: 6, fontSize: 12.5 }}>
        Hold the shortcut, speak, release: the text lands at your cursor (or on the
        clipboard when no text field has focus). Nothing leaves this machine; nothing
        is stored.
      </p>

      {micBlocked && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid rgba(225,29,42,0.5)",
            background: "rgba(225,29,42,0.08)",
            fontSize: 12.5,
          }}
        >
          <span>
            AGR Flow cannot reach a microphone. Allow microphone access for desktop
            apps in Windows Settings, then reopen this window.
          </span>
          <button style={S.btn} onClick={() => void window.agrflow.openMicSettings()}>
            Open Windows Settings
          </button>
        </div>
      )}

      <div style={{ ...S.row, marginTop: 14 }}>
        <div>
          <div style={S.label}>Shortcut</div>
          <div style={S.hint}>
            Hold = push-to-talk. Double-tap = hands-free (double-tap again to stop).
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.kbd}>{recording ? "Press keys..." : comboLabel(settings.combo)}</span>
          <button style={S.btn} onClick={record} disabled={recording}>
            {recording ? "Release to set" : "Change"}
          </button>
        </div>
      </div>
      {recording && (
        <div style={{ ...S.hint, padding: "6px 0" }}>
          Press the keys you want (modifier-only combos like Ctrl+Win are fine), then
          release everything. Esc cancels, Backspace clears.
        </div>
      )}

      <div style={S.row}>
        <div>
          <div style={S.label}>Microphone</div>
          <div style={S.hint}>Unplugged device? The capture falls back to the default.</div>
        </div>
        <select
          style={S.select}
          value={settings.micDeviceId}
          onChange={(e) => patch({ micDeviceId: e.target.value })}
        >
          <option value="">System default</option>
          {mics.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div style={S.row}>
        <div>
          <div style={S.label}>Languages you speak</div>
          <div style={S.hint}>
            Pick one to help accuracy; Auto detects any language per utterance
            (best for bilingual FR/EN dictation).
          </div>
        </div>
        <select
          style={S.select}
          value={settings.language}
          onChange={(e) => patch({ language: e.target.value })}
        >
          {LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div style={S.row}>
        <div>
          <div style={S.label}>Speech model</div>
          <div style={S.hint}>
            {modelState.status === "downloading"
              ? `Downloading... ${modelState.pct ?? 0}%`
              : modelState.status === "error"
                ? `Failed: ${modelState.message ?? "download error"}`
                : modelState.status === "ready"
                  ? "Model ready."
                  : "Downloaded once into your data folder; switching swaps the engine live."}
          </div>
        </div>
        <select
          style={S.select}
          value={settings.model}
          onChange={(e) => patch({ model: e.target.value })}
          disabled={modelState.status === "downloading"}
        >
          {models.map((m) => (
            <option key={m.file} value={m.file}>
              {m.label} ({m.size})
            </option>
          ))}
        </select>
      </div>

      <div style={S.row}>
        <div>
          <div style={S.label}>Sounds</div>
          <div style={S.hint}>A soft blip when listening starts and stops.</div>
        </div>
        <input
          type="checkbox"
          checked={settings.sounds}
          onChange={(e) => patch({ sounds: e.target.checked })}
          style={{ width: 16, height: 16, accentColor: "#34e3a0" }}
        />
      </div>
    </div>
  );
}
