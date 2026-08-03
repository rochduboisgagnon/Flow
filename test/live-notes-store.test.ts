import test from "node:test";
import assert from "node:assert/strict";
import { LiveNotesStore, type LiveNotesBacking } from "../src/main/liveNotes";
import type { LiveNote } from "../src/shared/liveNotes";

// ---------------------------------------------------------------------------
// B2 : le magasin des notes prises PENDANT un enregistrement.
//
// IL N'AVAIT AUCUN TEST AVANT CE FICHIER. Les dix-huit tests de
// test/live-notes.test.ts couvrent les fonctions pures de shared/liveNotes.ts -
// ce qu'est une note, comment on l'ajoute, comment on l'edite - et pas le
// magasin qui decide a QUI elles appartiennent. C'est justement la ou vit le
// risque : ces notes sont la seule partie d'une capture qu'on ne peut pas
// regenerer. Le transcript se refait depuis l'audio ; ce que quelqu'un a pris
// la peine d'ecrire pendant qu'on lui parlait, non.
//
// La reecriture de B2 etait le moment de s'en apercevoir, pas de l'aggraver.
// ---------------------------------------------------------------------------

function fakeBacking() {
  const sent: string[] = [];
  const notes = new Map<string, LiveNote>();
  const backing: LiveNotesBacking = {
    upsertLiveNote: (iso, n) => {
      sent.push(`upsert:${iso}:${n.text}`);
      notes.set(n.id, n);
    },
    deleteLiveNote: (id) => {
      sent.push(`delete:${id}`);
      notes.delete(id);
    },
    clearLiveNotes: (iso) => {
      sent.push(`clear:${iso}`);
      notes.clear();
    },
  };
  return { backing, sent, notes };
}

const ISO = "2026-08-03T14:00:00.000Z";
const OTHER = "2026-08-03T16:30:00.000Z";

function store(b?: LiveNotesBacking) {
  return new LiveNotesStore({ backing: () => b ?? null });
}

test("B2: une note visant un AUTRE enregistrement est refusee, jamais reclassee", () => {
  // LA GARDE QUI COMPTE. Une page qui a course avec la fin d'un enregistrement
  // doit se faire dire non. Classer sa note sur la seance suivante melangerait
  // les mots de deux reunions, et personne ne s'en apercevrait avant de relire
  // le document.
  const f = fakeBacking();
  const s = store(f.backing);
  s.open(ISO);

  const r = s.add(OTHER, "note pour une autre reunion", 5_000);
  assert.equal(r.ok, false);
  assert.equal(r.startedIso, ISO, "et la reponse dit a quel enregistrement la fente appartient");
  assert.deepEqual(f.sent, [], "rien ne doit partir vers le compte");
});

test("B2: sans enregistrement en cours, une note est refusee", () => {
  const f = fakeBacking();
  const s = store(f.backing);
  assert.equal(s.add(ISO, "x", 0).ok, false);
  assert.deepEqual(f.sent, []);
});

test("B2: ajouter, editer, supprimer - chacun UN envoi, et le bon", () => {
  const f = fakeBacking();
  const s = store(f.backing);
  s.open(ISO);

  const added = s.add(ISO, "premier point", 12_000);
  assert.equal(added.ok, true);
  assert.equal(added.notes.length, 1);
  const id = added.notes[0].id;
  assert.deepEqual(f.sent, [`upsert:${ISO}:premier point`]);

  s.edit(ISO, id, "premier point, corrige");
  assert.deepEqual(f.sent[1], `upsert:${ISO}:premier point, corrige`);

  s.remove(ISO, id);
  assert.deepEqual(f.sent[2], `delete:${id}`);
  assert.deepEqual(s.list().notes, []);
});

test("B2: editer une note ne DEPLACE PAS son estampille", () => {
  // shared/liveNotes.ts, DECISION 2. Corriger une faute de frappe ne doit pas
  // faire glisser la note vers le moment de la correction : elle pointerait
  // alors vers un passage du transcript qui n'a rien a voir.
  const s = store();
  s.open(ISO);
  const id = s.add(ISO, "faute", 30_000).notes[0].id;
  s.edit(ISO, id, "corrige");
  assert.equal(s.list().notes[0].atMs, 30_000);
});

test("B2: read() ne rend JAMAIS les notes d'un autre enregistrement", () => {
  // Ce que le recorder lit a la fin pour l'ecrire dans le document. Se tromper
  // ici mettrait les notes d'une reunion dans le document d'une autre.
  const s = store();
  s.open(ISO);
  s.add(ISO, "a moi", 1_000);
  assert.equal(s.read(ISO).length, 1);
  assert.deepEqual(s.read(OTHER), [], "un autre enregistrement ne lit rien");
  assert.deepEqual(s.read(""), [], "et une chaine vide non plus");
});

test("B2: ouvrir un NOUVEL enregistrement repart d'une fente vide", () => {
  const s = store();
  s.open(ISO);
  s.add(ISO, "reunion du matin", 1_000);
  s.open(OTHER);
  assert.deepEqual(s.list().notes, [], "les notes du matin ne suivent pas");
  assert.equal(s.list().startedIso, OTHER);
});

test("B2: rouvrir le MEME enregistrement ne perd pas les notes", () => {
  // Le recorder peut appeler open() plus d'une fois sur la meme seance. Le
  // traiter comme un nouvel enregistrement effacerait ce qui vient d'etre tape.
  const s = store();
  s.open(ISO);
  s.add(ISO, "a garder", 1_000);
  s.open(ISO);
  assert.equal(s.list().notes.length, 1);
});

test("B2: clear() n'efface QUE sa propre fente", () => {
  // Appele uniquement apres que les notes sont surement dans le document.
  // Effacer celles de quelqu'un d'autre serait la seule erreur irrattrapable de
  // ce module.
  const f = fakeBacking();
  const s = store(f.backing);
  s.open(ISO);
  s.add(ISO, "classee", 1_000);

  s.clear(OTHER);
  assert.equal(s.list().notes.length, 1, "une demande visant une autre seance ne doit rien effacer");
  assert.ok(!f.sent.some((x) => x.startsWith("clear:")));

  s.clear(ISO);
  assert.deepEqual(s.list().notes, []);
  assert.ok(f.sent.includes(`clear:${ISO}`), "et le compte est vide lui aussi");
});

test("B2: sans compte charge, les notes vivent quand meme en memoire", () => {
  // Une reunion peut commencer avant que le compte ait fini de charger. Refuser
  // la note serait pire que de la garder : la page l'affiche, et le premier
  // envoi qui trouve un magasin l'emportera.
  const s = store(); // backing() rend null
  s.open(ISO);
  const r = s.add(ISO, "dite pendant le chargement", 2_000);
  assert.equal(r.ok, true);
  assert.equal(s.read(ISO).length, 1);
});

test("B2: la liste rendue est une COPIE, pas la liste vivante", () => {
  // Elle traverse IPC vers une page web. Rendre le tableau reel laisserait un
  // appelant muter l'etat du magasin depuis l'exterieur.
  const s = store();
  s.open(ISO);
  s.add(ISO, "intacte", 1_000);
  s.list().notes.push({ id: "x", atMs: 0, text: "injectee" } as LiveNote);
  assert.equal(s.list().notes.length, 1);
});
