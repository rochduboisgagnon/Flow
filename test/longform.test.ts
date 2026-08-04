import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  endsInPause,
  findCutPoint,
  hms,
  transcriptLine,
  transcriptHeader,
  recordingBaseName,
  chunkTranscript,
  pushRecent,
  summaryPrompt,
  spliceNotes,
  RECENT_MAX,
  type RecentEntry,
} from "../src/shared/longform";
import { LongRecorder, refuseUnsafeDestination, DOC_FLUSH_MS, type LongDeps } from "../src/main/longform";
import { fakeCaptureStore, type FakeCaptureStore } from "./fixtures/capture-store";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

const SR = 16_000;

function tone(ms: number, amp = 6000): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amp);
  return out;
}
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}
// Speech-LIKE audio for the recorder tests: the adaptive VAD (rightly) reads a
// constant tone as background noise, so alternate loud bursts with real gaps
// (a third of the time quiet, like syllables and breaths).
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

/** Un enregistreur branche sur un magasin en memoire. Aucun test de ce fichier
 * n'ecrit un document sur le disque : c'est tout le sujet de B3a. */
function recorder(over: Partial<LongDeps> = {}): { store: FakeCaptureStore; rec: LongRecorder } {
  const store = fakeCaptureStore();
  const rec = new LongRecorder({
    transcribeSegment: () => Promise.reject(new Error("speech engine not ready")),
    store,
    // Pas d'horloge de tranches dans les tests : ils appellent flushSlice() quand
    // ils veulent observer une tranche, ce qui est plus sur qu'attendre 20 s.
    schedule: () => () => {},
    ...over,
  });
  return { store, rec };
}

const settle = async (rec: LongRecorder, ms = 50) => {
  for (let i = 0; i < 300 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, ms));
};

test("endsInPause: true after 1.2 s of trailing silence, false mid-speech", () => {
  assert.equal(endsInPause(concat(tone(3000), silence(1300))), true);
  assert.equal(endsInPause(concat(tone(3000), silence(300))), false);
  assert.equal(endsInPause(tone(4000)), false);
});

test("findCutPoint lands inside the quiet stretch", () => {
  const pcm = concat(tone(10_000), silence(1000), tone(4000));
  const cut = findCutPoint(pcm, 8_000);
  // The silence spans samples [160000, 176000): the cut must fall there.
  assert.ok(cut > 160_000 && cut <= 176_000, `cut=${cut}`);
});

test("hms formats hours, minutes and seconds", () => {
  assert.equal(hms(0), "00:00:00");
  assert.equal(hms(83_000), "00:01:23");
  assert.equal(hms(3_723_000), "01:02:03");
});

test("transcriptLine and the header carry the timestamps a reader needs", () => {
  assert.equal(transcriptLine(83_000, "Bonjour."), "[00:01:23] Bonjour.\n\n");
  const h = transcriptHeader("Reunion", "2026-07-14T09:00:00.000Z");
  assert.ok(h.startsWith("# Reunion\n"));
  assert.ok(h.includes("- recorded: 2026-07-14T09:00:00.000Z"));
});

test("recordingBaseName is file-safe and stamped", () => {
  const d = new Date(2026, 6, 14, 9, 5);
  assert.equal(recordingBaseName("Réunion  Équipe!", d), "reunion-equipe-2026-07-14-0905");
  assert.equal(recordingBaseName("", d), "recording-2026-07-14-0905");
});

test("chunkTranscript splits on blank lines, never mid-line", () => {
  const line = "[00:00:00] " + "x".repeat(200) + "\n\n";
  const doc = line.repeat(300);
  const parts = chunkTranscript(doc, 5_000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 5_200, `chunk too big: ${p.length}`);
  assert.equal(parts.join("").replace(/\s+/g, ""), doc.replace(/\s+/g, ""));
});

test("pushRecent keeps only the most recent entries", () => {
  let list: RecentEntry[] = [];
  for (let i = 0; i < RECENT_MAX + 3; i++) {
    list = pushRecent(list, { id: "id" + i, title: "t" + i, startedIso: "", durationMs: 0, staged: true });
  }
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].title, "t" + (RECENT_MAX + 2));
});

