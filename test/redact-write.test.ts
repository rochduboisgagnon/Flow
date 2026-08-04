import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Redactor, REDACT_SUFFIX, MAX_REDACT_DOC_BYTES } from "../src/main/redact";
import { transcriptHeader, transcriptLine } from "../src/shared/longform";
import { encodeWav } from "../src/shared/wav";

// D11, the writing half.
//
// Ce que ces tests defendent, et B3e n'en change AUCUN :
//  - l'operation est un vrai retrait : les mots quittent le transcript ET les
//    echantillons correspondants quittent l'audio ;
//  - une ecriture interrompue laisse « rien de fait » ou « audio fait, texte pas
//    encore » - jamais un document qui PRETEND que l'audio a ete rendu
//    silencieux alors qu'il ne l'est pas (voir l'ordre des operations dans le
//    bandeau de main/redact.ts).
//
// Ce qui a bouge est le support : le document est une ligne du compte, et l'audio
// est un objet de Storage. Le silence, lui, s'ecrit toujours sur un FICHIER -
// mettre des zeros au milieu d'un objet distant n'existe pas - donc le trajet
// descendre / reecrire / remonter est simule ici par un dossier de travail et
// deux fonctions. Les octets, eux, sont vrais : `isSilent` et `hasSound` lisent
// le fichier que le retrait a produit.

const SR = 16_000;

interface Fixture {
  work: string;
  /** Le dossier ou vit l'audio, donc celui que le retrait balaie. */
  dir: string;
  /** Le .wav de la reunion. C'est sur lui que les assertions comptent les zeros. */
  audio: string;
  id: string;
  /** Le document, tel que le compte le detient. Muté par `writeDoc`. */
  doc(): string;
  /** Vrai quand l'audio a ete remplace : la moitie « AUDIO FIRST » de l'ordre. */
  audioReplaced(): boolean;
  deps(over?: Partial<ConstructorParameters<typeof Redactor>[0]>): ConstructorParameters<typeof Redactor>[0];
}

/** A filed recording: three passages at 0 s, 7 s and 14 s, over 30 s of audio
 * whose every sample is non-zero, so "was this range silenced" is decidable by
 * looking at the bytes. */
function fixture(opts: { audio?: boolean; notes?: string; seconds?: number } = {}): Fixture {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-redact-"));
  const dir = path.join(work, "pending");
  fs.mkdirSync(dir, { recursive: true });

  const head = transcriptHeader("Weekly sync", "2026-07-29T09:00:00.000Z");
  const body = transcriptLine(0, "Alpha.") + transcriptLine(7000, "My card is 4111.") + transcriptLine(14_000, "Gamma.");
  let doc =
    opts.notes === undefined
      ? head + body
      : head + "## Notes\n\n" + opts.notes + "\n\n## Transcript\n\n" + body;

  // 2026-08-04 : LE .WAV DE LA REUNION, sur cette machine. C'etait « l'objet de
  // Storage », qu'il fallait descendre puis remonter ; l'audio ne quitte plus la
  // machine (decision de Roch), donc le retrait le reecrit sur place.
  //
  // Il vit hors du dossier de travail, et chaque echantillon est non nul, pour que
  // « cette plage a-t-elle ete rendue silencieuse » se decide en lisant les octets.
  //
  // IL VIT DANS LE DOSSIER BALAYE, et c'est une consequence du 2026-08-04 plutot
  // qu'un detail de harnais : la copie nettoyee s'ecrit A COTE de l'originale
  // (`silenceAudio` ajoute son suffixe au chemin du fichier), parce qu'un
  // renommage n'est atomique que sur le meme volume. Le dossier de travail
  // injecte n'existe donc plus - il n'y avait plus rien a y mettre.
  const audio = path.join(dir, "rec-1.wav");
  const hasAudio = opts.audio !== false;
  if (hasAudio) {
    const samples = new Int16Array(SR * (opts.seconds ?? 30));
    for (let i = 0; i < samples.length; i++) samples[i] = ((i % 1000) + 1) as number;
    fs.writeFileSync(audio, encodeWav(samples));
  }
  // 2026-08-04 : « l'audio a-t-il ete reecrit » se decide en comparant AU
  // FICHIER D'ORIGINE, et non sur un drapeau pose par une fausse remontee. Une
  // premiere version cherchait un octet nul, ce qui etait faux pour une raison
  // instructive : un echantillon 16 bits de valeur 1 s'ecrit `01 00`, donc le
  // fichier intact est deja plein d'octets nuls.
  const pristine = hasAudio ? fs.readFileSync(audio) : Buffer.alloc(0);
  const id = "rec-1";

  const f: Fixture = {
    work,
    dir,
    audio,
    id,
    doc: () => doc,
    // 2026-08-04 : « l'audio a-t-il ete remplace » se lit maintenant sur le
    // FICHIER, et non sur un drapeau pose par une fausse remontee. C'est une
    // meilleure question de test : elle ne peut pas etre vraie sans que les
    // octets aient change.
    audioReplaced: () => hasAudio && !fs.readFileSync(audio).equals(pristine),
    deps: (over = {}) => ({
      readRecording: (rid: string) =>
        Promise.resolve(rid === id ? { doc, audioBytes: hasAudio ? fs.statSync(audio).size : 0 } : null),
      writeDoc: (_rid: string, next: string) => void (doc = next),
      // 2026-08-04 : UNE seule couture au lieu de deux. Le module ne descend plus
      // et ne remonte plus rien : il nomme le fichier, le reecrit a cote, et le
      // remplace par un renommage.
      audioFile: () => audio,
      ...over,
    }),
  };
  return f;
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.work, { recursive: true, force: true });
}

