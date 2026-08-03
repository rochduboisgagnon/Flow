import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LongRecorder, listHistory, type LongDeps } from "../src/main/longform";
import { transcriptHeader, interruptedNote } from "../src/shared/longform";
import { ABANDON_AFTER_MS } from "../src/shared/recordings";
import { fakeCaptureStore, type FakeCaptureStore } from "./fixtures/capture-store";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

// ---------------------------------------------------------------------------
// U4 (blocking finding), tel que B3 le tient maintenant.
//
// Une reunion coupee par une fermeture, un plantage ou une coupure de courant
// ne doit jamais DISPARAITRE : elle doit etre visible COMME interrompue. Trois
// filets, tous testes ici :
//
//   1. rescueOnQuit(), strictement SYNCHRONE, appele depuis before-quit (une
//      finalize() asynchrone n'y a jamais le temps de tourner : Electron
//      n'attend rien). Elle insere l'avertissement, ferme la ligne, la met en
//      file, et rend la main.
//   2. rescueAbandoned(), a la connexion : une ligne restee OUVERTE que plus
//      personne n'alimente est une reunion interrompue. C'est le filet qui
//      couvre ce que before-quit ne voit jamais - et, nouveau avec B3, la
//      reunion coupee sur l'AUTRE ordinateur.
//   3. rescueOrphanedStaging(), le balayage des dossiers laisses par une
//      version PRECEDENTE de Flow. Il ne peut plus rien trouver d'une session
//      de ce build, et c'est justement pourquoi il reste : une mise a jour ne
//      doit pas perdre ce que la version d'avant avait sur le disque.
//
// Aucun test ne touche le vrai ~/.flow.
// ---------------------------------------------------------------------------

const SR = 16_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function tone(ms: number, amp = 6000): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amp);
  return out;
}
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}
function speechy(ms: number): Int16Array {
  const parts: Int16Array[] = [];
  let left = ms;
  while (left > 0) {
    const burst = Math.min(400, left);
    parts.push(tone(burst, 7000));
    left -= burst;
    if (left > 0) {
      const gap = Math.min(200, left);
      parts.push(silence(gap));
      left -= gap;
    }
  }
  return concat(...parts);
}
function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function make(over: Partial<LongDeps> = {}): { rec: LongRecorder; store: FakeCaptureStore; logs: string[] } {
  const store = fakeCaptureStore();
  const logs: string[] = [];
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    store,
    historyRootOverride: path.join(os.tmpdir(), "flow-rescue-legacy-history"),
    stagingRootOverride: path.join(os.tmpdir(), "flow-rescue-legacy-staging"),
    schedule: () => () => {},
    log: (m) => logs.push(m),
    ...over,
  });
  return { rec, store, logs };
}

/** Une ligne restee OUVERTE dans le compte, exactement comme une session tuee
 * en laisse une : un titre, un instant de depart, un document partiel avec son
 * entete, et pas d'instant de fin. */
function openRow(store: FakeCaptureStore, o: { id: string; title: string; startedIso: string; doc?: string }) {
  const header = transcriptHeader(o.title, o.startedIso);
  store.rows.set(o.id, {
    id: o.id,
    title: o.title,
    startedIso: o.startedIso,
    durationMs: 90 * 60_000,
    doc: o.doc ?? header + "[00:00:00] Bonjour tout le monde.\n\n",
    audioPath: "",
    audioBytes: 0,
    audioUploaded: 0,
    audioUploadUrl: "",
    audioUploadExpires: "",
    staged: true,
    endedIso: "", // OUVERTE
  });
}

// ---------------------------------------------------------------------------
// 2. LE SAUVETAGE A LA CONNEXION
// ---------------------------------------------------------------------------

