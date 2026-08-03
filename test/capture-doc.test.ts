import test from "node:test";
import assert from "node:assert/strict";
import { CaptureDoc, MAX_DOC_BYTES, TRUNCATED_NOTE } from "../src/shared/captureDoc";
import { transcriptHeader, transcriptLine, markLine, renderMyNotes, MY_NOTES_HEADING } from "../src/shared/longform";
import { looksAbandoned, ABANDON_AFTER_MS } from "../src/shared/recordings";

// ---------------------------------------------------------------------------
// B3a : le tampon en memoire.
//
// Ce que ces tests defendent :
//
//  1. LE DOCUMENT EST LE MEME qu'avant, octet pour octet. Le support a change,
//     pas le livrable.
//  2. LA MESURE. « Une heure tient en RAM » est refait a chaque passage plutot
//     que cite de memoire.
//  3. L'ORDRE de l'avertissement d'interruption et du bloc de notes, dont
//     depend la completude du retrait d'un passage (shared/redact.ts).
// ---------------------------------------------------------------------------

const HEADER = transcriptHeader("Reunion", "2026-08-03T14:00:00.000Z");

test("B3a: le tampon rend exactement ce qu'un fichier aurait contenu", () => {
  const d = new CaptureDoc(HEADER);
  d.append(transcriptLine(0, "premiere phrase"));
  d.append(markLine(12_000));
  d.append(transcriptLine(20_000, "deuxieme phrase"));

  const expected = HEADER + transcriptLine(0, "premiere phrase") + markLine(12_000) + transcriptLine(20_000, "deuxieme phrase");
  assert.equal(d.text(), expected, "le tampon doit produire le meme document que les appendFileSync qu'il remplace");
  assert.equal(d.byteLength(), Buffer.byteLength(expected, "utf8"));
});

test("B3a: version() bouge a chaque mutation, et seulement la", () => {
  // C'est ce compteur qui decide d'envoyer une tranche. S'il ne bougeait pas,
  // la reunion monterait une fois et s'arreterait la ; s'il bougeait tout seul,
  // Flow televerserait 200 Ko toutes les vingt secondes pour rien.
  const d = new CaptureDoc(HEADER);
  const v0 = d.version();
  assert.equal(d.append(""), true, "une chaine vide n'est pas une erreur");
  assert.equal(d.version(), v0, "un ajout vide n'est pas une mutation");
  d.text();
  d.byteLength();
  d.since(0);
  assert.equal(d.version(), v0, "lire n'est pas muter");
  d.append("x");
  assert.equal(d.version(), v0 + 1);
});

test("B3a: text() est mis en cache entre deux mutations", () => {
  // Le sondage de la page et l'envoi de tranche appellent tous les deux text().
  // Sur une reunion d'une heure, recoller 200 Ko a chaque appel serait le
  // meme genre de defaut que le cache de recent.json existait pour corriger.
  const d = new CaptureDoc(HEADER);
  for (let i = 0; i < 200; i++) d.append(transcriptLine(i * 7000, "phrase " + i));
  const a = d.text();
  const b = d.text();
  assert.equal(a === b, true, "deux lectures de suite doivent rendre LA MEME chaine, pas deux copies egales");
  d.append("z");
  assert.notEqual(d.text() === a, true, "une mutation doit invalider le cache");
});

test("B3a: MESURE - une heure de reunion tient largement en memoire", () => {
  // La mesure que le plan demande d'ecrire dans le code plutot que de deduire.
  // Debit retenu : 150 mots/minute, segments de 7 s.
  const SEG_MS = 7_000;
  const segments = Math.round((60 * 60 * 1000) / SEG_MS); // ~514
  const wordsPerSegment = Math.round((150 / 60) * (SEG_MS / 1000)); // ~18
  const word = "concertation"; // 12 caracteres, plus long que la moyenne du francais

  const d = new CaptureDoc(HEADER);
  for (let i = 0; i < segments; i++) {
    d.append(transcriptLine(i * SEG_MS, Array.from({ length: wordsPerSegment }, () => word).join(" ")));
  }

  const bytes = d.byteLength();
  // La borne haute de la mesure, pas une cible : si le calcul derive un jour,
  // ce test le dit au lieu de laisser le commentaire du module mentir.
  assert.ok(bytes > 60_000, `une heure devrait peser plus de 60 Ko, mesure : ${bytes}`);
  assert.ok(bytes < 200_000, `une heure devrait peser moins de 200 Ko, mesure : ${bytes}`);
  assert.ok(bytes * 3 < MAX_DOC_BYTES / 10, "trois heures doivent rester loin sous la borne de securite");
});

