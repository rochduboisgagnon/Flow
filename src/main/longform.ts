import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CaptureDoc } from "../shared/captureDoc";
import { looksAbandoned, type OpenRecording, type RecordingRow } from "../shared/recordings";
import { encodeWav } from "../shared/wav";
import { analyzeSpeech } from "../shared/vad";
import { gateTranscript } from "../shared/textGate";
import type { LlmProvider } from "./llm/provider";
// U8: the ONE line format a kept live suggestion takes in the document. It lives
// in the feature's own pure module (with the gate and the prompt) rather than in
// shared/longform.ts, and is imported here exactly the way markLine is.
import {
  SAMPLE_RATE,
  SEGMENT_TARGET_MS,
  SEGMENT_MIN_MS,
  endsInPause,
  findCutPoint,
  transcriptHeader,
  transcriptLine,
  markLine,
  gapLine,
  interruptedNote,
  recordingBaseName,
  summaryPrompt,
  chunkTranscript,
  composeNotesBlock,
  renderMyNotes,
  transcriptStamps,
  verifyCitations,
  type RecentEntry,
  type LongStateSnapshot,
  type LongStartResult,
  type LongStopResult,
  type LongTranscriptResult,
} from "../shared/longform";

// C2: a 44-byte canonical WAV header (16 kHz mono 16-bit). Written with a
// placeholder size at native-capture start, then patched with the real sizes when
// the stream closes (streaming lets a multi-hour recording never sit in RAM).
function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

// The long-form recorder (plan §6 + plan v2 chantier C): continuous capture
// streamed from the DEVICE running AGR Pilot's PWA (phone or PC browser),
// arriving through the local API (/long/chunk) - never the host mic. Pause-
// aware segmentation, one warm-whisper pass
// per closed segment, INCREMENTAL transcript writes into the folder the USER
// chose (crash-safe: everything transcribed so far is already on disk), marks,
// and an optional Ollama summary at stop. Memory stays bounded: a segment's
// PCM dies right after its transcription (ring-buffer discipline).
//
// This mode is the ONLY writer of content in AGR Flow; dictation remains
// zero-retention. X last recordings are indexed in ~/.agr-flow/recent.json.

export interface LongStartOpts {
  // B3a : `dir` a disparu. Une reunion nait dans le compte, sous son
  // identifiant, et « ou est-ce que je la range » est une question de la fin -
  // ce que la colonne `staged` disait deja. Enregistrer « directement dans ce
  // dossier » n'avait de sens que quand le dossier etait le magasin.
  title?: string;
  keepAudio?: boolean; // v3 chantier 4: keep the listenable .wav (default off)
  native?: boolean; // C2: the engine captures the audio itself, so IT writes the .wav
}

// LongStateSnapshot lives in ../shared/longform now (U4a: shared/ipcContracts.ts
// reuses it for UI_LONG_STATE without pulling src/main into the renderer build).

export interface LongDeps {
  /** F1: transcribe ONE segment of this recording.
   *
   * Was `getSidecar(): WhisperSidecar | null` until F1 gave batch work its own
   * model. Two things changed and both are deliberate:
   *
   *  - The recorder no longer knows what a WhisperSidecar is. It asks for a
   *    segment to be transcribed and gets text back, which is the whole of what
   *    it ever wanted; WHICH engine serves it is a decision that now has a
   *    policy (shared/asrRole.ts) and a holder (main/asr/batchEngine.ts).
   *  - `allowEmptyDemote: false` moved INSIDE the implementation. It used to be
   *    passed here with a comment explaining that a meeting legitimately contains
   *    music and applause, so an empty decode must not demote a healthy GPU. The
   *    import pipeline passed it with the same comment for the same reason. One
   *    fact, one place. */
  transcribeSegment(wav: Uint8Array): Promise<{ text: string; ms: number }>;
  /** P1: who writes the summary. Absent means nobody does, and the document
   * ships as the transcript alone - which is already the behaviour on a machine
   * with no local model, so nothing new had to be taught to the callers.
   *
   * This module used to import Ollama by name and resolve the model itself.
   * Both moved behind the provider: "which model" is a question only the local
   * provider has, and asking it here is what made a second implementation mean
   * editing this file. */
  llm?: LlmProvider;
  /** D7: the live-notes slot (main/liveNotes.ts). Injected rather than imported
   * for the same reason as everything else in this interface - so the recorder's
   * tests never touch the real ~/.flow - and OPTIONAL so a caller that has no
   * notes panel (a test, a future headless mode) gets a recorder that behaves
   * exactly as it did before D7.
   *
   * The recorder is the only thing that reads or clears this: notes reach the
   * document through the one writer of the document, never through a second one
   * (the "double ecrivain" this vague's review is told to hunt for). */
  liveNotes?: {
    open(startedIso: string): void;
    read(startedIso: string): Array<{ atMs: number; text: string }>;
    clear(startedIso: string): void;
  };
  /** B3a : ou la reunion est ecrite. La copie de travail en memoire devant, le
   * compte derriere ; le recorder ne sait ni l'un ni l'autre. */
  store: CaptureStore;
  /** Ou le .wav de la reunion est ecrit. INJECTE, et non resolu ici : c'est ce
   * qui permet a ce module de ne plus appeler `dataDir()` du tout. Absent = pas
   * d'audio du tout, ce qui est le cas des tests qui ne testent que le document.
   *
   * 2026-08-04 : ce n'est plus un dossier de TRANSIT. Le fichier qui y est ecrit
   * y reste - c'est la decision de Roch, et le nom du champ le dit maintenant. */
  audioDir?: string;
  log?: (msg: string) => void;
  /** Couture de test : l'horloge des tranches. Rend de quoi l'arreter. */
  schedule?(fn: () => void, ms: number): () => void;
  /** Couture de test : l'horloge. */
  now?(): number;
  /** Couture de test : l'identifiant de la ligne. */
  newId?(): string;
}

const MAX_QUEUE = 240; // ~100 min of backlog before we refuse to grow (safety)

// ---------------------------------------------------------------------------
// B3d : `history/` ET `staging/` ONT DISPARU.
//
// Ce qui est parti d'ici, et ou chaque protection est passee :
//
//  - `historyRoot()`, `stagingRoot()`, `recentPath()` : trois dossiers sous
//    dataDir(). Le grep du plan est maintenant vrai - ce module n'appelle plus
//    `dataDir()` du tout, et le seul chemin qu'il connait lui est INJECTE
//    (`audioDir`, le .wav de la reunion).
//
//  - LA PURGE DE RETENTION (90 jours) et ses garde-fous : le marqueur de
//    dossier, le refus d'operer sur une racine de volume ou un enfant du profil,
//    le lstat qui ne suit jamais un lien, le nom de dossier qui doit
//    correspondre exactement a une date. Tous existaient pour rendre sur un
//    `rm -rf` recursif sur un chemin configurable. Il n'y a plus de rm.
//
//    La retention, elle, N'A PAS disparu : elle vit cote base pour les dictees
//    (Repo.purgeOldDictations), qui est la ou le constat de securite F3/F9 la
//    demandait. Les enregistrements n'en ont jamais eu besoin - la fenetre de
//    90 jours etait une propriete du DOSSIER, une facon de ne pas laisser un
//    disque grossir sans fin, pas une promesse faite a quelqu'un.
//
//  - `fileRecordingIntoHistory`, `moveFileInto`, `copyFileInto`,
//    `cleanEmptyHoldingDirs`, `readStagedSession`, `noteInterruption`,
//    `spliceMyNotesSync`, `rescueOrphanedStaging` : le classement d'un document
//    dans un dossier date, et son sauvetage. Remplaces par une ligne du compte
//    qui existe des le premier instant et que `rescueAbandoned()` ferme.
//
// ET LE DOSSIER QUI EXISTE DEJA SUR LA MACHINE DE QUELQU'UN ? Il n'est ni lu ni
// supprime : main/index.ts le signale comme un dossier d'enregistrements que
// Flow ne gere plus, par le MEME mecanisme qui signalait deja celui d'une
// version pre-1.0.0 (main/legacyHistory.ts). La reponse a « ou sont passes mes
// enregistrements » n'est donc jamais « nulle part » - elle est un chemin, dans
// Reglages et dans la page Notes.
// ---------------------------------------------------------------------------