test("B3b: une ligne ouverte que plus personne n'alimente est fermee, et le document le DIT", async () => {
  const { rec, store, logs } = make();
  const startedIso = new Date(Date.now() - 90 * 60_000).toISOString();
  openRow(store, { id: "r1", title: "Board meeting", startedIso });

  assert.equal(await rec.rescueAbandoned(), 1, "one recording rescued");

  const row = store.rows.get("r1")!;
  assert.ok(row.endedIso, "la ligne est fermee : elle sort de l'ensemble des lignes ouvertes");
  assert.equal(row.endedIso, startedIso, "fermee au dernier instant ou on la savait vivante, pas a maintenant");
  assert.ok(row.doc.includes("Interrupted recording"), "the document is honest about how it ended");
  assert.ok(
    row.doc.indexOf("Interrupted recording") < row.doc.indexOf("[00:00:00]"),
    "the note sits above the transcript, not buried at the end of a three-hour document",
  );
  assert.ok(row.doc.includes("# Board meeting"), "the header is preserved");
  assert.equal(row.staged, true, "it still deserves a 'Save to...' - the user never filed it");
  assert.ok(logs.some((m) => /reunion interrompue retrouvee/.test(m)), "the rescue is journalled");

  // Et elle n'est pas sauvee deux fois : la ligne n'est plus ouverte.
  assert.equal(await rec.rescueAbandoned(), 0);
});

