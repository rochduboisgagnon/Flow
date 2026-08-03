import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// B4 : LA PORTE DU COMPTE.
//
// LE DEFAUT QU'ELLE FERME A ETE TROUVE EN LANCANT L'APPLICATION, et par aucun
// test. Apres B3, Flow demarrait, armait le raccourci, chauffait le moteur et
// ecoutait sur son API locale SANS que personne soit connecte - et laissait
// commencer une reunion dont la ligne n'avait aucun compte ou aller. Elle
// echouait a l'envoi, restait en tete de file, et mourait avec le processus. Une
// seule ligne de journal.
//
// Avant B3 ca ne coutait rien : tout allait sur le disque. C'est donc un defaut
// que la refonte a CREE, et que les quatre portes ne pouvaient pas voir.
//
// Ces tests lisent le SOURCE, comme test/quit-guard.test.ts et
// test/silent-failures-wiring.test.ts, parce qu'importer main/index.ts
// demanderait Electron. Ce qu'ils defendent n'est pas une phrase d'interface,
// c'est un ORDRE : le refus vient AVANT le demarrage, sur les deux chemins.
// ---------------------------------------------------------------------------

function src(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}

const INDEX = src("src", "main", "index.ts");
const APP = src("src", "renderer", "ui", "App.tsx");
const SIGNIN = src("src", "renderer", "ui", "SignIn.tsx");
const SETTINGS = src("src", "renderer", "ui", "pages", "Settings.tsx");

test("B4: le refus se decide sur isReady(), pas sur signedIn", () => {
  // Etre connecte ne suffit pas. La copie de travail peut avoir echoue a charger -
  // hors ligne au lancement - et une reunion demarree sur une copie non prete
  // ecrirait ses tranches dans une file qui ne sait pas encore a quel compte elle
  // appartient.
  const at = INDEX.indexOf("const refuseIfNoAccount = ()");
  assert.ok(at > 0, "refuseIfNoAccount doit exister");
  const body = INDEX.slice(at, INDEX.indexOf("\n    };", at));
  assert.match(body, /workingCopy\.isReady\(\)/, "c'est la copie de travail qui decide");
  // Et les deux cas sont distingues : « connectez-vous » et « ca charge » ne
  // veulent pas dire la meme chose, et confondre les deux ferait retaper un mot
  // de passe pour un probleme de reseau.
  assert.match(body, /accountSnapshot\.signedIn/, "les deux cas doivent etre distingues");
  assert.equal(body.split("return").length - 1, 2, "deux messages, un par cas");
});

test("B4: LES DEUX chemins de demarrage refusent, et AVANT d'appeler start()", () => {
  // Le chemin natif (le bouton de la page Record) et le chemin API (un appareil
  // qui pilote Flow). En couvrir un seul serait exactement la panne qu'on ferme :
  // un enregistrement qui commence sans nulle part ou aller.
  for (const [name, marker] of [
    ["native", "const started = longRec.start({ title: opts.title, keepAudio: !!opts.keepAudio, native: true })"],
    ["API", "longStart: (opts) => {"],
  ] as const) {
    const at = INDEX.indexOf(marker);
    assert.ok(at > 0, `le chemin ${name} a change de forme : verifier que le refus y est toujours`);
    // Le refus doit se trouver dans les quelques lignes QUI PRECEDENT l'appel.
    const before = INDEX.slice(Math.max(0, at - 400), at + 260);
    assert.match(before, /refuseIfNoAccount\(\)/, `le chemin ${name} doit refuser avant de demarrer`);
  }
  // Et il n'y a pas de troisieme chemin qui aurait ete oublie.
  assert.equal(INDEX.split("longRec.start(").length - 1, 2, "exactement deux facons de demarrer une reunion");
});

test("B4: la fenetre ne montre l'application QUE quand le compte est charge", () => {
  assert.match(APP, /!s\.accountDataReady \? \(/, "une porte, pas un onglet parmi d'autres");
  assert.match(APP, /<SignInScreen s=\{s\} \/>/);
  // Et l'ordre des trois etats : le moteur muet d'abord, le compte ensuite,
  // l'application en dernier. Inverse, un lancement afficherait l'application une
  // fraction de seconde avant de la retirer.
  const engine = APP.indexOf("s === null ?");
  const account = APP.indexOf("!s.accountDataReady ?");
  const app = APP.indexOf('section === "home"');
  assert.ok(engine > 0 && account > engine && app > account, "moteur, puis compte, puis application");
});

test("B4: UN SEUL formulaire de connexion dans toute l'application", () => {
  // Deux formulaires divergent, et un seul des deux se souviendrait dans six mois
  // que le mot de passe doit quitter le champ meme quand la connexion echoue.
  assert.equal(SIGNIN.split("window.flowui.signIn(").length - 1, 1, "un seul appel a signIn");
  assert.ok(!SETTINGS.includes("window.flowui.signIn("), "Reglages doit reutiliser SignInForm, pas le recopier");
  assert.match(SETTINGS, /<SignInForm \/>/);
});

test("B4: le mot de passe quitte le champ MEME quand la connexion echoue", () => {
  // Le `finally` est tout le sujet : c'est le cas d'echec qui tente de le garder
  // « pour reessayer », et un mot de passe qui reste dans un champ est un mot de
  // passe visible par-dessus l'epaule.
  const at = SIGNIN.indexOf("async function signIn(");
  const body = SIGNIN.slice(at, SIGNIN.indexOf("\n  }", at));
  const fin = body.indexOf("finally");
  assert.ok(fin > 0, "il doit y avoir un finally");
  assert.match(body.slice(fin), /setPassword\(""\)/, "et il doit vider le mot de passe");
});

test("B4: l'ecran distingue « pas connecte » de « connecte, ca charge »", () => {
  assert.match(SIGNIN, /const loading = s\.account\.signedIn && !s\.accountDataReady/);
  // Un compte connecte ne doit JAMAIS revoir le formulaire : ce serait lui
  // demander son mot de passe pour un probleme de reseau.
  const at = SIGNIN.indexOf("export function SignInScreen");
  const body = SIGNIN.slice(at);
  assert.match(body, /loading \? \(/, "les deux etats sont traites separement");
  const formAt = body.indexOf("<SignInForm />");
  const elseAt = body.lastIndexOf(") : (", formAt);
  assert.ok(elseAt > 0 && elseAt < formAt, "le formulaire est dans la branche NON-chargement");
});

test("B4: ce qui n'est pas monte est DIT, pas attendu", () => {
  // La troisieme des sept regressions par la porte de derriere : un compteur
  // affiche ne doit jamais devenir un compteur attendu.
  assert.match(INDEX, /unsent: workingCopy\.pending\(\) \+ audioUploads\.pending\(\)/);
  assert.match(SETTINGS, /s\.unsent > 0 \?/, "Reglages le montre quand il y a quelque chose a montrer");
  assert.ok(!/await .*\.pending\(\)/.test(INDEX), "et personne ne l'attend");
});
