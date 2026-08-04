import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// LA PORTE DU COMPTE.
//
// LE DEFAUT QU'ELLE FERME A ETE TROUVE EN INSTALLANT L'APPLICATION, deux fois,
// et par aucun test.
//
// Le 2026-08-03, apres B3 : Flow demarrait, armait le raccourci, chauffait le
// moteur et ecoutait sur son API locale SANS que personne soit connecte - et
// laissait commencer une reunion dont la ligne n'avait aucun compte ou aller.
// B4 a ferme DEUX chemins : le bouton d'enregistrement, et l'enregistrement
// pilote par l'API.
//
// Le 2026-08-04, Roch a installe la 2.0.0 et a trouve le troisieme en trente
// secondes : le raccourci de dictee fonctionnait sans compte. Le quatrieme
// (l'import d'un fichier audio) n'etait pas ferme non plus.
//
// UNE PORTE FERMEE SUR DEUX ENTREES D'UNE MAISON QUI EN A QUATRE N'EST PAS UNE
// PORTE A MOITIE FERMEE : C'EST UNE MAISON OUVERTE. Ce fichier enumere donc les
// quatre, nommement, plutot que de verifier « la porte existe ».
//
// Ces tests lisent le SOURCE, comme test/quit-guard.test.ts et
// test/silent-failures-wiring.test.ts, parce qu'importer main/index.ts
// demanderait Electron. Ce qu'ils defendent n'est pas une phrase d'interface,
// c'est un ORDRE : le refus vient AVANT que quoi que ce soit soit produit.
// ---------------------------------------------------------------------------

function src(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}

const INDEX = src("src", "main", "index.ts");
const APP = src("src", "renderer", "ui", "App.tsx");
const SIGNIN = src("src", "renderer", "ui", "SignIn.tsx");
const SETTINGS = src("src", "renderer", "ui", "pages", "Settings.tsx");

test("la porte se decide sur isReady(), pas sur signedIn", () => {
  // Etre connecte ne suffit pas. La copie de travail peut avoir echoue a charger -
  // hors ligne au lancement - et c'est ELLE qui porte le dictionnaire.
  const at = INDEX.indexOf("function refuseIfNoAccount(): string {");
  assert.ok(at > 0, "refuseIfNoAccount doit exister au niveau du module, pas enfermee dans un bloc");
  const body = INDEX.slice(at, INDEX.indexOf("\n}\n", at));
  assert.match(body, /workingCopy\.isReady\(\)/, "c'est la copie de travail qui decide");
  // Les deux cas sont distingues : « connectez-vous » et « ca charge » ne veulent
  // pas dire la meme chose, et les confondre ferait retaper un mot de passe pour
  // un probleme de reseau.
  assert.match(body, /accountSnapshot\.signedIn/, "les deux cas doivent etre distingues");
  assert.equal(body.split("return").length - 1, 2, "deux messages, un par cas");
});

test("LES QUATRE chemins qui produisent des donnees refusent sans compte", () => {
  const paths: Array<[string, string]> = [
    // La dictee au raccourci - celui que B4 avait oublie, et le pire des quatre :
    // le texte partait au curseur SANS que le dictionnaire s'applique, donc il
    // avait l'air juste. C'est la deuxieme des sept regressions du plan, sous sa
    // forme la plus vicieuse.
    ["le raccourci de dictee", "if (!workingCopy.isReady()) {"],
    // Le micro d'un telephone a travers l'API locale : meme moteur, meme
    // dictionnaire absent, meme texte faussement correct.
    ["la dictee par l'API locale", "transcribe: (wav) => {"],
    // Les deux enregistrements, fermes par B4.
    [
      "l'enregistrement natif",
      "const started = longRec.start({ title: opts.title, keepAudio: !!opts.keepAudio, native: true })",
    ],
    ["l'enregistrement par l'API", "longStart: (opts) => {"],
    // L'import d'un fichier : il produit une reunion exactement comme une capture,
    // et le refus doit arriver AVANT le decodage - le decouvrir apres vingt
    // minutes de transcription serait la meme faute, en plus long.
    ["l'import d'un fichier audio", "importStart: (req) => {"],
  ];
  for (const [name, marker] of paths) {
    const at = INDEX.indexOf(marker);
    assert.ok(at > 0, `le chemin « ${name} » a change de forme : verifier que le refus y est toujours`);
    const around = INDEX.slice(Math.max(0, at - 200), at + 700);
    assert.match(
      around,
      /refuseIfNoAccount\(\)|workingCopy\.isReady\(\)/,
      `« ${name} » doit refuser sans compte`,
    );
  }
  // Et il n'y a pas de cinquieme facon de demarrer une reunion.
  assert.equal(INDEX.split("longRec.start(").length - 1, 2, "exactement deux facons de demarrer une reunion");
  // Quatre appels au moins : les trois chemins qui rendent un refus, plus le
  // gardien du raccourci qui lit isReady() directement pour jouer son son de
  // refus avant de rendre la main.
  assert.ok(
    INDEX.split("refuseIfNoAccount()").length - 1 >= 4,
    "la fonction doit etre appelee par chaque chemin, pas recopiee",
  );
});

