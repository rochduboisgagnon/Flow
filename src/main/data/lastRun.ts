import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 2026-08-04 : QUELLE VERSION A TOURNE ICI LA DERNIERE FOIS.
//
// Deux consommateurs, et c'est ce qui justifie qu'un fichier de plus existe :
//
//  1. Le journal de reprise de session. Quand le trousseau refuse la cle, la
//     ligne peut NOMMER la cause (« apres une mise a jour, 2.5.0 -> 2.6.0 »)
//     plutot que decrire le symptome. Sur macOS c'est l'explication complete :
//     safeStorage s'appuie sur un element du trousseau dont l'ACL s'exprime en
//     termes de la SIGNATURE de l'application, et la signature ad-hoc de Flow
//     change a chaque version.
//  2. Le message d'autorisation Accessibilite, qui peut alors etre affirmatif :
//     « vous venez de mettre a jour, c'est pour ca. » Une phrase qui affirme la
//     cause vaut trois phrases qui l'evoquent.
//
// EN CLAIR, delibere : ce fichier ne contient rien de secret - un numero de
// version et un horodatage. Le faire passer par safeStorage le rendrait illisible
// exactement dans le cas ou il sert, celui ou le trousseau refuse.
// ---------------------------------------------------------------------------

const FILE = "last-run.json";

export interface LastRun {
  version: string;
  atIso: string;
}

export interface LastRunDeps {
  dir(): string;
  log?(msg: string): void;
}

/** Ce que dit le fichier, ou null s'il n'y en a pas (premiere installation) ou
 * s'il est illisible. Jamais une exception : cette lecture est sur le chemin du
 * demarrage, et un fichier de diagnostic ne peut pas empecher un lancement. */
export function readLastRun(deps: LastRunDeps): LastRun | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(deps.dir(), FILE), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.version !== "string" || typeof o.atIso !== "string") return null;
    if (!o.version) return null;
    return { version: o.version, atIso: o.atIso };
  } catch {
    return null;
  }
}

/** Note que CETTE version a demarre. Ecriture atomique (tmp puis rename), meme
 * discipline que les autres magasins de ~/.flow : un lancement qui meurt au
 * milieu ne doit pas laisser un demi-fichier qui se lirait comme une version
 * inconnue. */
export function writeLastRun(deps: LastRunDeps, version: string): void {
  const dest = path.join(deps.dir(), FILE);
  const tmp = `${dest}.tmp`;
  try {
    fs.mkdirSync(deps.dir(), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ version, atIso: new Date().toISOString() }, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, dest);
  } catch (err) {
    // Un fichier de diagnostic qui ne s'ecrit pas est une gene, jamais un arret.
    deps.log?.(`[lastrun] impossible de noter la version de ce lancement : ${String(err)}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* rien a nettoyer */
    }
  }
}

/** « Ce lancement est-il le premier d'une NOUVELLE version ? », et laquelle
 * tournait avant. Pure : elle prend les deux versions plutot que de les lire, ce
 * qui permet de tester les trois cas (premiere installation, meme version, mise a
 * jour) sans toucher au disque. */
export function versionChanged(previous: LastRun | null, current: string): { changed: boolean; from: string } {
  // Pas de fichier = premiere installation. Ce n'est PAS une mise a jour, et le
  // confondre ferait dire « vous venez de mettre a jour » a quelqu'un qui vient
  // d'installer Flow pour la premiere fois.
  if (!previous) return { changed: false, from: "" };
  if (previous.version === current) return { changed: false, from: previous.version };
  return { changed: true, from: previous.version };
}
