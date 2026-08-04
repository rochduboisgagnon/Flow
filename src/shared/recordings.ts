// ---------------------------------------------------------------------------
// B3 : la forme applicative d'un enregistrement.
//
// UN SEUL type, partage par le moteur, le depot et les pages. La forme SQL ne
// remonte nulle part (les conversions vivent dans main/data/repo.ts, comme pour
// le dictionnaire et les statistiques).
//
// ---------------------------------------------------------------------------
// 2026-08-04 : L'AUDIO RESTE SUR LA MACHINE. SEUL LE DOCUMENT SE SYNCHRONISE.
// ---------------------------------------------------------------------------
//
// Decision de Roch, prise apres la mesure du 2026-08-04 : le projet Supabase
// refuse tout objet de plus de 50 Mio, donc l'audio d'une reunion de plus de
// 27 minutes ne pouvait pas monter. Trois chemins etaient possibles - payer,
// compresser en Opus, ou garder l'audio local. Il a choisi le troisieme.
//
// CE QUE CA CHANGE DANS CE FICHIER, ET DANS TOUT LE RESTE :
//
//  - `audioBytes > 0` veut dire « cette reunion a garde son audio ». C'est le
//    seul champ de la LIGNE qui parle encore de l'audio, et il est vrai sur
//    n'importe quelle machine.
//  - « l'audio est ici » n'est PAS un champ de la ligne : c'est un fait local,
//    constate en regardant le dossier (main/audioLocal.ts). Une colonne qui
//    aurait dit « la machine X l'a » aurait pu mentir - la machine X peut avoir
//    ete reinstallee - alors qu'un fichier qu'on vient de voir ne ment pas.
//  - `audioPath` (le nom de l'objet dans le seau) est desormais un champ de
//    TRANSITION. Il reste rempli sur les reunions faites par les versions 2.0.x,
//    le temps que le balayage de demarrage ramene leur audio et vide la colonne.
//    Une ligne neuve ne le remplit jamais.
//  - `audioUploaded`, `audioUploadUrl` et `audioUploadExpires` ne sont plus
//    ecrits par personne. Les colonnes SQL restent : les supprimer serait une
//    migration destructive pour zero gain, et elles disent encore quelque chose
//    de vrai sur les lignes d'avant.
//
// CE QUE CETTE DECISION COUTE, ECRIT ICI PLUTOT QUE DECOUVERT : une reunion
// enregistree sur l'ordinateur A n'est PAS ecoutable sur l'ordinateur B. Son
// transcript et ses notes, oui - c'est ce que « ne synchroniser que le
// document » veut dire.
// ---------------------------------------------------------------------------

/**
 * Une reunion, telle que Flow la manipule.
 *
 * DEUX CHAMPS MERITENT UNE EXPLICATION.
 *
 * `startedIso` est la chaine EXACTE que la page a declaree au demarrage. Elle
 * part vers deux colonnes : `started_at`, pour trier, et `notes_key`, pour
 * retrouver les notes prises pendant la reunion. Ce n'est pas une redondance :
 * les notes en direct sont filees sous cette chaine telle quelle, et un
 * aller-retour par timestamptz ne la reproduit pas forcement octet pour octet.
 *
 * `endedIso` vide veut dire « pas encore terminee ». C'est le seul etat qui
 * porte la promesse « un enregistrement interrompu est visible comme
 * interrompu » : une ligne ouverte que plus personne n'alimente est une reunion
 * que quelque chose a coupee.
 */
export interface RecordingRow {
  id: string;
  title: string;
  startedIso: string;
  durationMs: number;
  doc: string;
  /** Le chemin de l'objet dans le seau `recordings`, ou "" quand il n'y a pas
   * d'audio garde. Jamais une URL : une URL signee expire, un chemin non. */
  audioPath: string;
  /** Ce que pese le fichier en entier. */
  audioBytes: number;
  /** Ce qui est DEJA arrive dans Storage. Egal a `audioBytes` = televersement
   * fini ; inferieur = il reste des tranches a envoyer, et c'est ce nombre qui
   * dit ou reprendre. */
  audioUploaded: number;
  /** B3c : l'URL unique du televersement TUS en cours, ou "".
   *
   * Gardee parce qu'elle ne se RECONSTRUIT pas : le serveur y encode un
   * identifiant opaque. Sans elle, une fermeture au milieu d'un envoi de 115 Mo
   * ferait tout recommencer au lancement suivant. Voir la migration
   * 20260803230000. */
  audioUploadUrl: string;
  /** Quand cette URL cesse d'etre valable, tel que le SERVEUR l'annonce, ou "". */
  audioUploadExpires: string;
  /** Vrai tant que la destination n'a pas ete choisie par l'utilisateur. */
  staged: boolean;
  endedIso: string;
}

/** Ce que la page Notes affiche : tout sauf le document.
 *
 * Le document en est EXCLU volontairement. Une liste de deux mille reunions qui
 * transporterait chaque document ferait descendre des centaines de megaoctets
 * pour dessiner des titres. `docBytes` vient d'une colonne generee cote base
 * (octet_length(doc)), donc la taille est exacte sans que le texte voyage. */
