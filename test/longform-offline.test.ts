import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LongRecorder } from "../src/main/longform";
import { WorkingCopy } from "../src/main/data/workingCopy";
import { WorkingCopyCaptureStore } from "../src/main/data/captureStore";
import type { Repo, RepoResult, Snapshot } from "../src/main/data/repo";
import type { OpenRecording, RecordingRow } from "../src/shared/recordings";

// ---------------------------------------------------------------------------
// B3b : « Reseau coupe dix minutes au milieu : le document final est intact. »
//
// C'est la condition de fin que le plan ecrit pour cette tache, et c'est la
// quatrieme des sept regressions annoncees - la seule qui coute une heure de
// travail a quelqu'un.
//
// CE TEST N'UTILISE PAS DE DOUBLURE DE MAGASIN. Il monte la vraie chaine -
// LongRecorder -> WorkingCopyCaptureStore -> WorkingCopy -> depot - et ne
// remplace que le depot, c'est-a-dire l'endroit exact ou le reseau existe. Les
// tests unitaires des deux bouts prouvent leurs regles chacun de leur cote ;
// celui-ci prouve qu'assembles, ils tiennent la promesse. La difference n'est
// pas theorique : la fusion de la file, la lecture d'une reunion detenue par la
// file, et le fait qu'une ligne terminee ne soit pas lachee avant d'etre montee
// sont trois pieces separees, et il suffit qu'une seule manque pour perdre la
// reunion sans qu'aucun test unitaire ne bronche.
// ---------------------------------------------------------------------------

const EMPTY: Snapshot = { settings: {}, dictionary: [], stats: [], dictations: [] };
const OK = <T,>(data: T): RepoResult<T> => ({ ok: true, data, error: "" });
const KO = <T,>(data: T): RepoResult<T> => ({ ok: false, data, error: "reseau injoignable" });

/** Un depot dont on coupe le reseau a volonte. Il garde ce qui est arrive, comme
 * Supabase le ferait. */
function switchableRepo() {
  const rows = new Map<string, RecordingRow>();
  const attempts: string[] = [];
  let online = true;
  const repo = {
    loadAll: () => Promise.resolve(OK(EMPTY)),
    purgeOldDictations: () => Promise.resolve(OK(null)),
    saveRecording: (r: RecordingRow) => {
      attempts.push(r.id);
      if (!online) return Promise.resolve(KO(null));
      rows.set(r.id, { ...r });
      return Promise.resolve(OK(null));
    },
    deleteRecording: (id: string) => {
      if (!online) return Promise.resolve(KO(null));
      rows.delete(id);
      return Promise.resolve(OK(null));
    },
    readRecording: (id: string) => Promise.resolve(online ? OK(rows.get(id) ?? null) : KO(null)),
    listOpenRecordings: () => {
      if (!online) return Promise.resolve(KO([] as OpenRecording[]));
      const open = [...rows.values()].filter((r) => !r.endedIso).map((r) => ({ ...r, heartbeatIso: r.startedIso }));
      return Promise.resolve(OK(open));
    },
    loadLiveNotes: () => Promise.resolve(OK([] as Array<{ id: string; at_ms: number; text: string }>)),
    clearLiveNotes: () => Promise.resolve(OK(null)),
    reportWriteFailure: () => {},
  } as unknown as Repo;
  return {
    repo,
    rows,
    attempts,
    goOffline: () => void (online = false),
    goOnline: () => void (online = true),
  };
}

function chain(over: { transcribeSegment?: (wav: Uint8Array) => Promise<{ text: string; ms: number }>; pendingAudioDir?: string } = {}) {
  const backing = switchableRepo();
  const workingCopy = new WorkingCopy({ repo: backing.repo, retryDelayMs: 1, schedule: () => {} });
  const store = new WorkingCopyCaptureStore({ workingCopy, repo: backing.repo });
  const rec = new LongRecorder({
    transcribeSegment: over.transcribeSegment ?? (() => Promise.resolve({ text: "phrase transcrite.", ms: 2 })),
    store,
    pendingAudioDir: over.pendingAudioDir,
    historyRootOverride: path.join(os.tmpdir(), "flow-offline-legacy-history"),
    stagingRootOverride: path.join(os.tmpdir(), "flow-offline-legacy-staging"),
    schedule: () => () => {},
  });
  return { backing, workingCopy, store, rec };
}

const settle = () => new Promise((r) => setImmediate(r));
const drain = async (n = 10) => {
  for (let i = 0; i < n; i++) await settle();
};

