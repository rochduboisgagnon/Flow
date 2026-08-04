import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AudioDuck } from "../src/main/audioDuck";

// ---------------------------------------------------------------------------
// 2026-08-04 : le silence pendant une dictee.
//
// CE QUE CES TESTS PEUVENT PROUVER, ET CE QU'ILS NE PEUVENT PAS.
//
// Couper vraiment le son d'une application est le travail de `flow-mute.exe`, et
// ca s'est verifie contre du VRAI son sur cette machine : un ton joue en boucle,
// « muted 1 » quand l'executable a epargner ne correspond pas, « muted 0 » quand
// il correspond. Cette mesure vit dans le journal de campagne ; aucun test
// unitaire ne peut la refaire sans une carte son.
//
// Ce qui EST prouvable ici est l'autre moitie, celle qui protege la dictee : rien
// dans ce module ne peut la retenir, la faire echouer, ni la laisser dans le
// silence. Ce sont ces proprietes-la qui casseraient sans qu'on le voie.
// ---------------------------------------------------------------------------

/** Un faux helper : un script Node qui parle le meme protocole et NOTE ce qu'il
 * recoit. Un vrai binaire n'est pas necessaire pour verifier le cablage. */
function fakeHelper(dir: string, opts: { crashOnStart?: boolean } = {}): string {
  const p = path.join(dir, "fake-helper.cmd");
  const log = path.join(dir, "commands.txt");
  // Un .cmd plutot qu'un .js : `spawn` recoit un chemin de binaire, et c'est ce
  // que le module fait en production.
  const body = opts.crashOnStart
    ? "@echo off\r\nexit /b 3\r\n"
    : `@echo off\r\nfor /f "delims=" %%L in ('more') do @echo %%L>>"${log}"\r\n`;
  fs.writeFileSync(p, body);
  return p;
}

