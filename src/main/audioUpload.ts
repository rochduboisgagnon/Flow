import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AUDIO_BUCKET, TUS_CHUNK_BYTES, audioObjectName, chunkCount, nextChunk } from "../shared/tus";
import type { AudioUploadProgress } from "../shared/recordings";
import type { RecordingRow } from "../shared/recordings";
import type { TusUpload } from "./data/tusUpload";

// ---------------------------------------------------------------------------
// B3c (A4) : L'AUDIO D'UNE REUNION VA DANS STORAGE, PAR TRANCHES REPRENABLES.
//
// Le seau `recordings` et ses politiques existent depuis la premiere migration
// et rien ne les utilisait. Voila l'utilisateur.
//
// ---------------------------------------------------------------------------
// CE QUE « REPRENABLE » VEUT DIRE ICI, PRECISEMENT
// ---------------------------------------------------------------------------
//
// Trois interruptions differentes, trois reponses :
//
//  1. UNE COUPURE PENDANT L'ENVOI. La tranche echoue, la file attend, elle
//     reprend a l'offset que le serveur confirme. Rien n'est reexpedie.
//  2. LA FERMETURE DE L'APPLICATION. L'URL unique du televersement est
//     PERSISTEE dans la ligne du compte (`audio_upload_url`), avec son
//     expiration. Le lancement suivant la reprend telle quelle. C'est la seule
//     raison pour laquelle cette URL vit dans la base : elle encode un
//     identifiant opaque, elle ne se reconstruit pas.
//  3. L'EXPIRATION (24 h sur la plateforme hebergee). Le serveur repond 404/410,
//     la file ouvre un nouveau televersement et repart de zero - la seule fois
//     ou 115 Mo sont reexpedies, et le seul cas ou il n'y a pas d'alternative.
//
// ---------------------------------------------------------------------------
// LE FICHIER LOCAL EST LA SOURCE, ET C'EST CE QUI REND LA REPRISE POSSIBLE
// ---------------------------------------------------------------------------
//
// Un .wav d'une heure pese 115 Mo (mesure : 16 kHz mono 16 bits = 32 Ko/s). Le
// garder en memoire pour attendre la fin de la reunion couterait 115 Mo de RAM ;
// le televerser au fil de l'eau interdirait de reprendre, puisque reprendre
// suppose de pouvoir RELIRE ce qu'on a deja envoye. Donc il reste sur le disque
// jusqu'a ce que Storage confirme, et il est supprime ensuite.
//
// C'est le seul fichier de donnees que cette refonte laisse sur la machine, et
// c'est un fichier de TRANSIT : rien ne le lit pour afficher quoi que ce soit,
// il ne survit pas a un televersement reussi, et son nom est l'identifiant de sa
// ligne - donc un lancement retrouve exactement a quelle reunion il appartient.
//
// ---------------------------------------------------------------------------
// UNE SEULE A LA FOIS, ET JAMAIS DEVANT PERSONNE
// ---------------------------------------------------------------------------
//
// Deux televersements en parallele se disputeraient la bande passante d'une
// machine qui est peut-etre en train d'enregistrer la reunion suivante. La file
// est donc serialisee, comme celle de la copie de travail et pour la meme
// raison. Rien ici n'est jamais attendu par un appelant : `enqueue` rend la main
// tout de suite, et `before-quit` ne connait meme pas ce module.
// ---------------------------------------------------------------------------

export interface AudioUploadDeps {
  tus: TusUpload;
  /** L'identifiant du compte, pour composer le chemin de l'objet. Le prefixe EST
   * la frontiere du RLS - voir audioObjectName. */
  userId(): Promise<string>;
  /** Relire une ligne : la file a besoin de l'URL persistee et de l'offset. */
  readRow(id: string): Promise<RecordingRow | null>;
  /** Ecrire une ligne. La memoire d'abord, le reseau derriere, comme partout. */
  writeRow(row: RecordingRow): void;
  /** Ou vivent les .wav en transit. */
  pendingDir(): string;
  /** L'identifiant de la reunion en cours, ou "" : son .wav est encore en train
   * d'etre ecrit et ne doit surtout pas etre televerse ni supprime. */
  recordingNow(): string;
  log?(msg: string): void;
  /** Couture de test : l'attente entre deux tentatives. */
  retryDelayMs?: number;
  /** Couture de test : remplace setTimeout. */
  schedule?(fn: () => void, ms: number): void;
  now?(): number;
}