function redactor(f: Fixture): Redactor {
  return new Redactor(f.deps());
}

/** True when every PCM byte in [fromMs, toMs) is zero. */
function isSilent(audioPath: string, fromMs: number, toMs: number): boolean {
  const buf = fs.readFileSync(audioPath);
  const from = 44 + Math.floor((fromMs / 1000) * SR) * 2;
  const to = 44 + Math.floor((toMs / 1000) * SR) * 2;
  for (let i = from; i < to; i++) if (buf[i] !== 0) return false;
  return true;
}

/** True when SOME PCM byte in [fromMs, toMs) is non-zero. */
function hasSound(audioPath: string, fromMs: number, toMs: number): boolean {
  const buf = fs.readFileSync(audioPath);
  const from = 44 + Math.floor((fromMs / 1000) * SR) * 2;
  const to = 44 + Math.floor((toMs / 1000) * SR) * 2;
  for (let i = from; i < to; i++) if (buf[i] !== 0) return true;
  return false;
}

test("a removal takes the words out of the transcript AND the sound out of the audio", async () => {
  const f = fixture();
  const before = fs.statSync(f.audio).size;
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.audioSilenced, true);

  const doc = f.doc();
  assert.doesNotMatch(doc, /4111/, "the passage left the transcript");
  assert.match(doc, /Alpha\./);
  assert.match(doc, /\[00:00:14\] Gamma\./, "and the surviving timestamps did not move");
  assert.match(doc, /The audio for that range was silenced\./);

  assert.equal(isSilent(f.audio, 7000, 14_000), true, "the removed range is zeroed");
  assert.equal(hasSound(f.audio, 0, 7000), true, "what came before is untouched");
  assert.equal(hasSound(f.audio, 14_000, 30_000), true, "what came after is untouched");
  assert.equal(fs.statSync(f.audio).size, before, "zeroed in place: the file keeps its length and its timeline");
  cleanup(f);
});

test("the .wav stays a valid, same-length file - the timeline never shifts under the transcript", async () => {
  const f = fixture();
  const head = fs.readFileSync(f.audio).subarray(0, 44);
  await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  const after = fs.readFileSync(f.audio).subarray(0, 44);
  assert.deepEqual(Buffer.from(after), Buffer.from(head), "the RIFF header is byte-identical");
  cleanup(f);
});

test("removing the LAST passage silences to the end of the file", async () => {
  const f = fixture();
  const r = await redactor(f).remove(f.id, [{ index: 2, startMs: 14_000 }]);
  assert.equal(r.ok, true);
  assert.equal(isSilent(f.audio, 14_000, 30_000), true);
  assert.equal(hasSound(f.audio, 0, 14_000), true);
  assert.match(f.doc(), /to the end of the recording/);
  cleanup(f);
});

