import React, { useEffect, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import { Toggle, Row } from "../components";
import { SignInForm } from "../SignIn";

// Settings (wave U1 restyle): the eight tabs' LOGIC is transplanted verbatim
// from the pre-split main.tsx - same window.flowui calls, same state shapes.
// Only the markup moved to the mockup's .row .l/.c pattern, plus ONE new
// control: Theme in General (the wave that ships the light theme).

type SettingsTab =
  | "account" | "general" | "dictation" | "audio" | "engine" | "localai"
  | "storage" | "updates" | "about";

type Patch = (p: Record<string, unknown>) => Promise<void>;

export function SettingsPage({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabs: Array<[SettingsTab, string]> = [
    // A2 : Account en PREMIER, parce que rien d'autre ne fonctionne sans lui.
    // Depuis la refonte, les reglages, le dictionnaire, les dictees et les
    // reunions vivent dans le compte : un Flow deconnecte n'a pas de reglages
    // a montrer dans les huit onglets suivants.
    ["account", "Account"],
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
      {tab === "account" ? <TabAccount s={s} /> : null}
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

// ---------------------------------------------------------------------------
// A2 : le compte.
//
// IL N'Y A PAS DE BOUTON « CREER UN COMPTE », et ce n'est pas une etape
// remise a plus tard. Decision de Roch, 2026-08-03 : il cree les comptes
// lui-meme depuis la console Supabase ; s'il veut donner acces a quelqu'un, il
// lui fabrique son compte. Le projet REFUSE d'ailleurs les inscriptions cote
// serveur - verifie, 422 signup_disabled - ce qui est la moitie qui compte,
// puisqu'une porte fermee seulement dans cette page ne serait pas fermee du
// tout.
//
// LE MOT DE PASSE NE SURVIT PAS A LA SOUMISSION. Il vit dans l'etat de ce
// composant le temps de la frappe, part une fois vers le processus principal,
// et le champ est vide immediatement apres - y compris quand la connexion
// echoue. Un mot de passe qui reste dans un champ est un mot de passe visible
// par-dessus l'epaule, et lisible par les outils de developpement.
// ---------------------------------------------------------------------------
function TabAccount({ s }: { s: UiStatePayload }) {
  const a = s.account;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await window.flowui.signOut();
      // Une erreur ici veut dire « le serveur n'a pas repondu », pas « vous
      // etes encore connecte » : sur cette machine, le jeton est parti.
      setError(r.error ? "Signed out on this computer. The server did not answer." : "");
    } finally {
      setBusy(false);
    }
  }

  if (a.signedIn) {
    // 2026-08-04, Roch : « rien d'ecrit, c'est un Sign Out normal, pas besoin de
    // plein d'informations ». Les trois paragraphes d'explication qui etaient ici
    // repondaient a des questions que personne ne se pose devant un bouton
    // « Sign out » - ou qui sont deja repondues par l'ecran de connexion, une
    // fois, au bon moment.
    //
    // Ce qui RESTE conditionnel n'est pas de la decoration : les deux lignes
    // ci-dessous n'apparaissent que quand elles disent quelque chose de vrai a cet
    // instant, et leur absence est l'etat normal.
    return (
      <div className="rows">
        <Row label="Signed in as" help="">
          <span className="pinned">{a.email}</span>
        </Row>
        {!s.accountDataReady ? (
          <Row label="Your data" help="Flow has a session but has not loaded your dictionary and settings yet.">
            <span className="sub">Loading...</span>
          </Row>
        ) : null}
        {s.unsent > 0 ? (
          <Row label="Waiting to upload" help="Changes made offline. They go up as soon as the network is back.">
            <span className="pinned">{s.unsent}</span>
          </Row>
        ) : null}
        <Row label="Sign out" help="">
          <button className="btn" disabled={busy} onClick={() => void signOut()}>
            {busy ? "Signing out..." : "Sign out"}
          </button>
        </Row>
        {error ? <p className="sub">{error}</p> : null}
      </div>
    );
  }

  // B4 : LE MEME formulaire que l'ecran de lancement, jamais une seconde copie.
  // Deux formulaires divergent, et un seul des deux se souviendrait dans six mois
  // que le mot de passe doit quitter le champ meme quand la connexion echoue.
  return <SignInForm />;
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

function TabLocalAi({ s }: { s: UiStatePayload; patch: Patch }) {
  const nm = s.notesModel;

  return (
    <div className="rows">
      {/* D : le selecteur de fournisseur a disparu, et avec lui la pastille
          « vos transcripts partent chez X », le tableau found/answered et les
          boutons Test et Re-scan. Il n'y a plus qu'un lieu d'execution et il
          est sur cette machine : un choix a une seule option n'est pas un
          choix, c'est une rangee qui occupe l'ecran.

          D1 : et le selecteur de modele Ollama a suivi. Il demandait a
          l'utilisateur de choisir parmi ce qu'il avait installe LUI-MEME, ce
          qui, sur la machine de quelqu'un qui vient de telecharger Flow, est
          une liste vide et un choix impossible. Flow apporte maintenant son
          propre modele ; le seul geste qui reste est de le faire venir, et
          c'est un bouton, pas un reglage.

          POURQUOI UN BOUTON ET PAS UN TELECHARGEMENT AUTOMATIQUE : 1,9 Go.
          Personne ne devrait decouvrir apres coup qu'une application a pris ca
          sur sa connexion. */}
      <Row
        label="Meeting notes model"
        help="Speech is always transcribed on this machine, by Flow's own engine. This second model writes the meeting NOTES from that transcript, and it runs here too - nothing is sent anywhere. It is optional: without it, a recording still produces its full timestamped transcript, just no notes."
      >
        {nm.status === "ready" ? (
          <span className="sub" style={{ margin: 0 }}>Installed. Notes are written on this machine.</span>
        ) : nm.status === "downloading" ? (
          <span className="sub" style={{ margin: 0 }}>Downloading... {nm.pct ?? 0}%</span>
        ) : (
          <button type="button" onClick={() => void window.flowui.downloadNotesModel()}>
            Download (1.9 GB)
          </button>
        )}
      </Row>
      {nm.status === "error" && (
        // Dit, pas avale : le cas le plus probable est une coupure reseau au
        // milieu de 1,9 Go, et l'utilisateur doit pouvoir reappuyer en sachant
        // pourquoi le premier essai n'a pas abouti.
        <p className="sub">Download failed: {nm.message}</p>
      )}
    </div>
  );
}

// B3d : LE DOSSIER D'ENREGISTREMENTS N'EXISTE PLUS.
//
// Cet onglet montrait un chemin, un bouton « Ouvrir », et une regle de nettoyage
// a 90 jours. Les trois decrivaient un dossier que Flow remplissait. Les reunions
// vivent maintenant dans le compte, donc :
//
//  - il n'y a plus de chemin a montrer, ni de nettoyage a suspendre ou a
//    reprendre. Un bouton « Reprendre le nettoyage a 90 jours » qui ne nettoie
//    plus rien serait pire que pas de bouton : ce serait une interface qui ment.
//  - il reste le dossier de CEUX D'AVANT, et il compte plus qu'avant : c'est le
//    seul endroit ou sont les reunions enregistrees par une version precedente.
//    Il est donc montre, avec son chemin, et rien n'y est jamais touche.
function TabStorage({ s }: { s: UiStatePayload; patch: Patch }) {
  const legacy = s.legacyHistory;
  return (
    <div className="rows">
      <Row
        label="Where your meetings live"
        help="In your Flow account, not on this computer. Open the Notes page to browse them; they follow you to any machine you sign in on."
      >
        <span className="mono">{s.account?.email || "your account"}</span>
      </Row>
      {/* Montre UNIQUEMENT quand un dossier porte encore des enregistrements
          d'avant. Les faire disparaitre de l'ecran sans un mot ferait croire
          qu'ils ont ete supprimes, alors qu'ils sont intacts sur le disque. */}
      {legacy ? (
        <Row
          label="Recordings made before this update"
          help={
            legacy.exists
              ? "Flow used to file recordings into a folder on this computer. It no longer does - but nothing was moved or deleted: everything you recorded back then is still in this folder, which Flow just checked is there."
              : "Flow used to file recordings into a folder on this computer. It no longer finds it at this path - it was moved, renamed or is on a drive that is not connected. Flow never deleted anything there."
          }
        >
          <span className="mono">{legacy.dir}</span>
          {legacy.exists ? (
            <button className="btn" aria-label="Open the old folder" onClick={() => void window.flowui.openPath("legacy-history")}>Open the old folder</button>
          ) : null}
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
