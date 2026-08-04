import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AudioLocal, audioDirIn, migrateAudioDir, retiredTransitDirIn, wavBytesForMs } from "../src/main/audioLocal";
import type { RecordingRow, RecordingSummary } from "../src/shared/recordings";

// ---------------------------------------------------------------------------
// 2026-08-04 : L'AUDIO RESTE SUR LA MACHINE. Ce fichier prouve les regles du
// module qui possede le dossier, et surtout les regles de SUPPRESSION.
//
// Pourquoi ces tests-la et pas d'autres : ce module est le seul de Flow qui
// puisse detruire l'enregistrement d'une reunion. Le televersement qu'il remplace
// avait deja produit, en une journee, deux defauts de cette famille - un audio
// supprime par une course avec la file, et un audio blanchi par un sauvetage qui
// reecrivait quatre champs sur six. Les deux se seraient vus ici.
//
// La forme suit test/audio-upload.test.ts, supprime avec la couche TUS : de vrais
// fichiers dans un dossier temporaire, et des fausses lignes en memoire.
// ---------------------------------------------------------------------------

function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-local-"));
  const dir = audioDirIn(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const logs: string[] = [];
  const audio = new AudioLocal({ dir: () => dir, log: (m) => logs.push(m) });
  const rows = new Map<string, RecordingRow>();
  const released: string[] = [];
  /** Ce que le faux compte accepte de rendre, par nom d'objet. */
  const objects = new Map<string, Buffer>();
  let fetchCalls = 0;

  function row(id: string, over: Partial<RecordingRow> = {}): RecordingRow {
    return {
      id,
      title: "Reunion",
      startedIso: "2026-08-04T14:00:00.000Z",
      durationMs: 600_000,
      doc: "# Reunion\n\n",
      audioPath: "",
      audioBytes: 0,
      audioUploaded: 0,
      audioUploadUrl: "",
      audioUploadExpires: "",
      staged: false,
      endedIso: "2026-08-04T14:10:00.000Z",
      ...over,
    };
  }

  function summary(r: RecordingRow): RecordingSummary {
    return {
      id: r.id,
      title: r.title,
      startedIso: r.startedIso,
      durationMs: r.durationMs,
      docBytes: Buffer.byteLength(r.doc),
      audioBytes: r.audioBytes,
      audioUploaded: r.audioUploaded,
      hasAudio: r.audioBytes > 0,
      audioLocal: fs.existsSync(path.join(dir, r.id + ".wav")),
      audioInAccount: r.audioPath !== "",
      staged: r.staged,
      endedIso: r.endedIso,
    };
  }

  return {
    dataDir,
    dir,
    audio,
    rows,
    logs,
    released,
    objects,
    row,
    fetchCalls: () => fetchCalls,
    put(id: string, bytes: number): string {
      const p = path.join(dir, id + ".wav");
      fs.writeFileSync(p, Buffer.alloc(bytes, 7));
      return p;
    },
    exists: (id: string) => fs.existsSync(path.join(dir, id + ".wav")),
    sweepDeps(over: Partial<Parameters<AudioLocal["sweep"]>[0]> = {}) {
      return {
        list: () => Promise.resolve([...rows.values()].map(summary)),
        read: (id: string) => Promise.resolve(rows.get(id) ?? null),
        write: (r: RecordingRow) => void rows.set(r.id, { ...r }),
        fetch: async (objectName: string, destPath: string) => {
          fetchCalls++;
          const body = objects.get(objectName);
          if (!body) return { ok: false, error: "hors ligne" };
          await fs.promises.writeFile(destPath, body);
          return { ok: true, error: "" };
        },
        releaseObject: async (objectName: string) => void released.push(objectName),
        recordingNow: () => "",
        ...over,
      };
    },
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("present() rend les identifiants des reunions dont l'audio est ICI, en un seul acces", async () => {
  const t = rig();
  t.put("rec-1", 100);
  t.put("rec-2", 200);
  fs.writeFileSync(path.join(t.dir, "notes.txt"), "pas un audio");
  const here = await t.audio.present();
  assert.deepEqual([...here].sort(), ["rec-1", "rec-2"]);
  t.cleanup();
});

test("totalBytes() dit ce que le dossier pese - la moitie de la decision qu'il ne faut pas taire", async () => {
  const t = rig();
  t.put("rec-1", 1000);
  t.put("rec-2", 2000);
  const usage = await t.audio.totalBytes();
  assert.equal(usage.files, 2);
  assert.equal(usage.bytes, 3000);
  t.cleanup();
});

// ---------------------------------------------------------------------------
// LE BALAYAGE : ramener l'audio des versions 2.0.x
// ---------------------------------------------------------------------------

test("sweep: un objet reste dans le seau est RAMENE, puis lache", async () => {
  const t = rig();
  const body = Buffer.alloc(5000, 3);
  t.objects.set("uid/rec-1.wav", body);
  t.rows.set("rec-1", t.row("rec-1", { audioPath: "uid/rec-1.wav", audioBytes: 5000, audioUploaded: 5000 }));

  const out = await t.audio.sweep(t.sweepDeps());
  assert.equal(out.broughtDown, 1);
  assert.equal(t.exists("rec-1"), true, "le fichier est sur la machine");
  assert.deepEqual(fs.readFileSync(path.join(t.dir, "rec-1.wav")), body, "octet pour octet");
  // ET L'ORDRE : la ligne ne cite plus d'objet, et l'objet est lache ensuite.
  assert.equal(t.rows.get("rec-1")!.audioPath, "", "la ligne ne cite plus d'objet");
  assert.equal(t.rows.get("rec-1")!.audioBytes, 5000, "et elle garde la taille : la reunion A un audio");
  assert.deepEqual(t.released, ["uid/rec-1.wav"]);
  t.cleanup();
});

test("sweep: un telechargement COUPE n'est jamais mis en place", async () => {
  // Le pire defaut possible de ce balayage : une reunion tronquee qui passe pour
  // complete, avec son objet supprime derriere. La taille annoncee par la ligne
  // est la seule reference, et elle doit correspondre.
  const t = rig();
  t.objects.set("uid/rec-1.wav", Buffer.alloc(120, 3)); // la ligne en annonce 5000
  t.rows.set("rec-1", t.row("rec-1", { audioPath: "uid/rec-1.wav", audioBytes: 5000, audioUploaded: 5000 }));

  const out = await t.audio.sweep(t.sweepDeps());
  assert.equal(out.broughtDown, 0);
  assert.equal(t.exists("rec-1"), false, "rien n'est mis en place");
  assert.equal(fs.existsSync(path.join(t.dir, "rec-1.wav.part")), false, "et le fichier partiel est nettoye");
  assert.equal(t.rows.get("rec-1")!.audioPath, "uid/rec-1.wav", "la ligne garde son objet : il reste la seule copie");
  assert.deepEqual(t.released, [], "et l'objet n'est PAS lache");
  assert.ok(t.logs.some((m) => /incomplet/.test(m)), "le refus est dit");
  t.cleanup();
});

test("sweep: HORS LIGNE, rien ne bouge et rien n'est perdu", async () => {
  const t = rig();
  // Aucun objet dans le faux compte : le fetch echoue, comme hors ligne.
  t.rows.set("rec-1", t.row("rec-1", { audioPath: "uid/rec-1.wav", audioBytes: 5000, audioUploaded: 5000 }));

  const out = await t.audio.sweep(t.sweepDeps());
  assert.equal(out.broughtDown, 0);
  assert.equal(t.exists("rec-1"), false);
  assert.equal(t.rows.get("rec-1")!.audioPath, "uid/rec-1.wav", "la page peut donc encore jouer depuis le compte");
  assert.deepEqual(t.released, []);
  t.cleanup();
});

test("sweep: quand le fichier est DEJA ici, aucune requete - et la ligne cesse de citer un objet", async () => {
  // C'est le cas exact de la reunion de 55 minutes dont l'audio avait ete refuse
  // par le compte (413) : son .wav n'a jamais quitte la machine, et la ligne
  // portait quand meme un chemin d'objet qui ne designait rien.
  const t = rig();
  t.put("rec-1", 106_283_608 % 9973); // une taille quelconque : elle n'est pas comparee ici
  t.rows.set("rec-1", t.row("rec-1", { audioPath: "uid/rec-1.wav", audioBytes: 106_283_608, audioUploaded: 0 }));

  const out = await t.audio.sweep(t.sweepDeps());
  assert.equal(t.fetchCalls(), 0, "rien n'est telecharge : le fichier est la");
  assert.equal(out.broughtDown, 0);
  assert.equal(t.exists("rec-1"), true, "et il n'est surtout pas touche");
  assert.equal(t.rows.get("rec-1")!.audioPath, "", "la ligne ne promet plus un objet inexistant");
  assert.deepEqual(t.released, ["uid/rec-1.wav"], "l'objet est lache au cas ou il existerait");
  t.cleanup();
});

// ---------------------------------------------------------------------------
// LE BALAYAGE : les deux seules suppressions permises
// ---------------------------------------------------------------------------

test("sweep: un .wav dont la reunion a demande de NE PAS garder l'audio est supprime", async () => {
  const t = rig();
  t.put("rec-1", 4000);
  t.rows.set("rec-1", t.row("rec-1", { audioBytes: 0 })); // la case n'etait pas cochee
  const out = await t.audio.sweep(t.sweepDeps());
  assert.equal(out.dropped, 1);
  assert.equal(t.exists("rec-1"), false);
  t.cleanup();
});

test("sweep: un .wav dont la LIGNE est illisible n'est JAMAIS supprime", async () => {
  // Hors ligne, « ligne introuvable » et « ligne effacee » se ressemblent. Se
  // tromper voudrait dire jeter l'audio d'une reunion, donc le doute laisse le
  // fichier en place - et le dit.
  const t = rig();
  t.put("orpheline", 4000);
  const out = await t.audio.sweep(t.sweepDeps());
  assert.equal(out.dropped, 0);
  assert.equal(t.exists("orpheline"), true, "le fichier survit au doute");
  assert.ok(t.logs.some((m) => /introuvable/.test(m) && /laisse en place/.test(m)));
  t.cleanup();
});

test("sweep: le .wav de la reunion EN COURS n'est ni mesure ni touche", async () => {
  // Il grandit encore. Le juger reviendrait a comparer une taille a un fichier
  // qui n'a pas fini de s'ecrire.
  const t = rig();
  t.put("en-cours", 4000);
  t.rows.set("en-cours", t.row("en-cours", { audioBytes: 0, endedIso: "" }));
  const out = await t.audio.sweep(t.sweepDeps({ recordingNow: () => "en-cours" }));
  assert.equal(out.dropped, 0);
  assert.equal(t.exists("en-cours"), true);
  t.cleanup();
});

test("sweep: un audio garde et bien present n'est ni supprime ni redemande", async () => {
  const t = rig();
  t.put("rec-1", 4000);
  t.rows.set("rec-1", t.row("rec-1", { audioBytes: 4000 }));
  const out = await t.audio.sweep(t.sweepDeps());
  assert.deepEqual(out, { broughtDown: 0, dropped: 0 });
  assert.equal(t.fetchCalls(), 0);
  assert.equal(t.exists("rec-1"), true);
  t.cleanup();
});

test("remove() emporte le fichier - sans quoi supprimer une reunion laisserait 101 Mo anonymes", async () => {
  const t = rig();
  t.put("rec-1", 4000);
  await t.audio.remove("rec-1");
  assert.equal(t.exists("rec-1"), false);
  // Et sur un identifiant qui n'a pas de fichier : aucune erreur. La ligne est
  // deja partie, refuser de finir le menage serait pire.
  await t.audio.remove("jamais-existe");
  t.cleanup();
});

// ---------------------------------------------------------------------------
// LE RENOMMAGE DU DOSSIER
// ---------------------------------------------------------------------------

test("migrateAudioDir: `pending-audio` devient `audio`, et le vieux dossier disparait", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-mig-"));
  const from = retiredTransitDirIn(dataDir);
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, "rec-1.wav"), Buffer.alloc(10, 1));
  fs.writeFileSync(path.join(from, "rec-2.wav"), Buffer.alloc(20, 2));

  const moved = migrateAudioDir(dataDir);
  assert.equal(moved, 2);
  assert.equal(fs.existsSync(path.join(audioDirIn(dataDir), "rec-1.wav")), true);
  assert.equal(fs.existsSync(path.join(audioDirIn(dataDir), "rec-2.wav")), true);
  assert.equal(fs.existsSync(from), false, "le dossier de transit vide est retire");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("migrateAudioDir: n'ECRASE jamais un fichier deja present dans le nouveau dossier", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-mig2-"));
  const from = retiredTransitDirIn(dataDir);
  const to = audioDirIn(dataDir);
  fs.mkdirSync(from, { recursive: true });
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(from, "rec-1.wav"), Buffer.alloc(10, 1));
  fs.writeFileSync(path.join(to, "rec-1.wav"), Buffer.alloc(99, 9)); // le nouveau gagne

  const moved = migrateAudioDir(dataDir);
  assert.equal(moved, 0);
  assert.equal(fs.statSync(path.join(to, "rec-1.wav")).size, 99, "le fichier du nouveau dossier est intact");
  assert.equal(fs.existsSync(path.join(from, "rec-1.wav")), true, "et l'ancien est laisse en place, pas jete");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("migrateAudioDir: sans dossier de transit, c'est un non-evenement", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-mig3-"));
  assert.equal(migrateAudioDir(dataDir), 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("115 Mo pour une heure - le chiffre du plan, calcule", () => {
  const oneHour = wavBytesForMs(60 * 60 * 1000);
  assert.equal(oneHour, 44 + 3600 * 16_000 * 2);
  assert.equal(Math.round(oneHour / (1024 * 1024)), 110, "110 Mio, soit 115 Mo decimaux");
});
