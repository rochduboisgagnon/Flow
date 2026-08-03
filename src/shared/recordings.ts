// ---------------------------------------------------------------------------
// B3 : la forme applicative d'un enregistrement.
//
// UN SEUL type, partage par le moteur, le depot et les pages. La forme SQL ne
// remonte nulle part (les conversions vivent dans main/data/repo.ts, comme pour
// le dictionnaire et les statistiques).
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
  hasAudio: boolean;
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
