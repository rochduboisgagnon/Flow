import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { MAC_MANIFEST_NAME, MAC_MANIFEST_URL, parseMacManifest } from "../src/main/update/macManifest";

const require_ = createRequire(import.meta.url);
const macManifest = require_("../scripts/mac-manifest.cjs") as {
  MAC_MANIFEST_NAME: string;
  buildManifest(o: { zip: string; tag: string; version: string; arch?: string; signature?: string }): Record<string, unknown>;
  sha256File(f: string): string;
  verifyManifest(m: string, zip: string): Record<string, unknown>;
};
const verifyNativeDeps = require_("../scripts/verify-native-deps.cjs") as { sha256(f: string): string };

// ---------------------------------------------------------------------------
// 2026-08-04 : LA CHAINE DE PUBLICATION macOS, GARDEE DEPUIS WINDOWS.
//
// Rien de ce que ce fichier decrit ne s'execute ici : ditto, codesign, shasum et
// gh tournent sur un runner macos-14. Ces tests sont donc des canaris textuels, du
// meme genre que test/diagnostics-wiring.test.ts, et ils defendent trois choses
// qu'aucune relecture ne rattrape de facon fiable :
//   - l'ORDRE (les portes avant la publication, le zip avant le manifeste),
//   - les NOMS (le document ne doit pas ressembler a un feed electron-updater),
//   - et le CONTRAT (le CI et l'application doivent epeler la meme URL).
// ---------------------------------------------------------------------------

const read = (...p: string[]): string =>
  fs.readFileSync(path.join(process.cwd(), ...p), "utf8").replace(/\r\n/g, "\n");

const RELEASE = read(".github", "workflows", "release.yml");
const MACBUILD = read(".github", "workflows", "mac-build.yml");

/** Le YAML sans ses lignes de commentaire (celles du workflow comme celles des
 * blocs `run:`, qui sont du shell : dans les deux cas un `#` en tete de ligne).
 *
 * Meme raison qu'ailleurs dans ce depot : ces canaris interdisent des tournures
 * precises (`gh release create`, `unzip`, `--publish always`), et la bonne
 * pratique est d'expliquer POURQUOI elles sont interdites - c'est-a-dire de les
 * ecrire dans un commentaire juste a cote. Un canari qu'une explication fait
 * echouer pousse a ne pas expliquer. */
function codeOnly(yml: string): string {
  const NL = String.fromCharCode(10);
  return yml
    .split(NL)
    .map((l) => (l.trimStart().startsWith("#") ? "" : l))
    .join(NL);
}

const RELEASE_CODE = codeOnly(RELEASE);
const MACBUILD_CODE = codeOnly(MACBUILD);

/** Le corps d'un job, sans son voisin. */
function jobBody(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `release.yml doit porter un job ${name}`);
  const after = yml.slice(start + 1);
  const next = after.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? after : after.slice(0, next + 1);
}

const MAC = jobBody(RELEASE, "mac");
const MAC_CODE = codeOnly(MAC);

test("MR-1: the mac job runs on arm64 and BEHIND the Windows publication", () => {
  // needs: release, donc le job Windows a deja cree la release et pose latest.yml.
  // Ce job n'AJOUTE que des assets : un seul geste expedie, et c'est le tag.
  assert.match(MAC, /needs: release/);
  assert.match(MAC, /runs-on: macos-14/);
});

test("MR-2: the mac job NEVER creates a release, and never touches a .yml feed", () => {
  // Le job Windows est le seul createur, et le seul proprietaire de latest.yml.
  // Un `create` ici serait un second chemin de publication ; un upload de .yml
  // ecraserait le feed que la machine Windows de Roch interroge.
  assert.doesNotMatch(MAC_CODE, /gh release create/);
  const uploads = [...MAC_CODE.matchAll(/gh release upload[^\n]*/g)].map((m) => m[0]);
  assert.equal(uploads.length, 3, `trois uploads attendus, vu : ${JSON.stringify(uploads)}`);
  for (const u of uploads) {
    assert.doesNotMatch(u, /\.ya?ml/, `un .yml est televerse : ${u}`);
    assert.doesNotMatch(u, /blockmap/, `un blockmap est televerse : ${u}`);
  }
});

test("MR-3: latest-mac.yml is actively DELETED before anything can pick it up", () => {
  // electron-builder l'ecrit des qu'un provider `publish` global existe. Ce nom
  // EST le feed d'electron-updater : le laisser trainer, c'est laisser un futur
  // glob le publier et une bibliotheque le ramasser toute seule.
  assert.match(MAC, /rm -f dist-build\/latest-mac\.yml/);
});