test("summaryPrompt carries the transcript, clean section headings and marks", () => {
  const p = summaryPrompt("TRANSCRIPT BODY", [83_000]);
  assert.ok(p.includes("TRANSCRIPT BODY"));
  assert.ok(p.includes("## Decisions"));
  assert.ok(p.includes("00:01:23"));
  // The lead summary must NOT carry its own heading (it would double the
  // "## Summary" wrapper finalize adds), and no "(bullets)"/"(one paragraph)"
  // instruction parentheticals must leak into the section titles.
  assert.ok(!p.includes("## Resume"), "no ## Resume heading to stack under ## Summary");
  assert.ok(!p.includes("(bullets)"));
  assert.ok(!p.includes("(one paragraph)"));
});

// ---------------------------------------------------------------------------
// PIEGE DU PLAN (B3) : la regle « Flow suggestion kept at ».
//
// Live Suggestions a disparu de l'application (vague C), mais des documents
// ecrits AVANT en portent les lignes, et la regle qui avertit le modele que
// personne ne les a prononcees doit rester. Elle est pilotee par le CONTENU du
// transcript, donc elle survit au changement de support - et ce test est ce qui
// le prouve plutot que de l'esperer.
// ---------------------------------------------------------------------------
test("B3: summaryPrompt avertit encore que les lignes « Flow suggestion kept at » n'ont ete dites par personne", () => {
  const withSuggestion =
    "[00:00:00] Bonjour.\n\n> [Flow suggestion kept at 00:00:12] Une phrase ecrite par un modele.\n\n";
  const p = summaryPrompt(withSuggestion, []);
  assert.ok(p.includes("WRITTEN BY A MODEL"), "la regle doit etre dans le prompt");
  assert.ok(p.includes("spoken by NOBODY"));
  // Et elle n'est PAS ajoutee quand rien ne la justifie : un transcript ordinaire
  // ne doit pas depenser du contexte a expliquer une forme qu'il ne contient pas.
  assert.ok(!summaryPrompt("[00:00:00] Bonjour.\n\n", []).includes("WRITTEN BY A MODEL"));
});

// ---------------------------------------------------------------------------
// B3a : LE DOCUMENT VA DANS LE COMPTE, ET NULLE PART SUR LE DISQUE
// ---------------------------------------------------------------------------

test("B3a: une reunion produit un document complet dans le compte, sans ecrire un seul .md", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-long-"));
  const seen: number[] = [];
  const mockSidecar = {
    transcribe: (wav: Uint8Array) => {
      seen.push(wav.length);
      return Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 });
    },
  } as unknown as WhisperSidecar;
  const { rec, store } = recorder({
    transcribeSegment: (wav) => mockSidecar.transcribe(wav),
    audioDir: path.join(work, "pending-audio"),
  });

  const started = rec.start({ title: "Test Meeting", keepAudio: true });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  assert.ok(started.recordingId, "start rend l'identifiant de la ligne, plus un chemin de fichier");
  assert.equal(rec.isBusy, true);
  // La ligne existe DES LE DEPART : c'est ce qui rend une reunion coupee trente
  // secondes plus tard visible comme interrompue plutot que disparue.
  const atStart = store.rows.get(started.recordingId!);
  assert.ok(atStart, "la ligne doit exister des le premier instant");
  assert.equal(atStart.endedIso, "", "et elle doit etre OUVERTE");

  // 10 s of speech then a real pause: the segment closes naturally.
  rec.onChunk(speechy(5000));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.mark();
  rec.gap(7.4);
  rec.onChunk(speechy(4000));
  const stopped = rec.stop();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.recordingId, started.recordingId);

  await settle(rec);
  assert.equal(rec.isBusy, false, "finalize must complete");

  const st = rec.state();
  assert.ok(st.segments >= 2, `segments=${st.segments}`);
  assert.equal(st.pending, 0);
  const row = store.rows.get(stopped.recordingId)!;
  assert.ok(row, "la reunion est dans le compte");
  assert.ok(row.doc.includes("# Test Meeting"));
  assert.ok(row.doc.includes("[00:00:00] Bonjour tout le monde."));
  assert.ok(row.doc.includes("Moment marked at"));
  assert.ok(row.doc.includes("Recording paused ~7s"), "the gap must be marked honestly");
  assert.ok(seen.length >= 2, "the mock engine transcribed the segments");
  assert.ok(row.endedIso, "une reunion terminee porte son instant de fin");
  assert.equal(row.title, "Test Meeting");
  assert.equal(row.staged, true, "personne ne l'a encore rangee dans un dossier a lui");

  // AUCUN .md nulle part. C'est l'invariant de la vague, verifie et non suppose.
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]))
      : [];
  assert.deepEqual(
    walk(work).filter((f) => f.endsWith(".md")),
    [],
    "aucun document ne doit toucher le disque",
  );
  assert.equal(rec.state().recent[0].id, stopped.recordingId, "state() nomme la derniere capture par son identifiant");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: la tranche ne part QUE si le document a bouge", () => {
  const { rec, store } = recorder();
  rec.start({ title: "Tranches" });
  const afterStart = store.writes.length;
  assert.equal(afterStart, 1, "start() ecrit la ligne, une fois");

  rec.flushSlice();
  assert.equal(store.writes.length, afterStart, "rien de neuf : pas d'envoi");

  rec.mark(); // une mutation du document
  rec.flushSlice();
  assert.equal(store.writes.length, afterStart + 1, "le document a bouge : une tranche part");

  rec.flushSlice();
  rec.flushSlice();
  assert.equal(store.writes.length, afterStart + 1, "et elle ne repart pas trois fois pour rien");
  rec.stop();
});

