import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LlamaServer } from "../src/main/llm/llamaServer";

// ---------------------------------------------------------------------------
// D1 : le lanceur de llama-server.
//
// La piece que P9 n'avait pas livree : le fournisseur existait, rien ne lui
// fournissait de serveur, et la release 1.22.0 a tout de meme annonce que
// l'invariant « un ami qui installe Flow a le produit complet » etait ferme.
//
// Ces tests couvrent ce qu'un test PEUT couvrir. Le reste - est-ce qu'un vrai
// llama-server demarre et redige vraiment des notes - se verifie en le lancant,
// et c'est exactement l'erreur que la 1.22.0 a commise : une classe testee que
// rien n'appelait.
// ---------------------------------------------------------------------------

function tmpFile(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-llama-")), "x.bin");
  fs.writeFileSync(p, "x");
  return p;
}

test("D1: baseUrl est vide tant que rien de VERIFIE n'ecoute", () => {
  // Le fournisseur lit baseUrl() et ne fait rien quand elle est vide. C'est ce
  // qui fait qu'un modele absent produit « le transcript seul » plutot qu'une
  // erreur : le contrat que tous les appelants traitent deja.
  const s = new LlamaServer({ binPath: () => "C:/absent.exe", modelPath: () => "C:/absent.gguf" });
  assert.equal(s.baseUrl(), "");
});

test("D1: ready() est deux existsSync, jamais un lancement", () => {
  // La question est posee par des pages et par des sondes. Si elle lancait le
  // binaire, ouvrir un onglet couterait un chargement de 1,9 Go.
  const bin = tmpFile();
  const model = tmpFile();
  assert.equal(new LlamaServer({ binPath: () => bin, modelPath: () => model }).ready(), true);
  assert.equal(new LlamaServer({ binPath: () => bin, modelPath: () => "C:/absent" }).ready(), false);
  assert.equal(new LlamaServer({ binPath: () => "C:/absent", modelPath: () => model }).ready(), false);
});

test("D1: demarrer sans binaire ni modele echoue proprement, sans lancer quoi que ce soit", async () => {
  let spawned = false;
  const s = new LlamaServer({
    binPath: () => "C:/absent.exe",
    modelPath: () => "C:/absent.gguf",
    spawnProc: () => {
      spawned = true;
      throw new Error("ne doit jamais etre atteint");
    },
  });
  await assert.rejects(() => s.ensureStarted(), /not installed/);
  assert.equal(spawned, false, "un binaire absent ne doit pas mener a un spawn");
});

test("D1: stop() est sur, meme quand rien ne tourne", () => {
  // Appele depuis before-quit, qui est synchrone : une exception ici
  // empecherait l'application de se fermer.
  const s = new LlamaServer({ binPath: () => "C:/absent", modelPath: () => "C:/absent" });
  assert.doesNotThrow(() => s.stop());
  assert.doesNotThrow(() => s.stop());
});

test("D1: le port de llama ne peut pas entrer en collision avec celui de whisper", () => {
  // whisper prend 8178-8199, l'API locale 8176/8296/8396. Un chevauchement
  // ferait que les deux moteurs se disputent une plage, et le controle de
  // propriete du port refuserait alors l'un des deux - un echec qui ressemble a
  // une attaque alors que c'est Flow contre lui-meme. Deja vu une fois dans
  // cette campagne, sur les deux sidecars whisper.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "llm", "llamaServer.ts"), "utf8");
  const start = Number(/PORT_START = (\d+)/.exec(src)?.[1]);
  const end = Number(/PORT_END = (\d+)/.exec(src)?.[1]);
  const asr = fs.readFileSync(path.join(__dirname, "..", "src", "main", "asr", "sidecar.ts"), "utf8");
  const aStart = Number(/PORT_START = (\d+)/.exec(asr)?.[1]);
  const aEnd = Number(/PORT_END = (\d+)/.exec(asr)?.[1]);
  assert.ok(start > 0 && end > start, "la plage de llama doit etre lisible");
  assert.ok(start > aEnd || end < aStart, `llama ${start}-${end} chevauche whisper ${aStart}-${aEnd}`);
  for (const api of [8176, 8296, 8396]) {
    assert.ok(api < start || api > end, `le port ${api} de l'API locale tombe dans la plage de llama`);
  }
});

test("D1: le controle de propriete du port est REUTILISE, pas reecrit", () => {
  // Le scan de securite a trouve ce trou sur whisper (F4/F5), et le SECOND scan
  // a trouve que le premier correctif se contournait deux fois. Reecrire le
  // controle ici aurait garanti de reintroduire l'un des deux contournements.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "llm", "llamaServer.ts"), "utf8");
  assert.match(src, /import \{ socketOwnedBy \} from "\.\.\/asr\/portOwner"/);
  assert.ok(!/netstat/i.test(src), "aucune reimplementation du controle ici");
});

test("D1: le processus est tue en ARBRE, pas seulement lui-meme", () => {
  // child.kill() n'atteint pas les petits-enfants sur Windows. Sans taskkill /T,
  // un llama-server survit a la fermeture de Flow et garde la VRAM.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "llm", "llamaServer.ts"), "utf8");
  assert.match(src, /taskkill\.exe/);
  assert.match(src, /"\/T"/);
});

test("D1: l'enfant ne recoit aucun identifiant, sauf le sien", () => {
  // Meme discipline que le sidecar whisper et la sonde PowerShell : un binaire
  // qui resume du texte n'a aucun usage des cles de qui que ce soit. La seule
  // chose ajoutee est son propre laissez-passer, et il part par
  // l'ENVIRONNEMENT : une ligne de commande se lit depuis n'importe quel autre
  // processus, ce qui aurait rendu ce controle decoratif.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "llm", "llamaServer.ts"), "utf8");
  assert.match(src, /env: \{ \.\.\.childEnv\(\), LLAMA_API_KEY: this\.key \}/);
  assert.ok(!/"--api-key"/.test(src), "la clef ne doit jamais passer par la ligne de commande");
});

test("D1: le laissez-passer est tire au hasard et ne survit pas au processus", () => {
  // MESURE du 2026-08-03, et c'est elle qui justifie tout ce controle :
  // llama-server imprime lui-meme « CORS is set to allow all origins ('*') and
  // no API key is set », et sans clef une requete anonyme vers
  // /v1/chat/completions REUSSIT - depuis n'importe quel processus local, et
  // depuis n'importe quelle page web ouverte dans un navigateur. Avec la clef,
  // la meme requete recoit 401, et /health continue de repondre 200 (ce dernier
  // point compte : c'est /health que waitReady sonde).
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "llm", "llamaServer.ts"), "utf8");
  assert.match(src, /crypto\.randomBytes\(32\)/, "tiree au hasard, pas une constante");
  // Elle est effacee aux TROIS sorties : l'arret volontaire, l'arret dur, et la
  // mort du processus. En oublier une laisserait apiKey() rendre la clef d'un
  // serveur qui n'existe plus.
  assert.equal((src.match(/this\.key = "";/g) ?? []).length, 2, "hardStop et le handler d'exit");
  assert.ok(!/writeFileSync|appendFile/.test(src), "jamais ecrite sur le disque");

  // Et jamais rendue quand rien ne tourne : un fournisseur qui recevrait une
  // clef sans serveur enverrait un en-tete dans le vide.
  const s = new LlamaServer({ binPath: () => "C:/absent", modelPath: () => "C:/absent" });
  assert.equal(s.apiKey(), "");
});
