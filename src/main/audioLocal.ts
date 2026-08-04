import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { RecordingRow, RecordingSummary } from "../shared/recordings";

// ---------------------------------------------------------------------------
// 2026-08-04 : L'AUDIO D'UNE REUNION VIT SUR LA MACHINE QUI L'A ENREGISTREE.
//
// Ce module remplace main/audioUpload.ts. Il ne parle a aucun reseau pour ecrire :
// il possede un dossier, sait ce qu'il contient, et sait le nettoyer.
//
// ---------------------------------------------------------------------------
// POURQUOI CE MODULE EXISTE PLUTOT QU'UN `fs.existsSync` LA OU ON EN A BESOIN
// ---------------------------------------------------------------------------
//
// Trois raisons, et la premiere est la seule qui compte vraiment :
//
//  1. LE PROCESSUS PRINCIPAL PORTE LE CROCHET CLAVIER. Windows revoque un
//     crochet de bas niveau qui met trop de temps a repondre, donc une lecture
//     disque synchrone dans ce processus est une dette qu'on paie sur la dictee
//     de quelqu'un. La liste des reunions peut compter deux mille lignes : deux
//     mille `existsSync` seraient deux mille acces. Un SEUL `readdir` par
//     listage rend le meme fait.
//  2. « Ou est le dossier » doit avoir une seule reponse. Le nom a deja change
//     une fois (`pending-audio`, du temps ou un .wav n'y passait qu'en transit),
//     et la migration ci-dessous n'est possible que parce qu'un seul endroit
//     decide.
//  3. Les regles de suppression sont delicates - voir `sweep`. Elles ne doivent
//     pas etre recopiees.
//
// ---------------------------------------------------------------------------
// CE MODULE NE SUPPRIME QUE DANS DEUX CAS, ET JAMAIS SUR UN DOUTE
// ---------------------------------------------------------------------------
//
//  - la reunion a demande de NE PAS garder l'audio, et une fermeture brutale a
//    laisse le fichier : c'est l'execution d'une demande explicite ;
//  - l'utilisateur supprime la reunion depuis la page Notes.
//
// Un fichier dont la ligne est introuvable n'est PAS supprime. Hors ligne,
// « ligne introuvable » et « ligne effacee » se ressemblent, et se tromper
// voudrait dire jeter l'audio d'une reunion. Il est laisse en place et signale.
// ---------------------------------------------------------------------------

/** Le dossier, sous le dossier de donnees. Le nom dit ce qu'il contient, ce que
 * `pending-audio` ne fait plus : rien n'y est en transit. */
export function audioDirIn(dataDir: string): string {
  return path.join(dataDir, "audio");
}

/** L'ancien nom, garde uniquement pour la migration de `migrateAudioDir`. */
export function retiredTransitDirIn(dataDir: string): string {
  return path.join(dataDir, "pending-audio");
}

export function audioFileIn(dir: string, recordingId: string): string {
  return path.join(dir, recordingId + ".wav");
}

export interface AudioLocalDeps {
  /** Ou vivent les .wav. Une fonction : le dossier de donnees se resout
   * paresseusement partout dans ce projet, et le figer ici le pinnerait au
   * dossier d'avant migration. */
  dir(): string;
  log?(msg: string): void;
}

export class AudioLocal {
  private deps: AudioLocalDeps;

  constructor(deps: AudioLocalDeps) {
    this.deps = deps;
  }

  dir(): string {
    return this.deps.dir();
  }

  pathFor(recordingId: string): string {
    return audioFileIn(this.deps.dir(), recordingId);
  }

  /** Le dossier existe, ou vient d'etre cree. Appele avant la premiere ecriture
   * d'une capture, jamais dans une boucle. */
  ensure(): string {
    const d = this.deps.dir();
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (err) {
      this.deps.log?.(`[audio] le dossier audio n'a pas pu etre cree : ${err}`);
    }
    return d;
  }

