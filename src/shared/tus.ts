// ---------------------------------------------------------------------------
// B3c : LE PROTOCOLE TUS, sa part PURE.
//
// Un .wav d'une heure pese 115 Mo. Un `POST` unique de 115 Mo qui echoue a 90 %
// recommence a zero, et c'est exactement ce que le plan interdit : « une coupure
// reprend sans reexpedier ce qui a atterri ». Supabase Storage parle TUS 1.0.0
// sur /storage/v1/upload/resumable, ce qui donne cette reprise pour de vrai.
//
// LA BIBLIOTHEQUE CLIENTE N'EST PAS INSTALLEE, et ce n'est pas un oubli :
// `@supabase/storage-js` 2.95.0 n'expose aucun verbe reprenable, et le client
// TUS de reference (`tus-js-client`) est ecrit pour un navigateur - il veut un
// Blob, un File, un localStorage. Ici la source est un fichier sur le disque et
// le consommateur est le processus principal d'Electron. Trois requetes HTTP
// bien comprises coutent moins qu'une dependance qui ne parle pas la meme
// langue, et le contrat verifie contre la doc tient en dix lignes :
//
//   POST  /upload/resumable        -> 201 + Location (l'URL unique, a garder)
//   HEAD  <Location>               -> 200/204 + Upload-Offset (la verite)
//   PATCH <Location>               -> 204 + Upload-Offset (le nouvel offset)
//
// CE FICHIER NE FAIT AUCUNE REQUETE. Il encode, decode et decoupe. C'est ce qui
// permet de tester au caractere pres la seule partie du protocole ou une erreur
// est silencieuse : l'encodage des metadonnees.
// ---------------------------------------------------------------------------

/**
 * 6 Mo, et ce n'est pas un reglage.
 *
 * La doc Supabase l'ecrit en majuscules dans son propre exemple : « it must be
 * set to 6MB (for now) do not change it ». La raison est en dessous : chaque
 * tranche devient une partie de televersement multipart S3, et S3 refuse une
 * partie de moins de 5 Mo ailleurs qu'en derniere position. Une tranche plus
 * petite serait donc rejetee au milieu d'un fichier, et une tranche plus grosse
 * ne va pas plus vite.
 *
 * Consequence a garder en tete en lisant la boucle d'envoi : toutes les tranches
 * font exactement cette taille, SAUF la derniere, qui vaut le reste.
 */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

export const TUS_VERSION = "1.0.0";

/** Le type de contenu qu'un PATCH doit porter. Autre chose = 415, et le
 * televersement n'avance pas d'un octet. */
export const TUS_PATCH_CONTENT_TYPE = "application/offset+octet-stream";

/**
 * `Upload-Metadata`, encode comme la spec l'exige.
 *
 * « The key and value MUST be separated by a space [...] the value MUST be
 * Base64 encoded. » Base64 STANDARD, pas base64url : c'est le genre de detail
 * qui ne se voit pas a la lecture et qui fait echouer un objectName contenant un
 * tiret ou un souligne. Les cles, elles, restent en clair.
 *
 * Une valeur vide est OMISE plutot qu'envoyee vide : `bucketName` absent fait
 * lever `MetadataRequired` cote serveur, ce qui est un message clair, alors
 * qu'un `bucketName` vide fait chercher un seau nomme "" - et le message parle
 * alors d'un seau introuvable.
 */