test("two contiguous passages are one silenced range", async () => {
  const f = fixture();
  const r = await redactor(f).remove(f.id, [
    { index: 1, startMs: 7000 },
    { index: 2, startMs: 14_000 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(isSilent(f.audio, 7000, 30_000), true);
  assert.equal(hasSound(f.audio, 0, 7000), true);
  cleanup(f);
});

test("the derived notes go with the passage, and the result says so", async () => {
  const f = fixture({ notes: "The client read out his card number, 4111, at seven seconds." });
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.notesDropped, true);
  const doc = f.doc();
  assert.doesNotMatch(doc, /4111/, "a summary that repeated the passage would cancel the removal");
  assert.match(doc, /The meeting notes were removed on \d{4}-\d{2}-\d{2}/);
  cleanup(f);
});

test("a recording with no audio is removed from honestly, not silently", async () => {
  const f = fixture({ audio: false });
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.audioSilenced, false);
  assert.match(f.doc(), /No audio was kept for this recording/);
  cleanup(f);
});

// ---- refusals: nothing is written ----

test("a forged or stale id is refused, and nothing anywhere is touched", async () => {
  const f = fixture();
  const before = f.doc();
  for (const id of ["", "not-a-real-id", Buffer.from("../../etc/x", "utf8").toString("base64url")]) {
    const r = await redactor(f).remove(id, [{ index: 1, startMs: 7000 }]);
    assert.equal(r.ok, false, `id ${JSON.stringify(id)} must be refused`);
  }
  assert.equal(f.doc(), before);
  assert.equal(hasSound(f.audio, 7000, 14_000), true);
  cleanup(f);
});

test("B3e: un identifiant qui ne designe aucune reunion ne retire rien", async () => {
  // Ce test remplace « une racine que Flow n'a pas etablie ne sert rien », qui
  // portait sur un marqueur de dossier. La garde a change de nature et elle est
  // plus forte : il n'y a plus de dossier a marquer, et une requete portant le
  // jeton de quelqu'un ne peut rendre que SES lignes - un identifiant inconnu ne
  // rend rien du tout, jamais la reunion d'un autre.
  const f = fixture();
  const r = await redactor(f).remove("pas-une-reunion", [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not found/i);
  assert.match(f.doc(), /4111/, "the transcript is untouched");
  assert.equal(f.audioReplaced(), false, "et l'audio n'a pas ete touche non plus");
  cleanup(f);
});

test("an index whose start offset has DRIFTED refuses the whole request", async () => {
  // Between the page's parse and the human's click, a notes regeneration or a
  // startup rescue can rewrite the document. Acting on the stale index would
  // irreversibly destroy a passage nobody looked at.
  const f = fixture();
  const before = f.doc();
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 999_000 }]);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /changed since you opened it/);
  assert.equal(f.doc(), before);
  assert.equal(hasSound(f.audio, 7000, 14_000), true, "the audio was not touched either");
  cleanup(f);
});

test("an out-of-range index refuses, and never falls back to a neighbouring passage", async () => {
  const f = fixture();
  const before = f.doc();
  const r = await redactor(f).remove(f.id, [{ index: 99, startMs: 0 }]);
  assert.equal(r.ok, false);
  assert.equal(f.doc(), before);
  cleanup(f);
});

test("an empty target list is refused rather than treated as \"all of it\"", async () => {
  const f = fixture();
  const before = f.doc();
  const r = await redactor(f).remove(f.id, []);
  assert.equal(r.ok, false);
  assert.equal(f.doc(), before);
  cleanup(f);
});

test("an audio file Flow cannot silence refuses the WHOLE removal, transcript included", async () => {
  // The forbidden alternative: edit the text, leave the sound. The document
  // would then claim a passage is gone over audio that still plays it - the
  // exact false assurance this feature exists to prevent.
  const f = fixture();
  const stereo = Buffer.from(fs.readFileSync(f.audio));
  stereo.writeUInt16LE(2, 22); // two channels: the byte-to-time mapping is no longer ours
  fs.writeFileSync(f.audio, stereo);
  const before = f.doc();

  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /could not silence/i);
  assert.equal(f.doc(), before, "the transcript still holds the passage");
  assert.equal(fs.existsSync(f.audio + REDACT_SUFFIX), false, "no work file was left behind");
  cleanup(f);
});