test("B3a: chaque tranche contient TOUT le document, pas seulement l'ajout", async () => {
  // C'est ce qui rend la coalescence de la file correcte : si une tranche ne
  // portait que le delta, en jeter une perdrait ce qu'elle portait.
  const { rec, store } = recorder({ transcribeSegment: () => Promise.resolve({ text: "Un.", ms: 1 }) });
  rec.start({ title: "Cumul" });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  await new Promise((r) => setTimeout(r, 80));
  rec.flushSlice();
  const first = store.writes[store.writes.length - 1].doc;
  rec.mark();
  rec.flushSlice();
  const second = store.writes[store.writes.length - 1].doc;
  assert.ok(second.startsWith(first), "la tranche suivante contient la precedente en entier");
  assert.ok(second.length > first.length);
  rec.stop();
  await settle(rec);
});

test("B3a: DOC_FLUSH_MS borne la perte d'un plantage, et l'annonce", () => {
  // Le chiffre est un engagement, pas un reglage : il dit ce qu'on accepte de
  // perdre. Un test le fige pour que le changer soit une decision.
  assert.equal(DOC_FLUSH_MS, 20_000);
});

test("B3a: un deuxieme start est refuse", () => {
  const { rec } = recorder();
  assert.equal(rec.start({ title: "A" }).ok, true);
  assert.equal(rec.start({ title: "B" }).ok, false, "second start must refuse");
  rec.stop();
});

test("v6 c8: only the last recording is remembered (RECENT_MAX=1)", () => {
  assert.equal(RECENT_MAX, 1);
  let list: RecentEntry[] = [];
  for (const t of ["a", "b", "c"]) {
    list = pushRecent(list, { id: t, title: t, startedIso: "", durationMs: 0, staged: true });
  }
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "c", "the last capture replaces the previous one");
});

test("B3a: state() ne lit plus aucun fichier - la derniere capture vit en memoire", async () => {
  // Le cache RECENT_STATE_CACHE_MS existait parce que state() lisait recent.json
  // et faisait un existsSync par entree, jusqu'a deux fois par seconde, sur le
  // fil du crochet clavier. La cause a disparu ; ce test refuse son retour.
  const { rec } = recorder({ transcribeSegment: () => Promise.resolve({ text: "Un.", ms: 1 }) });
  assert.deepEqual(rec.state().recent, []);
  rec.start({ title: "Memoire" });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  rec.stop();
  await settle(rec);
  // Immediatement, sans fenetre de cache a attendre.
  assert.equal(rec.state().recent.length, 1, "la derniere capture est visible tout de suite");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "longform.ts"), "utf8");
  assert.ok(!src.includes("RECENT_STATE_CACHE_MS = "), "le cache ne doit pas revenir : il n'a plus de cause");
  assert.ok(!src.includes('"recent.json"'), "et recent.json non plus");
});