test("B3a: la borne de taille tronque en le DISANT, et ne perd pas ce qui precede", () => {
  const d = new CaptureDoc(HEADER);
  const chunk = "x".repeat(64 * 1024);
  let refused = 0;
  for (let i = 0; i < 200; i++) if (!d.append(chunk)) refused++;
  assert.ok(refused > 0, "la borne doit finir par refuser");
  assert.equal(d.didTruncate(), true);
  assert.ok(d.text().includes(TRUNCATED_NOTE.trim()), "le document doit dire qu'il s'arrete la");
  assert.ok(d.byteLength() <= MAX_DOC_BYTES + TRUNCATED_NOTE.length);
  assert.ok(d.text().startsWith(HEADER), "l'entete et le contenu deja accumule survivent a la troncature");
});

test("B3a: l'avertissement d'interruption reste AU-DESSUS du corps, et le bloc de notes commence le corps", () => {
  // La regle d'ordre de spliceMyNotesSync, transposee au tampon : l'avertissement
  // d'abord, le splice ensuite. Si l'ordre s'inversait, le corps ne commencerait
  // plus par « ## Notes » et shared/redact.ts ne trouverait plus les notes
  // derivees a supprimer lors du retrait d'un passage.
  const d = new CaptureDoc(HEADER);
  d.append(transcriptLine(0, "ce qui a ete dit"));
  d.prependToBody("> [Interrompu]\n\n");
  d.spliceNotesBlock(renderMyNotes([{ atMs: 5_000, text: "ma note" }]));

  const body = d.text().slice(HEADER.length);
  assert.ok(body.startsWith("## Notes\n"), "le corps doit commencer par le bloc de notes : " + body.slice(0, 40));
  assert.ok(body.includes(MY_NOTES_HEADING));
  assert.ok(body.includes("> [Interrompu]"), "l'avertissement ne disparait pas, il descend dans le transcript");
  assert.ok(body.includes("ce qui a ete dit"));
});

test("B3a: since() rend des offsets en OCTETS, comme la lecture de fichier qu'il remplace", () => {
  const d = new CaptureDoc("# Reunion\n\n");
  d.append("des accents : ecole, ete, ou\n"); // ASCII pur
  const first = d.since(0);
  assert.equal(first.nextSince, Buffer.byteLength(d.text(), "utf8"));

  const d2 = new CaptureDoc("# Réunion\n\n"); // un caractere multi-octets
  d2.append("déjà\n");
  const s = d2.since(0);
  assert.equal(s.nextSince, Buffer.byteLength(d2.text(), "utf8"), "les offsets sont des octets, pas des caracteres");
  assert.equal(d2.since(s.nextSince).text, "", "reprendre au bout ne rend rien");
});

test("B3: looksAbandoned distingue une session morte d'une reunion en cours ailleurs", () => {
  const now = Date.parse("2026-08-03T15:00:00.000Z");
  const fresh = new Date(now - 10_000).toISOString();
  const stale = new Date(now - ABANDON_AFTER_MS - 1_000).toISOString();
  assert.equal(looksAbandoned(fresh, now), false, "un pouls recent = quelqu'un enregistre, ne pas y toucher");
  assert.equal(looksAbandoned(stale, now), true);
  assert.equal(looksAbandoned("pas une date", now), true, "un pouls illisible ne doit pas faire perdre la reunion");
});
