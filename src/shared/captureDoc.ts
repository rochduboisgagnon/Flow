import { spliceNotes } from "./longform";

// ---------------------------------------------------------------------------
// B3a : LE DOCUMENT D'UNE REUNION, EN MEMOIRE.
//
// Avant cette vague, longform.ts ecrivait le .md au fil de l'eau : un
// `appendFileSync` par ligne de transcript, par marque, par trou de capture, et
// deux reecritures completes du fichier pour y inserer les notes. Dix-huit sites
// d'ecriture disque pour UN document.
//
// Ici il n'y a plus de fichier. Le document est un tableau de morceaux de
// chaine, et ce fichier ne connait ni `fs` ni le reseau - il ne sait rien
// d'autre qu'assembler du texte. C'est ce qui le rend testable au caractere
// pres, et c'est aussi ce qui garantit qu'aucune ligne de transcript ne peut
// plus attendre un disque.
//
// ---------------------------------------------------------------------------
// LA QUESTION QU'IL FALLAIT MESURER : EST-CE QUE CA TIENT EN RAM ?
// ---------------------------------------------------------------------------
//
// « Une heure de reunion en memoire » est le genre d'affirmation qui se deduit
// mal. Mesure faite (test/capture-doc.test.ts, qui refait le calcul a chaque
// passage plutot que de citer ce commentaire) :
//
//   - la parole tourne autour de 150 mots/minute ;
//   - un segment fait ~7 s, donc 514 segments par heure, ~18 mots chacun ;
//   - transcriptLine ajoute « [hh:mm:ss] » et deux sauts de ligne par segment ;
//   - avec des mots de DOUZE caracteres, deux fois la moyenne du francais pour
//     que la mesure soit pessimiste : 126 519 octets, soit 124 Ko par heure.
//
// Une reunion de trois heures reste donc sous 400 Ko, et le chiffre reel sera
// plus bas. Le tampon n'est pas un risque memoire : il est plus petit qu'une
// seule image de l'interface.
//
// CE QUI EST QUAND MEME BORNE, et pourquoi. MAX_DOC_BYTES existe pour le cas
// pathologique - un modele ASR qui boucle sur la meme phrase, une capture
// laissee tourner une nuit entiere. Depasser la borne n'efface RIEN et ne casse
// rien : le tampon arrete d'accepter des ajouts et le dit dans le document,
// pour que personne ne decouvre la troncature en comparant deux fichiers.
// ---------------------------------------------------------------------------

/** ~8 Mo, soit une centaine d'heures de parole au debit mesure ci-dessus. Une
 * borne qu'une reunion reelle ne touche jamais, placee la ou une boucle
 * pathologique se cognerait dessus avant d'inquieter la memoire du processus. */
export const MAX_DOC_BYTES = 8 * 1024 * 1024;

export const TRUNCATED_NOTE =
  "> [This document reached Flow's size limit and stops here. Everything above it is complete.]\n\n";

/**
 * Le document d'une capture, en cours d'ecriture.
 *
 * TOUTES les mutations sont synchrones, comme les lectures de la copie de
 * travail et pour la meme raison : `onChunk` et `pump` s'executent pendant la
 * capture, et rien sur ce chemin ne doit pouvoir attendre quoi que ce soit.
 * L'envoi vers le compte est decide AILLEURS (longform.ts), en regardant
 * `version()`.
 */
export class CaptureDoc {
  private header: string;
  private parts: string[];
  private size: number;
  /** Compteur de mutations. C'est lui, et non une comparaison de chaines, qui
   * dit a l'envoi « il y a du nouveau » : comparer deux fois 200 Ko de texte a
   * chaque tour d'horloge pour decouvrir qu'il n'a pas bouge serait payer le
   * prix du document entier pour repondre a une question binaire. */
  private rev = 1;
  private truncated = false;
  /** Le texte assemble, mis en cache jusqu'a la prochaine mutation. `text()`
   * est appele a chaque envoi de tranche ET par le sondage de la page ; sans
   * ca, une reunion d'une heure recolle 200 Ko de morceaux plusieurs fois par
   * seconde. */
  private joined: { rev: number; value: string } | null = null;