test("B3b: reseau coupe au milieu d'une reunion - le document final est INTACT", async () => {
  const { backing, workingCopy, rec } = chain();
  const started = rec.start({ title: "Reunion coupee" });
  const id = started.recordingId!;
  await drain();
  assert.ok(backing.rows.get(id), "la ligne est arrivee avant la coupure");

  // --- avant la coupure : deux tranches montent ---
  rec.mark();
  rec.flushSlice();
  await drain();
  rec.gap(3);
  rec.flushSlice();
  await drain();
  assert.ok(backing.rows.get(id)!.doc.includes("Moment marked at"));

  // --- LA COUPURE. Dix minutes, soit trente tranches. ---
  backing.goOffline();
  const attemptsAtCut = backing.attempts.length;
  for (let i = 0; i < 30; i++) {
    rec.mark();
    rec.flushSlice();
    await settle();
  }
  // La reunion continue sans se soucier du reseau : rien ne bloque, rien ne
  // leve, et le document en memoire est complet.
  assert.equal(rec.state().active, true, "la capture n'est pas arretee par une coupure");
  assert.ok(workingCopy.pending() >= 1, "les tranches attendent en memoire");
  assert.equal(rec.state().unsent, workingCopy.pending(), "et l'etat le DIT, pour que la page puisse l'afficher");
  // Ce que le compte detient est la version d'avant la coupure : c'est normal,
  // et c'est pourquoi la ligne reste OUVERTE.
  const duringCut = backing.rows.get(id)!;
  assert.equal(duringCut.endedIso, "");

  // --- LE RETOUR DU RESEAU, la reunion toujours en cours ---
  backing.goOnline();
  rec.mark();
  rec.flushSlice();
  await drain(20);
  const afterReturn = backing.rows.get(id)!;
  assert.ok(afterReturn.doc.length > duringCut.doc.length, "la file a repris et a rattrape le retard");
  // TOUT ce qui a ete ecrit pendant la coupure est la : trente marques plus les
  // deux d'avant plus celle du retour.
  const marks = afterReturn.doc.split("Moment marked at").length - 1;
  assert.equal(marks, 32, `${marks} marques dans le document final : la coupure a mange du contenu`);
  assert.ok(afterReturn.doc.includes("Recording paused ~3s"), "et le trou de capture aussi");
  assert.ok(backing.attempts.length > attemptsAtCut, "la file a bien reessaye");

  // --- LA FIN ---
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 20));
  await drain(20);
  const final = backing.rows.get(id)!;
  assert.ok(final.endedIso, "la reunion est fermee");
  assert.equal(final.doc.split("Moment marked at").length - 1, 32, "et le document final porte tout");
  assert.equal(workingCopy.pending(), 0, "la file est vide");
});

test("B3b: une reunion TERMINEE pendant la coupure monte au retour, en entier", async () => {
  // Le pire moment pour une coupure : juste avant la fin. Le document final -
  // celui qui porte le resume et les notes - est celui qui compte le plus, et
  // c'est celui qui n'etait pas encore monte.
  const { backing, workingCopy, rec } = chain();
  const started = rec.start({ title: "Finie hors ligne" });
  const id = started.recordingId!;
  await drain();
  rec.mark();
  backing.goOffline();
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 20));
  await drain();

  assert.equal(backing.rows.get(id)!.endedIso, "", "le compte ne sait pas encore qu'elle est finie");
  assert.ok(workingCopy.pending() >= 1, "la fin attend dans la file");

  backing.goOnline();
  // Ce qui relance la file : ici un tour d'horloge, dans l'application le
  // prochain changement ou la reprise programmee.
  workingCopy.writeRecording(workingCopy.readRecording(id)!);
  await drain(20);
  const final = backing.rows.get(id)!;
  assert.ok(final.endedIso, "elle est fermee des que le reseau revient");
  assert.ok(final.doc.includes("Moment marked at"));
  assert.equal(workingCopy.pending(), 0);
});

