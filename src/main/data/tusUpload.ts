import {
  TUS_PATCH_CONTENT_TYPE,
  TUS_VERSION,
  cacheControlSeconds,
  encodeUploadMetadata,
  readUploadExpires,
  readUploadOffset,
  uploadIsGone,
  uploadTooLarge,
} from "../../shared/tus";

// ---------------------------------------------------------------------------
// B3c : les trois requetes, et rien d'autre.
//
// Ce fichier fait des appels reseau et ne decide de rien : il ne choisit pas les
// tranches, ne reessaie pas, ne connait aucun fichier. C'est la file
// (main/audioUpload.ts) qui pilote ; celui-ci traduit une intention en HTTP et
// rend une reponse typee.
//
// ---------------------------------------------------------------------------
// LE JETON, ET POURQUOI IL NE PEUT PAS FUIR PAR ICI
// ---------------------------------------------------------------------------
//
// Ce module a besoin du jeton d'acces : le RLS de storage.objects est evalue a
// CHAQUE requete non-HEAD, donc chaque PATCH le porte. La sixieme des sept
// regressions du plan est precisement « fuite de jeton dans flow.log, /status ou
// selfCheck() », et elle est fermee ici par trois choses :
//
//  1. Le jeton arrive par une fonction, jamais par un champ. Rien ne le garde.
//  2. Il ne traverse jamais `log` : les messages de ce fichier ne contiennent
//     que des statuts et des offsets, et `err()` construit ses textes a partir du
//     code HTTP, jamais du corps de la reponse ni des en-tetes envoyes.
//  3. Un test lit ce fichier et refuse qu'un appel de journalisation mentionne
//     le jeton.
// ---------------------------------------------------------------------------

export interface TusDeps {
  /** L'URL du projet, sans barre finale. */
  projectUrl(): string;
  /** La clef publiable. Publique par conception (voir shared/supabaseConfig.ts),
   * mais requise par la passerelle. */
  anonKey(): string;
  /** Le jeton d'acces de la session, ou "" quand personne n'est connecte. */
  accessToken(): Promise<string>;
  /** Couture de test. */
  fetchImpl?: typeof fetch;
  log?(msg: string): void;
}

export interface TusCreated {
  ok: boolean;
  /** L'URL unique du televersement, a PERSISTER. Elle encode un identifiant
   * opaque : elle ne se reconstruit pas, elle se garde. */
  url: string;
  /** Quand elle cesse d'etre valable, ou "" si le serveur ne le dit pas. */
  expiresIso: string;
  /** 413 : le fichier depasse ce que le projet accepte. DEFINITIF - voir
   * shared/tus.ts, uploadTooLarge, et la mesure du plafond qui y est ecrite. */
  tooLarge: boolean;
  error: string;
}

export interface TusOffset {
  ok: boolean;
  offset: number;
  /** L'URL est perdue (expiree, inconnue) : il faut recommencer un POST. */
  gone: boolean;
  error: string;
}

export interface TusPatched {
  ok: boolean;
  /** L'offset que le SERVEUR confirme. Jamais un compteur local : c'est la seule
   * valeur qui dit ce qui a vraiment atterri. */
  offset: number;
  /** Le serveur declare l'objet complet (`Tus-Complete: 1`). */
  complete: boolean;
  /** 409 : soit l'offset ne correspond plus, soit deux clients se disputent la
   * meme URL. Dans les DEUX cas la reponse est la meme - refaire un HEAD - et
   * c'est pourquoi ce drapeau ne cherche pas a les distinguer. */
  conflict: boolean;
  gone: boolean;
  /** 413 sur une tranche. Le refus arrive normalement au POST, qui declare la
   * taille entiere ; ce drapeau existe pour que la file n'ait pas UNE porte
   * ouverte sur la boucle infinie qu'elle vient de fermer. */
  tooLarge: boolean;
  error: string;
}

export class TusUpload {
  private deps: TusDeps;