export class AudioUploadQueue {
  private deps: AudioUploadDeps;
  private queue: string[] = [];
  private working = false;
  private failures = 0;
  private current: AudioUploadProgress | null = null;
  /**
   * LES REUNIONS DONT L'AUDIO A ETE REFUSE POUR SA TAILLE.
   *
   * Trouve en LANCANT l'application, le 2026-08-04 : une reunion de 55 minutes,
   * 101 Mo, refusee par Storage en 413 (« Maximum size exceeded » : le plafond du
   * projet est de 50 Mio, sonde - voir shared/tus.ts). Ce que Flow en faisait
   * etait faux de trois facons a la fois :
   *
   *  1. il reessayait, toutes les soixante secondes, pour toujours ;
   *  2. la page Notes offrait « Download audio (101 MB) », qui rendait 404 -
   *     l'interface promettait un fichier que le compte n'a pas ;
   *  3. rien, nulle part, ne disait que l'audio etait en securite sur le disque.
   *
   * Ce Set repare le premier point et rend les deux autres possibles. Il n'est
   * PAS persiste, et c'est un choix : le plafond est un reglage de projet, donc
   * une offre superieure le change du jour au lendemain. Un refus grave dans la
   * base survivrait a la raison qui l'a cause. Chaque lancement redemande donc
   * au serveur, ce qui coute UN POST sans corps par fichier trop gros.
   */
  private refused = new Set<string>();