  constructor(header: string) {
    this.header = header;
    this.parts = [];
    this.size = Buffer.byteLength(header, "utf8");
  }

  /** Ajoute a la fin. Rend faux quand la borne a ete atteinte et que l'ajout a
   * ete refuse - l'appelant peut le journaliser, mais n'a rien a reparer. */
  append(s: string): boolean {
    if (!s) return true;
    if (this.truncated) return false;
    const n = Buffer.byteLength(s, "utf8");
    if (this.size + n > MAX_DOC_BYTES) {
      this.truncated = true;
      this.parts.push(TRUNCATED_NOTE);
      this.size += Buffer.byteLength(TRUNCATED_NOTE, "utf8");
      this.rev++;
      this.joined = null;
      return false;
    }
    this.parts.push(s);
    this.size += n;
    this.rev++;
    this.joined = null;
    return true;
  }

  /** Le document tel qu'il serait ecrit dans un fichier. */
  text(): string {
    if (this.joined?.rev === this.rev) return this.joined.value;
    const value = this.header + this.parts.join("");
    this.joined = { rev: this.rev, value };
    return value;
  }

  /** L'entete seule, telle qu'elle a ete posee au depart. `spliceNotes` en a
   * besoin pour savoir ou commence le corps. */
  headerText(): string {
    return this.header;
  }

  byteLength(): number {
    return this.size;
  }

  version(): number {
    return this.rev;
  }

  didTruncate(): boolean {
    return this.truncated;
  }

  /**
   * Insere le bloc « ## Notes » et REMPLACE tout le contenu par le resultat.
   *
   * C'est la seule mutation qui ne fait pas que grandir, et elle passe par la
   * MEME fonction `spliceNotes` que la version disque utilisait : il n'y a
   * qu'une forme de document, pas une pour le tampon et une pour les fichiers
   * existants. Le prix : le tampon perd sa structure en morceaux et redevient
   * une seule chaine. Ca n'arrive qu'une fois, a la fin.
   */
  spliceNotesBlock(notes: string): void {
    const next = spliceNotes(this.text(), this.header, notes);
    this.parts = [next.startsWith(this.header) ? next.slice(this.header.length) : next];
    if (!next.startsWith(this.header)) this.header = "";
    this.size = Buffer.byteLength(next, "utf8");
    this.rev++;
    this.joined = null;
  }

  /**
   * Insere un texte JUSTE APRES l'entete, au-dessus du corps.
   *
   * L'equivalent en memoire de `noteInterruption`, et il porte la meme regle
   * d'ordre : il doit s'executer AVANT `spliceNotesBlock`, jamais apres. Un
   * splice fait descendre ce qu'il trouve en haut du corps dans la region du
   * transcript, donc un avertissement insere ensuite se retrouverait au-dessus
   * du bloc de notes, le corps ne commencerait plus par « ## Notes », et
   * shared/redact.ts ne trouverait plus les notes derivees a supprimer lors du
   * retrait d'un passage. La raison complete est dans le bandeau de
   * spliceMyNotesSync, dont cette methode reprend l'exigence.
   */
  prependToBody(s: string): void {
    if (!s) return;
    this.parts.unshift(s);
    this.size += Buffer.byteLength(s, "utf8");
    this.rev++;
    this.joined = null;
  }

  /** Le document depuis l'octet `since`, pour le sondage de la page (l'ancien
   * `transcriptSince`, qui lisait le fichier). Les offsets sont en octets et
   * non en caracteres, comme quand la source etait un Buffer : la page les
   * reutilise tels quels au tour suivant. */
  since(from: number): { text: string; nextSince: number } {
    const buf = Buffer.from(this.text(), "utf8");
    const at = Math.max(0, Math.min(from | 0, buf.length));
    return { text: buf.toString("utf8", at), nextSince: buf.length };
  }
}