export function encodeUploadMetadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k} ${Buffer.from(v, "utf8").toString("base64")}`)
    .join(",");
}

/**
 * `cacheControl` tel que Supabase le lit, et non tel qu'un en-tete HTTP
 * l'ecrirait.
 *
 * Le serveur teste `/^-?\d+$/` sur la valeur : un nombre devient
 * `max-age=<n>`, et TOUT LE RESTE tombe en `no-cache` sans le dire. Envoyer
 * « max-age=3600 » - la forme qui a l'air correcte - desactive donc le cache.
 * Cette fonction existe pour que ce piege soit ecrit une fois.
 */
export function cacheControlSeconds(seconds: number): string {
  return String(Math.max(0, Math.floor(seconds)));
}

/** Ce que la prochaine tranche doit couvrir, depuis l'offset que le SERVEUR a
 * confirme. Rend une longueur nulle quand tout est arrive. */
export function nextChunk(offset: number, total: number, chunkBytes = TUS_CHUNK_BYTES): { start: number; length: number; last: boolean } {
  const start = Math.max(0, Math.min(offset, total));
  const length = Math.max(0, Math.min(chunkBytes, total - start));
  return { start, length, last: start + length >= total };
}

/** Combien de requetes PATCH un fichier demande. Sert a l'affichage et aux
 * tests, jamais a piloter la boucle - c'est l'offset rendu par le serveur qui
 * la pilote. */
export function chunkCount(total: number, chunkBytes = TUS_CHUNK_BYTES): number {
  return total <= 0 ? 0 : Math.ceil(total / chunkBytes);
}

/** L'offset porte par une reponse, ou null quand l'en-tete manque ou n'est pas
 * un entier.
 *
 * NULL PLUTOT QUE ZERO, et c'est la distinction qui compte : un offset absent
 * veut dire « cette reponse ne dit pas ou on en est », et le traiter comme zero
 * ferait reexpedier 115 Mo. La spec impose l'en-tete sur chaque HEAD et chaque
 * PATCH reussi, donc son absence est une anomalie a signaler, pas un defaut a
 * combler. */
export function readUploadOffset(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get("upload-offset");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** L'instant d'expiration que le serveur annonce, ou "" s'il n'en annonce pas.
 *
 * L'extension `expiration` de TUS le met dans `Upload-Expires`, au format date
 * HTTP. Le lire vaut mieux que compter 24 h soi-meme : la plateforme hebergee
 * dit 24 h, mais la valeur est configurable par deploiement (TUS_URL_EXPIRY_MS),
 * et une arithmetique locale se tromperait en silence. */
export function readUploadExpires(headers: { get(name: string): string | null }): string {
  const raw = headers.get("upload-expires");
  if (!raw) return "";
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

/** Vrai quand l'URL d'un televersement est perdue et qu'il faut tout
 * recommencer : elle a expire, ou le serveur ne la connait plus. */
export function uploadIsGone(status: number): boolean {
  return status === 404 || status === 410 || status === 403;
}

/**
 * L'OBJET EST PLUS GROS QUE CE QUE LE PROJET ACCEPTE, ET C'EST DEFINITIF.
 *
 * ---------------------------------------------------------------------------
 * MESURE, PAS DEDUCTION (2026-08-04)
 * ---------------------------------------------------------------------------
 *
 * Trouve en LANCANT l'application : une reunion d'environ 55 minutes, 101 Mo de
 * .wav, a passe la nuit a se faire refuser. Le journal de Roch, sept fois de
 * suite avec un intervalle qui grandit :
 *
 *     [audio] l'audio n'a pas pu etre ouvert : le serveur a repondu 413
 *
 * Le plafond a ete SONDE contre le vrai projet, par des POST de creation qui
 * n'envoient aucun octet et ne changent que `Upload-Length` :
 *
 *     41 943 040 octets (40 Mio)  -> 201
 *     52 428 800 octets (50 Mio)  -> 201
 *     52 428 801 octets           -> 413 « Maximum size exceeded »
 *    106 283 608 octets (le wav)  -> 413 « Maximum size exceeded »
 *
 * Donc 50 Mio pile, et ce n'est pas le seau : la migration ne fixe aucun
 * `file_size_limit`, c'est le plafond du PROJET. A 32 Ko/s, un .wav de dictee
 * atteint 50 Mio en 27 minutes : au-dela, l'audio d'une reunion ne peut PAS
 * monter tant que ce plafond ne change pas.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CETTE FONCTION EXISTE AU LIEU D'UN SIMPLE `!ok`
 * ---------------------------------------------------------------------------
 *
 * Le reste des echecs de televersement sont TRANSITOIRES : hors ligne, jeton
 * expire, tranche perdue. La file les garde en tete et reessaie, ce qui est
 * exactement ce qu'il faut. Un 413 ne guerira jamais tout seul, et le traiter
 * comme les autres produit ce que le journal montre : une requete toutes les
 * soixante secondes, pour toujours, sur un fichier qui ne passera jamais.
 *
 * CE QUI N'EST PAS FAIT ICI, ET DELIBEREMENT : aucun plafond en dur. Le nombre
 * mesure ci-dessus est celui d'un projet a un instant donne - il monte a 50 Go
 * sur une offre payante. Une constante locale refuserait alors des fichiers que
 * le serveur accepte, c'est-a-dire mentirait dans l'autre sens. C'est le serveur
 * qui tranche, au prix d'une requete sans corps, et la seule chose gardee
 * localement est sa reponse.
 */
export function uploadTooLarge(status: number): boolean {
  return status === 413;
}

/** Le seau prive de la premiere migration. Ici, et non dans main/audioUpload.ts,
 * pour que le depot puisse le nommer sans dependre de la file de televersement :
 * la lecture et l'ecriture d'un objet audio sont deux modules differents, et le
 * nom du seau est la seule chose qu'ils doivent partager. */
export const AUDIO_BUCKET = "recordings";

/** Le chemin de l'objet audio d'une reunion dans le seau `recordings`.
 *
 * Le prefixe EST la frontiere : les politiques de la premiere migration
 * n'autorisent que `(storage.foldername(name))[1] = auth.uid()`. Une seule
 * fonction pour le fabriquer, parce que deux endroits qui le composent sont deux
 * chances d'ecrire un chemin que le RLS refuse - et le refus arriverait apres
 * une heure de reunion. */
export function audioObjectName(userId: string, recordingId: string): string {
  return `${userId}/${recordingId}.wav`;
}