// ---------------------------------------------------------------------------
// L'EXPORT (l'ancien « Save to... »)
// ---------------------------------------------------------------------------

test("B3a: l'export ecrit une COPIE dans le dossier choisi et ne deplace rien", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-export-"));
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const { rec, store } = recorder({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 }),
    audioDir: path.join(work, "pending"),
  });
  const started = rec.start({ title: "Client kickoff", keepAudio: true });
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  await settle(rec);

  const res = await rec.save(dest);
  assert.equal(res.ok, true, res.error ?? "expected ok");
  // Le sous-dossier par capture, comme avant.
  const sub = path.dirname(res.docPath!);
  assert.equal(path.dirname(sub), dest, "the capture folder sits in the chosen folder");
  assert.equal(path.basename(sub), path.basename(res.docPath!, ".md"), "the folder carries the capture's name+date");
  assert.ok(fs.readFileSync(res.docPath!, "utf8").includes("# Client kickoff"));
  assert.ok(res.audioPath && fs.existsSync(res.audioPath), "l'audio en transit part avec le document");
  assert.equal(path.dirname(res.audioPath!), sub);
  // ET la reunion est toujours dans le compte : un export ne deplace rien.
  const row = store.rows.get(started.recordingId!)!;
  assert.ok(row.doc.includes("# Client kickoff"), "la reunion n'a pas quitte le compte");
  assert.equal(row.staged, false, "elle sait maintenant qu'elle a ete rangee");
  assert.equal(rec.state().recent[0].staged, false);
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: l'export ne reutilise jamais un dossier existant de la destination", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-export2-"));
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const { rec } = recorder({ transcribeSegment: () => Promise.resolve({ text: "Un.", ms: 1 }) });
  rec.start({ title: "Note" });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  rec.stop();
  await settle(rec);
  const first = await rec.save(dest);
  assert.equal(first.ok, true, first.error ?? "expected ok");
  fs.writeFileSync(path.join(path.dirname(first.docPath!), "keep.md"), "KEEP");
  // Le meme export une seconde fois : il ne doit pas s'installer dans le dossier
  // qui existe deja, ni ecraser ce qu'il contient.
  const second = await rec.save(dest);
  assert.equal(second.ok, true, second.error ?? "expected ok");
  assert.notEqual(path.dirname(second.docPath!), path.dirname(first.docPath!), "un suffixe, jamais une fusion");
  assert.equal(fs.readFileSync(path.join(path.dirname(first.docPath!), "keep.md"), "utf8"), "KEEP");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: l'export refuse une destination absente et une absence de capture", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-export3-"));
  const { rec } = recorder();
  assert.equal((await rec.save(path.join(work, "nope"))).ok, false, "a missing dir is refused");
  assert.equal((await rec.save(work)).ok, false, "no finished recording is refused");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: un export qui echoue ne laisse rien dans le dossier de l'utilisateur - et rien n'est perdu", async () => {
  // Remplace l'ancien test de rollback en deux phases. Il n'y a plus de commit
  // en deux phases parce qu'il n'y a plus de deplacement : ce qui doit etre
  // prouve n'est donc plus « la source survit » mais « la destination reste
  // propre », la source etant le compte, qui n'est jamais touche.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-export4-"));
  const dest = path.join(work, "dest");
  fs.mkdirSync(dest);
  const pending = path.join(work, "pending");
  const { rec, store } = recorder({
    transcribeSegment: () => Promise.resolve({ text: "Un.", ms: 1 }),
    audioDir: pending,
  });
  const started = rec.start({ title: "Note", keepAudio: true });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  rec.stop();
  await settle(rec);
  // Le .wav en transit remplace par un DOSSIER : existsSync dit oui, copyFileSync
  // leve (EISDIR/EPERM) apres que le document a deja ete ecrit. C'est le chemin
  // exact que le nettoyage doit couvrir.
  const wav = path.join(pending, started.recordingId! + ".wav");
  assert.equal(fs.existsSync(wav), true, "keepAudio garde le .wav en transit");
  fs.rmSync(wav);
  fs.mkdirSync(wav);

  const res = await rec.save(dest);
  assert.equal(res.ok, false, "l'echec est rapporte");
  assert.deepEqual(fs.readdirSync(dest), [], "rien - ni dossier, ni copie partielle - ne reste chez l'utilisateur");
  assert.ok(store.rows.get(started.recordingId!)!.doc.includes("# Note"), "la reunion est toujours dans le compte");
  assert.equal(store.rows.get(started.recordingId!)!.staged, true, "et elle n'a pas ete marquee comme rangee");
  fs.rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Security scan F1 (MEDIUM, 3/3, 2026-08-02). `/long/save` passed the caller's
