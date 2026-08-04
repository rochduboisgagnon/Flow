import React, { useEffect, useRef, useState } from "react";
import type { UiStatePayload } from "../../shared/ipcContracts";
import { Titlebar } from "./Titlebar";
import { Rail, type Section } from "./Rail";
import { Coming } from "./components";
import { Home } from "./pages/Home";
import { Diagnostics } from "./pages/Diagnostics";
import { SettingsPage } from "./pages/Settings";
import { Record } from "./pages/Record";
import { Notes } from "./pages/Notes";
import { Dictionary } from "./pages/Dictionary";
import { Statistics } from "./pages/Statistics";
import { Import } from "./pages/Import";
import { SignInScreen } from "./SignIn";

// Flow main window shell (wave U1). State discipline unchanged since A1/A2:
// the window renders ONE snapshot pushed by the engine (UiStatePayload),
// fetched once then subscribed; settings writes go through setSettings which
// returns the fresh snapshot. The window owns nothing; killing it loses
// nothing. Section state is a plain useState - no router, no hash: a desktop
// window has no URL, and close=hide means the section survives for free.

// The honest not-yet pages (plan rule: never a dead control that looks
// alive). Intro sentences come from the validated mockup; each names what is
// missing and the wave that builds it.
// V4 D3: `import` left this list - the decode pipeline the note pointed at
// (D1/D2) exists, so the page is the real thing now.
//
// The list is EMPTY, and that is the state it should stay in: a section that is
// not built does not belong in the rail. A placeholder there is both halves of
// what this campaign calls blocking at once - a dead control, and an interface
// sentence that says something false about the engine.
//
// 2026-07-30, in two passes and both at Roch's request: `functions` (voice
// commands) and then `snippets` were removed from the rail AND from the app.
// Not hidden, not disabled - deleted, down to their shared modules, their
// stores and their IPC channels. What is left on the dictation path is the
// shortest thing it has ever been: what you said is what gets inserted.
const COMING: Partial<Record<Section, { title: string; blurb: string; missing: string; wave: string }>> = {};

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

  // ---------------------------------------------------------------------------
  // LA PORTE : l'ecran de connexion remplace TOUT, rail compris.
  //
  // La premiere version gardait le rail visible a cote du formulaire, en se
  // disant qu'il « dit ce que Flow est pendant qu'on se connecte ». Roch a
  // installe la 2.0.0 et a tranche en une phrase : on ne devrait meme pas voir
  // les menus. Il avait raison, et pas seulement sur l'esthetique - un rail dont
  // AUCUNE section ne repond est exactement ce que cette campagne appelle un
  // controle mort, et c'est la faute qu'elle a passe six vagues a retirer
  // ailleurs (le bouton « Reprendre le nettoyage a 90 jours » qui ne nettoyait
  // plus rien, les pages « Coming soon » supprimees plutot que grisees).
  //
  // Rien d'autre n'est donc atteignable : ni le rail, ni les sections, ni les
  // Reglages. La barre de titre reste - elle porte les boutons de fenetre de
  // Windows, et sans elle on ne pourrait pas fermer l'application.
  // ---------------------------------------------------------------------------
  if (s === null) {
    return (
      <div className="app">
        <Titlebar s={s} />
        <div className="body">
          <main className="content gate">
            <p className="sub">Connecting to the engine...</p>
          </main>
        </div>
      </div>
    );
  }
  if (!s.accountDataReady) {
    return (
      <div className="app">
        <Titlebar s={s} />
        <div className="body">
          <main className="content gate">
            <SignInScreen s={s} />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Titlebar s={s} />
      <div className="body">
        <Rail section={section} go={setSection} />
        <main className="content">
          {(
            // key remounts the section wrapper so the pagein animation plays
            // on every navigation (reduced-motion disables it in CSS).
            <section className="page" key={section}>
              {section === "home" ? <Home s={s} go={setSection} /> : null}
              {section === "diagnostics" ? <Diagnostics s={s} /> : null}
              {section === "record" ? <Record s={s} /> : null}
              {section === "import" ? <Import go={setSection} /> : null}
              {section === "notes" ? <Notes s={s} /> : null}
              {section === "stats" ? <Statistics s={s} patch={patch} /> : null}
              {section === "dictionary" ? <Dictionary /> : null}
              {section === "settings" ? <SettingsPage s={s} patch={patch} /> : null}
              {coming ? <Coming {...coming} /> : null}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