test("B3b: une reunion EN COURS sur l'autre ordinateur n'est PAS marquee interrompue", async () => {
  // Le cas que la refonte cree, et que rien ne couvrait avant. Sans le pouls,
  // se connecter sur le portable pendant que le fixe enregistre aurait ferme la
  // reunion en cours et pose un avertissement mensonger dedans.
  const { rec, store, logs } = make();
  const fresh = new Date(Date.now() - 10_000).toISOString();
  openRow(store, { id: "live", title: "En cours ailleurs", startedIso: fresh });

  assert.equal(await rec.rescueAbandoned(), 0, "rien a sauver : quelqu'un enregistre");
  const row = store.rows.get("live")!;
  assert.equal(row.endedIso, "", "la ligne reste ouverte");
  assert.ok(!row.doc.includes("Interrupted"), "et son document n'est pas annote");
  assert.ok(logs.some((m) => /en cours d'enregistrement ailleurs/.test(m)), "et Flow le dit");
});

test("B3b: la borne du pouls est celle que le module annonce", async () => {
  const { rec, store } = make();
  openRow(store, { id: "edge", title: "Juste au-dela", startedIso: new Date(Date.now() - ABANDON_AFTER_MS - 5_000).toISOString() });
  openRow(store, { id: "in", title: "Juste en deca", startedIso: new Date(Date.now() - ABANDON_AFTER_MS + 30_000).toISOString() });
  assert.equal(await rec.rescueAbandoned(), 1, "seule celle qui a depasse la borne est fermee");
  assert.ok(store.rows.get("edge")!.endedIso);
  assert.equal(store.rows.get("in")!.endedIso, "");
});

test("B3b: le sauvetage recolle les notes tapees pendant la seance morte", async () => {
  // Le piege nomme par le plan : les notes en direct sont DEJA dans le compte,
  // sous leur started_iso. Une seance morte ne les a dans la memoire de
  // personne, donc le sauvetage doit aller les lire la.
  const { rec, store } = make();
  const startedIso = new Date(Date.now() - 90 * 60_000).toISOString();
  openRow(store, { id: "r2", title: "Avec mes notes", startedIso });
  store.liveNotes.set(startedIso, [
    { atMs: 5_000, text: "il faut rappeler Steve" },
    { atMs: 60_000, text: "budget a revoir" },
  ]);

  assert.equal(await rec.rescueAbandoned(), 1);
  const row = store.rows.get("r2")!;
  assert.ok(row.doc.includes("il faut rappeler Steve"), "les notes de quelqu'un ne se perdent pas dans un plantage");
  assert.ok(row.doc.includes("budget a revoir"));
  // Et le corps commence par le bloc de notes, ce dont depend la completude du
  // retrait d'un passage (shared/redact.ts).
  const body = row.doc.slice(transcriptHeader("Avec mes notes", startedIso).length);
  assert.ok(body.startsWith("## Notes\n"), "le corps commence par le bloc : " + body.slice(0, 40));
  assert.ok(body.includes("Interrupted recording"), "l'avertissement reste, descendu dans le transcript");
  // La fente du compte n'est videe qu'APRES l'ecriture du document.
  assert.deepEqual(store.clearedNotes, [startedIso]);
  assert.equal(store.liveNotes.has(startedIso), false);
});

test("B3b: sans notes, la fente du compte n'est PAS videe", async () => {
  const { rec, store } = make();
  openRow(store, { id: "r3", title: "Sans notes", startedIso: new Date(Date.now() - 90 * 60_000).toISOString() });
  assert.equal(await rec.rescueAbandoned(), 1);
  assert.deepEqual(store.clearedNotes, [], "rien a effacer, donc rien d'efface");
});

test("B3b: la ligne de la reunion EN COURS ici n'est jamais touchee par son propre sauvetage", async () => {
  // rescueAbandoned() peut tourner apres une reconnexion en cours de reunion.
  // Elle doit reconnaitre sa propre ligne, quoi que dise son pouls.
  const { rec, store } = make();
  const started = rec.start({ title: "Ici, maintenant" });
  const id = started.recordingId!;
  // Le faux magasin derive le pouls de l'instant de depart : on le vieillit
  // artificiellement pour rendre la ligne « abandonnee » aux yeux du tri.
  const row = store.rows.get(id)!;
  store.rows.set(id, { ...row, startedIso: new Date(Date.now() - 10 * 60_000).toISOString() });

  assert.equal(await rec.rescueAbandoned(), 0, "on n'interrompt pas la reunion qu'on est en train de faire");
  assert.equal(store.rows.get(id)!.endedIso, "");
  rec.stop();
});

test("B3b: un compte sans ligne ouverte ne dit rien et ne fait rien", async () => {
  const { rec, logs } = make();
  assert.equal(await rec.rescueAbandoned(), 0);
  assert.deepEqual(logs, [], "nothing to rescue, nothing to say");
});

// ---------------------------------------------------------------------------
// 1. LA FERMETURE DE L'APPLICATION
// ---------------------------------------------------------------------------

test("B3a: quitter en cours de reunion ferme la ligne avec son avertissement, sans rien attendre", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-rescue-quit-"));
  // Un moteur qui ne repond JAMAIS : le retard de transcription ne peut donc pas
  // se resorber, ce qui est exactement l'etat qu'une vraie fermeture interrompt
  // (et la raison pour laquelle finalize() ne peut pas etre le sauvetage).
  const wedged = {
    transcribe: () => new Promise<{ text: string; ms: number }>(() => {}),
  } as unknown as WhisperSidecar;
  const { rec, store } = make({
    transcribeSegment: (wav) => wedged.transcribe(wav),
    pendingAudioDir: path.join(work, "pending"),
  });

  const started = rec.start({ title: "Interrupted client call", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(3000), silence(1500))); // closes a segment into the wedged queue
  assert.equal(rec.isBusy, true);

  // Ce que app.on("before-quit") fait, synchroniquement. Rien n'est attendu.
  const t0 = Date.now();
  assert.equal(rec.rescueOnQuit(), true, "the rescue reports that it saved something");
  assert.ok(Date.now() - t0 < 500, "before-quit est SYNCHRONE : le sauvetage ne peut rien attendre");

  const row = store.rows.get(started.recordingId!)!;
  assert.ok(row.doc.includes("# Interrupted client call"));
  assert.ok(row.doc.includes("Flow was closed while this recording was still running"), "the document says how it ended");
  assert.ok(row.doc.includes("no summary was generated"), "and that it has no summary");
  assert.ok(/still queued for transcription/.test(row.doc), "and that queued segments were never transcribed");
  assert.ok(row.endedIso, "la ligne est fermee");

  // Le moteur n'a plus l'air occupe, et la finalize() laissee en suspens ne doit
  // pas reecrire la meme reunion quand elle se reveille.
  assert.equal(rec.isBusy, false, "the engine is not left looking busy forever");
  const writesAfterQuit = store.writes.length;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(store.writes.length, writesAfterQuit, "no second write from the abandoned finalize()");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: quitter recolle les notes tapees, et ne vide la fente qu'apres avoir ecrit le document", () => {
  const notes = [{ atMs: 12_000, text: "penser au devis" }];
  const cleared: string[] = [];
  const { rec, store } = make({
    liveNotes: {
      open: () => {},
      read: () => notes,
      clear: (s) => cleared.push(s),
    },
  });
  const started = rec.start({ title: "Quit with notes" });
  const startedIso = rec.state().startedIso;
  rec.onChunk(speechy(3000));
  assert.equal(rec.rescueOnQuit(), true);

  const row = store.rows.get(started.recordingId!)!;
  assert.ok(row.doc.includes("penser au devis"), "les notes sont dans le document");
  // L'ORDRE est ce qui rend l'effacement sur : la file est FIFO, donc l'ecriture
  // du document passe avant la suppression des notes du compte. Si l'inverse
  // arrivait, un processus qui meurt entre les deux aurait jete les notes de
  // quelqu'un - la seule partie d'une capture qu'on ne peut pas regenerer.
  assert.ok(
    store.writes.some((w) => w.doc.includes("penser au devis")),
    "le document part en file AVEC les notes dedans",
  );
  assert.deepEqual(cleared, [startedIso], "et la fente est videe ensuite, sous la bonne cle");
});

test("B3a: rescueOnQuit ne fait rien quand aucune reunion n'est en cours", () => {
  const { rec, store } = make();
  assert.equal(rec.rescueOnQuit(), false, "an idle engine has nothing to rescue");
  assert.equal(store.writes.length, 0, "and writes nothing");
});

test("B3b: quitter hors ligne ne perd rien - la ligne reste OUVERTE et le prochain lancement la ferme", async () => {
  // Le scenario complet du filet : le reseau est coupe, la file ne se vide pas,
  // le processus meurt. Ce que Supabase detient est la derniere tranche montee,
  // avec ended_at NULL - donc le sauvetage du lancement suivant la voit.
  const { rec, store } = make({ transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 1 }) });
  const started = rec.start({ title: "Coupure a la fermeture" });
  const id = started.recordingId!;
  rec.onChunk(concat(speechy(3000), silence(1500)));
  await new Promise((r) => setTimeout(r, 80));
  rec.flushSlice(); // une tranche est montee

  store.goOffline(); // et le reseau tombe
  rec.rescueOnQuit(); // l'application meurt : la fermeture reste en file
  assert.equal(store.rows.get(id)!.endedIso, "", "ce que le compte detient est une ligne OUVERTE");
  assert.ok(store.pending() > 0, "et la fermeture attend dans la file");

  // Prochain lancement, reseau revenu, rien en memoire : la ligne est fermee
  // depuis le compte.
  const next = make({});
  next.store.rows.set(id, { ...store.rows.get(id)!, startedIso: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal(await next.rec.rescueAbandoned(), 1);
  const closed = next.store.rows.get(id)!;
  assert.ok(closed.endedIso, "la reunion est fermee");
  assert.ok(closed.doc.includes("Interrupted recording"), "et visible COMME interrompue");
  assert.ok(closed.doc.includes("Bonjour."), "avec tout ce qui avait ete transcrit");
});

// ---------------------------------------------------------------------------
// 3. LE BALAYAGE DES DOSSIERS D'UNE VERSION PRECEDENTE
// ---------------------------------------------------------------------------

/** Un dossier staging exactement comme une session tuee par un Flow PLUS ANCIEN
 * en laisse un : le dossier nomme « <epoch ms>-<random> », le document ecrit au
 * fil de l'eau avec son entete, et le .wav de la capture. */
function orphanStagingFolder(
  staging: string,
  opts: { title: string; startedMs: number; withAudio?: boolean; base?: string },
): { dir: string; doc: string; audio: string } {
  const dir = path.join(staging, String(opts.startedMs) + "-abc123");
  fs.mkdirSync(dir, { recursive: true });
  const base = opts.base ?? "orphan-meeting";
  const doc = path.join(dir, base + ".md");
  fs.writeFileSync(
    doc,
    transcriptHeader(opts.title, new Date(opts.startedMs).toISOString()) + "[00:00:00] Bonjour tout le monde.\n\n",
  );
  const audio = path.join(dir, base + ".wav");
  if (opts.withAudio !== false) fs.writeFileSync(audio, Buffer.alloc(44 + SR * 2 * 3)); // 3 s of PCM
  return { dir, doc, audio };
}

test("B3a: un dossier staging laisse par une version PRECEDENTE est classe dans l'archive locale", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-legacy-sweep-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  const startedMs = Date.now() - 90 * 60_000;
  const orphan = orphanStagingFolder(staging, { title: "Board meeting", startedMs });

  const { rec, logs } = make({ stagingRootOverride: staging, historyRootOverride: history });
  assert.equal(rec.rescueOrphanedStaging(), 1, "one recording rescued");

  assert.equal(fs.existsSync(orphan.doc), false, "the document left staging");
  assert.equal(fs.existsSync(orphan.dir), false, "the emptied staging session folder is cleaned up");

  const items = listHistory(history);
  assert.equal(items.length, 1, "the rescued recording shows up in the local archive");
  assert.equal(items[0].hasAudio, true, "a recovery keeps the audio it cannot attribute");
  assert.ok(logs.some((m) => /an older Flow/.test(m)), "and the log says where it came from");

  const filed = path.join(history, items[0].date, items[0].title);
  const doc = fs.readFileSync(path.join(filed, fs.readdirSync(filed).find((f) => f.endsWith(".md"))!), "utf8");
  assert.ok(doc.includes("Interrupted recording"), "the document is honest about how it ended");
  assert.ok(doc.includes("# Board meeting"), "the header is preserved");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: le balayage est un silence total quand staging est vide ou absent", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-legacy-none-"));
  const { rec, logs } = make({
    stagingRootOverride: path.join(work, "staging"), // never created
    historyRootOverride: path.join(work, "history"),
  });
  assert.equal(rec.rescueOrphanedStaging(), 0);
  assert.deepEqual(logs, [], "nothing to rescue, nothing to say");
  assert.equal(fs.existsSync(path.join(work, "history")), false, "and no history root is created for nothing");

  fs.mkdirSync(path.join(work, "staging"), { recursive: true });
  assert.equal(rec.rescueOrphanedStaging(), 0, "an empty staging folder rescues nothing");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: un dossier recupere n'est jamais classe dans une date que la purge suivante supprimerait", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-legacy-date-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  // Une machine restee eteinte des mois : classer sous sa vraie date la
  // livrerait a la purge - sauvee dans la poubelle.
  const orphan = orphanStagingFolder(staging, { title: "Very old meeting", startedMs: Date.now() - 200 * DAY_MS });
  const { rec } = make({ stagingRootOverride: staging, historyRootOverride: history });
  assert.equal(rec.rescueOrphanedStaging(), 1);
  const items = listHistory(history);
  assert.equal(items.length, 1);

  rec.purgeHistory();
  assert.deepEqual(
    listHistory(history).map((i) => i.title),
    items.map((i) => i.title),
    "a recording rescued an instant ago is not immediately purgeable",
  );
  assert.equal(fs.existsSync(orphan.dir), false, "and it really did leave staging");

  // Un dossier dans la fenetre est classe sous SA date, pas sous celle du jour.
  // Les deux cotes derivent du MEME instant (U5 review : la version d'avant
  // comparait a Date.now() et echouait une heure sur vingt-quatre).
  const startedMs = Date.now() - 60 * 60_000;
  orphanStagingFolder(staging, { title: "Today", startedMs, base: "today-meeting" });
  rec.rescueOrphanedStaging();
  const today = listHistory(history).find((i) => i.title.startsWith("today-meeting"));
  const pad = (n: number) => String(n).padStart(2, "0");
  const started = new Date(startedMs);
  assert.equal(today!.date, `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`);
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: le balayage classe meme quand la purge de retention est suspendue", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-legacy-suspended-"));
  const staging = path.join(work, "staging");
  const history = path.join(work, "history");
  orphanStagingFolder(staging, { title: "Suspended-purge meeting", startedMs: Date.now() - 60_000 });
  const { rec } = make({
    stagingRootOverride: staging,
    historyRootOverride: history,
    historyPurgeSuspended: () => true, // U2c: rien n'est jamais SUPPRIME ici...
  });
  assert.equal(rec.rescueOrphanedStaging(), 1, "...mais classer un enregistrement n'est pas en supprimer un");
  assert.equal(listHistory(history).length, 1);
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: un balayage qui ne peut pas ecrire ne detruit rien et ne leve jamais", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-legacy-fail-"));
  const staging = path.join(work, "staging");
  // La racine d'archive est un FICHIER : tout mkdir dessous echoue, partout.
  const history = path.join(work, "history");
  fs.writeFileSync(history, "not a folder");
  const orphan = orphanStagingFolder(staging, { title: "Doomed", startedMs: Date.now() - 60_000 });

  const { rec, logs } = make({ stagingRootOverride: staging, historyRootOverride: history });
  assert.doesNotThrow(() => assert.equal(rec.rescueOrphanedStaging(), 0));
  assert.equal(fs.existsSync(orphan.doc), true, "still in staging, for the next boot to try again");
  assert.ok(fs.readFileSync(orphan.doc, "utf8").includes("# Doomed"), "and it is still readable");
  assert.ok(logs.some((m) => /cannot prepare the history folder/.test(m)), "the failure is journalled, not silent");
  assert.equal(fs.readFileSync(history, "utf8"), "not a folder", "and nothing outside the app's roots was touched");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: un dossier staging sans transcript est laisse exactement ou il est", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-legacy-nodoc-"));
  const staging = path.join(work, "staging");
  const dir = path.join(staging, String(Date.now()) + "-zzz999");
  fs.mkdirSync(dir, { recursive: true });
  const stray = path.join(dir, "audio-only.wav");
  fs.writeFileSync(stray, Buffer.alloc(64));
  const { rec, logs } = make({ stagingRootOverride: staging, historyRootOverride: path.join(work, "history") });
  assert.equal(rec.rescueOrphanedStaging(), 0, "nothing to file without a document");
  assert.equal(fs.existsSync(stray), true, "Flow never deletes what it does not understand");
  assert.ok(logs.some((m) => /without a transcript/.test(m)), "it says so instead of failing silently");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4: the interruption note tells the truth about what was and was not transcribed", () => {
  const quitPending = interruptedNote("quit", 3);
  assert.ok(quitPending.includes("Flow was closed while this recording was still running"));
  assert.ok(quitPending.includes("the last 3 audio segments were still queued"));
  assert.ok(quitPending.includes("no summary was generated"));

  assert.ok(interruptedNote("quit", 1).includes("the last 1 audio segment was still queued"));
  assert.ok(interruptedNote("quit", 0).includes("nothing was left waiting for transcription"));

  const recovered = interruptedNote("recovered", -1);
  assert.ok(recovered.includes("crash, power loss or forced quit"));
  assert.ok(recovered.includes("anything still waiting for transcription at that moment was lost"));

  // A markdown blockquote followed by a blank line, like every other note the
  // transcript carries (markLine, gapLine): it must not glue itself to the
  // header or to the first transcript line.
  for (const note of [quitPending, recovered]) {
    assert.ok(note.startsWith("> ["), "a blockquote, like the marks and gaps");
    assert.ok(note.endsWith("]\n\n"), "and a blank line after it");
  }
});