// folder to statSync and nothing else. The dangerous case is not an odd local
// folder - it is a UNC path, which turns "file my recording" into "copy the
// meeting off this machine, and authenticate to the attacker's host on the way".
// ---------------------------------------------------------------------------

test("F1: a UNC or device destination is refused before anything is created", () => {
  for (const bad of [
    "\\\\attacker.tld\\share",
    "\\\\attacker.tld\\share\\drop",
    "//attacker.tld/share", // forward slashes: Windows accepts these too
    "\\\\?\\C:\\Windows",
    "\\\\.\\pipe\\anything",
  ]) {
    const why = refuseUnsafeDestination(bad);
    assert.ok(why, `${bad} must be refused`);
    assert.match(why, /network path/, "and the refusal must say why, not just fail");
  }
});

test("F1: a relative destination is refused (it would resolve against Flow's cwd)", () => {
  for (const bad of ["notes", "./notes", "..\\..\\somewhere"]) {
    assert.ok(refuseUnsafeDestination(bad), `${bad} must be refused`);
  }
});

test("F1: an ordinary local folder is still accepted - the fix must not remove the feature", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-f1-"));
  try {
    assert.equal(refuseUnsafeDestination(work), null, "a real local folder is a normal destination");
    // The point of NOT confining to the home directory: saving to another
    // volume is a thing a person does, and must not be called suspicious.
    assert.equal(refuseUnsafeDestination("D:\\Recordings"), null);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("F1: save() itself refuses a UNC destination, not just the helper", async () => {
  const { rec } = recorder();
  const res = await rec.save("\\\\attacker.tld\\share");
  assert.equal(res.ok, false);
  assert.match(String(res.error), /network path/, "refused for the RIGHT reason, not for 'folder not found'");
});

test("F13: la seconde verification de destination existe et vient APRES l'attente", () => {
  // Une lecture du code plutot qu'un scenario : fabriquer la course de dix
  // minutes dans une suite unitaire couterait dix minutes.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "longform.ts"), "utf8");
  const wait = src.indexOf("still finalizing; try again in a moment");
  const second = src.indexOf("lateRefusal");
  assert.ok(wait > 0 && second > wait, "la re-verification doit venir APRES l'attente, sinon elle ne ferme rien");
  assert.equal(src.split("refuseUnsafeDestination(").length - 1, 3, "definition + deux appels");
});

// ---- meeting notes (2026-07-21): spliceNotes + notesSplice ----

test("spliceNotes: a bare transcript (no Ollama) gains ## Notes and ## Transcript", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = header + "[00:00:00] Bonjour.\n\n[00:00:05] On commence.\n\n";
  const out = spliceNotes(doc, header, "## Resume\n\nCourt.");
  assert.equal(
    out,
    header + "## Notes\n\n## Resume\n\nCourt.\n\n## Transcript\n\n[00:00:00] Bonjour.\n\n[00:00:05] On commence.\n\n",
  );
});

test("spliceNotes: an Ollama ## Summary block is replaced, never stacked", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = header + "## Summary\n\nvieux resume\n\n## Transcript\n\n[00:00:00] Bonjour.\n\n";
  const out = spliceNotes(doc, header, "notes fraiches");
  assert.ok(!out.includes("## Summary"), "the old summary is gone");
  assert.ok(!out.includes("vieux resume"));
  assert.ok(out.includes("## Notes\n\nnotes fraiches\n\n## Transcript\n\n[00:00:00] Bonjour."));
});

