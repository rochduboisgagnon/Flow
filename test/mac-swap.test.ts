import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleFromExe } from "../src/main/update/macZipChannel";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE SEUL GESTE IRREVERSIBLE DE FLOW, GARDE PAR DES CANARIS.
//
// Rien de ce fichier ne s'execute sur Windows : ditto, xattr, open, pgrep, et la
// survie d'un enfant detache a la mort de son parent sont tous macOS. Ces tests ne
// prouvent donc PAS que l'echange fonctionne - ils prouvent que le code est cable
// comme il doit l'etre, et ils interdisent les quelques formes precises qui
// laisseraient Roch sans application.
//
// C'est une distinction a garder honnete : la preuve, elle, se fait sur le Mac, et
// elle est listee dans le plan (cinq faits a relever et a reecrire en commentaires
// dates).
// ---------------------------------------------------------------------------

const read = (...p: string[]): string => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");

/** Le CODE seul, sans les commentaires.
 *
 * Ces canaris interdisent des tournures precises (`kill -9`, `rm -rf "$TARGET"`,
 * `execSync`, `app.exit`). Or la bonne pratique de ce depot est d'expliquer
 * POURQUOI une tournure est interdite, ce qui veut dire l'ecrire dans un
 * commentaire juste a cote. Un canari qu'une explication fait echouer est un
 * canari qui pousse a ne pas expliquer, donc les commentaires sont retires avant
 * d'asserter. Ils restent lus par les `match`, ou ils ne peuvent pas nuire. */
