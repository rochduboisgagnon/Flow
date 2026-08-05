import test from "node:test";
import assert from "node:assert/strict";
import { isNewerVersion } from "../src/shared/semver";
import {
  MAC_MANIFEST_NAME,
  MAC_MANIFEST_URL,
  MIN_ZIP_BYTES,
  buildAssetUrl,
  githubReleaseRedirectAllowed,
  parseMacManifest,
} from "../src/main/update/macManifest";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE SEUL DOCUMENT NON FIABLE DU CHEMIN DE MISE A JOUR macOS.
//
// Sur Windows, electron-updater lit latest.yml et fait ses propres controles. Sur
// macOS, Squirrel.Mac est hors jeu (il exige un Developer ID, que Roch a decide de
// ne pas acheter), donc c'est NOTRE code qui lit un document telecharge et decide
// d'echanger un bundle de 200 Mo sur cette base. C'est l'endroit du portage ou une
// erreur coute le plus cher, et c'est pour ca qu'il est pur et teste avant d'etre
// branche.
// ---------------------------------------------------------------------------

const OK = {
  schemaVersion: 1,
  version: "2.6.0",
  arch: "arm64",
  zip: "Flow-2.6.0-mac-arm64.zip",
  sha256: "a".repeat(64),
  bytes: 150_000_000,
  signature: "adhoc",
};

function verdict(over: Record<string, unknown> = {}, current = "2.5.0") {
  return parseMacManifest(JSON.stringify({ ...OK, ...over }), current);
}

// ---- semver ----

test("SV-1: strictly newer, and nothing else", () => {
  assert.equal(isNewerVersion("2.6.0", "2.5.0"), true);
  assert.equal(isNewerVersion("2.5.0", "2.5.0"), false, "l'egalite n'est pas une mise a jour");
  assert.equal(isNewerVersion("2.5.1", "2.5.0"), true);
  assert.equal(isNewerVersion("3.0.0", "2.99.99"), true);
});

test("SV-2: a downgrade is REFUSED, and that is a security property", () => {
  // « A downgrade is how an attacker who can publish gets a machine back onto a
  // version whose hole is already patched » - le commentaire existe deja dans
  // updater.ts pour allowDowngrade, et il vaut ici.
  assert.equal(isNewerVersion("2.4.0", "2.5.0"), false);
  assert.equal(isNewerVersion("1.0.0", "2.5.0"), false);
});

test("SV-3: the string-comparison trap, which would silently freeze updates at .10", () => {
  // « 2.10.0 » < « 2.9.0 » en comparaison de chaines. Rien ne signalerait l'erreur :
  // les Mac cesseraient simplement de se mettre a jour.
  assert.equal(isNewerVersion("2.10.0", "2.9.0"), true);
  assert.equal(isNewerVersion("2.9.0", "2.10.0"), false);
});

test("SV-4: a pre-release is refused BY CONSTRUCTION, not by a second rule", () => {
  assert.equal(isNewerVersion("2.6.0-beta.1", "2.5.0"), false);
  assert.equal(isNewerVersion("2.6.0+build7", "2.5.0"), false);
});

test("SV-5: anything that is not MAJOR.MINOR.PATCH means 'do not update'", () => {
  for (const bad of ["", "2.6", "v2.6.0", "2.6.0.1", "abc", " ", "2.-1.0"]) {
    assert.equal(isNewerVersion(bad, "2.5.0"), false, `accepte : ${JSON.stringify(bad)}`);
    assert.equal(isNewerVersion("2.6.0", bad), false, `accepte comme courante : ${JSON.stringify(bad)}`);
  }
});

// ---- le manifeste ----

test("MM-1: a well-formed manifest yields a URL this code composed itself", () => {
  const v = verdict();
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.version, "2.6.0");
  assert.equal(v.url, "https://github.com/rochduboisgagnon/Flow/releases/download/v2.6.0/Flow-2.6.0-mac-arm64.zip");
  assert.equal(v.adhoc, true);
});

