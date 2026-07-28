import React, { useEffect, useRef, useState } from "react";
import type { UiStatePayload } from "../../shared/ipcContracts";
import { Titlebar } from "./Titlebar";
import { Rail, type Section } from "./Rail";
import { Coming } from "./components";
import { Home } from "./pages/Home";
import { Diagnostics } from "./pages/Diagnostics";
import { SettingsPage } from "./pages/Settings";
import { SnippetsPage } from "./pages/Snippets";
import { Record } from "./pages/Record";
import { Notes } from "./pages/Notes";

// Flow main window shell (wave U1). State discipline unchanged since A1/A2:
// the window renders ONE snapshot pushed by the engine (UiStatePayload),
// fetched once then subscribed; settings writes go through setSettings which
// returns the fresh snapshot. The window owns nothing; killing it loses
// nothing. Section state is a plain useState - no router, no hash: a desktop
// window has no URL, and close=hide means the section survives for free.

// The honest not-yet pages (plan rule: never a dead control that looks
// alive). Intro sentences come from the validated mockup; each names what is
// missing and the wave that builds it.
const COMING: Partial<Record<Section, { title: string; blurb: string; missing: string; wave: string }>> = {
  import: {
    title: "Import",
    blurb: "Drop audio files, get notes. Phone memos, downloaded recordings, any common format.",
    missing: "Long files need a chunked decode pipeline (a 2 h memo decoded whole would exhaust memory), so this is an engine wave, not a page skin.",
    wave: "Planned after the design campaign.",
  },
  stats: {
    title: "Statistics",
    blurb: "Counters only. Your words are never stored, so there is nothing here to leak.",
    missing: "No counters are written today - whether they ever are is an explicit privacy decision, made before any data exists.",
    wave: "Planned after the design campaign, opening on that decision.",
  },
  dictionary: {
    title: "Dictionary",
    blurb: "Teach the engine your names, acronyms and jargon. Starred terms get priority.",
    missing: "The dictionary store and its injection into transcription are not built yet.",
    wave: "Planned as the dictionary wave of the standalone plan (V3).",
  },
  functions: {
    title: "Functions",
    blurb: "Say a trigger at the start of an utterance and Flow transforms everything after it.",
    missing: "Needs the local AI wave first: transformations run on a local model that may not be installed.",
    wave: "Planned as the voice-functions wave of the standalone plan (V5).",
  },
};

export function App() {
  const [s, setS] = useState<UiStatePayload | null>(null);
  const [section, setSection] = useState<Section>("home");
  const offRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void window.flowui.getState().then((st) => { if (st) setS(st); });
    offRef.current = window.flowui.onState(setS);
    return () => { offRef.current?.(); };
  }, []);

  // Live theme: the engine resolves (preference + OS) and the snapshot says
  // what to paint. The FIRST paint got the same answer synchronously from
  // flowui.initialTheme in main.tsx - this effect only follows changes.
  useEffect(() => {
    if (s) document.documentElement.classList.toggle("light", s.resolvedTheme === "light");
  }, [s?.resolvedTheme]);

  async function patch(p: Record<string, unknown>) {
    const st = await window.flowui.setSettings(p);
    if (st) setS(st);
  }

  const coming = COMING[section];
  return (
    <div className="app">
      <Titlebar s={s} />
      <div className="body">
        <Rail section={section} go={setSection} />
        <main className="content">
          {s === null ? (
            <p className="sub">Connecting to the engine...</p>
          ) : (
            // key remounts the section wrapper so the pagein animation plays
            // on every navigation (reduced-motion disables it in CSS).
            <section className="page" key={section}>
              {section === "home" ? <Home s={s} go={setSection} /> : null}
              {section === "diagnostics" ? <Diagnostics s={s} /> : null}
              {section === "record" ? <Record s={s} /> : null}
              {section === "notes" ? <Notes s={s} /> : null}
              {section === "snippets" ? <SnippetsPage /> : null}
              {section === "settings" ? <SettingsPage s={s} patch={patch} /> : null}
              {coming ? <Coming {...coming} /> : null}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
