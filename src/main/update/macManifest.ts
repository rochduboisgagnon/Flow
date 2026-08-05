import { isNewerVersion } from "../../shared/semver";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE SEUL DOCUMENT NON FIABLE DU CHEMIN DE MISE A JOUR macOS.
//
// ---------------------------------------------------------------------------
// POURQUOI UN MANIFESTE A NOUS, ET PAS latest-mac.yml
// ---------------------------------------------------------------------------
//
// electron-builder sait ecrire un latest-mac.yml, et il serait gratuit. C'est
// exactement pour ca qu'il ne faut pas le publier : ce nom EST le feed
// d'electron-updater. Le jour ou quelqu'un active `autoUpdater` sur darwin, la
// bibliotheque le ramasse toute seule et tente une installation Squirrel.Mac, qui
// echoue sur une signature ad-hoc. Un second chemin de publication apparaitrait
// sans que personne l'ait decide, par le seul fait qu'un fichier porte le nom que
// la bibliotheque cherche.
//
// Le document publie s'appelle donc mac-arm64.json, et son empreinte est un
// SHA-256 hexadecimal - le format que tout le reste du depot sait deja verifier
// (scripts/native-deps.json, MODEL_SHA256) et que `shasum -a 256` rend sur un Mac.
//
// ---------------------------------------------------------------------------
// LE MANIFESTE NOMME UN FICHIER, JAMAIS UN HOTE
// ---------------------------------------------------------------------------
//
// C'est la propriete la plus importante de ce fichier. Le document ne porte PAS
// d'URL : il porte un nom de fichier, et l'adresse est composee ici, a partir
// d'une constante. Un document compromis peut donc au pire nommer un asset
// inexistant de NOTRE page de release ; il ne peut pas deplacer le
// telechargement ailleurs. C'est la regle de MODEL_SHA256 retournee : un asset
// que ce code ne nomme pas ne peut pas etre recupere du tout.
//
// L'URL composee est epinglee AU TAG et non a « latest » : entre la lecture du
// manifeste et la fin du telechargement, une release plus recente peut apparaitre,
// et une URL « latest » livrerait alors des octets dont l'empreinte du manifeste ne
// parle pas. L'echec ressemblerait a une corruption.
// ---------------------------------------------------------------------------

const RELEASE_BASE = "https://github.com/rochduboisgagnon/Flow/releases/download";

/** Le nom du document, stable d'une version a l'autre : l'URL « latest » que
 * l'application interroge en depend. Il est aussi le contrat avec la chaine de
 * publication, qui doit ecrire exactement ce nom. */
export const MAC_MANIFEST_NAME = "mac-arm64.json";

/** L'adresse anonyme et sans tag que l'application interroge. Meme forme que
 * celle que release.yml verifie deja pour latest.yml en fin de course : pas de
 * jeton, pas de quota d'API, une redirection vers le stockage d'objets. */
export const MAC_MANIFEST_URL = `https://github.com/rochduboisgagnon/Flow/releases/latest/download/${MAC_MANIFEST_NAME}`;

const ZIP_NAME = /^Flow-\d+\.\d+\.\d+-mac-arm64\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Plancher de taille, pour qu'une reponse tronquee ou une page d'erreur soit
 * refusee avant meme d'etre hachee.
 *
 * 2026-08-05, MESURE et non estimation : le zip macOS arm64 de la 2.6.0 pese
 * 138 133 643 octets (run 31000665592 de mac-build.yml, etape « Inspect the
 * artifact the way the app will read it »). Le plancher est fixe a 64 Mio, soit un
 * peu sous la moitie : assez bas pour qu'une version qui maigrit ne se fasse pas
 * refuser, assez haut pour arreter une page d'erreur HTML ou un telechargement
 * coupe avant qu'on paie le hachage de 130 Mo. */
export const MIN_ZIP_BYTES = 64 * 1024 * 1024;

export type MacManifestVerdict =
  | { ok: true; version: string; zip: string; url: string; sha256: string; bytes: number; adhoc: boolean }
  | { ok: false; reason: string };

/** Compose l'adresse d'un asset. L'hote vient de la constante, et RIEN du
 * document ne peut le changer. */
export function buildAssetUrl(version: string, zip: string): string {
  return `${RELEASE_BASE}/v${version}/${zip}`;
}

/**
 * Lit le document publie et decide s'il y a quelque chose a telecharger.
 *
 * Tout refus est une VALEUR avec un motif lisible, jamais une exception : ce
 * texte finit dans flow.log, et « le manifeste a ete refuse parce que son
 * empreinte n'est pas 64 hexadecimaux » vaut mille fois « SyntaxError ».
 */