/** Un dossier de destination, refuse quand il n'en est pas un.
 *
 * Security scan F1 (MEDIUM, 3/3, 2026-08-02) : `/long/save` prenait le dossier
 * de l'appelant tel quel - `statSync` disait « est-ce un dossier », rien ne
 * disait « devrait-on y ecrire ». C'est une primitive d'ecriture partout ou cet
 * utilisateur peut ecrire, et pire, une destination UNC transforme un
 * enregistrement local en copie sortante PLUS une authentification SMB/NTLM vers
 * un hote que l'appelant nomme.
 *
 * CE QUE CA REFUSE, et pourquoi chacun plutot qu'une liste blanche :
 *
 *  - Ce qui n'est pas absolu. Un chemin relatif se resout contre le repertoire
 *    courant de Flow, ce qui est une coincidence, jamais une intention.
 *  - Les chemins UNC et peripheriques (`\\host\share`, `\\?\`, `\\.\`). C'est
 *    celui qui compte : la difference entre « un fichier atterrit dans un dossier
 *    bizarre » et « l'enregistrement quitte la machine en emportant une poignee
 *    de main d'authentification ». Aucun flux d'export legitime n'en a jamais
 *    passe un.
 *  - Une jonction ou un lien qui aboutit sur l'un des deux apres resolution -
 *    verifie sur le chemin REEL, sinon la verification est decorative.
 *
 * CE QUE CA NE FAIT DELIBEREMENT PAS : confiner la destination au profil de
 * l'utilisateur. Exporter vers D:\Recordings est une chose qu'une personne fait,
 * et cette fonction ne doit pas decider que c'est suspect. « Ecrit dans un
 * dossier local inhabituel » est un choix ; « ecrit vers un hote distant » est
 * une exfiltration. Tracer la ligne la est l'endroit honnete de la tracer, et le
 * dire vaut mieux que laisser croire que ceci rend la destination a un bac a
 * sable. */