  constructor(deps: AudioUploadDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Ce qui monte en ce moment, pour l'AFFICHER. Jamais pour l'attendre. */
  progress(): AudioUploadProgress | null {
    return this.current;
  }

  /** Combien de reunions attendent leur audio, celle en cours comprise. */
  pending(): number {
    return this.queue.length + (this.working ? 1 : 0);
  }

  /** Les reunions dont l'audio a ete refuse pour sa taille, pour que la page
   * puisse le DIRE au lieu d'offrir un telechargement qui rendra 404. */
  refusedForSize(): string[] {
    return [...this.refused];
  }

  /** Une reunion vient de finir et son audio doit monter. Rend la main tout de
   * suite : l'appelant est `finalize()`, et une reunion n'attend pas 115 Mo. */
  enqueue(recordingId: string): void {
    if (!recordingId) return;
    if (this.queue.includes(recordingId)) return;
    // Deja refuse pour sa taille dans cette session : le redemander donnerait le
    // meme 413. Le prochain lancement, lui, redemandera - voir `refused`.
    if (this.refused.has(recordingId)) return;
    this.queue.push(recordingId);
    void this.drain();
  }

  /**
   * AU LANCEMENT : reprendre ce qui n'est pas fini, et nettoyer ce qui l'est.
   *
   * Le balayage part du DISQUE et non du compte, et l'ordre a une raison : un
   * .wav en transit est la seule chose qui puisse encore etre televersee, donc
   * c'est lui qui definit le travail restant. Partir du compte demanderait de
   * lister toutes les reunions pour decouvrir que 99 % ont deja leur audio.
   *
   * CE QU'IL NE SUPPRIME JAMAIS : un fichier dont la ligne n'a pas pu etre lue.
   * Hors ligne, « ligne introuvable » et « ligne effacee » se ressemblent, et se
   * tromper voudrait dire jeter l'audio d'une reunion. Un fichier qu'on ne sait
   * pas classer est laisse en place et signale une fois.
   */
  async resumePending(): Promise<number> {
    const dir = this.deps.pendingDir();
    let entries: string[];
    try {
      entries = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".wav"));
    } catch {
      return 0; // pas de dossier : le cas normal
    }
    let resumed = 0;
    for (const file of entries) {
      const id = file.slice(0, -4);
      if (id === this.deps.recordingNow()) continue; // en cours d'ecriture
      const row = await this.deps.readRow(id);
      if (!row) {
        this.deps.log?.(`[audio] ${file} : sa reunion est introuvable, le fichier est laisse en place`);
        continue;
      }
      if (!row.audioPath) {
        // La reunion a demande de ne PAS garder l'audio, et la suppression de fin
        // n'a pas eu lieu (fermeture brutale). C'est le seul cas ou ce balayage
        // supprime, et il execute une demande explicite de l'utilisateur.
        await this.dropLocal(id, "la reunion avait demande de ne pas garder l'audio");
        continue;
      }
      if (row.audioBytes > 0 && row.audioUploaded >= row.audioBytes) {
        await this.dropLocal(id, "l'audio est deja arrive dans le compte");
        continue;
      }
      this.enqueue(id);
      resumed++;
    }
    if (resumed > 0) this.deps.log?.(`[audio] ${resumed} televersement(s) a reprendre`);
    return resumed;
  }

  /**
   * Un televersement DIRECT, sans aucune comptabilite de ligne.
   *
   * Un seul appelant : le retrait d'un passage, qui remplace l'audio d'une
   * reunion par sa version nettoyee. Il ne peut pas passer par `enqueue` - il n'y
   * a pas de .wav en transit sous l'identifiant de la reunion, l'objet existe
   * DEJA, et il n'y a pas d'offset a garder pour plus tard : cet envoi doit
   * reussir maintenant ou echouer maintenant, parce que l'appelant refuse
   * d'ecrire le document tant qu'il n'a pas reussi.
   *
   * Il partage donc la seule chose qui compte - le protocole, les tranches de
   * 6 Mo, l'offset lu de la reponse - et rien du reste.
   */
  async uploadFile(objectName: string, srcPath: string): Promise<{ ok: boolean; error: string }> {
    let total: number;
    try {
      total = (await fsp.stat(srcPath)).size;
    } catch (err) {
      return { ok: false, error: `le fichier a televerser est introuvable : ${err}` };
    }
    const made = await this.deps.tus.create({ bucket: AUDIO_BUCKET, objectName, totalBytes: total });
    if (!made.ok) return { ok: false, error: made.error };
    const fh = await fsp.open(srcPath, "r");
    const buf = Buffer.allocUnsafe(TUS_CHUNK_BYTES);
    let sent = 0;
    try {
      for (;;) {
        const plan = nextChunk(sent, total);
        if (plan.length === 0) break;
        const read = await fh.read(buf, 0, plan.length, plan.start);
        if (read.bytesRead === 0) return { ok: false, error: "le fichier a rapetisse pendant l'envoi" };
        const res = await this.deps.tus.patch(made.url, plan.start, buf.subarray(0, read.bytesRead));
        if (res.conflict) {
          const at = await this.deps.tus.offset(made.url);
          if (!at.ok) return { ok: false, error: at.error || "offset illisible" };
          sent = at.offset;
          continue;
        }
        if (!res.ok) return { ok: false, error: res.error || "une tranche a ete refusee" };
        sent = res.offset;
        if (res.complete || sent >= total) break;
      }
    } finally {
      await fh.close();
    }
    return sent >= total ? { ok: true, error: "" } : { ok: false, error: "le televersement s'est arrete avant la fin" };
  }

  /**
   * STORAGE REFUSE CE FICHIER POUR SA TAILLE. Ce travail est fini, et le .wav
   * RESTE.
   *
   * Les trois lignes de cette fonction sont chacune une decision :
   *
   *  - le .wav n'est PAS supprime. C'est la seule copie de l'audio de cette
   *    reunion, et la seule chose que Flow puisse encore en faire est de dire ou
   *    elle est. `dropLocal` est appele partout ailleurs dans ce fichier ; ici,
   *    l'appeler serait detruire la donnee que le televersement devait sauver.
   *  - l'URL de televersement est effacee de la ligne. Le POST a echoue, donc il
   *    n'y a rien a reprendre, et laisser une adresse morte ferait faire un HEAD
   *    inutile au prochain lancement. `audioBytes` reste : c'est un fait vrai sur
   *    le fichier, et c'est ce qui permet a la page de dire « 101 Mo, restes
   *    ici ».
   *  - `true` est rendu, donc la file passe au suivant et n'y revient plus. Un
   *    413 ne guerit pas en attendant.
   */
  private refuseForSize(id: string, row: RecordingRow, bytes: number): boolean {
    this.refused.add(id);
    this.deps.writeRow({ ...row, audioBytes: bytes, audioUploaded: 0, audioUploadUrl: "", audioUploadExpires: "" });
    this.deps.log?.(
      `[audio] refuse par le compte : ${Math.round(bytes / (1024 * 1024))} Mo depassent la taille maximale d'un objet. ` +
        "Le .wav reste sur cette machine et n'est pas supprime.",
    );
    return true;
  }

  private async dropLocal(id: string, why: string): Promise<void> {
    try {
      await fsp.rm(path.join(this.deps.pendingDir(), id + ".wav"), { force: true });
      this.deps.log?.(`[audio] .wav en transit supprime : ${why}`);
    } catch (err) {
      this.deps.log?.(`[audio] le .wav en transit n'a pas pu etre supprime : ${err}`);
    }
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue[0];
        const done = await this.run(id);
        if (done) {
          this.queue.shift();
          this.failures = 0;
          this.current = null;
          continue;
        }
        // Echec : le travail RESTE en tete de file, comme dans la copie de
        // travail. Hors ligne il attend ; il ne se perd pas et ne martele pas.
        this.failures++;
        const wait = Math.min(60_000, (this.deps.retryDelayMs ?? 5_000) * Math.min(this.failures, 12));
        const again = () => void this.drain();
        if (this.deps.schedule) this.deps.schedule(again, wait);
        else setTimeout(again, wait).unref?.();
        return;
      }
    } finally {
      this.working = false;
    }
  }

  /** Rend vrai quand ce travail est FINI - televerse, ou abandonne pour une
   * raison definitive. Faux veut dire « a reessayer plus tard ». Ne lance
   * jamais : une exception ici remonterait dans une promesse que personne
   * n'attend. */
  private async run(id: string): Promise<boolean> {
    try {
      const local = path.join(this.deps.pendingDir(), id + ".wav");
      let size: number;
      try {
        size = (await fsp.stat(local)).size;
      } catch {
        // Le fichier n'est plus la : il n'y a plus rien a televerser, et
        // reessayer indefiniment sur un fichier absent bloquerait la file.
        this.deps.log?.("[audio] le .wav en transit a disparu : ce televersement est abandonne");
        return true;
      }
      const row = await this.deps.readRow(id);
      if (!row) return false; // probablement hors ligne : reessayer
      if (!row.audioPath) {
        await this.dropLocal(id, "la reunion ne garde pas son audio");
        return true;
      }
      const uid = await this.deps.userId();
      if (!uid) return false; // pas de session : reessayer

      let url = row.audioUploadUrl;
      let expires = row.audioUploadExpires;
      let sent = 0;

      // Une URL expiree n'est pas reprenable : ouvrir un nouveau televersement
      // AVANT d'y envoyer une tranche coute une requete, alors que decouvrir
      // l'expiration sur un PATCH coute 6 Mo.
      if (url && expires && Date.parse(expires) <= this.now()) {
        this.deps.log?.("[audio] l'adresse de televersement a expire : on recommence");
        url = "";
      }

      if (url) {
        const at = await this.deps.tus.offset(url);
        if (at.gone) {
          url = "";
        } else if (!at.ok) {
          this.deps.log?.(`[audio] ${at.error}`);
          return false;
        } else {
          sent = at.offset;
        }
      }

      if (!url) {
        const made = await this.deps.tus.create({
          bucket: AUDIO_BUCKET,
          objectName: audioObjectName(uid, id),
          totalBytes: size,
        });
        if (made.tooLarge) return this.refuseForSize(id, row, size);
        if (!made.ok) {
          this.deps.log?.(`[audio] ${made.error}`);
          return false;
        }
        url = made.url;
        expires = made.expiresIso;
        sent = 0;
        // Persistee TOUT DE SUITE, avant la premiere tranche : une fermeture
        // entre le POST et le premier PATCH laisserait sinon une URL vivante que
        // plus personne ne connait, et le lancement suivant en ouvrirait une
        // seconde pour le meme objet.
        this.deps.writeRow({ ...row, audioUploadUrl: url, audioUploadExpires: expires, audioBytes: size, audioUploaded: 0 });
      }

      const total = size;
      this.current = { recordingId: id, sentBytes: sent, totalBytes: total, chunks: chunkCount(total) };
      const fh = await fsp.open(local, "r");
      const buf = Buffer.allocUnsafe(TUS_CHUNK_BYTES);
      try {
        for (;;) {
          const plan = nextChunk(sent, total);
          if (plan.length === 0) break;
          const read = await fh.read(buf, 0, plan.length, plan.start);
          if (read.bytesRead === 0) {
            // Le fichier a rapetisse sous nos pieds. Rien de bon a faire d'autre
            // que de s'arreter en le disant : reessayer lirait la meme chose.
            this.deps.log?.("[audio] le .wav en transit est plus court qu'annonce : televersement interrompu");
            return true;
          }
          const res = await this.deps.tus.patch(url, plan.start, buf.subarray(0, read.bytesRead));
          if (res.conflict) {
            // L'offset a bouge (ou deux clients se disputent l'URL) : la seule
            // reponse correcte est de redemander au serveur ou il en est.
            const at = await this.deps.tus.offset(url);
            if (!at.ok) return false;
            sent = at.offset;
            continue;
          }
          if (res.gone) {
            // Recommencer proprement au prochain tour, avec une URL neuve.
            this.deps.writeRow({ ...row, audioUploadUrl: "", audioUploadExpires: "", audioUploaded: 0 });
            return false;
          }
          if (res.tooLarge) return this.refuseForSize(id, row, total);
          if (!res.ok) {
            this.deps.log?.(`[audio] ${res.error}`);
            // L'offset confirme est garde dans la ligne : la reprise ne
            // reexpediera pas ce qui a atterri.
            this.deps.writeRow({ ...row, audioUploadUrl: url, audioUploadExpires: expires, audioBytes: total, audioUploaded: sent });
            return false;
          }
          sent = res.offset;
          this.current = { recordingId: id, sentBytes: sent, totalBytes: total, chunks: chunkCount(total) };
          this.deps.writeRow({ ...row, audioUploadUrl: url, audioUploadExpires: expires, audioBytes: total, audioUploaded: sent });
          if (res.complete || sent >= total) break;
        }
      } finally {
        await fh.close();
      }

      // Arrive. La ligne le dit, l'URL de televersement n'a plus de raison
      // d'etre gardee, et le fichier de transit peut partir.
      this.deps.writeRow({
        ...row,
        audioBytes: total,
        audioUploaded: total,
        audioUploadUrl: "",
        audioUploadExpires: "",
      });
      await this.dropLocal(id, "il est arrive dans le compte");
      this.deps.log?.(`[audio] televerse : ${Math.round(total / (1024 * 1024))} Mo`);
      return true;
    } catch (err) {
      this.deps.log?.(`[audio] televersement echoue : ${err}`);
      return false;
    }
  }
}

export { AUDIO_BUCKET };

/** La taille qu'un .wav de cette duree atteindra, pour l'afficher AVANT d'avoir
 * le fichier. 16 kHz mono 16 bits, plus l'entete de 44 octets : 32 Ko par
 * seconde, donc 115 Mo pour une heure. Le chiffre que le plan cite, calcule
 * plutot que recopie. */
export function wavBytesForMs(ms: number): number {
  return 44 + Math.round((Math.max(0, ms) / 1000) * 16_000 * 2);
}

/** La taille reelle d'un .wav en transit, ou 0. */
export function localWavBytes(pendingDir: string, recordingId: string): number {
  try {
    return fs.statSync(path.join(pendingDir, recordingId + ".wav")).size;
  } catch {
    return 0;
  }
}