export function parseMacManifest(raw: string, currentVersion: string, arch = "arm64"): MacManifestVerdict {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "le manifeste macOS n'est pas du JSON" };
  }
  if (!doc || typeof doc !== "object") return { ok: false, reason: "le manifeste macOS n'est pas un objet" };
  const o = doc as Record<string, unknown>;

  // Une version de schema inconnue est un REFUS et non une tentative de deviner :
  // une application plus ancienne qui lirait un format qu'elle ne connait pas
  // choisirait au hasard quels champs croire.
  if (o.schemaVersion !== 1) return { ok: false, reason: `schema de manifeste inconnu : ${String(o.schemaVersion)}` };

  // L'architecture, avant tout le reste qui coute quelque chose. On ne publie que
  // arm64 ; sans ce controle un Mac Intel telechargerait 200 Mo pour se remplacer
  // par un binaire qu'il ne peut pas executer.
  if (o.arch !== arch) return { ok: false, reason: `paquet pour ${String(o.arch)}, cette machine est ${arch}` };

  const version = typeof o.version === "string" ? o.version : "";
  if (!version) return { ok: false, reason: "le manifeste macOS ne nomme aucune version" };
  if (!isNewerVersion(version, currentVersion)) {
    // Pas une erreur : c'est la reponse normale quatre fois par jour. Le motif
    // couvre aussi le refus de retrogradation et celui des preversions, qui sont
    // tous deux obtenus par isNewerVersion.
    return { ok: false, reason: `rien de plus recent (publie ${version}, installe ${currentVersion})` };
  }

  const zip = typeof o.zip === "string" ? o.zip : "";
  // La garde qui compte : un nom, pas un chemin, pas une URL. Elle refuse « / »,
  // « .. », « https://... » et tout ce qui n'est pas exactement le nom que
  // electron-builder produit.
  if (!ZIP_NAME.test(zip)) return { ok: false, reason: `nom d'archive refuse : ${JSON.stringify(zip)}` };
  // Et le nom doit parler de LA version annoncee, sinon le document se contredit.
  if (!zip.includes(`-${version}-`)) {
    return { ok: false, reason: `le manifeste annonce ${version} mais nomme ${zip}` };
  }

  const sha256 = typeof o.sha256 === "string" ? o.sha256.toLowerCase() : "";
  if (!SHA256.test(sha256)) return { ok: false, reason: "empreinte absente ou malformee (64 hexadecimaux attendus)" };

  const bytes = typeof o.bytes === "number" && Number.isSafeInteger(o.bytes) ? o.bytes : 0;
  if (bytes < MIN_ZIP_BYTES) return { ok: false, reason: `taille annoncee invraisemblable : ${bytes} octets` };

  return {
    ok: true,
    version,
    zip,
    url: buildAssetUrl(version, zip),
    sha256,
    bytes,
    // Ce que la signature vaut, dit par la chaine qui a construit le paquet.
    // Sert a AVERTIR : avec une signature ad-hoc, l'autorisation Accessibilite est
    // a redonner apres l'echange (voir shared/accessibility.ts).
    adhoc: o.signature === "adhoc",
  };
}

/**
 * L'allowlist d'hotes du telechargement macOS.
 *
 * 2026-08-04, MESURE et non deduction. Commande lancee depuis Windows :
 *   curl -sIL -D - -o /dev/null \
 *     "https://github.com/rochduboisgagnon/Flow/releases/latest/download/latest.yml" \
 *     | grep -i "^location:"
 * Resultat : DEUX sauts, github.com -> github.com (le tag resolu) ->
 * release-assets.githubusercontent.com. Noter que ce n'est PAS
 * objects.githubusercontent.com, l'hote historique cite un peu partout : GitHub a
 * change cette cible au moins deux fois, donc elle rechangera.
 *
 * C'est pour cela que le mode d'echec est une mise a jour REFUSEE ET JOURNALISEE
 * AVEC L'HOTE REFUSE, jamais un arret muet : la prochaine session saura exactement
 * quelle ligne ajouter, au lieu de chercher pourquoi les Mac ne se mettent plus a
 * jour.
 *
 * Regle par suffixe ANCREE SUR UN POINT, comme redirectAllowed dans
 * asr/modelStore.ts : sans le point, « github.com.evil.com » passerait.
 */
export function githubReleaseRedirectAllowed(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const allowed = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
  return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}