test("MR-4: the gates and the inspection come BEFORE the first upload", () => {
  const firstUpload = MAC.indexOf("gh release upload");
  assert.ok(firstUpload > 0);
  for (const before of ["npm test", "npm run lint", "npm run typecheck", "Inspect the artifact BEFORE publishing"]) {
    const at = MAC.indexOf(before);
    assert.ok(at > 0, `le job mac ne contient pas « ${before} »`);
    assert.ok(at < firstUpload, `« ${before} » se produit APRES la publication`);
  }
});

test("MR-5: the zip is never published without its fingerprint, and the manifest goes LAST", () => {
  // `gh` televerse les fichiers d'un meme appel en parallele : un appel unique
  // pourrait publier le manifeste avant la fin du zip, et un Mac lirait un
  // document qui pointe vers un asset absent. Le manifeste EST la publication.
  const manifestAt = MAC.indexOf("mac-manifest.cjs");
  const firstUpload = MAC.indexOf("gh release upload");
  assert.ok(manifestAt > 0 && manifestAt < firstUpload, "l'empreinte est calculee apres la publication");
  const zipUpload = MAC.indexOf("gh release upload \"$GITHUB_REF_NAME\" --clobber dist-build/Flow-*-mac-arm64.zip");
  const jsonUpload = MAC.indexOf("--clobber dist-build/mac-arm64.json");
  assert.ok(zipUpload > 0 && jsonUpload > 0);
  assert.ok(zipUpload < jsonUpload, "le manifeste est publie avant le zip qu'il nomme");
});

test("MR-6: the inspection extracts the way the APP will extract", () => {
  // unzip ne voit ni les liens symboliques ni les bits d'execution, donc un zip
  // casse passerait une inspection faite avec lui.
  assert.match(MAC, /ditto -x -k/);
  assert.doesNotMatch(MAC_CODE, /\bunzip\b/);
  // Et les quatre choses sans lesquelles le paquet est vivant mais inutile.
  assert.match(MAC, /whisper-server-darwin-arm64/);
  assert.match(MAC, /llama-server/);
  assert.match(MAC, /MacKeyServer/);
  assert.match(MAC, /mac-swap\.sh/, "le script d'echange n'est pas verifie dans le paquet");
});

test("MR-7: the grep trap that would fail the release when all is WELL stays banned", () => {
  // `grep -q ... && { exit 1; }` rend 1 quand la recherche ne trouve rien, donc
  // dans le cas sain, et sous `set -e` la release echouerait a chaque fois.
  assert.doesNotMatch(RELEASE, /grep -q[^\n]*&&\s*\{[^\n]*exit 1/);
});

test("MR-8: what was built is attested, and attested BEFORE it is uploaded", () => {
  // Sur mac la signature est ad-hoc, donc aucune autorite ne dit d'ou viennent ces
  // octets : l'attestation est la seule affirmation existante sur l'origine du
  // paquet. Et ce qui est signe doit etre ce qui vient d'etre inspecte.
  const attestAt = MAC.indexOf("attest-build-provenance");
  const firstUpload = MAC.indexOf("gh release upload");
  assert.ok(attestAt > 0, "le paquet mac n'est pas atteste");
  assert.ok(attestAt < firstUpload);
});

test("MR-9: no action is pinned by tag anywhere in release.yml", () => {
  // Ce depot epingle le SHA-256 de chaque binaire tiers qu'il livre. Une action
  // referencee par @v4 est un tiers mutable dont le code s'execute sur le runner
  // qui fabrique et signe les octets que Roch installe.
  assert.doesNotMatch(RELEASE_CODE, /uses: actions\/[a-z-]+@v\d/);
  // Et mac-build.yml aussi, meme s'il ne publie rien : c'est le banc ou les portes
  // de la release sont mises au point, et un banc qui n'execute pas le meme code
  // que la release n'est pas un banc.
  assert.doesNotMatch(MACBUILD_CODE, /uses: actions\/[a-z-]+@v\d/);
});

test("MR-10: mac-build.yml still publishes NOTHING", () => {
  // Il reste le banc d'essai avant de tagger. C'est desormais la seule chose qui
  // tient la regle « un seul chemin » fermee, maintenant que mac publie ailleurs.
  assert.doesNotMatch(MACBUILD_CODE, /gh release (create|upload)/);
  assert.doesNotMatch(MACBUILD_CODE, /--publish (always|onTag|onTagOrDraft)/);
  assert.match(MACBUILD_CODE, /--publish never/);
});

test("MR-11: the CI and the app spell the SAME document, at the same URL", () => {
  // Le seul point de couture entre la chaine de publication et l'application, donc
  // le seul qui merite un test dedie : une derive ici ne serait vue par aucun des
  // deux cotes pris separement.
  assert.equal(macManifest.MAC_MANIFEST_NAME, MAC_MANIFEST_NAME);
  assert.ok(MAC.includes(MAC_MANIFEST_NAME), `le job mac ne nomme pas ${MAC_MANIFEST_NAME}`);
  assert.ok(MAC.includes(`releases/latest/download/${MAC_MANIFEST_NAME}`));
  assert.ok(MAC_MANIFEST_URL.endsWith(`/releases/latest/download/${MAC_MANIFEST_NAME}`));
});

test("MR-12: the published document is not named like an updater feed", () => {
  assert.doesNotMatch(macManifest.MAC_MANIFEST_NAME, /^latest/);
  assert.doesNotMatch(macManifest.MAC_MANIFEST_NAME, /\.ya?ml$/);
});

// ---- le script lui-meme --------------------------------------------------

function fixtureZip(name = "Flow-9.9.9-mac-arm64.zip"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-manifest-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(4096));
  return p;
}