export interface RecordingSummary {
  id: string;
  title: string;
  startedIso: string;
  durationMs: number;
  docBytes: number;
  audioBytes: number;
  audioUploaded: number;
  /** Cette reunion a-t-elle garde un audio ? Vrai sur n'importe quelle machine :
   * c'est un fait sur la reunion, pas sur ce disque-ci. */
  hasAudio: boolean;
  /** Le fichier est-il sur CETTE machine ? Constate en regardant le dossier au
   * moment de la liste, jamais lu dans une colonne - voir le bandeau du fichier.
   *
   * C'est ce qui separe « ecoutable ici » de « enregistre sur l'autre
   * ordinateur », et la page Notes ne peut pas dire l'un pour l'autre. */
  audioLocal: boolean;
  /** Reste-t-il un objet dans le seau ? Vrai seulement sur les reunions faites
   * par une version 2.0.x, jusqu'a ce que le balayage de demarrage ramene leur
   * audio. La page s'en sert pour pouvoir jouer l'audio pendant cette fenetre. */
  audioInAccount: boolean;
  staged: boolean;
  endedIso: string;
}

/**
 * Une ligne restee ouverte, telle que le sauvetage au demarrage la voit.
 *
 * LA LIGNE ENTIERE, et pas les quatre champs dont le sauvetage a besoin pour
 * ecrire son avertissement. La difference a compte tout de suite : une premiere
 * version ne portait que titre, depart, document et duree, et le sauvetage
 * reecrivait donc la ligne avec `audio_path` vide - il aurait efface l'audio
 * deja televerse d'une reunion coupee apres la fin de son envoi. Etendre le
 * type est ce qui rend cette classe d'oubli impossible plutot que rattrapee.
 *
 * `heartbeatIso` s'y ajoute parce que c'est lui qui DECIDE : trop recent =
 * quelqu'un enregistre en ce moment, sur cette machine ou sur l'autre.
 */
export interface OpenRecording extends RecordingRow {
  heartbeatIso: string;
}

/** Combien de temps une ligne ouverte peut rester sans pouls avant d'etre
 * declaree interrompue.
 *
 * Le raisonnement, parce que le chiffre seul ne dit rien : une tranche part
 * toutes les DOC_FLUSH_MS (20 s) tant qu'il y a du nouveau, et une reunion peut
 * legitimement passer une minute sans un mot - donc sans nouveau, donc sans
 * envoi. Deux minutes laissent passer ce silence sans jamais laisser une vraie
 * interruption dormir longtemps : au pire, la reunion coupee est signalee comme
 * interrompue deux minutes plus tard que la verite, ce qui n'a aucune
 * consequence puisque personne ne la regarde a cet instant.
 *
 * Ce qui SERAIT grave est l'inverse - declarer interrompue une reunion en cours
 * sur l'autre ordinateur - et c'est pour ca que la borne est genereuse. */
export const ABANDON_AFTER_MS = 120_000;

/** Vrai quand une ligne ouverte n'est plus alimentee par personne. Une fonction
 * plutot qu'une comparaison recopiee : le sauvetage l'applique, et le test
 * l'applique a la meme donnee. */
export function looksAbandoned(heartbeatIso: string, nowMs: number, afterMs = ABANDON_AFTER_MS): boolean {
  const beat = Date.parse(heartbeatIso);
  // Un pouls illisible est traite comme VIEUX : la ligne existe, elle est
  // ouverte, et refuser de la sauver parce qu'on ne sait pas la dater
  // reviendrait a perdre la reunion pour proteger une reunion imaginaire.
  if (Number.isNaN(beat)) return true;
  return nowMs - beat > afterMs;
}

/** Une reunion ouverte dans la page Notes : son texte, et de quoi le titrer.
 *
 * L'ancien `HistoryDocPayload` portait `date` - le nom du dossier date dans
 * lequel le document vivait. Il porte maintenant `startedIso`, qui est un FAIT
 * sur la reunion et non l'endroit ou elle etait rangee. La page formate la date
 * elle-meme, ce qui lui permet enfin d'afficher l'heure. */
export interface RecordingDocPayload {
  id: string;
  title: string;
  startedIso: string;
  text: string;
}

/** ~5 Mo : un transcript plus long est deja pathologique. La borne suit le
 * document depuis l'epoque du fichier (MAX_HISTORY_DOC_BYTES) et garde son
 * role - une page ne doit pas essayer d'afficher un document sans fin - mais
 * elle s'applique maintenant a la LECTURE d'une ligne, et le tampon en amont
 * (shared/captureDoc.ts) l'empeche deja d'etre atteinte par une vraie reunion. */
export const MAX_DOC_DISPLAY_BYTES = 5 * 1024 * 1024;

/** Le meme plafond que l'ancienne archive disque (MAX_HISTORY_ITEMS valait
 * 2000). Il n'a pas change de valeur en changeant de support : ce qu'il borne
 * est ce qu'une PAGE peut afficher, pas ce qu'un dossier peut contenir.
 *
 * Il vit ici et non dans le depot parce que la page Notes doit pouvoir DIRE que
 * la liste s'arrete la - une troncature silencieuse se lit comme « voila tout ce
 * que vous avez ».  */
export const MAX_RECORDINGS_LISTED = 2000;

/**
 * LE SEAU PRIVE, ET LE NOM D'UN OBJET DEDANS.
 *
 * 2026-08-04 : ces deux-la sont tout ce qui reste de shared/tus.ts, supprime avec
 * le televersement qu'il servait. Ils ne servent plus qu'a DEUX choses, et
 * aucune n'ecrit un nouvel objet :
 *
 *  - lire, puis lacher, l'objet d'une reunion faite par une version 2.0.x, le
 *    temps que le balayage de demarrage ramene son audio (main/audioLocal.ts) ;
 *  - prouver que le RLS du seau isole bien deux comptes (test/rls-isolation).
 *
 * Le prefixe EST la frontiere : les politiques de la premiere migration
 * n'autorisent que `(storage.foldername(name))[1] = auth.uid()`.
 */
export const AUDIO_BUCKET = "recordings";

export function audioObjectName(userId: string, recordingId: string): string {
  return `${userId}/${recordingId}.wav`;
}
