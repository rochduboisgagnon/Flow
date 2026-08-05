import fs from "node:fs";
import https from "node:https";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE TELECHARGEMENT QUI REND L'EMPREINTE DE CE QU'IL A ECRIT.
//
// Ce corps vient de `download()` dans asr/modelStore.ts, ou il vivait depuis F8.
// Il n'a pas ete copie : il a ete DEPLACE, et modelStore l'appelle desormais. Le
// canal de mise a jour macOS a exactement le meme besoin, et deux copies de la
// garde de troncature auraient fini par diverger - la premiere corrigee, l'autre
// pas, sur un chemin qui decide de remplacer un binaire.
//
// POURQUOI PAS ELARGIR redirectAllowed A LA PLACE : l'allowlist de modelStore
// nomme HuggingFace. Y ajouter GitHub pour arranger un appelant qui n'a rien a
// voir avec les modeles affaiblirait la garantie du chemin des modeles. Une
// allowlist est PAR USAGE, delibere - donc elle est un PARAMETRE ici, jamais une
// valeur devinee.
//
// CE QUE LE PARAMETRE `get` ACHETE : la garde de troncature et le hachage au fil
// de l'eau n'avaient aucun test unitaire, parce que les eprouver demandait un
// vrai serveur qui ment sur son content-length. C'est le vrai gain de
// l'extraction, pas la reutilisation.
// ---------------------------------------------------------------------------

export interface FetchOpts {
  url: string;
  dest: string;
  /** L'UNIQUE porte de sortie des redirections. PASSEE, jamais devinee ici. */
  redirectAllowed(rawUrl: string): boolean;
  onProgress?(pct: number): void;
  /** Couture d'injection pour les tests. Par defaut : https.get. */
  get?: typeof https.get;
  /** Ce que les messages d'erreur appellent la chose telechargee (« model »,
   * « macOS update »). Sans ca, un echec de mise a jour parlerait de modele. */
  what?: string;
}

const MAX_REDIRECTS = 5;

/**
 * Telecharge vers `dest` et rend le SHA-256 hexadecimal de ce qui a ete ECRIT.
 *
 * F8 : l'empreinte est calculee AU FIL DE L'ARRIVEE DES OCTETS plutot qu'en
 * relisant le fichier ensuite. Pas seulement pour eviter de lire un gigaoctet
 * deux fois : c'est l'empreinte de ce que cette fonction a REELLEMENT recu, ce
 * qu'une relecture ulterieure ne pourrait plus promettre.
 */
export function fetchToFile(opts: FetchOpts): Promise<string> {
  const what = opts.what ?? "download";
  const get = opts.get ?? https.get;

  const attempt = (url: string, redirects: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (redirects > MAX_REDIRECTS) return reject(new Error(`too many redirects downloading the ${what}`));
      get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // F8: a 302 used to be followed anywhere at all, http included.
          const next = new URL(res.headers.location, url).toString();
          if (!opts.redirectAllowed(next)) {
            // Le refus NOMME l'hote refuse. GitHub comme HuggingFace ont deja
            // change leur cible de redirection ; sans cette phrase, la panne se
            // presente comme « les mises a jour ne marchent plus » et il faut la
            // rechercher au lieu de la lire.
            return reject(new Error(`refusing a ${what} redirect off the pinned host: ${next}`));
          }
          return resolve(attempt(next, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${what} download failed: HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers["content-length"] ?? 0);
        let got = 0;
        const hash = crypto.createHash("sha256");
        const out = fs.createWriteStream(opts.dest);
        res.on("data", (c: Buffer) => {
          got += c.length;
          hash.update(c);
          if (total && opts.onProgress) opts.onProgress(Math.round((got / total) * 100));
        });
        res.pipe(out);
        out.on("finish", () =>
          out.close(() => {
            // R1: a cut connection can end the stream cleanly with a short file. If the
            // server told us the length, insist on getting all of it before we accept it.
            if (total > 0 && got !== total) {
              try {
                fs.unlinkSync(opts.dest);
              } catch {
                /* best effort */
              }
              return reject(new Error(`${what} download truncated: got ${got} of ${total} bytes`));
            }
            resolve(hash.digest("hex"));
          }),
        );
        out.on("error", (e) => {
          try {
            fs.unlinkSync(opts.dest);
          } catch {
            /* best effort */
          }
          reject(e);
        });
        res.on("error", reject);
      }).on("error", reject);
    });

  return attempt(opts.url, 0);
}