test("MR-13: the manifest is built from the REAL bytes, in the shape the app parses", () => {
  const zip = fixtureZip();
  const doc = macManifest.buildManifest({ zip, tag: "v9.9.9", version: "9.9.9" });
  assert.deepEqual(Object.keys(doc), ["schemaVersion", "version", "arch", "zip", "sha256", "bytes", "signature"]);
  assert.equal(doc.bytes, fs.statSync(zip).size);
  assert.match(String(doc.sha256), /^[0-9a-f]{64}$/);
  assert.equal(doc.signature, "adhoc");
  // Et le tour complet : ce que le CI ecrit, l'application le lit. Sans ce test,
  // les deux moities peuvent rester correctes chacune de son cote et ne pas se
  // parler. Le plancher de taille est le seul motif de refus attendu ici, la
  // fixture ne pesant que 4 Ko.
  const v = parseMacManifest(JSON.stringify(doc), "9.9.8");
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /taille annoncee invraisemblable/);
  const big = { ...doc, bytes: 150_000_000 };
  const v2 = parseMacManifest(JSON.stringify(big), "9.9.8");
  assert.equal(v2.ok, true, JSON.stringify(v2));
});

test("MR-14: a tag that contradicts package.json refuses to produce a manifest", () => {
  // La garde de l'etape 2 de release.yml, rejouee A L'INTERIEUR du document : un
  // manifeste mal etiquete est pire qu'un manifeste absent, parce qu'il est cru.
  const zip = fixtureZip();
  assert.throws(() => macManifest.buildManifest({ zip, tag: "v0.0.1", version: "9.9.9" }), /ne correspond pas/);
});

test("MR-15: a zip that does not name the version or the arch is refused", () => {
  assert.throws(
    () => macManifest.buildManifest({ zip: fixtureZip("Flow-1.0.0-mac-arm64.zip"), tag: "v9.9.9", version: "9.9.9" }),
    /ne parle pas de la version/,
  );
  assert.throws(
    () => macManifest.buildManifest({ zip: fixtureZip("Flow-9.9.9-mac-x64.zip"), tag: "v9.9.9", version: "9.9.9" }),
    /ne parle pas de l'architecture/,
  );
});

test("MR-16: --verify refuses bytes that changed after the manifest was written", () => {
  // Le manifeste doit s'accorder aux octets APRES ecriture, pas seulement au
  // moment du calcul : meme discipline qu'une comparaison d'empreinte avant
  // renommage.
  const zip = fixtureZip();
  const doc = macManifest.buildManifest({ zip, tag: "v9.9.9", version: "9.9.9" });
  const out = path.join(path.dirname(zip), "mac-arm64.json");
  fs.writeFileSync(out, JSON.stringify(doc, null, 2), "utf8");
  assert.doesNotThrow(() => macManifest.verifyManifest(out, zip));
  fs.appendFileSync(zip, "un octet de plus");
  assert.throws(() => macManifest.verifyManifest(out, zip), /taille|empreinte/);
});

test("MR-17: the two hashing implementations of this repo agree", () => {
  // Le prix paye pour en avoir deux (celle-ci en flux, celle de verify-native-deps
  // synchrone et en memoire) : un test qui les force a s'accorder sur un fichier
  // reel.
  const f = fixtureZip();
  assert.equal(macManifest.sha256File(f), verifyNativeDeps.sha256(f));
});
