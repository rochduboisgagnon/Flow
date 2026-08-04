import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { capabilitiesFor, isReadOnlyPlatform, MISSING_ON_THIS_PLATFORM } from "../src/shared/platform";

// ---------------------------------------------------------------------------
// 2026-08-04 : la couture de plateforme, charpente du portage macOS.
//
// Roch veut Flow sur son MacBook, parce que la verification qui compte le plus du
// projet - la synchro entre deux ordinateurs - a besoin d'un second ordinateur, et
// que c'est celui-la.
//
// CE QUE CES TESTS DEFENDENT : qu'une capacite absente soit absente PARTOUT et
// DITE, jamais un controle qui a l'air vivant. C'est la regle que ce depot a
// appliquee en supprimant les pages « Coming soon » plutot qu'en les grisant, et en
// retirant le bouton de nettoyage a 90 jours qui ne nettoyait plus rien.
// ---------------------------------------------------------------------------

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
}

test("Windows a tout ; une plateforme inconnue n'a rien - et le defaut est FAUX", () => {
  const win = capabilitiesFor("win32");
  assert.deepEqual(win, {
    dictation: true,
    localEngines: true,
    systemAudio: true,
    muteOthers: true,
    focusProbe: true,
  });
  // Le defaut FAUX est deliberement l'inverse de la prudence habituelle : une
  // capacite qu'on croit presente et qui ne l'est pas produit une application qui
  // a l'air de fonctionner, ce qui est le mode de panne que ce depot chasse.
  for (const p of ["darwin", "linux", "aix", ""]) {
    const caps = capabilitiesFor(p);
    assert.deepEqual(Object.values(caps).filter(Boolean), [], `${p} ne doit rien affirmer`);
  }
});

test("chaque capacite a une phrase qui NOMME ce qui manque", () => {
  const keys = Object.keys(capabilitiesFor("win32")) as Array<keyof typeof MISSING_ON_THIS_PLATFORM>;
  for (const k of keys) {
    const said = MISSING_ON_THIS_PLATFORM[k];
    assert.ok(said && said.length > 20, `${k} doit avoir une phrase, pas un drapeau muet`);
    // Une phrase qui dit « pas encore » sans dire QUOI est un TODO deguise en
    // interface. Chacune doit nommer la plateforme ou la raison technique.
    assert.match(said, /Windows-only|macOS/, `${k} doit nommer la plateforme`);
  }
});

test("isReadOnlyPlatform : la machine qui ne sait que lire le compte", () => {
  assert.equal(isReadOnlyPlatform(capabilitiesFor("win32")), false);
  assert.equal(isReadOnlyPlatform(capabilitiesFor("darwin")), true);
  // Une machine avec un moteur mais sans crochet n'est PAS en lecture seule : elle
  // peut encore importer un fichier et le transcrire. La distinction compte pour la
  // phrase que Home affiche.
  assert.equal(isReadOnlyPlatform({ ...capabilitiesFor("darwin"), localEngines: true }), false);
});

// ---------------------------------------------------------------------------
// CANARIS DE SOURCE : la couture n'existe que si elle est CABLEE.
// ---------------------------------------------------------------------------

test("canari : la plateforme est lue UNE fois, et rien d'autre ne la redemande", () => {
  // Deux lectures de `process.platform` dans deux modules sont deux reponses qui
  // peuvent diverger. Le moteur en garde une seule, au chargement.
  const index = read("src", "main", "index.ts");
  assert.match(index, /const CAPS = capabilitiesFor\(process\.platform\)/, "lue une fois, ici");
  // Les modules qui ont un `process.platform` legitime le gardent (ils decident
  // d'un DETAIL d'implementation, pas d'une capacite) ; ce qui est interdit est
  // qu'un module de rendu en lise un.
  for (const rel of ["src/renderer/ui/pages/Home.tsx", "src/renderer/ui/Rail.tsx", "src/renderer/ui/App.tsx"]) {
    assert.doesNotMatch(read(rel), /process\.platform/, `${rel} recoit les capacites, il ne les devine pas`);
  }
});

test("canari : rien de specifique a Windows ne DEMARRE sur une autre plateforme", () => {
  const index = read("src", "main", "index.ts");
  // Le crochet clavier : sans garde, keyspy demanderait la permission
  // Accessibilite de macOS pour armer un raccourci dont rien ne peut honorer
  // l'avalement - donc une dictee qui laisse ses touches fuir dans le document.
  assert.match(index, /if \(CAPS\.dictation\) startPtt\(\)/, "le crochet est garde");
  // Le moteur de parole : sans garde, un lancement irait telecharger 550 Mo de
  // modele pour un binaire win32 qui n'existe pas.
  assert.match(index, /if \(!CAPS\.localEngines\) \{/, "le prechauffage du moteur est garde");
  // La sonde de fenetre : elle lance powershell.exe.
  assert.match(index, /if \(CAPS\.focusProbe\) probe = new FocusProbe\(/, "la sonde est gardee");
});

test("canari : la fenetre ne dit « Armed » que la ou c'est vrai", () => {
  const home = read("src", "renderer", "ui", "pages", "Home.tsx");
  assert.match(home, /caps\.dictation \?/, "la carte de dictee se branche sur la capacite");
  assert.match(home, /MISSING_ON_THIS_PLATFORM\.dictation/, "et elle nomme ce qui manque");
  // Le rail n'offre pas une section qui ne peut pas repondre.
  const rail = read("src", "renderer", "ui", "Rail.tsx");
  assert.match(rail, /canRecord \|\| id !== "record"/, "le rail filtre ce qui ne repond pas");
});
