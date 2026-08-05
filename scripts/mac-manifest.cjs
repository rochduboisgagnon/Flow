#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE DOCUMENT QUE L'APPLICATION macOS INTERROGE POUR SE METTRE A JOUR.
//
// Sur Windows, electron-builder ecrit latest.yml et electron-updater le lit. Sur
// macOS, Squirrel.Mac est hors jeu (il exige une signature Developer ID que Roch a
// decide de ne pas acheter), donc Flow lit un document a nous : mac-arm64.json.
//
// POURQUOI PAS scripts/verify-native-deps.cjs, qui hache deja des fichiers : parce
// que le SENS DE LA FLECHE est inverse. La-bas on verifie que des octets RECUS
// sont ceux qu'on attendait, contre un manifeste COMMITTE, et son invariant le
// plus fort est « un asset absent du manifeste est un ECHEC ». Ici on DECLARE
// l'empreinte d'octets qu'on vient de fabriquer. Lui demander ce travail
// echouerait toujours, et pour le faire passer il faudrait committer l'empreinte
// d'un artefact qui n'existe pas encore.
//
// Deux differences techniques suivent de la : le hachage se fait EN FLUX (le zip
// pese de l'ordre de 200 Mo ; verify-native-deps fait un readFileSync entier), et
// ce script est appelable depuis un test Windows, ce qu'un pipeline shell n'est
// pas - or toute la suite de tests de ce depot tourne sur Windows.
//
// Usage :
//   node scripts/mac-manifest.cjs --zip <chemin> --tag vX.Y.Z --out <chemin.json>
//   node scripts/mac-manifest.cjs --verify <chemin.json> --zip <chemin>
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** Le nom du document. DOIT etre le meme que MAC_MANIFEST_NAME dans
 * src/main/update/macManifest.ts : c'est le seul point de couture entre la chaine
 * de publication et l'application, et un test le verifie des deux cotes.
 *
 * Ce n'est surtout PAS latest-mac.yml : ce nom EST le feed d'electron-updater, et
 * le publier inviterait la bibliotheque a le ramasser toute seule le jour ou
 * quelqu'un active autoUpdater sur darwin. Un second chemin de publication
 * apparaitrait sans que personne l'ait decide. */
const MAC_MANIFEST_NAME = "mac-arm64.json";

/** L'empreinte, EN FLUX. Synchrone dans sa forme (le CLI est synchrone) mais lue
 * par morceaux : charger 200 Mo d'un coup marche, et c'est un choix qu'on ne veut
 * pas heriter par accident. */
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Construit le manifeste depuis les OCTETS REELS du zip.
 *
 * Jamais precalcule, jamais committe : une reconstruction produit des octets qui
 * peuvent differer (horodatages internes), l'empreinte suit, et le couple reste
 * coherent. C'est ce qui rend un « Re-run failed jobs » correct.
 */
function buildManifest({ zip, tag, version, arch = "arm64", signature = "adhoc" }) {
  if (!fs.existsSync(zip)) throw new Error(`introuvable : ${zip}`);
  const name = path.basename(zip);

  // La garde de l'etape 2 de release.yml, rejouee A L'INTERIEUR du document. Un
  // manifeste mal etiquete est pire qu'un manifeste absent, parce qu'il est cru.
  if (tag !== `v${version}`) {
    throw new Error(`le tag ${tag} ne correspond pas a la version ${version} de package.json`);
  }
  if (!name.includes(`-${version}-`)) {
    throw new Error(`le zip ${name} ne parle pas de la version ${version}`);
  }
  if (!name.includes(`-${arch}.`)) {
    throw new Error(`le zip ${name} ne parle pas de l'architecture ${arch}`);
  }

  const bytes = fs.statSync(zip).size;
  if (bytes <= 0) throw new Error(`${name} est vide`);

  // Ordre des cles fixe : un diff lisible est une propriete, pas un hasard.
  return {
    schemaVersion: 1,
    version,
    arch,
    zip: name,
    sha256: sha256File(zip),
    bytes,
    signature,
  };
}

/** Relit le document ECRIT et re-hache le zip. Le manifeste doit s'accorder aux
 * octets APRES ecriture, pas seulement au moment du calcul : meme discipline
 * qu'une comparaison d'empreinte avant renommage. */
function verifyManifest(manifestPath, zip) {
  const doc = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const bytes = fs.statSync(zip).size;
  const sha = sha256File(zip);
  if (doc.zip !== path.basename(zip)) throw new Error(`le manifeste nomme ${doc.zip}, pas ${path.basename(zip)}`);
  if (doc.bytes !== bytes) throw new Error(`taille : manifeste ${doc.bytes}, fichier ${bytes}`);
  if (doc.sha256 !== sha) throw new Error(`empreinte : manifeste ${doc.sha256}, fichier ${sha}`);
  return doc;
}

module.exports = { MAC_MANIFEST_NAME, buildManifest, sha256File, verifyManifest };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const zip = arg("--zip");
    if (!zip) throw new Error("--zip est obligatoire");
    const verify = arg("--verify");
    if (verify) {
      const doc = verifyManifest(verify, zip);
      console.log(`OK : ${doc.zip} ${doc.bytes} octets ${doc.sha256}`);
      process.exit(0);
    }
    const tag = arg("--tag");
    const out = arg("--out");
    if (!tag || !out) throw new Error("--tag et --out sont obligatoires");
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
    const doc = buildManifest({ zip, tag, version });
    fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(doc, null, 2));
  } catch (err) {
    console.error(`mac-manifest: ${err.message}`);
    process.exit(1);
  }
}