  /**
   * QUELLES REUNIONS ONT LEUR AUDIO ICI - un seul acces disque.
   *
   * Rend les identifiants et non les chemins : la page n'a aucune raison de voir
   * un chemin de fichier, et le renderer non plus (c'est la meme regle que pour
   * l'import, ou le chemin ne quitte jamais le processus principal).
   */
  async present(): Promise<Set<string>> {
    try {
      const files = await fsp.readdir(this.deps.dir());
      return new Set(files.filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.slice(0, -4)));
    } catch {
      return new Set(); // pas de dossier : aucune reunion n'a son audio ici
    }
  }

  /** Ce que le dossier pese, pour l'AFFICHER. Roch doit pouvoir savoir combien
   * d'espace ses reunions prennent, maintenant que rien ne les enleve tout seul :
   * un dossier qui grossit de 115 Mo par heure sans jamais le dire serait la
   * mauvaise moitie de cette decision. */
  async totalBytes(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    try {
      for (const f of await fsp.readdir(this.deps.dir())) {
        if (!f.toLowerCase().endsWith(".wav")) continue;
        try {
          bytes += (await fsp.stat(path.join(this.deps.dir(), f))).size;
          files++;
        } catch {
          /* disparu entre le listage et la mesure : il ne compte pas */
        }
      }
    } catch {
      /* pas de dossier */
    }
    return { files, bytes };
  }

  /** L'audio d'une reunion supprimee. Le SEUL chemin de suppression declenche par
   * quelqu'un, et il ne rend pas d'erreur : la ligne est deja partie, et refuser
   * de finir le menage laisserait un fichier que plus rien ne peut nommer. */
  async remove(recordingId: string): Promise<void> {
    try {
      await fsp.rm(this.pathFor(recordingId), { force: true });
    } catch (err) {
      this.deps.log?.(`[audio] le .wav de ${recordingId} n'a pas pu etre supprime : ${err}`);
    }
  }

  /**
   * LE BALAYAGE DE DEMARRAGE. Deux travaux, et un seul supprime.
   *
   * 1. RAMENER l'audio des reunions faites par une version 2.0.x. Elles ont un
   *    objet dans le seau et, tres souvent, plus de fichier local - la 2.0.x
   *    supprimait le .wav des que Storage confirmait. Le ramener est ce qui rend
   *    la decision de Roch vraie POUR LES REUNIONS DEJA FAITES, et pas seulement
   *    pour les prochaines.
   *
   *    L'ORDRE EST LE SUJET : descendre, verifier la taille, mettre en place,
   *    PUIS vider la colonne et lacher l'objet. A aucun instant il n'existe une
   *    ligne qui ne pointe vers rien - si quelque chose echoue, l'objet est
   *    encore la et le prochain lancement recommence.
   *
   * 2. Supprimer les .wav d'une reunion qui avait demande de NE PAS garder son
   *    audio et qu'une fermeture brutale a laisses.
   *
   * Rejouable, en arriere-plan, jamais attendu par personne.
   */
  async sweep(deps: {
    list(): Promise<RecordingSummary[]>;
    read(id: string): Promise<RecordingRow | null>;
    write(row: RecordingRow): void;
    fetch(objectName: string, destPath: string): Promise<{ ok: boolean; error: string }>;
    releaseObject(objectName: string): Promise<void>;
    /** L'identifiant de la reunion en cours d'ecriture, ou "". Son .wav grandit
     * encore : ni le mesurer, ni le toucher. */
    recordingNow(): string;
  }): Promise<{ broughtDown: number; dropped: number }> {
    const out = { broughtDown: 0, dropped: 0 };
    const here = await this.present();
    let items: RecordingSummary[];
    try {
      items = await deps.list();
    } catch (err) {
      this.deps.log?.(`[audio] le balayage n'a pas pu lire la liste des reunions : ${err}`);
      return out;
    }

    // --- 1. les objets restes dans le seau -----------------------------------
    for (const item of items) {
      if (!item.audioInAccount) continue;
      if (item.id === deps.recordingNow()) continue;
      const row = await deps.read(item.id);
      if (!row || !row.audioPath) continue;

      if (here.has(item.id)) {
        // Le fichier est DEJA ici : il n'y a rien a descendre. C'est le cas de la
        // reunion dont l'audio avait ete refuse pour sa taille (413) - son .wav
        // n'a jamais quitte la machine. La ligne cesse de pretendre qu'un objet
        // existe, et l'objet est lache au cas ou il existerait quand meme.
        deps.write({ ...row, audioPath: "", audioUploadUrl: "", audioUploadExpires: "" });
        await deps.releaseObject(row.audioPath);
        this.deps.log?.(`[audio] ${item.id} : l'audio etait deja sur cette machine, la ligne ne cite plus d'objet`);
        continue;
      }

      const dest = this.pathFor(item.id);
      const work = dest + ".part";
      this.ensure();
      const got = await deps.fetch(row.audioPath, work);
      if (!got.ok) {
        // Hors ligne, ou l'objet a disparu. Dans les DEUX cas on ne touche a
        // rien : la ligne garde son objet, la page continue de jouer depuis le
        // compte, et le prochain lancement reessaie.
        this.deps.log?.(`[audio] ${item.id} : l'audio n'a pas pu etre ramene (${got.error})`);
        await fsp.rm(work, { force: true }).catch(() => {});
        continue;
      }
      let size = 0;
      try {
        size = (await fsp.stat(work)).size;
      } catch {
        /* size reste 0, ce qui echoue la verification juste en dessous */
      }
      // La taille que la LIGNE annonce est la seule reference disponible. Un
      // fichier plus court est un telechargement coupe, et le mettre en place
      // ferait passer une reunion tronquee pour complete.
      if (size === 0 || (row.audioBytes > 0 && size !== row.audioBytes)) {
        this.deps.log?.(
          `[audio] ${item.id} : audio ramene incomplet (${size} octets pour ${row.audioBytes} annonces), rien n'est mis en place`,
        );
        await fsp.rm(work, { force: true }).catch(() => {});
        continue;
      }
      try {
        await fsp.rename(work, dest);
      } catch (err) {
        this.deps.log?.(`[audio] ${item.id} : l'audio ramene n'a pas pu etre mis en place (${err})`);
        await fsp.rm(work, { force: true }).catch(() => {});
        continue;
      }
      deps.write({ ...row, audioPath: "", audioBytes: size, audioUploadUrl: "", audioUploadExpires: "" });
      await deps.releaseObject(row.audioPath);
      out.broughtDown++;
    }

    // --- 2. les .wav qu'une reunion avait demande de ne pas garder ------------
    for (const id of here) {
      if (id === deps.recordingNow()) continue;
      const row = await deps.read(id);
      if (!row) {
        // JAMAIS supprime : voir le bandeau. Une ligne illisible hors ligne
        // ressemble a une ligne effacee.
        this.deps.log?.(`[audio] ${id}.wav : sa reunion est introuvable, le fichier est laisse en place`);
        continue;
      }
      if (row.audioBytes <= 0 && !row.audioPath) {
        await this.remove(id);
        out.dropped++;
      }
    }

    if (out.broughtDown > 0) this.deps.log?.(`[audio] ${out.broughtDown} audio(s) ramene(s) du compte vers cette machine`);
    if (out.dropped > 0) this.deps.log?.(`[audio] ${out.dropped} .wav supprime(s) : leur reunion avait demande de ne pas garder l'audio`);
    return out;
  }
}