function codeOnly(src: string, kind: "sh" | "ts"): string {
  if (kind === "sh") {
    return src
      .split("\n")
      .map((l) => (l.trimStart().startsWith("#") ? "" : l))
      .join("\n");
  }
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SCRIPT = read("resources", "mac-swap.sh");
const SCRIPT_CODE = codeOnly(SCRIPT, "sh");
const CHANNEL = read("src", "main", "update", "macZipChannel.ts");
const CHANNEL_CODE = codeOnly(CHANNEL, "ts");
const INDEX = read("src", "main", "index.ts");
const INDEX_CODE = codeOnly(INDEX, "ts");
const BUILDER = read("electron-builder.json");

test("MS-1: the script waits for the process, and the wait is BOUNDED", () => {
  // kill -0 est le test honnete : il ne signale rien, il demande si le processus
  // existe. Et la boucle doit avoir un plafond - un `while true` ici laisserait un
  // zombie qui tient un bundle en otage indefiniment.
  assert.match(SCRIPT, /kill -0 "\$PID"/);
  assert.match(SCRIPT, /-gt 120/, "la boucle d'attente n'a pas de plafond");
  assert.doesNotMatch(SCRIPT_CODE, /while\s+true/, "boucle infinie dans le script d'echange");
});

test("MS-2: the script NEVER kills Flow", () => {
  // Une application qui refuse de se fermer est une application au milieu de
  // quelque chose : before-quit fait des sauvetages SYNCHRONES (rescueOnQuit d'un
  // enregistrement long, d'un import, le flush du journal). La tuer est
  // precisement la facon de perdre l'enregistrement d'une reunion, c'est-a-dire la
  // seule donnee de ce produit qui ne peut pas etre refaite.
  assert.doesNotMatch(SCRIPT_CODE, /kill -9/);
  assert.doesNotMatch(SCRIPT_CODE, /kill -KILL/);
  assert.doesNotMatch(SCRIPT_CODE, /pkill/);
});

test("MS-3: the old bundle is moved ASIDE, and there is a way back", () => {
  // Un `rm -rf "$TARGET" && mv` naif ouvre une fenetre pendant laquelle AUCUNE
  // application n'existe. Si le mv echoue (disque plein, permissions, volume
  // different), Roch n'a plus de Flow du tout.
  assert.match(SCRIPT, /mv "\$TARGET" "\$OLD"/, "l'ancien bundle n'est pas mis de cote");
  assert.match(SCRIPT, /mv "\$OLD" "\$TARGET"/, "aucun retour arriere si l'installation echoue");
  // Et l'etape destructive n'arrive qu'apres que le nouveau a pris sa place.
  const rmOld = SCRIPT_CODE.indexOf('rm -rf "$OLD"');
  const mvNew = SCRIPT_CODE.indexOf('mv "$NEW" "$TARGET"');
  assert.ok(mvNew > 0 && rmOld > mvNew, "l'ancien bundle est supprime avant que le nouveau soit en place");
  assert.doesNotMatch(SCRIPT_CODE, /rm -rf "\$TARGET"/, "suppression directe de l'application installee");
});

test("MS-4: quarantine removal can never abort the swap", () => {
  // Les octets ont deja ete verifies contre un SHA-256 publie, ce qui est un
  // controle plus fort que le verdict de Gatekeeper sur une signature ad-hoc.
  assert.match(SCRIPT, /xattr -dr com\.apple\.quarantine "\$NEW"[^\n]*\|\| true/);
});

test("MS-5: it relaunches, and never with -n", () => {
  // -n forcerait une NOUVELLE instance, donc deux Flow. Flow est un demon de
  // raccourci : une mise a jour qui laisse la machine sans push-to-talk jusqu'a la
  // prochaine ouverture de session est pire qu'une fenetre qui reapparait.
  assert.match(SCRIPT, /\nopen "\$TARGET"/);
  assert.doesNotMatch(SCRIPT_CODE, /open -n /);
});

test("MS-6: a swap that succeeded but did not relaunch is LOUD", () => {
  // Le pire resultat possible de tout ce chemin : le bundle est en place et rien
  // ne tourne. Personne ne lit un journal quand tout va bien, donc c'est ici que
  // la ligne doit crier.
  assert.match(SCRIPT, /pgrep -f/);
  assert.match(SCRIPT, /open -R "\$TARGET"/);
});

test("MS-7: the script writes to its OWN log, never to flow.log", () => {
  // flow.log passe par logQueue. Deux ecrivains sur un journal rotatif est
  // exactement la facon dont un journal se corrompt - et ce serait le journal
  // qu'on lit pour comprendre ce qui vient de se passer.
  assert.match(SCRIPT, /exec >>"\$LOG"/);
  assert.doesNotMatch(SCRIPT_CODE, /flow\.log/);
  assert.match(CHANNEL, /"swap\.log"/);
});

test("MS-8: the script IS in the bundle - without this, the whole feature is a no-op", () => {
  // La lecon de la 1.22.0 (une classe qui existait sans que rien ne l'instancie),
  // appliquee a un fichier de ressource. release.yml encode deja trois fois cette
  // meme regle pour les binaires.
  const cfg = JSON.parse(BUILDER) as { extraResources: Array<{ from: string; to: string }> };
  assert.ok(
    cfg.extraResources.some((r) => r.from === "resources/mac-swap.sh" && r.to === "mac-swap.sh"),
    "mac-swap.sh n'est pas dans extraResources : il ne sera pas dans le paquet",
  );
});

test("MS-9: the script is COPIED out of the bundle, with an explicit chmod", () => {
  // `sh` lit son script de facon incrementale : un script qui vit dans le bundle
  // qu'il est en train de supprimer peut se faire couper en deux au milieu. Et le
  // chmod explicite supprime la question de savoir si extraResources preserve le
  // bit d'execution, au lieu d'y repondre par esperance.
  assert.match(CHANNEL, /copyFileSync\(this\.deps\.swapScriptSource\(\)/);
  assert.match(CHANNEL, /chmodSync\(dst, 0o755\)/);
});

test("MS-10: the swap is armed BEFORE the app is asked to close", () => {
  // Un processus deja sorti ne peut plus rien lancer. Meme technique d'indices que
  // test/quit-guard.test.ts sur le bloc before-quit.
  const body = CHANNEL.slice(CHANNEL.indexOf("install(): void {"), CHANNEL.indexOf("sweep(): void {"));
  const spawnAt = body.indexOf("spawn(");
  const quitAt = body.indexOf("this.deps.quit()");
  assert.ok(spawnAt > 0, "install() ne lance aucun script");
  assert.ok(quitAt > 0, "install() ne demande jamais la fermeture");
  assert.ok(spawnAt < quitAt, "la fermeture est demandee AVANT que le script soit arme");
  // Detache, et sans aucun tuyau qui garde une poignee sur nous.
  assert.match(body, /detached: true/);
  assert.match(body, /stdio: "ignore"/);
});

test("MS-11: before-quit still contains no spawn, and will-quit carries the mac hook", () => {
  // La sequence de before-quit est synchrone et son ORDRE est documente ligne par
  // ligne. Y ajouter un lancement de processus serait un genre de chose nouveau au
  // milieu d'un enchainement dont chaque position a une raison.
  const before = INDEX.slice(INDEX.indexOf('app.on("before-quit"'), INDEX.indexOf('app.on("will-quit"'));
  assert.ok(before.length > 500, "le bloc before-quit n'a pas ete trouve");
  assert.doesNotMatch(codeOnly(before, "ts"), /spawn\(/, "un spawn est apparu dans before-quit");
  assert.match(INDEX, /app\.on\("will-quit", \(\) => \{[\s\S]*?macChannel\?\.hasStagedUpdate\(\)/);
});

test("MS-12: the mac channel is built with app.quit, never app.exit", () => {
  // app.exit sauterait before-quit et ses sauvetages synchrones.
  assert.match(INDEX, /quit: \(\) => app\.quit\(\)/);
  assert.doesNotMatch(INDEX_CODE, /app\.exit\(/, "app.exit court-circuiterait les sauvetages de before-quit");
});

test("MS-13: the fingerprint is checked BEFORE the file takes its name", () => {
  // La raison est deja ecrite dans modelStore.ts et s'applique mot pour mot :
  // verifier apres voudrait dire que les octets non verifies ont deja pris le nom
  // sous lequel ditto va les detendre.
  const shaAt = CHANNEL.indexOf("digest !== v.sha256");
  const renameAt = CHANNEL.indexOf("renameSync(part, zip)");
  assert.ok(shaAt > 0 && renameAt > 0);
  assert.ok(shaAt < renameAt, "le renommage a lieu avant la comparaison d'empreinte");
});

test("MS-14: ditto, never unzip, and never execSync", () => {
  // Un .app Electron contient des liens symboliques structurels et des bits
  // d'execution ; unzip les perd, et le bundle refuse alors de se lancer. Et
  // execSync gelerait le processus qui porte le crochet clavier pendant toute la
  // decompression de 200 Mo.
  assert.match(CHANNEL, /"\/usr\/bin\/ditto", \["-x", "-k"/);
  assert.doesNotMatch(CHANNEL_CODE, /\bunzip\b/);
  assert.doesNotMatch(CHANNEL_CODE, /execSync/);
});

test("MS-15: writability is checked BEFORE 200 MB are downloaded", () => {
  const accessAt = CHANNEL.indexOf("constants.W_OK");
  const fetchAt = CHANNEL.indexOf("await fetchToFile(");
  assert.ok(accessAt > 0, "le dossier parent n'est jamais teste en ecriture");
  assert.ok(accessAt < fetchAt, "on telecharge avant de savoir si on pourra ecrire");
});

test("MS-16: bundleFromExe walks up exactly three levels", () => {
  // Le seul morceau de ce fichier qui soit une vraie fonction plutot qu'un canari.
  assert.equal(bundleFromExe("/Applications/Flow.app/Contents/MacOS/Flow"), path.resolve("/Applications/Flow.app"));
  assert.equal(bundleFromExe("/Users/roch/Applications/Flow.app/Contents/MacOS/Flow"), path.resolve("/Users/roch/Applications/Flow.app"));
});

test("MS-17: a 404 on the manifest is 'nothing new', never an error", () => {
  // Le job macOS tourne APRES le job Windows sur le meme tag : entre les deux, la
  // release existe sans son manifeste mac. Un message rouge pendant quinze minutes
  // pour une condition normale que Roch ne peut pas corriger serait le contraire
  // d'un diagnostic utile.
  assert.match(CHANNEL, /HTTP 404/);
  const idx = CHANNEL.indexOf("HTTP 404");
  const around = CHANNEL.slice(idx, idx + 400);
  assert.match(around, /kind: "not-available"/, "un 404 remonte comme une erreur");
});