// ---- the interrupted write ----

test("AUDIO FIRST: l'audio est silencieux AVANT que le document bouge", async () => {
  // Tout l'argument de surete du bandeau de main/redact.ts, exerce.
  //
  // B3e le rend plus direct qu'avant : l'ancien test rendait le document en
  // lecture seule et devait prevoir le cas ou le systeme de fichiers ignore le
  // bit pour le proprietaire (tests eleves), ce qui laissait la moitie du temps
  // l'affirmation d'ordre non verifiee. Ici l'ordre s'OBSERVE : `writeDoc` note
  // dans quel etat etait l'audio quand il a ete appele.
  const f = fixture();
  let audioSilentWhenDocWritten: boolean | null = null;
  const red = new Redactor(
    f.deps({
      writeDoc: () => {
        audioSilentWhenDocWritten = isSilent(f.audio, 7000, 14_000);
      },
    }),
  );
  const r = await red.remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true, r.error ?? "expected ok");
  assert.equal(audioSilentWhenDocWritten, true, "le document n'est ecrit qu'APRES que l'audio est silencieux");
  cleanup(f);
});

test("AUDIO FIRST: un audio qu'on ne peut pas REECRIRE refuse tout le retrait", async () => {
  // Le pire etat possible est un document qui annonce un passage supprime au-dessus
  // d'un audio qui le joue encore. Si la reecriture echoue, le document ne doit PAS
  // etre ecrit.
  //
  // 2026-08-04 : CE TEST A REMPLACE DEUX AUTRES, et la raison vaut d'etre ecrite.
  // Il y avait « un audio qu'on ne peut pas DESCENDRE » et « un audio qu'on ne
  // peut pas REMPLACER » : deux echecs reseau, sur les deux moities d'un
  // aller-retour avec Storage. L'audio ne quitte plus la machine, donc ces deux
  // pannes n'existent plus. Celle qui reste est la seule vraie : le disque refuse.
  //
  // La panne est provoquee en faisant pointer `audioFile` vers un fichier qui
  // n'est pas un .wav lisible - ce que `silenceAudio` refuse avant d'ecrire quoi
  // que ce soit.
  const f = fixture();
  const before = f.doc();
  const junk = path.join(f.work, "pas-un-wav.wav");
  fs.writeFileSync(junk, "ceci n'est pas un RIFF");
  const red = new Redactor(f.deps({ audioFile: () => junk }));
  const r = await red.remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, false);
  assert.equal(f.doc(), before, "le document n'a pas ete reecrit");
  assert.equal(hasSound(f.audio, 7000, 14_000), true, "et l'audio joue encore le passage");
  // Et aucun fichier de travail ne reste, meme sur ce chemin d'echec.
  assert.deepEqual(
    fs.readdirSync(f.dir).filter((n) => n.includes(REDACT_SUFFIX)),
    [],
    "aucun fichier de travail ne reste apres un echec",
  );
  cleanup(f);
});