/**
 * LE RENOMMAGE DU DOSSIER, UNE FOIS.
 *
 * `pending-audio` decrivait un transit : un .wav n'y vivait que le temps de
 * monter. Ce n'est plus vrai, et un dossier dont le nom mentit est exactement le
 * genre de chose que ce depot corrige plutot que de propager.
 *
 * DEPLACE, NE COPIE PAS, et n'ecrase jamais : un fichier deja present dans le
 * nouveau dossier gagne (il est plus recent par construction - le nouveau code
 * n'ecrit que la). Le dossier d'origine est retire seulement s'il finit vide.
 *
 * Synchrone, et c'est volontaire : ca tourne une fois, avant que quoi que ce
 * soit puisse lire le dossier, et une version asynchrone laisserait une fenetre
 * ou les deux noms sont vivants.
 */
export function migrateAudioDir(dataDir: string, log?: (msg: string) => void): number {
  const from = retiredTransitDirIn(dataDir);
  const to = audioDirIn(dataDir);
  let files: string[];
  try {
    files = fs.readdirSync(from);
  } catch {
    return 0; // le cas normal : ce dossier n'a jamais existe sur cette machine
  }
  let moved = 0;
  for (const f of files) {
    const src = path.join(from, f);
    const dst = path.join(to, f);
    try {
      if (fs.existsSync(dst)) {
        log?.(`[audio] ${f} existe deja dans le nouveau dossier : l'ancien est laisse en place`);
        continue;
      }
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(src, dst);
      moved++;
    } catch (err) {
      log?.(`[audio] ${f} n'a pas pu etre deplace vers le dossier audio : ${err}`);
    }
  }
  try {
    fs.rmdirSync(from); // echoue s'il reste quelque chose, ce qui est le comportement voulu
  } catch {
    /* pas vide, ou deja parti */
  }
  if (moved > 0) log?.(`[audio] ${moved} fichier(s) deplace(s) de pending-audio vers audio`);
  return moved;
}

/** La taille qu'un .wav de cette duree atteindra, pour l'afficher AVANT d'avoir
 * le fichier. 16 kHz mono 16 bits, plus l'entete de 44 octets : 32 Ko par
 * seconde, donc 115 Mo pour une heure. Le chiffre que le plan cite, calcule
 * plutot que recopie. */
export function wavBytesForMs(ms: number): number {
  return 44 + Math.round((Math.max(0, ms) / 1000) * 16_000 * 2);
}

/** La taille reelle d'un .wav local, ou 0. */
export function localWavBytes(dir: string, recordingId: string): number {
  try {
    return fs.statSync(audioFileIn(dir, recordingId)).size;
  } catch {
    return 0;
  }
}