test("spliceNotes is idempotent: a regenerate replaces the previous ## Notes", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc = header + "[00:00:00] Bonjour.\n\n";
  const once = spliceNotes(doc, header, "v1");
  const twice = spliceNotes(once, header, "v2");
  assert.ok(!twice.includes("v1"), "the first notes are replaced");
  assert.equal(twice, spliceNotes(doc, header, "v2"), "regenerate lands on the same canonical form");
});

test("spliceNotes: a hand-edited title falls back to the engine line, transcript intact", () => {
  const header = transcriptHeader("Kickoff", "2026-07-21T09:00:00.000Z");
  const doc =
    "# Titre change a la main\n\n- recorded: 2026-07-21T09:00:00.000Z\n- engine: AGR Flow (100% local)\n\n[00:00:00] Bonjour.\n\n";
  const out = spliceNotes(doc, header, "notes");
  assert.ok(out.startsWith("# Titre change a la main"), "the user's edited header wins");
  assert.ok(out.includes("## Notes\n\nnotes\n\n## Transcript\n\n[00:00:00] Bonjour."));
});

test("B3a: notesSplice ecrit les notes dans la ligne, designee par son identifiant", async () => {
  const { rec, store } = recorder({ transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 1 }) });
  const started = rec.start({ title: "Kickoff" });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  rec.stop();
  await settle(rec);
  const id = started.recordingId!;

  const res = await rec.notesSplice(id, "## Resume\n\nCourt.");
  assert.equal(res.ok, true, res.error ?? "expected ok");
  const doc = store.rows.get(id)!.doc;
  assert.ok(doc.includes("## Notes\n\n## Resume\n\nCourt.\n\n## Transcript\n\n[00:00:00] Bonjour."));
  // Des notes vides et un identifiant vide sont refuses sans rien toucher.
  assert.equal((await rec.notesSplice(id, "   ")).ok, false);
  assert.equal((await rec.notesSplice("", "x")).ok, false);
  // Un identifiant inconnu est refuse : il n'y a plus de `movedTo` a rendre,
  // parce qu'il n'y a plus rien qui se deplace.
  const unknown = await rec.notesSplice("00000000-0000-4000-8000-000000000000", "notes");
  assert.equal(unknown.ok, false);
  assert.equal(store.rows.get(id)!.doc, doc, "et rien n'a bouge");
});

// ---- U4 (review): the duration a recording reached is a FACT about it ----

test("U4: the duration stays at what the recording reached, through finalizing and after", async () => {
  const slow = {
    transcribe: () => new Promise<{ text: string; ms: number }>((r) => setTimeout(() => r({ text: "Bonjour.", ms: 5 }), 400)),
  } as unknown as WhisperSidecar;
  const { rec } = recorder({ transcribeSegment: (wav) => slow.transcribe(wav) });

  const started = rec.start({ title: "Duration", keepAudio: false });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  await new Promise((r) => setTimeout(r, 120)); // let the wall clock actually move
  rec.onChunk(concat(speechy(4000), silence(1500)));
  const live = rec.state().durationMs;
  assert.ok(live >= 100, `a running recording reports its elapsed time (got ${live})`);

  rec.stop();
  const whileFinalizing = rec.state();
  assert.equal(whileFinalizing.finalizing, true, "the recorder is still finishing the transcript");
  assert.ok(
    whileFinalizing.durationMs >= live,
    `the biggest number on the page must not fall to 00:00:00 the instant Stop is pressed (got ${whileFinalizing.durationMs})`,
  );

  await settle(rec, 25);
  assert.equal(rec.isBusy, false, "finalize must complete");
  const idle = rec.state();
  assert.equal(idle.active, false);
  assert.equal(idle.finalizing, false);
  assert.ok(idle.durationMs > 0, "et elle reste une longueur : c'est un fait sur l'enregistrement");

  // A new recording is the only thing that resets it.
  const again = rec.start({ title: "Second", keepAudio: false });
  assert.equal(again.ok, true, again.error ?? "expected ok");
  assert.ok(rec.state().durationMs < 1000, "a fresh recording starts from zero, not from the previous one's length");
  rec.stop();
  await settle(rec, 25);
});