  constructor(deps: TusDeps) {
    this.deps = deps;
  }

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? globalThis.fetch;
  }

  private endpoint(): string {
    return this.deps.projectUrl().replace(/\/+$/, "") + "/storage/v1/upload/resumable";
  }

  /** Les en-tetes communs. `Tus-Resumable` sur chaque requete sauf OPTIONS :
   * une version absente ou differente rend 412 et rien n'avance. */
  private async authHeaders(): Promise<Record<string, string> | null> {
    const token = await this.deps.accessToken();
    if (!token) return null;
    return {
      authorization: `Bearer ${token}`,
      apikey: this.deps.anonKey(),
      "tus-resumable": TUS_VERSION,
    };
  }

  /** Un message d'erreur construit a partir du STATUT, jamais du corps.
   * Le corps d'une reponse Storage peut contenir le chemin de l'objet, donc
   * l'identifiant du compte ; il n'a rien a faire dans flow.log. */
  private static err(what: string, status: number): string {
    return `${what} : le serveur a repondu ${status}`;
  }

  /**
   * Ouvre un televersement et rend son URL unique.
   *
   * `x-upsert: true`, et c'est deliberement la chaine litterale que le serveur
   * teste (`req.headers['x-upsert'] === 'true'`). Sans elle, un chemin deja
   * occupe rend « Asset Already Exists » - ce qui arriverait des qu'un
   * televersement expire est repris par un POST neuf sur le meme objet.
   */
  async create(opts: {
    bucket: string;
    objectName: string;
    totalBytes: number;
    contentType?: string;
  }): Promise<TusCreated> {
    const headers = await this.authHeaders();
    if (!headers) return { ok: false, url: "", expiresIso: "", tooLarge: false, error: "personne n'est connecte" };
    try {
      const res = await this.fetch(this.endpoint(), {
        method: "POST",
        headers: {
          ...headers,
          "upload-length": String(opts.totalBytes),
          "upload-metadata": encodeUploadMetadata({
            bucketName: opts.bucket,
            objectName: opts.objectName,
            contentType: opts.contentType ?? "audio/wav",
            // Des CHIFFRES SEULEMENT. Voir cacheControlSeconds : « max-age=3600 »
            // - la forme qui a l'air juste - tombe en `no-cache` sans le dire.
            cacheControl: cacheControlSeconds(3600),
          }),
          "x-upsert": "true",
        },
      });
      if (res.status !== 201) {
        return {
          ok: false,
          url: "",
          expiresIso: "",
          // 413 : le fichier ne passera JAMAIS, et la file doit pouvoir le
          // distinguer d'une coupure reseau. Voir uploadTooLarge.
          tooLarge: uploadTooLarge(res.status),
          error: TusUpload.err("l'audio n'a pas pu etre ouvert", res.status),
        };
      }
      const url = res.headers.get("location") ?? "";
      if (!url) {
        // Un 201 sans Location est un serveur qui ne respecte pas la spec : il
        // n'y a rien a reprendre, et pretendre le contraire ferait boucler la
        // file sur une URL vide.
        return { ok: false, url: "", expiresIso: "", tooLarge: false, error: "le serveur n'a pas rendu d'adresse de televersement" };
      }
      return { ok: true, url: absolutize(url, this.endpoint()), expiresIso: readUploadExpires(res.headers), tooLarge: false, error: "" };
    } catch (e) {
      return { ok: false, url: "", expiresIso: "", tooLarge: false, error: reachError(e) };
    }
  }

  /**
   * Ou en est le serveur.
   *
   * LA SEULE SOURCE DE VERITE POUR REPRENDRE. Le nombre garde dans la ligne du
   * compte est un affichage : il peut etre en retard d'une tranche, ou en avance
   * si un PATCH a ete accepte et que la reponse n'est jamais revenue. Demander
   * coute une requete et evite d'envoyer 6 Mo au mauvais endroit.
   */
  async offset(url: string): Promise<TusOffset> {
    const headers = await this.authHeaders();
    try {
      const res = await this.fetch(url, {
        method: "HEAD",
        // L'autorisation n'est PAS requise sur un HEAD (le serveur retourne tot,
        // « Options and HEAD request don't need to be authorized » : l'URL opaque
        // fait office de capacite). On l'envoie quand meme - ca ne coute rien et
        // ca protege d'un changement de comportement.
        headers: { ...(headers ?? {}), "tus-resumable": TUS_VERSION },
      });
      if (uploadIsGone(res.status)) {
        return { ok: false, offset: 0, gone: true, error: "le televersement a expire" };
      }
      if (res.status !== 200 && res.status !== 204) {
        return { ok: false, offset: 0, gone: false, error: TusUpload.err("l'etat du televersement est illisible", res.status) };
      }
      const at = readUploadOffset(res.headers);
      if (at === null) {
        return { ok: false, offset: 0, gone: false, error: "le serveur n'a pas dit ou en etait le televersement" };
      }
      return { ok: true, offset: at, gone: false, error: "" };
    } catch (e) {
      return { ok: false, offset: 0, gone: false, error: reachError(e) };
    }
  }

  /** Envoie une tranche a l'offset donne. */
  async patch(url: string, offset: number, chunk: Uint8Array): Promise<TusPatched> {
    const headers = await this.authHeaders();
    if (!headers) return { ok: false, offset, complete: false, conflict: false, gone: false, tooLarge: false, error: "personne n'est connecte" };
    try {
      const res = await this.fetch(url, {
        method: "PATCH",
        headers: {
          ...headers,
          "upload-offset": String(offset),
          "content-type": TUS_PATCH_CONTENT_TYPE,
          "x-upsert": "true",
        },
        // Une COPIE de la tranche : le tampon de lecture est reutilise d'une
        // tranche a l'autre, et `fetch` peut lire le corps apres le retour.
        body: chunk.slice(),
      });
      if (res.status === 409) {
        return { ok: false, offset, complete: false, conflict: true, gone: false, tooLarge: false, error: "" };
      }
      if (uploadIsGone(res.status)) {
        return { ok: false, offset, complete: false, conflict: false, gone: true, tooLarge: false, error: "le televersement a expire" };
      }
      if (res.status !== 204) {
        return {
          ok: false,
          offset,
          complete: false,
          conflict: false,
          gone: false,
          tooLarge: uploadTooLarge(res.status),
          error: TusUpload.err("une tranche d'audio a ete refusee", res.status),
        };
      }
      const at = readUploadOffset(res.headers);
      if (at === null) {
        // La spec impose l'en-tete sur un PATCH reussi. Sans lui on ne sait pas
        // ou on en est : traiter ca comme un conflit force un HEAD, ce qui est
        // exactement la bonne reaction.
        return { ok: false, offset, complete: false, conflict: true, gone: false, tooLarge: false, error: "" };
      }
      return {
        ok: true,
        offset: at,
        complete: res.headers.get("tus-complete") === "1",
        conflict: false,
        gone: false,
        tooLarge: false,
        error: "",
      };
    } catch (e) {
      return { ok: false, offset, complete: false, conflict: false, gone: false, tooLarge: false, error: reachError(e) };
    }
  }
}

/** Le `Location` d'un 201 peut etre relatif. Le resoudre ici plutot que de
 * supposer : une URL relative gardee telle quelle serait inutilisable au
 * prochain lancement, quand plus rien ne se souvient de la base. */
function absolutize(location: string, base: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

/** Une panne reseau, dite sans citer l'exception. `fetch` met l'adresse
 * complete dans le message de certaines erreurs, et cette adresse porte
 * l'identifiant du compte (le chemin de l'objet est `<uid>/<id>.wav`). */
function reachError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  return name ? `le stockage est injoignable (${name})` : "le stockage est injoignable";
}