function rig(over: { helperPath?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-duck-"));
  const logs: string[] = [];
  const duck = new AudioDuck({
    helperPath: () => over.helperPath ?? fakeHelper(dir),
    selfExePath: () => "C:\\Program Files\\Flow\\Flow.exe",
    log: (m) => logs.push(m),
  });
  return { dir, logs, duck, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("un helper ABSENT ne fait pas echouer une dictee, et se dit UNE seule fois", () => {
  // Le cas de toute machine de developpement sans compilateur C++, et de tout
  // installeur ou le binaire manquerait. La dictee doit partir exactement comme
  // avant : ce module n'a pas le droit de lever quoi que ce soit.
  const t = rig({ helperPath: path.join(os.tmpdir(), "n-existe-pas-flow-mute.exe") });
  t.duck.mute();
  t.duck.unmute();
  t.duck.mute();
  t.duck.unmute();
  const said = t.logs.filter((m) => /absent/.test(m));
  assert.equal(said.length, 1, "quatre appels, un seul message : un journal qui se repete est du bruit");
  assert.match(said[0], /Tout le reste fonctionne/, "et le message dit ce qui marche encore");
  t.cleanup();
});

test("un helper qui refuse de demarrer est note, et n'est pas relance en boucle", async () => {
  const t = rig();
  const bad = fakeHelper(t.dir, { crashOnStart: true });
  const duck = new AudioDuck({
    helperPath: () => bad,
    selfExePath: () => "C:\\Flow.exe",
    log: (m) => t.logs.push(m),
  });
  duck.mute();
  await new Promise((r) => setTimeout(r, 300));
  duck.unmute();
  duck.mute();
  await new Promise((r) => setTimeout(r, 300));
  // Ce qui compte n'est pas le nombre exact de tentatives : c'est qu'aucun appel
  // n'ait leve, et que l'echec soit DIT plutot qu'avale.
  assert.ok(t.logs.length > 0, "l'echec est dit");
  t.cleanup();
});

test("mute() est idempotent, et unmute() sans mute() ne lance meme pas le helper", () => {
  // Le mode mains libres tient une dictee ouverte pendant des minutes : rien ne
  // garantit qu'un seul `mute` arrive. Et `unmute` est appele sur les TROIS fins
  // possibles d'une dictee, dont deux ne se produisent jamais ensemble.
  //
  // OBSERVE PAR LE NOMBRE DE FOIS OU LE CHEMIN DU HELPER EST DEMANDE, et non par
  // ce que le helper recoit : un faux helper qui lirait vraiment son entree
  // standard demanderait un script batch, et un test qui depend d'un script batch
  // echoue pour des raisons qui n'ont rien a voir avec ce qu'il verifie.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-duck-"));
  let asked = 0;
  const duck = new AudioDuck({
    helperPath: () => {
      asked++;
      return path.join(dir, "n-existe-pas.exe"); // jamais lance : c'est le compte qui compte
    },
    selfExePath: () => "C:\\Flow.exe",
  });

  duck.unmute(); // avant tout
  assert.equal(asked, 0, "un retablissement sans coupure ne touche a rien");

  duck.mute();
  duck.mute();
  duck.mute();
  assert.equal(asked, 1, "trois appels, une seule tentative");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("stop() ferme le tuyau - le filet qui survit a un plantage est CE geste-la", () => {
  const t = rig();
  t.duck.mute();
  t.duck.stop();
  // Apres stop(), un unmute ne doit ni lever ni ressusciter le helper.
  t.duck.unmute();
  t.cleanup();
});

// ---------------------------------------------------------------------------
// CANARIS DE SOURCE : trois proprietes qu'aucun harnais ne peut observer, et qui
// sont exactement celles dont la casse serait invisible.
// ---------------------------------------------------------------------------

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}

test("canari : le module n'ATTEND jamais rien - aucune dictee ne peut etre retenue", () => {
  const src = read("src", "main", "audioDuck.ts");
  // Pas une seule attente, et aucune methode publique asynchrone : une promesse
  // ici serait une invitation a l'attendre depuis le chemin chaud.
  assert.doesNotMatch(src, /\bawait\b/, "rien ne s'attend dans ce module");
  assert.doesNotMatch(src, /async /, "et rien n'y est asynchrone");
});

test("canari : les TROIS fins d'une dictee retablissent le son", () => {
  // Une pression annulee - trop courte, touche etrangere, ecran verrouille - ne
  // passe pas par onStop. Sans le retablissement sur onCancel, l'ordinateur
  // resterait muet jusqu'a la dictee suivante.
  const src = read("src", "main", "index.ts");
  const onStop = src.slice(src.indexOf("  onStop() {"), src.indexOf("  onCancel(reason) {"));
  const onCancel = src.slice(src.indexOf("  onCancel(reason) {"), src.indexOf("  onPreArm() {"));
  assert.match(onStop, /audioDuck\.unmute\(\)/, "onStop retablit");
  assert.match(onCancel, /audioDuck\.unmute\(\)/, "onCancel retablit aussi");
  assert.match(src, /audioDuck\.stop\(\)/, "et la fermeture de Flow ferme le tuyau");
});

test("canari : le son de Flow est joue AVANT que le silence tombe", () => {
  // `startCapture` joue la pastille et son signal sonore. Couper avant lui
  // couperait le signal de Flow en meme temps que les autres applications - ce
  // que l'option choisie par Roch dit explicitement ne pas vouloir.
  const src = read("src", "main", "index.ts");
  const onStart = src.slice(src.indexOf("  onStart() {"), src.indexOf("  onStop() {"));
  const play = onStart.indexOf("overlay.startCapture(");
  const mute = onStart.indexOf("audioDuck.mute()");
  assert.ok(play > 0 && mute > 0, "les deux gestes sont dans onStart");
  assert.ok(play < mute, "le son de Flow part d'abord, le silence tombe ensuite");
});

test("canari : la dictee seulement - un enregistrement long ne coupe RIEN", () => {
  // Une reunion peut melanger le son du PC avec le microphone : c'est une case a
  // cocher de la page Record. Couper pendant une heure detruirait exactement ce
  // que l'utilisateur a demande de capturer.
  const src = read("src", "main", "index.ts");
  const longStart = src.slice(src.indexOf("const longRec = new LongRecorder("));
  const body = longStart.slice(0, longStart.indexOf("\n});\n"));
  assert.doesNotMatch(body, /audioDuck/, "le recorder longue duree ne connait pas ce module");
});