test("MM-2: the document names a FILE, and can never move the download elsewhere", () => {
  // La propriete centrale. Chacune de ces valeurs est une tentative de faire
  // pointer le telechargement ailleurs, ou de sortir du dossier.
  for (const zip of [
    "https://evil.example/Flow-2.6.0-mac-arm64.zip",
    "//evil.example/Flow-2.6.0-mac-arm64.zip",
    "../../../etc/passwd",
    "sub/Flow-2.6.0-mac-arm64.zip",
    "Flow-2.6.0-mac-arm64.zip.exe",
    "Flow-2.6.0-mac-arm64.zip\n",
    "",
  ]) {
    const v = verdict({ zip });
    assert.equal(v.ok, false, `accepte : ${JSON.stringify(zip)}`);
    if (!v.ok) assert.match(v.reason, /nom d'archive refuse|manifeste annonce/);
  }
});

test("MM-3: the URL is pinned to the TAG, never to 'latest'", () => {
  // Entre la lecture du manifeste et la fin du telechargement, une release plus
  // recente peut apparaitre. Une URL « latest » livrerait alors des octets dont
  // l'empreinte du manifeste ne parle pas, et l'echec ressemblerait a une
  // corruption.
  const url = buildAssetUrl("2.6.0", "Flow-2.6.0-mac-arm64.zip");
  assert.match(url, /\/download\/v2\.6\.0\//);
  assert.doesNotMatch(url, /\/latest\//);
});

test("MM-4: a malformed fingerprint is a refusal, never a download 'we will check later'", () => {
  for (const sha256 of ["", "abc", "A".repeat(64) + "0", "g".repeat(64), "a".repeat(63)]) {
    const v = verdict({ sha256 });
    assert.equal(v.ok, false, `accepte : ${JSON.stringify(sha256)}`);
  }
  // Majuscules acceptees mais normalisees : une empreinte comparee a la casse
  // pres echouerait sur un manifeste parfaitement valide.
  const upper = verdict({ sha256: "A".repeat(64) });
  assert.equal(upper.ok, true);
  if (upper.ok) assert.equal(upper.sha256, "a".repeat(64));
});

test("MM-5: an implausible size is refused BEFORE 200 MB are fetched", () => {
  assert.equal(verdict({ bytes: 0 }).ok, false);
  assert.equal(verdict({ bytes: 1024 }).ok, false, "une page d'erreur HTML aurait passe");
  assert.equal(verdict({ bytes: MIN_ZIP_BYTES - 1 }).ok, false);
  assert.equal(verdict({ bytes: 1.5 }).ok, false);
  assert.equal(verdict({ bytes: "150000000" }).ok, false, "une taille en chaine n'est pas une taille");
});

test("MM-6: nothing newer is the NORMAL answer, four times a day", () => {
  const same = verdict({}, "2.6.0");
  assert.equal(same.ok, false);
  if (!same.ok) assert.match(same.reason, /rien de plus recent/);
  const older = verdict({ version: "2.4.0" }, "2.5.0");
  assert.equal(older.ok, false, "une retrogradation a ete acceptee");
});

test("MM-7: a package for another architecture is refused before anything is downloaded", () => {
  // Sans ce controle, un Mac Intel telecharge 200 Mo pour se remplacer par un
  // binaire qu'il ne peut pas executer.
  const v = parseMacManifest(JSON.stringify({ ...OK, arch: "arm64" }), "2.5.0", "x64");
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /arm64.*x64|x64/);
});

test("MM-8: an unknown schema version is refused rather than guessed at", () => {
  assert.equal(verdict({ schemaVersion: 2 }).ok, false);
  assert.equal(verdict({ schemaVersion: undefined }).ok, false);
});

test("MM-9: garbage in is a readable refusal, never an exception", () => {
  for (const raw of ["", "not json", "null", "[]", '"a string"', "123"]) {
    const v = parseMacManifest(raw, "2.5.0");
    assert.equal(v.ok, false, `accepte : ${JSON.stringify(raw)}`);
    if (!v.ok) assert.ok(v.reason.length > 10, `motif inutile : ${v.reason}`);
  }
});

test("MM-10: a manifest that contradicts itself is refused", () => {
  // Le nom de l'archive doit parler de la version annoncee. Sans ce controle, un
  // document pourrait annoncer 2.6.0 et faire telecharger l'archive de 2.5.0,
  // c'est-a-dire une retrogradation qui passe par la porte de derriere.
  const v = verdict({ version: "2.6.0", zip: "Flow-2.5.0-mac-arm64.zip" });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /annonce 2\.6\.0 mais nomme/);
});

// ---- l'allowlist d'hotes ----

test("MM-11: the redirect allowlist is anchored on a dot", () => {
  // Meme forme et meme piege que test/model-integrity.test.ts pour HuggingFace :
  // sans l'ancrage, « github.com.evil.com » est accepte.
  assert.equal(githubReleaseRedirectAllowed("https://github.com/x"), true);
  assert.equal(githubReleaseRedirectAllowed("https://release-assets.githubusercontent.com/x"), true);
  assert.equal(githubReleaseRedirectAllowed("https://github.com.evil.com/x"), false);
  assert.equal(githubReleaseRedirectAllowed("https://notgithubusercontent.com/x"), false);
  assert.equal(githubReleaseRedirectAllowed("https://evil.com/x"), false);
});

test("MM-12: never a downgrade to http, and never a malformed URL", () => {
  assert.equal(githubReleaseRedirectAllowed("http://github.com/x"), false);
  assert.equal(githubReleaseRedirectAllowed("ftp://github.com/x"), false);
  assert.equal(githubReleaseRedirectAllowed("pas une url"), false);
  assert.equal(githubReleaseRedirectAllowed(""), false);
});

test("MM-13: the host the app will actually be redirected to is on the list", () => {
  // Mesure du 2026-08-04 : deux sauts, et l'hote final est
  // release-assets.githubusercontent.com - PAS objects.githubusercontent.com, qui
  // est l'hote historique cite partout ailleurs. Les deux sont listes parce que
  // GitHub a deja change cette cible deux fois.
  assert.equal(githubReleaseRedirectAllowed(MAC_MANIFEST_URL), true);
  assert.equal(githubReleaseRedirectAllowed(buildAssetUrl("2.6.0", "Flow-2.6.0-mac-arm64.zip")), true);
});

test("MM-14: the published document is NOT named like an electron-updater feed", () => {
  // latest-mac.yml serait ramasse tout seul par la bibliotheque le jour ou
  // quelqu'un active autoUpdater sur darwin : un second chemin de publication
  // apparaitrait sans que personne l'ait decide.
  assert.equal(MAC_MANIFEST_NAME, "mac-arm64.json");
  assert.doesNotMatch(MAC_MANIFEST_NAME, /^latest/);
  assert.doesNotMatch(MAC_MANIFEST_NAME, /\.ya?ml$/);
  assert.ok(MAC_MANIFEST_URL.endsWith(`/releases/latest/download/${MAC_MANIFEST_NAME}`), MAC_MANIFEST_URL);
});