test("B3a: transcriptSince lit la memoire et rend des offsets reutilisables", async () => {
  const { rec } = recorder({ transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 1 }) });
  rec.start({ title: "Poll" });
  const first = rec.transcriptSince(0);
  assert.ok(first.text.includes("# Poll"), "le sondage voit l'entete des le depart");
  rec.onChunk(concat(speechy(3000), silence(1500)));
  await new Promise((r) => setTimeout(r, 80));
  const next = rec.transcriptSince(first.nextSince);
  assert.ok(next.nextSince >= first.nextSince);
  assert.equal(rec.transcriptSince(next.nextSince).text, "", "reprendre au bout ne rend rien");
  rec.stop();
  await settle(rec);
});

// ---------------------------------------------------------------------------
// B3a : LA CASE « GARDER L'AUDIO » DECIDE ENCORE QUELQUE CHOSE.
//
// Ces deux tests remplacent quatre tests de test/history.test.ts, supprime avec
// le dossier qu'il decrivait. Les quatre verifiaient le trajet staging/ ->
// history/ ; la PROMESSE, elle, survit sans changer d'un mot - le .wav est ecrit
// pendant toute la capture quoi que dise la case (c'est la seule chose qui peut
// encore sauver une reunion dont la transcription tombe), et c'est a la FIN que
// la case tranche.
// ---------------------------------------------------------------------------

test("U4-2: keepAudio decoche - le .wav en transit est supprime des que le document est sur", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-off-"));
  const pending = path.join(work, "pending");
  const { rec } = recorder({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 5 }),
    audioDir: pending,
  });
  const started = rec.start({ title: "No Audio Please", keepAudio: false });
  assert.equal(started.ok, true, started.error ?? "expected ok");
  // Le .wav est ouvert MEME avec la case decochee : pendant la capture, c'est le
  // dernier recours si la transcription tombe, et un plantage ne donne pas de
  // seconde chance de commencer a l'ecrire.
  const wav = path.join(pending, started.recordingId! + ".wav");
  assert.equal(fs.existsSync(wav), true, "l'audio est ecrit pendant la capture, quoi que dise la case");

  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  await settle(rec);
  assert.equal(fs.existsSync(wav), false, "et il disparait a la fin : la case decrit ce que Flow GARDE");
  fs.rmSync(work, { recursive: true, force: true });
});

test("U4-2: keepAudio cochee - le .wav survit a la fin, avec une entete valide", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-on-"));
  const pending = path.join(work, "pending");
  const { rec, store } = recorder({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 5 }),
    audioDir: pending,
  });
  const started = rec.start({ title: "Keep It", keepAudio: true });
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.stop();
  await settle(rec);

  const wav = path.join(pending, started.recordingId! + ".wav");
  assert.equal(fs.existsSync(wav), true, "la case cochee garde l'audio, et il RESTE ici (2026-08-04)");
  // Et son entete de taille a ete corrigee : un fichier lu avant la fermeture du
  // flux parait vide a tous les lecteurs.
  const head = fs.readFileSync(wav);
  assert.equal(head.subarray(0, 4).toString(), "RIFF");
  assert.equal(head.readUInt32LE(4), 36 + head.readUInt32LE(40), "RIFF et data se repondent");
  // 2026-08-04 : LA LIGNE NE CITE AUCUN OBJET, et elle annonce la taille reelle.
  //
  // Elle portait `uid-1/<id>.wav`, le nom de l'objet a televerser. L'audio ne
  // monte plus (decision de Roch), donc un chemin d'objet serait une promesse que
  // rien ne tient. Ce qui traverse est la TAILLE : c'est elle qui permet a une
  // autre machine de dire « cette reunion a 101 Mo d'audio, sur l'ordinateur qui
  // l'a enregistree » plutot que de croire qu'il n'y a pas d'audio du tout.
  const row = store.rows.get(started.recordingId!)!;
  assert.equal(row.audioPath, "", "aucun objet n'est cite : l'audio ne quitte pas la machine");
  assert.equal(row.audioBytes, fs.statSync(wav).size, "la taille annoncee est celle du fichier, mesuree");
  fs.rmSync(work, { recursive: true, force: true });
});