export function refuseUnsafeDestination(dir: string): string | null {
  const looksRemote = (p: string): boolean => {
    const s = p.replace(/\//g, "\\");
    return s.startsWith("\\\\"); // UNC \\host\share, and the \\?\ and \\.\ prefixes
  };
  if (looksRemote(dir)) {
    return "refused: recordings are saved to a local folder, never to a network path";
  }
  if (!path.isAbsolute(dir)) {
    return "refused: the destination folder must be an absolute path";
  }
  try {
    // Suit les jonctions et les liens. Un dossier qui n'existe pas encore echoue
    // ici et est rapporte par le `statSync` de l'appelant un instant plus tard,
    // donc un chemin illisible n'est jamais traite comme sur en silence.
    if (looksRemote(fs.realpathSync(dir))) {
      return "refused: that folder resolves to a network path";
    }
  } catch {
    /* not resolvable: statSync in the caller reports it as "not found" */
  }
  return null;
}

/** Cree un sous-dossier NEUF sous `parent` : une collision de nom (meme titre
 * dans la meme minute, ou un reste d'un export precedent) recoit un suffixe
 * « -1 », « -2 »... plutot que de reutiliser le dossier de quelqu'un d'autre. */
function uniqueDir(parent: string, name: string): string {
  let dir = path.join(parent, name);
  for (let i = 1; fs.existsSync(dir); i++) dir = path.join(parent, name + "-" + i);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// B3a : LE MAGASIN D'UNE CAPTURE.
//
// Le recorder ne connait ni Supabase, ni la copie de travail, ni la file : il
// pousse une ligne complete et rend la main. C'est la meme frontiere que
// LiveNotesBacking, pour la meme raison - les tests du recorder ne doivent
// toucher ni reseau ni compte.
//
// `write` est SYNCHRONE et ne rend rien. Une methode qui rendrait une promesse
// serait une methode qu'un appelant pourrait attendre, et le seul appelant qui
// compte ici tourne pendant une reunion.
// ---------------------------------------------------------------------------
export interface CaptureStore {
  /** La memoire d'abord, le reseau derriere. Ne bloque jamais, ne lance jamais. */
  write(row: RecordingRow): void;
  /** Ce qui n'est pas encore monte. Pour le DIRE, jamais pour l'attendre. */
  pending(): number;
  /** Relire une reunion deja terminee. Jamais appelee pendant une capture : elle
   * sert a exporter ou a annoter un enregistrement dont le tampon a ete lache. */
  read(id: string): Promise<RecordingRow | null>;
  /** Retire une reunion, ligne comprise. Le seul appelant est l'import qui n'a
   * RIEN produit : une ligne vide, et surtout une ligne OUVERTE que le sauvetage
   * du prochain lancement viendrait annoter comme « interrompue », serait pire
   * que pas de ligne du tout. */
  remove(id: string): void;
  /** Les lignes restees ouvertes du compte. Pour le sauvetage au demarrage. */
  listOpen(): Promise<OpenRecording[]>;
  /** Les notes tapees pendant une seance, lues depuis le compte.
   *
   * Le recorder les lit AILLEURS pendant une reunion (deps.liveNotes, servi
   * depuis la memoire, parce que la page les relit dix fois par minute). Celle-ci
   * ne sert qu'au sauvetage : les notes d'une seance morte ne sont dans la
   * memoire de personne, seulement dans le compte. */
  readLiveNotes(startedIso: string): Promise<Array<{ atMs: number; text: string }>>;
  /** Uniquement apres que les notes sont surement dans le document. */
  clearLiveNotes(startedIso: string): void;
}

/**
 * Toutes les DOC_FLUSH_MS, la tranche part si le document a bouge.
 *
 * CE QUE CE CHIFFRE ACHETE, ET CE QU'IL COUTE. C'est la fenetre de perte d'un
 * plantage brutal : au pire vingt secondes de transcript, jamais la reunion.
 * Le prix est le nombre d'envois - une heure produit ~180 mises a jour d'une
 * ligne qui grandit jusqu'a 124 Ko (mesure : shared/captureDoc.ts).
 *
 * Pourquoi pas plus court : chaque tranche renvoie le document ENTIER, donc
 * diviser l'intervalle par deux double le trafic pour gagner dix secondes sur
 * un scenario - le plantage en cours de reunion - qui doit rester rare.
 * Pourquoi pas plus long : au-dela d'une minute, la fenetre de perte cesse
 * d'etre negligeable pour quelqu'un qui vient d'entendre la phrase importante.
 */
export const DOC_FLUSH_MS = 20_000;

export class LongRecorder {
  private deps: LongDeps;
  private active = false;
  private finalizing = false;
  private splicing = false; // annotation en vol : save() l'attend (un seul ecrivain)
  // U4: rescueOnQuit() ran. The process is on its way out and the recording is
  // already closed, so a finalize() still awaiting the ASR or Ollama must not
  // write it a second time if it somehow gets CPU again.
  private quitting = false;
  private startedAt = 0;
  private startedIso = "";
  private endedIso = "";
  private title = "";
  private recordingId = "";
  private staged = true; // la destination se choisit a la fin, jamais au depart
  /** B3a : LE document. Il n'y a plus de fichier .md pendant la capture. */
  private doc: CaptureDoc | null = null;
  /** La version deja envoyee. Compare a `doc.version()`, c'est ce qui evite de
   * televerser 124 Ko toutes les vingt secondes quand personne ne parle. */
  private flushedRev = 0;
  private stopFlush: (() => void) | null = null;
  private keepAudio = false;
  private native = false; // C2: engine-captured -> engine writes the .wav
  /** Le .wav EN TRANSIT sur le disque de la machine.
   *
   * Oui, c'est un fichier, dans une refonte qui en retire cinq. Il reste, et le
   * choix est mesure : un .wav d'une heure pese 115 Mo. Le garder en memoire
   * pour attendre la fin de la reunion couterait 115 Mo de RAM, et le
   * televerser au fil de l'eau interdirait de reprendre apres une coupure -
   * reprendre suppose une source durable a relire.
   *
   * Ce n'est donc pas un MAGASIN : rien ne le lit pour afficher quoi que ce
   * soit, il ne survit pas a un televersement reussi, et il porte un nom
   * derive de l'identifiant de la ligne pour qu'un redemarrage retrouve
   * exactement le fichier de la ligne inachevee. */
  private audioLocalPath = "";
  /** Le chemin de l'objet dans Storage. Vide jusqu'a ce que B3c le remplisse. */
  /** 2026-08-04 : TOUJOURS VIDE sur une reunion neuve, et c'est le sujet - une
   * ligne ne cite plus d'objet dans le seau, parce qu'il n'y en a plus. Le champ
   * survit dans la LIGNE pour les reunions faites par une version 2.0.x, que le
   * balayage de demarrage ramene (main/audioLocal.ts). */
  private audioObjectPath = "";
  private audioStream: fs.WriteStream | null = null;
  private audioBytes = 0; // octets PCM ecrits dans le .wav local (pour l'entete)
  private audioUploaded = 0; // octets confirmes dans Storage (B3c)
  private audioUploadUrl = "";
  private audioUploadExpires = "";
  private audioFailed = false; // une erreur d'I/O audio : arreter d'ecrire, continuer a transcrire
  private marks: number[] = [];
  private lastError = "";
  // U4 (review, major): how long the capture actually ran, frozen the moment it
  // ends. state() used to report 0 as soon as `active` went false, so the
  // biggest number on the Record page fell to 00:00:00 the instant Stop was
  // pressed - for the whole of a finalization that can take minutes, and after
  // it. The duration a recording reached is a FACT about it; it does not
  // disappear because the transcription is still running.
  private elapsedMs = 0;
  // Current (open) segment + its start offset in samples since recording start.
  private cur: Int16Array[] = [];
  private curLen = 0;
  private consumed = 0; // samples already CLOSED into segments
  private queue: Array<{ pcm: Int16Array; offsetMs: number }> = [];
  private segments = 0;
  private pumping = false;
  /** La derniere capture terminee, en memoire.
   *
   * U4a piege 1 a disparu avec son support : `recent` etait une lecture de
   * recent.json plus un `existsSync` par entree, faite jusqu'a une fois par
   * seconde par deux appelants, et il fallait un cache pour la tenir hors du
   * chemin du crochet clavier. Un champ en memoire n'a rien a mettre en cache. */
  private lastFinished: RecentEntry | null = null;

  constructor(deps: LongDeps) {
    this.deps = deps;
  }

  get isBusy(): boolean {
    return this.active || this.finalizing;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * B3b : LE SAUVETAGE, cote compte.
   *
   * Le remplacant de `rescueOrphanedStaging`, et il tient la meme promesse par
   * un chemin plus court : une ligne ouverte que plus personne n'alimente EST
   * une reunion interrompue. Pas de dossier a inventorier, pas d'entete a
   * reparser pour retrouver un instant de depart - la ligne le porte.
   *
   * TROIS CHOSES QU'IL FAIT ET QUE L'ANCIEN NE POUVAIT PAS FAIRE :
   *
   *  - il voit la reunion coupee sur l'AUTRE ordinateur. C'est un cas que la
   *    refonte cree, et rien d'autre ne le couvre.
   *  - il distingue « morte » de « en cours ailleurs », par le pouls. Sans ca,
   *    se connecter sur le portable pendant que le fixe enregistre marquerait la
   *    reunion en cours comme interrompue.
   *  - il recolle les notes tapees pendant la seance, lues depuis `live_notes`
   *    sous leur `started_iso`. L'ancien les lisait dans une fente locale, donc
   *    il ne les retrouvait que sur la machine qui avait plante.
   *
   * Ne lance jamais. Rend le nombre de reunions fermees. */
  async rescueAbandoned(): Promise<number> {
    const store = this.deps.store;
    const open = await store.listOpen();
    if (open.length === 0) return 0;
    const nowMs = this.now();
    let closed = 0;
    for (const r of open) {
      // La ligne de CETTE session en cours n'est pas orpheline, quoi que dise
      // son pouls : c'est nous qui l'alimentons.
      if (r.id === this.recordingId && this.isBusy) continue;
      if (!looksAbandoned(r.heartbeatIso, nowMs)) {
        this.deps.log?.(`[long] "${r.title}" est en cours d'enregistrement ailleurs : laissee telle quelle`);
        continue;
      }
      const header = transcriptHeader(r.title, r.startedIso);
      const doc = new CaptureDoc(header);
      // Le document tel qu'il a atterri, entete comprise. On le remet dans un
      // tampon plutot que de manipuler la chaine a la main, pour que l'ordre
      // « avertissement puis splice » soit tenu par le meme code que la fin
      // normale d'une reunion.
      doc.append(r.doc.startsWith(header) ? r.doc.slice(header.length) : r.doc);
      doc.prependToBody(interruptedNote("recovered", -1));
      const mine = await store.readLiveNotes(r.startedIso);
      const block = renderMyNotes(mine);
      if (block) doc.spliceNotesBlock(block);
      // La ligne ENTIERE est reecrite, avec son audio tel qu'il etait : une
      // reunion coupee apres la fin de son televersement ne doit pas perdre son
      // audio en se faisant fermer. Seuls le document et l'instant de fin
      // changent - voir le commentaire d'OpenRecording.
      store.write({
        ...r,
        doc: doc.text(),
        // Le dernier instant dont on sache qu'elle vivait, et non maintenant :
        // une reunion coupee hier ne s'est pas terminee au lancement d'aujourd'hui.
        endedIso: r.heartbeatIso,
      });
      // Les notes ne sont effacees de `live_notes` qu'APRES l'ecriture du
      // document, et la file est FIFO : la suppression ne peut pas depasser le
      // document. C'est la seule chose qui rend cet effacement sur.
      if (block) store.clearLiveNotes(r.startedIso);
      closed++;
      this.deps.log?.(
        `[long] reunion interrompue retrouvee : "${r.title}" (${mine.length} note(s) recuperee(s))`,
      );
    }
    return closed;
  }

  /** U4 blocking finding: `before-quit` is SYNCHRONOUS and Electron awaits
   * nothing a handler starts.
   *
   * B3 rend cette contrainte inoffensive plutot que de ruser avec elle. Il n'y a
   * plus rien a finir : le document est en memoire, l'avertissement s'y insere
   * en trois affectations, la ligne part dans la file et le processus meurt.
   * Rien n'est attendu, rien ne peut retenir la fermeture.
   *
   * ET SI LA FILE NE SE VIDE PAS ? C'est le cas normal, pas le cas d'erreur : le
   * processus meurt en general avant. La ligne reste alors OUVERTE dans le
   * compte avec un pouls vieux de quelques secondes, et `rescueAbandoned()` la
   * ferme au prochain lancement - sur cette machine ou sur l'autre. C'est
   * pourquoi ce chemin peut se permettre de ne rien attendre : il n'est pas la
   * derniere chance, il est le raccourci.
   *
   * Rend si quelque chose a ete sauve. */
  rescueOnQuit(): boolean {
    if (!this.active && !this.finalizing) return false;
    // Count what is about to be lost BEFORE tearing the state down, so the note
    // in the document can be specific: the queued segments plus the open one.
    const pending = this.queue.length + (this.curLen > 0 ? 1 : 0);
    if (this.active) this.elapsedMs = Math.max(0, this.now() - this.startedAt); // freeze before active drops
    this.active = false;
    this.quitting = true; // a finalize() still in flight must not write this twice
    this.cancelFlush();
    try {
      // Le .wav d'abord : son entete de taille est un espace reserve jusqu'a la
      // fermeture du flux, donc un fichier deplace avant ca parait vide a tous
      // les lecteurs. Il reste sur le disque, ou le prochain lancement le
      // retrouvera par le nom de la ligne.
      this.flushNativeAudioSync();
      const doc = this.doc;
      let hadNotes = false;
      if (doc) {
        doc.prependToBody(interruptedNote("quit", pending));
        // D7: les notes tapees partent MAINTENANT, sur le chemin de la sortie. Pas
        // de resume et pas de modele ici - le processus meurt et n'attend rien -
        // donc le bloc porte les notes de l'humain seules, ce qui est le contenu
        // honnete d'un enregistrement interrompu. Voir CaptureDoc.prependToBody
        // sur l'ordre de l'avertissement et du splice.
        const mine = this.deps.liveNotes?.read(this.startedIso) ?? [];
        const block = renderMyNotes(mine);
        if (block) {
          doc.spliceNotesBlock(block);
          hadNotes = true;
        }
      }
      this.endedIso = new Date(this.now()).toISOString();
      // LA LIGNE PART D'ABORD, LA FENTE EST VIDEE ENSUITE, et cet ordre est un
      // correctif - la version d'avant faisait l'inverse tout en affirmant en
      // commentaire qu'elle faisait ceci.
      //
      // Les deux ecritures vont dans la MEME file, qui est FIFO. Sur ce chemin, le
      // processus est en train de mourir : il peut tres bien vider un travail et
      // pas le second. Dans cet ordre, le pire etat atteignable est « le document
      // est monte avec les notes dedans, et les lignes `live_notes` survivent » -
      // du desordre, rattrapable. Dans l'autre, c'est « les notes ont ete
      // supprimees du compte et le document ne les a jamais portees », et les notes
      // tapees pendant une reunion sont la SEULE partie d'une capture que rien ne
      // peut regenerer.
      this.publish();
      if (hadNotes) this.deps.liveNotes?.clear(this.startedIso);
      this.rememberFinished();
      this.deps.log?.(`[long] rescued on quit -> ${this.recordingId}`);
      return true;
    } catch (err) {
      this.deps.log?.(`[long] quit rescue failed: ${err}`);
      return false;
    } finally {
      this.finalizing = false;
    }
  }

  start(opts: LongStartOpts): LongStartResult {
    if (this.active || this.finalizing) return { ok: false, error: "a recording is already in progress" };
    const now = new Date(this.now());
    this.title = (opts.title || "").trim() || "Recording";
    this.keepAudio = !!opts.keepAudio;
    this.recordingId = this.deps.newId?.() ?? randomUUID();
    // B3a : plus de dossier de destination au depart. Une reunion nait dans le
    // compte, sous son identifiant, et la question « ou est-ce que je la
    // range » se pose a la fin - ce que la colonne `staged` disait deja.
    this.staged = true;
    this.startedAt = this.now();
    this.startedIso = now.toISOString();
    this.endedIso = "";
    this.elapsedMs = 0; // a new recording: the previous one's length is no longer the answer
    this.marks = [];
    this.cur = [];
    this.curLen = 0;
    this.consumed = 0;
    this.queue = [];
    this.segments = 0;
    this.lastError = "";
    this.quitting = false;
    this.flushedRev = 0;
    this.audioUploaded = 0;
    this.audioObjectPath = "";
    this.audioUploadUrl = "";
    this.audioUploadExpires = "";
    this.doc = new CaptureDoc(transcriptHeader(this.title, this.startedIso));
    // Le .wav local est ouvert MEME quand la case « garder l'audio » est
    // decochee, et c'est le meme raisonnement qu'avant : pendant la capture,
    // l'audio est la seule chose qui peut encore sauver une reunion dont la
    // transcription tombe, et un plantage ne donne pas de seconde chance de
    // commencer a l'ecrire. U4 constat 2 : c'est a la FIN que la case decide,
    // en televersant ou en supprimant.
    this.audioLocalPath = this.openLocalAudio();
    this.native = !!opts.native;
    this.active = true;
    // D7: bind the live-notes slot to THIS recording, after the buffer exists (a
    // start that failed above must not claim the slot). Never destructive.
    this.deps.liveNotes?.open(this.startedIso);
    // La ligne existe des le premier instant, et c'est ce qui rend une reunion
    // coupee trente secondes plus tard VISIBLE comme interrompue plutot que
    // disparue.
    this.publish();
    this.armFlush();
    this.deps.log?.(`[long] recording started -> ${this.recordingId}`);
    return { ok: true, recordingId: this.recordingId };
  }

  /** Ouvre le .wav en transit et rend son chemin, ou "" si rien ne l'ecrira.
   * Toute erreur est absorbee : une capture sans audio vaut mieux que pas de
   * capture. */
  private openLocalAudio(): string {
    this.audioStream = null;
    this.audioBytes = 0;
    this.audioFailed = false;
    const dir = this.deps.audioDir;
    if (!dir) return "";
    const p = path.join(dir, this.recordingId + ".wav");
    try {
      fs.mkdirSync(dir, { recursive: true });
      // L'entete est ecrite SYNCHRONIQUEMENT, puis le flux ouvre en ajout.
      //
      // Ce n'est pas un detail de style. `createWriteStream` n'ouvre le fichier
      // que de facon differee, et son premier `write` est asynchrone : le
      // fichier peut ne pas exister pendant les premieres millisecondes de la
      // capture. Or l'argument entier qui justifie d'ouvrir ce .wav meme quand
      // la case est decochee est qu'« un plantage ne donne pas de seconde
      // chance de commencer a l'ecrire ». Un fichier qui n'existe pas encore ne
      // tient pas cette promesse.
      fs.writeFileSync(p, wavHeader(0));
      const s = fs.createWriteStream(p, { flags: "a" });
      // Sans ce gestionnaire, un echec d'ecriture asynchrone (disque plein,
      // volume retire, verrou antivirus) est un evenement 'error' non capture
      // qui ferait PLANTER le moteur. On l'absorbe : plus d'audio, mais le
      // transcript continue.
      s.on("error", (err) => {
        this.audioFailed = true;
        this.deps.log?.(`[long] .wav stream error: ${err}`);
      });
      s.write(wavHeader(0));
      this.audioStream = s;
      return p;
    } catch (err) {
      this.deps.log?.(`[long] cannot open the .wav in transit: ${err}`);
      return "";
    }
  }

  // -------------------------------------------------------------------------
  // LES TRANCHES
  // -------------------------------------------------------------------------

  /** Arme l'horloge des tranches. Une seule a la fois. */
  private armFlush(): void {
    this.cancelFlush();
    const tick = () => this.flushSlice();
    if (this.deps.schedule) {
      this.stopFlush = this.deps.schedule(tick, DOC_FLUSH_MS);
      return;
    }
    const t = setInterval(tick, DOC_FLUSH_MS);
    // unref : une horloge qui empeche le processus de mourir serait exactement
    // la troisieme des sept regressions du plan, par la porte de derriere.
    t.unref?.();
    this.stopFlush = () => clearInterval(t);
  }

  private cancelFlush(): void {
    this.stopFlush?.();
    this.stopFlush = null;
  }

  /** Envoie la tranche si le document a bouge. Public pour que les tests n'aient
   * pas a avancer une horloge pour verifier ce que la tranche contient. */
  flushSlice(): void {
    const doc = this.doc;
    if (!doc) return;
    if (doc.version() === this.flushedRev) return; // rien de neuf : pas d'envoi
    this.publish();
  }

  /** Ecrit la ligne, en entier, telle qu'elle est maintenant. */
  private publish(): void {
    const doc = this.doc;
    if (!doc || !this.recordingId) return;
    this.flushedRev = doc.version();
    try {
      this.deps.store.write(this.row(doc.text()));
    } catch (err) {
      // Le magasin promet de ne pas lancer ; s'il lance quand meme, ca ne doit
      // pas arreter une reunion en cours.
      this.deps.log?.(`[long] la tranche n'a pas pu etre mise en file : ${err}`);
    }
  }

  private row(doc: string): RecordingRow {
    return {
      id: this.recordingId,
      title: this.title,
      startedIso: this.startedIso,
      // Vivante pendant la capture, puis la longueur atteinte. L'autre
      // ordinateur peut ainsi voir une reunion avancer.
      durationMs: this.active ? Math.max(0, this.now() - this.startedAt) : this.elapsedMs,
      doc,
      audioPath: this.audioObjectPath,
      audioBytes: this.audioBytes,
      audioUploaded: this.audioUploaded,
      // La ligne du recorder ne connait aucune URL de televersement : c'est la
      // file qui la fabrique et la persiste. Ecrire "" ici l'effacerait a chaque
      // tranche de document, donc le recorder rend ce qu'il a lu au depart.
      audioUploadUrl: this.audioUploadUrl,
      audioUploadExpires: this.audioUploadExpires,
      staged: this.staged,
      endedIso: this.endedIso,
    };
  }

  private rememberFinished(): void {
    this.lastFinished = {
      id: this.recordingId,
      title: this.title,
      startedIso: this.startedIso,
      durationMs: this.elapsedMs,
      staged: this.staged,
    };
  }

  /** C2 native mode: append the engine-captured PCM to the .wav in transit.
   * Called alongside onChunk. */
  writeNativeAudio(pcm: Int16Array): void {
    const s = this.audioStream;
    if (!s || this.audioFailed) return;
    try {
      s.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      this.audioBytes += pcm.byteLength;
    } catch (err) {
      this.audioFailed = true;
      this.deps.log?.(`[long] .wav write failed: ${err}`);
    }
  }

  /** Patch a .wav's RIFF/data sizes to `bytes` in place. Best effort. */
  private patchWavSizes(p: string, bytes: number): void {
    if (!p) return;
    try {
      const fd = fs.openSync(p, "r+");
      const patch = Buffer.alloc(4);
      patch.writeUInt32LE(36 + bytes, 0);
      fs.writeSync(fd, patch, 0, 4, 4); // RIFF chunk size
      patch.writeUInt32LE(bytes, 0);
      fs.writeSync(fd, patch, 0, 4, 40); // data chunk size
      fs.closeSync(fd);
    } catch (err) {
      this.deps.log?.(`[long] .wav header patch failed: ${err}`);
    }
  }

  /** Close the .wav and patch its sizes. Awaited by finalize so the upload never
   * reads a half-written file. NEVER hangs: an errored/wedged stream still
   * resolves (via its 'error' event or a safety timer). */
  private closeLocalAudio(): Promise<void> {
    const stream = this.audioStream;
    this.audioStream = null;
    if (!stream) return Promise.resolve();
    const bytes = this.audioBytes;
    const p = this.audioLocalPath;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.patchWavSizes(p, bytes);
        resolve();
      };
      const timer = setTimeout(finish, 3000); // never await a wedged stream forever
      stream.on("error", () => {
        clearTimeout(timer);
        finish();
      });
      stream.end(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  /** C2: best-effort SYNCHRONOUS close for an abrupt engine quit, so a .wav left
   * open still gets a valid size header instead of looking empty (data size 0). */
  flushNativeAudioSync(): void {
    const stream = this.audioStream;
    if (!stream) return;
    this.audioStream = null;
    try {
      stream.destroy();
    } catch {
      /* best effort */
    }
    this.patchWavSizes(this.audioLocalPath, this.audioBytes);
  }

  /** One streamed PCM slice (~5 s, Int16 16 kHz) from the recording device. */
  onChunk(pcm: Int16Array): void {
    if (!this.active) return;
    this.cur.push(pcm);
    this.curLen += pcm.length;
    const curMs = (this.curLen / SAMPLE_RATE) * 1000;
    if (curMs < SEGMENT_MIN_MS) return;
    const joined = this.joinCurrent();
    if (endsInPause(joined)) {
      this.closeSegment(joined, joined.length);
    } else if (curMs >= SEGMENT_TARGET_MS) {
      // R5 (review fix): search for the quietest cut ONLY in the tail past the
      // minimum length, so the front segment stays >= SEGMENT_MIN_MS. Without this,
      // a cut window wider than the buffer could slice off a sub-250ms fragment (that
      // pump drops) and split a word mid-utterance.
      this.closeSegment(joined, findCutPoint(joined, SEGMENT_TARGET_MS - SEGMENT_MIN_MS));
    }
  }

  mark(): { ok: boolean } {
    if (!this.active) return { ok: false };
    const off = this.now() - this.startedAt;
    this.marks.push(off);
    this.doc?.append(markLine(off));
    return { ok: true };
  }

  /** A capture gap on the CLIENT device (screen locked, network loss): note it
   * honestly in the transcript. The audio and the offsets stay on the AUDIO
   * timeline (what was actually captured), so transcript timestamps keep
   * matching the playable file. */
  gap(seconds: number): { ok: boolean } {
    if (!this.active) return { ok: false };
    this.doc?.append(gapLine(this.now() - this.startedAt, seconds));
    return { ok: true };
  }

  /** Stops the capture; transcription of the backlog + the summary continue in
   * the background (state shows finalizing until done). */
  stop(): LongStopResult {
    if (!this.active) return { ok: false, recordingId: "" };
    // Freeze the length the capture reached BEFORE `active` drops: from here on
    // it is what state() reports, all through finalizing and after (U4 review).
    this.elapsedMs = Math.max(0, this.now() - this.startedAt);
    this.active = false;
    this.finalizing = true;
    const joined = this.joinCurrent();
    if (joined.length > 0) this.closeSegment(joined, joined.length);
    const id = this.recordingId;
    void this.finalize();
    return { ok: true, recordingId: id };
  }

  /**
   * L'EXPORT vers un dossier de l'utilisateur, l'ancien « Save to... ».
   *
   * Ce que ce verbe fait a change de nature avec B3. Il ne DEPLACE plus rien :
   * la reunion est dans le compte, elle y reste, et cette methode en ecrit une
   * COPIE la ou quelqu'un la demande. `staged` passe a faux pour dire « celle-la,
   * je l'ai rangee », ce qui est exactement ce que la colonne annonce.
   *
   * Consequence heureuse : il n'y a plus de commit en deux phases, plus de
   * rollback, plus de suppression de source. Un export rate ne peut plus laisser
   * une reunion orpheline, parce qu'il n'y a plus d'original a perdre.
   */
  async save(destDir: string): Promise<{ ok: boolean; error?: string; docPath?: string; audioPath?: string }> {
    if (this.active) return { ok: false, error: "a recording is still in progress" };
    const dir = (destDir || "").trim();
    if (!dir) return { ok: false, error: "no destination folder" };
    const refusal = refuseUnsafeDestination(dir);
    if (refusal) return { ok: false, error: refusal };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return { ok: false, error: "destination folder not found: " + dir };
    }
    if (!stat.isDirectory()) return { ok: false, error: "destination is not a folder" };
    // Normalement deja fait : l'interface n'offre « Save » qu'une fois la
    // finalisation passee. On l'attend quand meme, pour ne jamais exporter un
    // document a moitie ecrit. Meme attente pour une annotation en vol : un seul
    // ecrivain a la fois.
    const deadline = this.now() + 10 * 60_000;
    while ((this.finalizing || this.splicing) && this.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (this.finalizing || this.splicing) return { ok: false, error: "still finalizing; try again in a moment" };
    const last = this.lastFinished;
    if (!last) return { ok: false, error: "no finished recording to save" };
    const row = await this.rowFor(last.id);
    if (!row) return { ok: false, error: "the recording could not be read back from your account" };
    // F1, revue adverse : on revérifie la destination ICI, juste avant d'ecrire.
    // L'attente ci-dessus peut durer dix minutes, et c'est l'appelant qui decide
    // quand elle s'ouvre : passer un vrai dossier local, laisser la verification
    // passer, puis remplacer ce dossier par une jonction vers \\host\share. Sans
    // ce second regard, la garde serait la decoration que son propre commentaire
    // refuse d'etre.
    const lateRefusal = refuseUnsafeDestination(dir);
    if (lateRefusal) return { ok: false, error: lateRefusal };
    const base = recordingBaseName(row.title, new Date(Date.parse(row.startedIso) || this.now()));
    let subDir = "";
    let docPath = "";
    let audioPath = "";
    try {
      // Chaque capture a son sous-dossier, comme avant, pour que le .md et son
      // audio voyagent ensemble plutot que de s'empiler en vrac.
      subDir = uniqueDir(dir, base);
      docPath = path.join(subDir, base + ".md");
      fs.writeFileSync(docPath, row.doc);
      // Le .wav en transit est encore la quand le televersement n'est pas fini,
      // et l'exporter alors est le bon comportement : l'utilisateur demande une
      // copie, pas une preuve que Storage l'a recue.
      if (this.audioLocalPath && this.lastFinished?.id === row.id && fs.existsSync(this.audioLocalPath)) {
        audioPath = path.join(subDir, base + ".wav");
        fs.copyFileSync(this.audioLocalPath, audioPath);
      }
    } catch (err) {
      // Rien a annuler cote compte : la reunion n'a jamais quitte le compte.
      // On nettoie seulement ce qu'on vient de creer chez l'utilisateur.
      for (const p of [audioPath, docPath]) {
        if (!p) continue;
        try {
          fs.rmSync(p);
        } catch {
          /* laisser une copie partielle plutot que de toucher un fichier de l'utilisateur */
        }
      }
      try {
        if (subDir) fs.rmdirSync(subDir);
      } catch {
        /* non vide ou deja parti */
      }
      return { ok: false, error: "could not save the recording: " + String(err) };
    }
    this.staged = false;
    this.lastFinished = { ...last, staged: false };
    // La ligne du compte apprend qu'elle a ete rangee. Elle est terminee, donc
    // ceci n'est pas une tranche : c'est une derniere mise a jour.
    this.deps.store.write({ ...row, staged: false });
    this.deps.log?.(`[long] exported -> ${docPath}`);
    return { ok: true, docPath, audioPath };
  }

  /** La ligne d'une reunion : le tampon s'il la porte encore, le compte sinon. */
  private async rowFor(id: string): Promise<RecordingRow | null> {
    if (id && id === this.recordingId && this.doc) return this.row(this.doc.text());
    return this.deps.store.read(id);
  }

  /** Meeting-notes splice (2026-07-21): the Pilot server generates the notes
   * (Claude one-shot, on ITS side) and hands the finished text here; the ENGINE
   * stays the one writer of the document, so a splice can never tear against an
   * export reading it (save waits on `splicing` like it waits on `finalizing`).
   * The 100%-local invariant holds: no network call happens here, we only write
   * bytes we were handed.
   *
   * B3 : la cible est un IDENTIFIANT et non un chemin. Le « et si save() avait
   * deplace la capture entre-temps » n'existe plus - rien ne se deplace, donc il
   * n'y a plus de `movedTo` a renvoyer. */
  async notesSplice(recordingId: string, notes: string): Promise<{ ok: boolean; error?: string }> {
    const id = (recordingId || "").trim();
    const text = (notes || "").trim();
    if (!id) return { ok: false, error: "missing recording id" };
    if (!text) return { ok: false, error: "empty notes" };
    if (this.active || this.finalizing) return { ok: false, error: "a recording is still in progress" };
    this.splicing = true;
    try {
      const row = await this.rowFor(id);
      if (!row) return { ok: false, error: "no recording to annotate" };
      const doc = new CaptureDoc(transcriptHeader(row.title, row.startedIso));
      const header = doc.headerText();
      doc.append(row.doc.startsWith(header) ? row.doc.slice(header.length) : row.doc);
      doc.spliceNotesBlock(text);
      // Si c'est encore la capture en memoire, le tampon devient la verite ; la
      // ligne suit. Sinon on ecrit seulement la ligne.
      if (id === this.recordingId && this.doc) this.doc.spliceNotesBlock(text);
      this.deps.store.write({ ...row, doc: doc.text() });
      this.deps.log?.(`[long] notes spliced -> ${id}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      this.splicing = false;
    }
  }

  /** Live transcript tail for the Record page (v3 chantier 5): the document
   * content from byte `since` onward, plus the new byte offset to poll from.
   * Une lecture de memoire, la ou c'etait une lecture de fichier a 1 Hz. */
  transcriptSince(since: number): LongTranscriptResult {
    return this.doc?.since(since) ?? { text: "", nextSince: since | 0 };
  }

  state(): LongStateSnapshot {
    return {
      active: this.active,
      finalizing: this.finalizing,
      startedIso: this.startedIso,
      recordingId: this.recordingId,
      // Live while capturing, then the length it reached - through finalizing
      // and after it, until the next start() opens a new recording.
      durationMs: this.active ? this.now() - this.startedAt : this.elapsedMs,
      segments: this.segments,
      pending: this.queue.length,
      // Ce qui n'est pas encore monte dans le compte. Pour le DIRE : la page
      // Record montre « hors ligne, N changements en attente » plutot que de
      // laisser croire que tout est arrive.
      unsent: this.deps.store.pending(),
      marks: this.marks.length,
      title: this.title,
      lastError: this.lastError,
      recent: this.lastFinished ? [this.lastFinished] : [],
    };
  }

  /** Capture died under us (mic error): keep what we have, stop cleanly. */
  abort(reason: string): void {
    if (!this.active) return;
    this.lastError = reason;
    this.deps.log?.(`[long] capture error: ${reason}`);
    this.stop();
  }

  private joinCurrent(): Int16Array {
    if (this.cur.length === 1 && this.curLen === this.cur[0].length) return this.cur[0];
    const out = new Int16Array(this.curLen);
    let o = 0;
    for (const c of this.cur) {
      out.set(c, o);
      o += c.length;
    }
    this.cur = out.length ? [out] : [];
    return out;
  }

  private closeSegment(joined: Int16Array, cut: number): void {
    const seg = joined.slice(0, cut);
    const rest = joined.subarray(cut);
    this.cur = rest.length ? [rest.slice(0)] : [];
    this.curLen = rest.length;
    const offsetMs = Math.round((this.consumed / SAMPLE_RATE) * 1000);
    this.consumed += seg.length;
    if (this.queue.length >= MAX_QUEUE) {
      // The ASR cannot keep up at all (should not happen: whisper runs many
      // times faster than realtime here). Refusing keeps memory bounded; the
      // gap is written into the transcript rather than silently eaten (same
      // honest-gap discipline as a per-segment transcription failure).
      this.lastError = "transcription backlog full; a segment was dropped";
      this.deps.log?.("[long] " + this.lastError);
      this.doc?.append(`> [segment at ${Math.round(offsetMs / 1000)}s dropped: transcription backlog full]\n\n`);
      return;
    }
    this.queue.push({ pcm: seg, offsetMs });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        try {
          const speech = analyzeSpeech(item.pcm);
          if (speech.voicedMs >= 250) {
            // F1: which engine serves this is the batch engine's decision, not
            // the recorder's - and with the default settings it is the same warm
            // dictation engine this line used to reach for directly. The
            // "an empty decode must not demote a healthy GPU" rule moved with the
            // call (see LongDeps.transcribeSegment).
            const { text } = await this.deps.transcribeSegment(encodeWav(item.pcm));
            const clean = gateTranscript(text);
            if (clean) this.doc?.append(transcriptLine(item.offsetMs, clean));
          }
          this.segments++;
        } catch (err) {
          // One failed segment must not kill the recording: note it in the
          // transcript (honest gap) and move on.
          this.lastError = String(err);
          this.doc?.append(`> [segment at ${Math.round(item.offsetMs / 1000)}s could not be transcribed]\n\n`);
        }
        this.queue.shift(); // the segment's PCM dies here (bounded memory)
      }
    } finally {
      this.pumping = false;
    }
  }

  private async finalize(): Promise<void> {
    /** La ligne a-t-elle ete FERMEE ? Voir le `finally` : c'est ce drapeau qui
     * empeche une exception du resume de faire passer une reunion normale pour un
     * plantage. */
    let closed = false;
    try {
      // C2: close + size-patch the .wav BEFORE the recording is uploadable, so
      // B3c never reads a half-written audio file.
      await this.closeLocalAudio();
      // Drain the backlog (pump may already be running; wait it out).
      while ((this.queue.length > 0 || this.pumping) && !this.quitting) {
        await this.pump();
        await new Promise((r) => setTimeout(r, 200));
      }
      // U4: the quit rescue already closed and published this recording,
      // synchronously, on the way out. Whatever this async tail was still doing,
      // it must not write it a second time with a duration that has since moved.
      if (this.quitting) {
        this.deps.log?.("[long] finalize abandoned: the quit rescue already closed this recording");
        return;
      }
      const doc = this.doc;
      if (!doc) return;
      // v3 chantier 4: always attempt a summary and splice it into the SAME
      // document at the top (no template chooser anymore). If no local LLM is
      // available, the document is the transcript alone.
      //
      // D7 adds a second author to that block: it appears whenever EITHER author
      // has something to say. A recording the user annotated on a machine with no
      // local model still gets its notes - the campaign's own default case.
      const mine = this.deps.liveNotes?.read(this.startedIso) ?? [];
      const mineBlock = renderMyNotes(mine);
      let generated = "";
      // P1: ask the provider whether anything can write a summary at all, before
      // reading the document.
      const llm = this.deps.llm;
      const canSummarize = llm ? (await llm.available()).found : false;
      let body = "";
      if (canSummarize || mineBlock) {
        const text = doc.text();
        const header = doc.headerText();
        body = text.startsWith(header) ? text.slice(header.length) : text;
      }
      if (canSummarize && llm) {
        const parts = chunkTranscript(body);
        if (parts.length === 1) {
          generated = (await llm.long(summaryPrompt(parts[0], this.marks, mineBlock))) ?? "";
        } else {
          // Map-reduce: summarize each chunk, then the joined summaries. The
          // user's notes go to the REDUCE step only, not to every chunk: a note
          // about minute 90 is noise while summarizing minute 3, and repeating
          // the whole outline in every one of a dozen prompts spends the context
          // budget on the part of the work that needs it least.
          const partials: string[] = [];
          for (const p of parts) {
            const x = await llm.long(summaryPrompt(p, []));
            if (x) partials.push(x);
          }
          generated =
            (await llm.long(summaryPrompt(partials.join("\n\n---\n\n"), this.marks, mineBlock))) ??
            partials.join("\n\n---\n\n");
        }
        if (generated) {
          // D8: the model was ASKED for provenance; here is where we find out
          // whether it told the truth. Every "[hh:mm:ss]" it wrote is checked
          // against the timestamps that really begin a line of THIS transcript,
          // and anything else is deleted. Nothing is ever repaired or
          // approximated: see verifyCitations' note on why an invented citation
          // is worse than none.
          const checked = verifyCitations(generated, transcriptStamps(body));
          if (checked.dropped > 0) {
            this.deps.log?.(
              `[long] notes provenance: kept ${checked.kept} citation(s), dropped ${checked.dropped} the model made up (provider ${llm.id})`,
            );
          }
          generated = checked.text;
        } else {
          this.deps.log?.("[long] summary empty: transcript stands alone");
        }
      } else {
        this.deps.log?.("[long] no local model available: transcript only, no summary");
      }
      const block = composeNotesBlock(mineBlock, generated);
      if (block) {
        // Through spliceNotes, the SAME function the regenerate path uses, so
        // there is one shape of document rather than two that can drift. Plus
        // besoin de tmp+rename : le tampon n'est jamais lu a moitie ecrit, parce
        // qu'il n'y a plus de fichier a lire.
        doc.spliceNotesBlock(block);
      }
      // La reunion est terminee. C'est ce champ, et lui seul, qui la sort de
      // l'ensemble « lignes ouvertes » que le sauvetage inspecte.
      this.endedIso = new Date(this.now()).toISOString();
      this.elapsedMs = Math.round((this.consumed / SAMPLE_RATE) * 1000);
      // L'ORDRE DE CES TROIS LIGNES EST UN CORRECTIF, pas une preference.
      //
      // 2026-08-04 : L'AUDIO NE PART PLUS. `settleAudio` ne fait plus que deux
      // choses - supprimer le .wav si la reunion avait demande de ne pas le
      // garder, et mesurer sa taille reelle pour la ligne.
      //
      // CE QUI A DISPARU EST UNE COURSE ENTIERE. La version d'avant remplissait
      // `audio_path` puis confiait le fichier a une file de televersement qui
      // relisait la ligne pour savoir quoi faire : lue avant l'ecriture, elle y
      // trouvait un chemin vide, en concluait « cette reunion ne garde pas son
      // audio » et supprimait le .wav. L'ordre etait devenu une garantie a
      // maintenir ; il n'y a plus d'ordre a maintenir.
      await this.settleAudio();
      this.publish();
      closed = true;

      // SEULEMENT MAINTENANT, une fois le document ecrit dans la file avec les
      // notes dedans. Une fente videe avant une ecriture ratee aurait jete les
      // notes de quelqu'un ; et l'ordre FIFO de la file garantit que la
      // suppression cote compte ne depasse pas le document.
      if (block && mineBlock) this.deps.liveNotes?.clear(this.startedIso);
      this.rememberFinished();
      this.deps.log?.(
        `[long] done: ${this.recordingId}` +
          (mine.length > 0 ? ` (${mine.length} note(s) you typed` : " (") +
          (generated ? (mine.length > 0 ? " + generated notes)" : "generated notes)") : mine.length > 0 ? ")" : "transcript only)"),
      );
    } catch (err) {
      this.lastError = String(err);
      this.deps.log?.(`[long] finalize failed: ${err}`);
    } finally {
      this.finalizing = false;
      this.cancelFlush();
      // LA REUNION EST FERMEE MEME SI LA FINALISATION A ECHOUE.
      //
      // Sans ceci, une exception dans le chemin du resume - le modele local qui
      // tombe, Ollama qui ne repond pas - laissait la ligne OUVERTE. Le sauvetage
      // du prochain lancement la fermait alors en y ecrivant « Flow s'est arrete
      // de facon inattendue (plantage, coupure de courant ou arret force) », ce
      // qui est FAUX : la reunion s'est terminee normalement, c'est son resume qui
      // a rate. Une petite contre-verite dans un document que quelqu'un relira
      // dans six mois pour savoir ce qui s'est passe.
      //
      // Le document est donc ferme ici avec ce qu'il a - le transcript, sans
      // resume et sans notes generees, ce qui est exactement ce qu'il contient.
      // `quitting` exclut le chemin de la fermeture, qui a deja ferme la ligne
      // lui-meme.
      if (!closed && !this.quitting && this.doc) {
        this.endedIso = this.endedIso || new Date(this.now()).toISOString();
        this.publish();
        this.rememberFinished();
        this.deps.log?.("[long] la reunion est fermee malgre l'echec de la finalisation : le transcript est complet");
      }
    }
  }

  /**
   * Ce que devient le .wav en transit, une fois la reunion terminee.
   *
   * DEUX CHEMINS, et la case a cocher decide lequel :
   *
   *  - decochee : le fichier est supprime des que le document est sur. C'est ce
   *    que la case ANNONCE, et c'est ici qu'elle devient vraie - pendant la
   *    capture le .wav est ecrit quoi qu'elle dise, parce qu'il est le dernier
   *    recours si la transcription tombe.
   *  - cochee : la ligne apprend le chemin de l'objet et sa taille, et la file de
   *    televersement prend le relais. RIEN N'EST ATTENDU ICI : 115 Mo derriere
   *    une reunion qui vient de finir bloqueraient la finalisation, donc l'etat
   *    du transfert vit dans la ligne et la page le lit.
   *
   * Le chemin de l'objet est compose ICI et non par la file, pour que la ligne
   * porte « il y a un audio pour cette reunion » des la fin de la capture. C'est
   * ce qui permet a un lancement suivant de savoir qu'il reste du travail meme si
   * la premiere tranche n'est jamais partie.
   *
   * NE CONFIE RIEN A LA FILE : rend seulement s'il y a quelque chose a televerser,
   * et c'est l'appelant qui enfile - apres avoir ecrit la ligne. Voir le
   * commentaire d'ordre dans finalize().
   */
  private async settleAudio(): Promise<void> {
    const p = this.audioLocalPath;
    if (!p) return;
    if (!this.keepAudio) {
      try {
        await fsp.rm(p, { force: true });
        this.deps.log?.("[long] audio dropped: the recording asked not to keep the .wav");
        this.audioLocalPath = "";
        this.audioBytes = 0;
      } catch (err) {
        this.deps.log?.(`[long] could not drop the .wav the recording asked not to keep: ${err}`);
      }
      return;
    }
    // LA TAILLE REELLE DU FICHIER, et non celle calculee sur la duree. C'est ce
    // que la ligne annonce a toute machine qui lira cette reunion, y compris
    // celle qui n'a pas le fichier : « 101 Mo, sur l'ordinateur qui l'a
    // enregistree ».
    try {
      this.audioBytes = (await fsp.stat(p)).size;
    } catch {
      /* la taille mesuree pendant la capture reste la meilleure estimation */
    }
  }
}
