import React, { useEffect, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import { Toggle, Row } from "../components";
import { SignInForm } from "../SignIn";

// Settings (wave U1 restyle): the tabs' LOGIC is transplanted verbatim from the
// pre-split main.tsx - same window.flowui calls, same state shapes. Only the
// markup moved to the mockup's .row .l/.c pattern.
//
// ---------------------------------------------------------------------------
// NEUF ONGLETS SONT DEVENUS QUATRE (2026-08-04, demande de Roch)
// ---------------------------------------------------------------------------
//
// « La section Dictation & Audio, enleve-les puis transfere-les dans General.
// Puis la section Account, mais la aussi dans General. La section Local AI, je te
// dirais de l'enlever. La section About, tu pourrais l'enlever ou la mettre
// combinee avec Updates. Comme ca, ca va liberer un peu les settings. »
//
// AUCUN CONTROLE N'A DISPARU, et c'est la seule chose qui rendait ce
// regroupement acceptable : chaque rangee des cinq onglets retires vit
// maintenant dans un des quatre qui restent. Ou elle est allee, nommement :
//
//   Account     -> General, en TETE (rien ne fonctionne sans compte)
//   Dictation   -> General
//   Audio       -> General
//   Local AI    -> Engine. C'est un MODELE qui se telecharge, donc il rejoint
//                  l'onglet des modeles plutot que de mourir avec son onglet.
//   About       -> Updates, renomme « Updates & About ». La rangee de version en
//                  double a fusionne avec celle qui etait deja la ; le depot et
//                  le journal sont intacts.
//
// Une seule collision a fallu trancher : « Microphone » etait le libelle de DEUX
// rangees - le selecteur de peripherique (Audio) et l'etat de prechauffage
// (Dictation). La seconde est devenue « Microphone readiness ».

type SettingsTab = "general" | "engine" | "storage" | "updates";

type Patch = (p: Record<string, unknown>) => Promise<void>;

export function SettingsPage({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabs: Array<[SettingsTab, string]> = [
    ["general", "General"],
    ["engine", "Engine"],
    ["storage", "Storage & Privacy"],
    ["updates", "Updates & About"],
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
      {tab === "engine" ? <TabEngine s={s} patch={patch} /> : null}
      {/* Storage ne PATCHE plus rien : la regle de nettoyage a 90 jours etait son
          seul reglage, et elle est partie avec le dossier qu'elle nettoyait. */}
      {tab === "storage" ? <TabStorage s={s} /> : null}
      {tab === "updates" ? <TabUpdates s={s} /> : null}
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
function AccountRows({ s }: { s: UiStatePayload }) {
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
      <>
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
      </>
    );
  }

  // B4 : LE MEME formulaire que l'ecran de lancement, jamais une seconde copie.
  // Deux formulaires divergent, et un seul des deux se souviendrait dans six mois
  // que le mot de passe doit quitter le champ meme quand la connexion echoue.
  return <SignInForm />;
}

/**
 * L'ONGLET QUI PORTE TOUT CE QU'ON REGLE VRAIMENT.
 *
 * L'ORDRE DES QUATRE BLOCS N'EST PAS L'ORDRE DES ANCIENS ONGLETS. Il va du plus
 * structurel au plus fin :
 *
 *  1. LE COMPTE, en tete, parce que rien d'autre dans cette page ne fonctionne
 *     sans lui - les reglages eux-memes vivent dedans depuis la refonte.
 *  2. L'APPLICATION : theme, demarrage, comportement de la fenetre.
 *  3. LA DICTEE : le raccourci et ce qui arrive au texte.
 *  4. LE MICRO : quel appareil, et ce que Flow en fait.
 *
 * Il n'y a volontairement PAS de sous-titres de section. Une page de reglages qui
 * s'organise en quatre paves titres redemande de lire une table des matieres pour
 * trouver un interrupteur ; les rangees sont deja etiquetees, et le regroupement
 * se voit dans l'ordre.
 */
function TabGeneral({ s, patch }: { s: UiStatePayload; patch: Patch }) {
  const [login, setLogin] = useState<boolean | null>(null);
  const [rec, setRec] = useState(false);
  const [mics, setMics] = useState<Array<{ id: string; label: string }> | null>(null);
  useEffect(() => { void window.flowui.getLoginItem().then(setLogin); }, []);
  useEffect(() => { void window.flowui.listMics().then(setMics); }, []);
  async function record() {
    setRec(true);
    try { await window.flowui.recordShortcut(); } finally { setRec(false); }
  }
  return (
    <div className="rows">
      <AccountRows s={s} />
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
      {/* 2026-08-04 : renommee. Elle s'appelait « Microphone », comme le
          selecteur de peripherique juste en dessous - deux rangees du meme nom
          dans le meme onglet, dont une qui ne se regle pas. */}
      <Row
        label="Microphone readiness"
        help="Stays ready a few seconds after each dictation so your first word is never clipped. Windows shows its microphone indicator meanwhile. Nothing reaches the disk, the buffer is erased after use, and locking the session releases it."
      >
        <span className="pinned">Always ready &#183; nothing to configure</span>
      </Row>
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
      {/* 2026-08-04 : cette rangee arrive de l'onglet « Local AI », supprime a la
          demande de Roch. Elle est ici et pas ailleurs parce que c'est un MODELE
          qui se telecharge, comme celui du dessus : l'onglet des modeles est
          l'endroit ou quelqu'un qui cherche « pourquoi je n'ai pas de notes » va
          regarder.

          D : le selecteur de fournisseur a disparu bien avant, et avec lui la
          pastille « vos transcripts partent chez X ». Il n'y a plus qu'un lieu
          d'execution et il est sur cette machine.

          POURQUOI UN BOUTON ET PAS UN TELECHARGEMENT AUTOMATIQUE : 1,9 Go.
          Personne ne devrait decouvrir apres coup qu'une application a pris ca
          sur sa connexion. */}
      <Row
        label="Meeting notes model"
        help="Speech is always transcribed on this machine, by Flow's own engine. This second model writes the meeting NOTES from that transcript, and it runs here too - nothing is sent anywhere. It is optional: without it, a recording still produces its full timestamped transcript, just no notes."
      >
        {s.notesModel.status === "ready" ? (
          <span className="sub" style={{ margin: 0 }}>Installed. Notes are written on this machine.</span>
        ) : s.notesModel.status === "downloading" ? (
          <span className="sub" style={{ margin: 0 }}>Downloading... {s.notesModel.pct ?? 0}%</span>
        ) : (
          <button type="button" onClick={() => void window.flowui.downloadNotesModel()}>
            Download (1.9 GB)
          </button>
        )}
      </Row>
      {s.notesModel.status === "error" ? (
        // Dit, pas avale : le cas le plus probable est une coupure reseau au
        // milieu de 1,9 Go, et l'utilisateur doit pouvoir reappuyer en sachant
        // pourquoi le premier essai n'a pas abouti.
        <p className="sub">Download failed: {s.notesModel.message}</p>
      ) : null}
    </div>
  );
}


/**
 * OU VIVENT LES DONNEES. Quatre rangees, dont deux conditionnelles.
 *
 * Roch, le 2026-08-04 : « la section Storage & Privacy, tu pourrais l'ameliorer
 * juste pour dire que tout est stocke dans le cloud. That's it, garde ca
 * simple. »
 *
 * C'est fait, avec UNE reserve qui n'est pas une desobeissance : « tout est dans
 * le cloud » n'est pas exact, et cette page est la seule qui puisse le corriger.
 * Deux choses restent sur la machine :
 *
 *  - l'historique des DICTEES (le texte, un mois, liste sur Home) ;
 *  - un .wav en transit, le temps qu'il monte - et pour toujours quand le compte
 *    l'a refuse pour sa taille (vu en vrai le 2026-08-04).
 *
 * Une page « vie privee » qui aurait dit « tout est dans le cloud » aurait donc
 * ete rassurante et fausse, exactement comme le « rien de ce que vous dictez
 * n'est conserve » que cette meme page a deja du corriger une fois. Les deux
 * exceptions tiennent en une phrase chacune, ce qui reste simple.
 *
 * B3d : et il n'y a plus de chemin de dossier d'enregistrements, ni de regle de
 * nettoyage a 90 jours. Un bouton « Reprendre le nettoyage » qui ne nettoie plus
 * rien serait une interface qui ment.
 */
function TabStorage({ s }: { s: UiStatePayload }) {
  const legacy = s.legacyHistory;
  return (
    <div className="rows">
      <Row
        label="Everything is in your account"
        help="Your settings, your dictionary, your meetings and their audio live in your Flow account, not on this computer. Sign in on another machine and they follow you. Nothing is kept here to be lost with the disk."
      >
        <span className="mono">{s.account?.email || "your account"}</span>
      </Row>
      <Row
        label="What stays on this computer"
        help="Two things, both on purpose: a rolling month of DICTATION text (listed on Home, erasable there - its audio is never written anywhere), and a recording's audio file for as long as it takes to upload."
      >
        <span />
      </Row>
      {/* 2026-08-04 : LA SEULE CAPACITE QUE LA SUPPRESSION DE DIAGNOSTICS AURAIT
          FAIT PERDRE. Ce bouton etait la-bas ; il ouvre le dossier ou vivent le
          journal, la session et les .wav en transit. Il est ici parce que c'est
          l'onglet qui parle de ce qui reste sur la machine, et parce que
          l'auto-diagnostic y renvoie nommement quand il ne trouve pas un
          dossier (voir shared/selfCheck.ts). */}
      <Row
        label="Flow's folder on this computer"
        help="Holds the engine log, your session, and an audio file only while it is on its way up. Nothing you dictate is kept here."
      >
        <button className="btn" onClick={() => void window.flowui.openPath("data")}>
          Open Flow&apos;s folder
        </button>
      </Row>
      {/* Montre UNIQUEMENT quand il y a vraiment un fichier en attente. Un compte
          qui refuse un audio pour sa taille laisse le .wav ici, et c'est alors la
          seule copie qui existe : le dire est le minimum. */}
      {s.audioRefusedForSize.length > 0 ? (
        <Row
          label="Audio your account refused"
          help="One or more recordings were too large for your account's per-file limit, so their audio could not be uploaded. Nothing was deleted: the files are still on this computer. Open a recording in Notes to see which one."
        >
          <span className="num">{s.audioRefusedForSize.length}</span>
          <button className="btn" onClick={() => void window.flowui.openPath("pending-audio")}>
            Open the folder
          </button>
        </Row>
      ) : null}
      {/* Montre UNIQUEMENT quand un dossier porte encore des enregistrements
          d'avant la refonte. Les faire disparaitre de l'ecran sans un mot ferait
          croire qu'ils ont ete supprimes, alors qu'ils sont intacts sur le
          disque. */}
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
      {/* 2026-08-04 : l'onglet About a fondu ici, a la demande de Roch. Sa
          rangee « Flow » portait le MEME numero de version que celle-ci ; garder
          les deux aurait affiche deux fois le meme fait dans un onglet cense en
          liberer. Ce qu'elle disait en plus - l'auteur et la licence - a rejoint
          cette aide. */}
      <Row
        label="Flow"
        help="Local, on-device voice transcription by AGR Labs, MIT license. Flow updates itself from GitHub Releases, and never installs an update while you are dictating or recording."
      >
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
      {/* Les deux rangees de l'onglet About qui faisaient VRAIMENT quelque
          chose : elles ouvrent chacune une chose reelle, et il n'y avait aucune
          raison de les perdre en supprimant l'onglet. */}
      <Row label="Source code" help="github.com/rochduboisgagnon/Flow">
        <button className="btn" onClick={() => void window.flowui.openPath("repo")}>Open on GitHub</button>
      </Row>
      <Row label="Engine log" help="The rotating diagnostic log. Nothing you dictate is ever written to it.">
        <button className="btn" onClick={() => void window.flowui.openPath("log")}>Open log</button>
      </Row>
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