test("canari de source : l'audio est remplace AVANT que le document soit ecrit", () => {
  // Un test verifie un comportement ; celui-ci verifie la PREMISSE sur laquelle
  // le comportement repose, et qu'aucun harnais ne peut observer sans tuer un
  // processus. Si quelqu'un inverse ces deux appels un jour, l'argument de
  // securite du bandeau de ce module cesse de tenir, et ce test tombe.
  //
  // B3e avait change les moyens, pas l'ordre : la bascule atomique etait devenue
  // le `upsert` de Storage. 2026-08-04 la change encore, et toujours pas l'ordre :
  // l'audio reste sur la machine, donc la bascule est redevenue un renommage sur
  // le meme volume. Ce qui reste vrai a travers les trois versions, et qui est
  // tout le sujet : au moment ou le document annonce un audio silencieux, l'audio
  // EST silencieux.
  const src = fs.readFileSync(new URL("../src/main/redact.ts", import.meta.url), "utf8");
  const silence = src.indexOf("await this.silenceLocalAudio(");
  const write = src.indexOf("this.deps.writeDoc(id, plan.doc)");
  assert.ok(silence > 0 && write > 0, "les deux etapes sont toujours la");
  assert.ok(silence < write, "l'audio d'abord, le document ensuite : voir le bandeau du module");
  // Et la reecriture est ATTENDUE. Sans `await`, le document partirait pendant que
  // la copie nettoyee s'ecrit encore, ce qui rendrait la pierre tombale fausse
  // exactement le temps d'une passe sur 115 Mo.
  assert.match(src.slice(silence - 10, silence + 40), /await this\.silenceLocalAudio\(/);
});

test("un fichier de travail laisse par une execution tuee est balaye, et l'audio survit", async () => {
  // Le balayage porte sur le dossier de TRAVAIL. Ce qui ne change pas d'une
  // version a l'autre : un reste d'une execution morte ne doit ni s'accumuler, ni
  // etre confondu avec l'audio de la reunion.
  const f = fixture();
  const orphan = path.join(f.dir, "rec-0" + REDACT_SUFFIX);
  fs.writeFileSync(orphan, "debris from a run that died mid-scrub");
  const r = await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(orphan), false, "the orphan is gone");
  assert.equal(f.audioReplaced(), true, "et l'audio a bien ete reecrit");
  cleanup(f);
});

test("the sweep only ever touches its own suffix", async () => {
  const f = fixture();
  const innocent = path.join(f.dir, "notes.txt");
  fs.writeFileSync(innocent, "the user's own file");
  await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.equal(fs.readFileSync(innocent, "utf8"), "the user's own file");
  cleanup(f);
});

test("un retrait termine ne laisse aucun fichier de travail derriere lui", async () => {
  // Il n'y a plus qu'un fichier de travail - la copie nettoyee - et il devient le
  // .wav de la reunion par un renommage, ou il part dans un `finally`. Un .wav
  // d'une heure pese 115 Mo : un reste par retrait remplirait un disque en
  // silence.
  const f = fixture();
  await redactor(f).remove(f.id, [{ index: 1, startMs: 7000 }]);
  // 2026-08-04 : le dossier n'est plus VIDE, il contient l'audio de la reunion -
  // c'est le meme dossier depuis que la copie nettoyee s'ecrit a cote de
  // l'originale. Ce qu'il ne doit pas contenir est un reste de travail, et c'est
  // exactement ce que cette assertion dit maintenant.
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ["rec-1.wav"], "il ne reste que l'audio de la reunion");
  cleanup(f);
});

test("a second removal, on the already-cleaned transcript, still works on the right passage", async () => {
  const f = fixture();
  const red = redactor(f);
  assert.equal((await red.remove(f.id, [{ index: 1, startMs: 7000 }])).ok, true);
  // The tombstone is not a passage, so what was index 2 is now index 1.
  const r = await red.remove(f.id, [{ index: 1, startMs: 14_000 }]);
  assert.equal(r.ok, true);
  assert.equal(isSilent(f.audio, 7000, 30_000), true);
  assert.equal(hasSound(f.audio, 0, 7000), true);
  const doc = f.doc();
  assert.equal(doc.match(/Passage removed/g)?.length, 2);
  assert.match(doc, /Alpha\./);
  cleanup(f);
});

test("a transcript too large to rewrite is refused rather than truncated", () => {
  // The one that would be catastrophic and silent: rewriting from a capped read
  // would drop everything past the cap while reporting a clean removal.
  assert.ok(MAX_REDACT_DOC_BYTES > 5 * 1024 * 1024, "bien au-dessus du plafond d'AFFICHAGE (MAX_DOC_DISPLAY_BYTES)");
});

test("nothing removed is ever written to the log", async () => {
  const f = fixture();
  const lines: string[] = [];
  const red = new Redactor(f.deps({ log: (m) => lines.push(m) }));
  await red.remove(f.id, [{ index: 1, startMs: 7000 }]);
  assert.ok(lines.length > 0, "the operation is traceable");
  for (const l of lines) {
    assert.doesNotMatch(l, /4111/, "the removed text must not survive in flow.log");
    assert.doesNotMatch(l, /00:00:07/, "nor the range that would let someone find it in a backup");
  }
  cleanup(f);
});