test("2026-08-04 : garder l'audio ne demande AUCUN compte", async () => {
  // CE TEST REMPLACE DEUX AUTRES, ET LES DEUX PREMISSES ONT DISPARU LE MEME JOUR.
  //
  //  - « sans compte connu, l'audio ATTEND au lieu de partir sous un mauvais
  //    chemin » : il n'y a plus de chemin d'objet a composer, donc plus rien a
  //    attendre. Une reunion enregistree avant que la session soit lue gardait son
  //    audio en suspens ; elle le garde maintenant, simplement.
  //  - « la ligne porte le chemin de l'audio AVANT que la file soit prevenue » :
  //    cette course protegeait un ordre entre deux ecritures - la ligne, puis la
  //    file qui la relit pour savoir s'il faut supprimer le .wav. Il n'y a plus de
  //    file, donc plus d'ordre a garantir. Le defaut qu'elle fermait est ecrit
  //    dans le journal de campagne ; le supprimer sans le nommer aurait efface la
  //    lecon avec le code.
  //
  // Ce qui RESTE a prouver est la promesse visible : la case cochee garde
  // l'audio, ici, quoi qu'il arrive au reseau ou a la session.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-noacct-"));
  const dir = path.join(work, "audio");
  const { rec, store } = recorder({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 5 }),
    audioDir: dir,
  });
  const started = rec.start({ title: "No account", keepAudio: true });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  rec.stop();
  await settle(rec);
  const wav = path.join(dir, started.recordingId! + ".wav");
  assert.equal(fs.existsSync(wav), true, "le fichier est la");
  const row = store.rows.get(started.recordingId!)!;
  assert.equal(row.audioPath, "", "et la ligne ne cite aucun objet dans le seau");
  assert.ok(row.audioBytes > 44, "mais elle annonce sa taille : la reunion A un audio");
  fs.rmSync(work, { recursive: true, force: true });
});

test("B3a: une reunion est FERMEE meme quand la finalisation echoue", async () => {
  // Sans ce filet, une exception dans le chemin du resume - le modele local qui
  // tombe, Ollama qui ne repond pas - laissait la ligne OUVERTE. Le sauvetage du
  // prochain lancement la fermait alors en y ecrivant « Flow s'est arrete de facon
  // inattendue (plantage, coupure de courant ou arret force) », ce qui est FAUX :
  // la reunion s'est terminee normalement, c'est son resume qui a rate.
  //
  // Une petite contre-verite dans un document que quelqu'un relira dans six mois
  // pour savoir ce qui s'est passe.
  const { rec, store } = recorder({
    transcribeSegment: () => Promise.resolve({ text: "Bonjour.", ms: 1 }),
    llm: {
      id: "faux",
      available: () => Promise.resolve({ found: true, responded: true }),
      long: () => Promise.reject(new Error("Ollama ne repond pas")),
      short: () => Promise.resolve(null),
    } as unknown as LongDeps["llm"],
  });
  const started = rec.start({ title: "Resume rate" });
  rec.onChunk(concat(speechy(3000), silence(1500)));
  rec.stop();
  await settle(rec);

  const row = store.rows.get(started.recordingId!)!;
  assert.ok(row.endedIso, "la reunion est FERMEE : le sauvetage ne doit pas la prendre pour un plantage");
  assert.ok(row.doc.includes("[00:00:00] Bonjour."), "et son transcript est complet");
  assert.ok(!row.doc.includes("Interrupted recording"), "rien ne pretend qu'elle a ete interrompue");
  assert.ok(!row.doc.includes("## Notes"), "et rien ne pretend qu'elle a un resume");
  assert.equal(rec.isBusy, false, "le moteur n'est pas laisse occupe pour toujours");
});