test("le refus de la dictee est RESSENTI, jamais silencieux", () => {
  // Quelqu'un qui appuie doit toujours sentir qu'il a appuye, y compris quand la
  // reponse est non. Meme chemin que le refus « une reunion tient le moteur » :
  // son, pastille, session demontee un instant plus tard.
  const at = INDEX.indexOf("if (!workingCopy.isReady()) {");
  assert.ok(at > 0, "la garde du raccourci doit exister");
  const body = INDEX.slice(at, at + 1400);
  assert.match(body, /overlay\.startAndRefuse\(/, "le meme refus ressenti que « une reunion tient le moteur »");
  assert.match(body, /hotpath\.abandon\(HOTPATH_ABANDON_REASON\.noAccount\)/, "et la trace se ferme honnetement");
  // Et la FENETRE se montre, ce qui est la vraie reponse. Roch, le 2026-08-04 :
  // « l'application ne peut pas fonctionner s'il n'y a aucun compte connecte ».
  // Si c'est vrai, un eclair de 260 ms est un mystere - la seule chose qui aide
  // est de montrer l'ecran qui explique ET qui repare.
  assert.match(body, /mainWindow\.show\(DEV\)/, "la fenetre doit se montrer, pas seulement clignoter");
  // Une fois par serie, jamais a chaque pression : dix pressions ne doivent pas
  // voler le focus dix fois a quelqu'un qui tape ailleurs.
  const raise = body.indexOf("mainWindow.show(DEV)");
  const guard = body.lastIndexOf("if (!noAccountSaid) {", raise);
  assert.ok(guard > 0 && guard < raise, "la fenetre se montre DANS la garde « une seule fois »");
  // La raison est NOMMEE dans le vocabulaire partage, pas une chaine libre : le
  // panneau Diagnostics compte les abandons par raison.
  assert.match(src("src", "shared", "hotpath.ts"), /noAccount: "no-account"/);
});

test("la raison du refus est dite UNE fois, pas a chaque pression", () => {
  // Quelqu'un qui appuie dix fois ne doit pas remplir son journal, mais il doit
  // pouvoir y trouver la raison. Et le drapeau doit se remettre a zero quand le
  // compte arrive, sinon la prochaine session hors compte serait muette.
  assert.match(INDEX, /let noAccountSaid = false;/);
  assert.match(INDEX, /if \(!noAccountSaid\) \{/);
  const load = INDEX.indexOf("async function loadAccountData()");
  const body = INDEX.slice(load, INDEX.indexOf("\n}\n", load));
  assert.match(body, /noAccountSaid = false/, "le compte charge : un futur refus devra se dire a nouveau");
});

// ---------------------------------------------------------------------------
// L'ECRAN : rien d'autre n'est atteignable
// ---------------------------------------------------------------------------

test("la fenetre ne montre RIEN d'autre que la connexion - pas meme le rail", () => {
  // La premiere version gardait le rail visible a cote du formulaire. Roch, en
  // installant la 2.0.0 : « on ne devrait meme pas voir les menus ». Un rail dont
  // AUCUNE section ne repond est un controle mort, et c'est la faute que cette
  // campagne a passe six vagues a retirer ailleurs.
  const gate = APP.indexOf("if (!s.accountDataReady) {");
  assert.ok(gate > 0, "la porte doit etre un retour anticipe, pas une branche dans le rendu principal");
  const body = APP.slice(gate, APP.indexOf("\n  }\n", gate));
  assert.match(body, /<SignInScreen s=\{s\} \/>/);
  assert.ok(!/<Rail/.test(body), "pas de rail derriere la porte");
  assert.ok(!/section ===/.test(body), "et aucune section atteignable");
  // La barre de titre RESTE : elle porte les boutons de fenetre de Windows, et
  // sans elle on ne pourrait pas fermer l'application.
  assert.match(body, /<Titlebar/, "la barre de titre reste, sinon la fenetre ne se ferme plus");
  // Et l'ordre des trois etats : le moteur muet d'abord, le compte ensuite,
  // l'application en dernier.
  const engine = APP.indexOf("if (s === null) {");
  const app = APP.indexOf('section === "home"');
  assert.ok(engine > 0 && gate > engine && app > gate, "moteur, puis compte, puis application");
});

test("UN SEUL formulaire de connexion dans toute l'application", () => {
  // Deux formulaires divergent, et un seul des deux se souviendrait dans six mois
  // que le mot de passe doit quitter le champ meme quand la connexion echoue.
  assert.equal(SIGNIN.split("window.flowui.signIn(").length - 1, 1, "un seul appel a signIn");
  assert.ok(!SETTINGS.includes("window.flowui.signIn("), "Reglages doit reutiliser SignInForm, pas le recopier");
  assert.match(SETTINGS, /<SignInForm \/>/);
});

test("le mot de passe quitte le champ MEME quand la connexion echoue", () => {
  // Le `finally` est tout le sujet : c'est le cas d'echec qui tente de le garder
  // « pour reessayer », et un mot de passe qui reste dans un champ est un mot de
  // passe visible par-dessus l'epaule.
  const at = SIGNIN.indexOf("async function signIn(");
  const body = SIGNIN.slice(at, SIGNIN.indexOf("\n  }", at));
  const fin = body.indexOf("finally");
  assert.ok(fin > 0, "il doit y avoir un finally");
  assert.match(body.slice(fin), /setPassword\(""\)/, "et il doit vider le mot de passe");
});

test("l'ecran distingue « pas connecte » de « connecte, ca charge »", () => {
  assert.match(SIGNIN, /const loading = s\.account\.signedIn && !s\.accountDataReady/);
  // Un compte connecte ne doit JAMAIS revoir le formulaire : ce serait lui
  // demander son mot de passe pour un probleme de reseau.
  const at = SIGNIN.indexOf("export function SignInScreen");
  const body = SIGNIN.slice(at);
  const formAt = body.indexOf("<SignInForm />");
  const elseAt = body.lastIndexOf(") : (", formAt);
  assert.ok(elseAt > 0 && elseAt < formAt, "le formulaire est dans la branche NON-chargement");
});

test("2026-08-04 : aucune phrase d'explication sous les champs ni sous Sign out", () => {
  // Roch, en installant la 2.0.0 : « rien d'ecrit, c'est un Sign Out normal, pas
  // besoin de plein d'informations ». Les paragraphes qui etaient la repondaient a
  // des questions que personne ne pose devant un formulaire de connexion.
  //
  // Les DECISIONS, elles, sont intactes : elles vivent dans les bandeaux des
  // fichiers, ou elles servent a celui qui modifie le code plutot qu'a celui qui
  // tape son mot de passe. Ce test porte sur ce que l'ECRAN dit.
  for (const label of ["Email", "Password"]) {
    const at = SIGNIN.indexOf(`<Row label="${label}"`);
    assert.ok(at > 0, `le champ ${label} doit exister`);
    assert.match(SIGNIN.slice(at, at + 60), /help=""/, `le champ ${label} ne porte aucune phrase`);
  }
  for (const label of ["Signed in as", "Sign out"]) {
    const at = SETTINGS.indexOf(`<Row label="${label}"`);
    assert.ok(at > 0, `la ligne ${label} doit exister`);
    assert.match(SETTINGS.slice(at, at + 60), /help=""/, `la ligne ${label} ne porte aucune phrase`);
  }
});

test("ce qui n'est pas monte est DIT, pas attendu", () => {
  // La troisieme des sept regressions par la porte de derriere : un compteur
  // affiche ne doit jamais devenir un compteur attendu.
  assert.match(INDEX, /unsent: workingCopy\.pending\(\) \+ audioUploads\.pending\(\)/);
  assert.match(SETTINGS, /s\.unsent > 0 \?/, "Reglages le montre quand il y a quelque chose a montrer");
  assert.ok(!/await .*\.pending\(\)/.test(INDEX), "et personne ne l'attend");
});