test("B3b: hors ligne, l'export marche quand meme - la file est une source de lecture", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-offline-export-"));
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest, { recursive: true });
  const { backing, rec } = chain();
  rec.start({ title: "Export hors ligne" });
  rec.mark();
  backing.goOffline();
  rec.stop();
  for (let i = 0; i < 200 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 20));
  await drain();

  // Le compte est injoignable. L'export doit quand meme rendre le document :
  // c'est exactement le moment ou quelqu'un veut une copie sur son disque.
  const res = await rec.save(dest);
  assert.equal(res.ok, true, res.error ?? "un export hors ligne doit reussir");
  assert.ok(fs.readFileSync(res.docPath!, "utf8").includes("# Export hors ligne"));
  assert.ok(fs.readFileSync(res.docPath!, "utf8").includes("Moment marked at"));
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3b: le sauvetage hors ligne ne detruit rien et sera refait au prochain lancement", async () => {
  // `listOpenRecordings` echoue : le sauvetage doit rendre zero sans rien
  // annoter ni fermer. La ligne reste ouverte, ce qui est precisement ce qui le
  // rend rejouable.
  const { backing, rec } = chain();
  backing.rows.set("orpheline", {
    id: "orpheline",
    title: "Coupee hier",
    startedIso: new Date(Date.now() - 60 * 60_000).toISOString(),
    durationMs: 600_000,
    doc: "# Coupee hier\n\n[00:00:00] Bonjour.\n\n",
    audioPath: "",
    audioBytes: 0,
    audioUploaded: 0,
    audioUploadUrl: "",
    audioUploadExpires: "",
    staged: true,
    endedIso: "",
  });
  backing.goOffline();
  assert.equal(await rec.rescueAbandoned(), 0, "hors ligne, on ne sauve rien");
  assert.equal(backing.rows.get("orpheline")!.endedIso, "", "et on n'a rien casse");

  backing.goOnline();
  assert.equal(await rec.rescueAbandoned(), 1, "au retour du reseau, la reunion est fermee");
  await drain(20);
  const closed = backing.rows.get("orpheline")!;
  assert.ok(closed.endedIso);
  assert.ok(closed.doc.includes("Interrupted recording"));
  assert.ok(closed.doc.includes("Bonjour."), "avec ce qui avait ete transcrit");
});

test("B3b: le sauvetage ne perd pas l'audio deja televerse d'une reunion coupee", async () => {
  // Le defaut que le type OpenRecording existe pour rendre impossible : une
  // premiere version ne rapatriait que titre, depart, document et duree, donc la
  // reecriture remettait `audio_path` a vide.
  const { backing, rec } = chain();
  backing.rows.set("avec-audio", {
    id: "avec-audio",
    title: "Audio deja monte",
    startedIso: new Date(Date.now() - 60 * 60_000).toISOString(),
    durationMs: 600_000,
    doc: "# Audio deja monte\n\n[00:00:00] Bonjour.\n\n",
    audioPath: "uid/avec-audio.wav",
    audioBytes: 115_000_000,
    audioUploaded: 115_000_000,
    audioUploadUrl: "",
    audioUploadExpires: "",
    staged: true,
    endedIso: "",
  });
  assert.equal(await rec.rescueAbandoned(), 1);
  await drain(20);
  const closed = backing.rows.get("avec-audio")!;
  assert.equal(closed.audioPath, "uid/avec-audio.wav", "l'audio survit a la fermeture");
  assert.equal(closed.audioUploaded, 115_000_000);
});

// ---------------------------------------------------------------------------
// LA PREMIERE LECON DES VAGUES CLOSES : une classe testee que RIEN N'APPELLE.
//
// La release 1.22.0 a annonce un invariant ferme alors que LocalSidecarProvider
// n'etait jamais instancie. `rescueAbandoned()` est exactement du meme genre :
// entierement testee juste au-dessus, et parfaitement inutile si `index.ts` ne
// l'appelle pas. Aucune des quatre portes ne peut le voir.
//
// Meme technique que test/silent-failures-wiring.test.ts et
// test/quit-guard.test.ts : lire le source comme du texte, parce qu'importer
// main/index.ts demanderait Electron.
// ---------------------------------------------------------------------------

test("B3b: index.ts appelle VRAIMENT rescueAbandoned, au chargement du compte", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const at = src.indexOf("async function loadAccountData()");
  assert.ok(at > 0, "loadAccountData a change de nom : verifier ou le sauvetage doit vivre");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /longRec\.rescueAbandoned\(\)/, "un sauvetage que rien n'appelle ne sauve rien");
  // EN ARRIERE-PLAN : la connexion ne doit pas attendre que des reunions soient
  // recollees. `void` (et non `await`) est ce qui le garantit.
  assert.match(body, /void longRec\.rescueAbandoned\(\)/, "le sauvetage ne doit pas retenir la connexion");
  // Et son echec est DIT. Un sauvetage silencieux qui ne marche pas est
  // indistinguable d'un sauvetage qui n'avait rien a faire.
  assert.match(body, /le sauvetage des reunions interrompues a echoue/, "un echec doit laisser une trace");
});

test("B3b: rien dans le chemin de fermeture n'attend la file", () => {
  // La troisieme des sept regressions : « l'application ne se ferme plus ».
  // rescueOnQuit ecrit dans la file et rend la main ; si quelqu'un y glissait un
  // await sur ce qui n'est pas monte, Flow cesserait de se fermer hors ligne.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "longform.ts"), "utf8").replace(/\r\n/g, "\n");
  const at = src.indexOf("  rescueOnQuit(): boolean {");
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  assert.ok(!/\bawait\b/.test(body), "rescueOnQuit doit rester SYNCHRONE : before-quit n'attend rien");
  assert.ok(!/pending\(\)/.test(body), "pending() existe pour DIRE ce qui n'est pas monte, jamais pour l'attendre");
});
