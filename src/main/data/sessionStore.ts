import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// A2 : ou vit le jeton de session, et ce qui se passe quand on ne peut pas le
// mettre en surete.
//
// Ce fichier est l'adaptateur de stockage que le client Supabase appelle pour
// se souvenir d'une session entre deux lancements. Il ne contient AUCUNE
// logique d'authentification : il chiffre, il ecrit, il relit. C'est
// deliberement la piece la plus ennuyeuse de la vague, parce que c'est la piece
// qui detient la clef de toutes les donnees de quelqu'un.
//
// ---------------------------------------------------------------------------
// CE QU'IL Y A DANS UN JETON, ET POURQUOI IL NE VA PAS DANS UN FICHIER NU
// ---------------------------------------------------------------------------
//
// Le jeton de rafraichissement n'est pas « une preference » : il transforme un
// fichier en acces permanent au compte. Qui le lit peut, sans mot de passe,
// obtenir un jeton d'acces frais et lire les reglages, le dictionnaire, les
// dictees, les notes et l'audio de toutes les reunions. Le RLS ecrit en A1 ne
// protege de rien contre lui : le RLS distingue les comptes, et celui qui
// presente le jeton EST le compte.
//
// Donc `safeStorage`, qui adosse le chiffrement au trousseau du systeme (DPAPI
// sur Windows) : un autre utilisateur de la machine, ou une sauvegarde du
// dossier copiee ailleurs, ne rend rien de lisible.
//
// ---------------------------------------------------------------------------
// ET QUAND LE TROUSSEAU N'EST PAS DISPONIBLE : ON NE PERSISTE PAS
// ---------------------------------------------------------------------------
//
// C'est la decision du plan et c'est la bonne : plutot se reconnecter au
// prochain lancement qu'ecrire en clair un fichier qui ouvre le compte. Le
// piege serait d'ecrire quand meme « en attendant », parce que ce genre de
// provisoire ne se remarque jamais - rien ne casse, l'application marche
// mieux, et le fichier reste.
//
// La degradation est donc SILENCIEUSE POUR LE MOTEUR mais DITE dans le
// journal : la session vit en memoire, tout fonctionne, et fermer l'application
// demande de se reconnecter.
// ---------------------------------------------------------------------------

/** Ce que le client Supabase attend d'un stockage. Volontairement le
 * sous-ensemble exact qu'il utilise, et rien de plus. */
export interface SupabaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionStoreDeps {
  /** Le dossier de donnees de CETTE machine. Le jeton y vit parce qu'il decrit
   * cette machine-ci, pas le compte : c'est l'une des quatre choses que la
   * refonte laisse sur le disque, avec la geometrie de fenetre, le journal et
   * le fichier de decouverte de l'API. */
  dir(): string;
  /** electron.safeStorage, injecte pour que ce module soit testable sans
   * Electron - et pour que le chemin « pas de trousseau » soit teste, ce qui
   * est impossible sur une vraie machine ou il marche toujours. */
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  isEncryptionAvailable(): boolean;
  log?(msg: string): void;
}

/** Un seul fichier, un seul jeton. Le nom ne ment pas sur ce qu'il contient :
 * quelqu'un qui inspecte son dossier doit pouvoir le reconnaitre et le
 * supprimer, et le supprimer doit valoir deconnexion. */
const FILE = "session.bin";

export class SessionStore implements SupabaseStorage {
  private deps: SessionStoreDeps;
  /** La copie chaude. Elle existe meme quand le disque est utilisable : le
   * client Supabase relit la session a chaque rafraichissement de jeton, et
   * dechiffrer par le trousseau a chaque fois serait payer un appel systeme
   * pour une valeur qu'on vient d'ecrire. */
  private memory = new Map<string, string>();
  /** Sait-on deja si le trousseau repond ? Pose au premier acces et pas dans le
   * constructeur : safeStorage n'est pas fiable avant que l'application soit
   * prete, et ce magasin peut etre construit avant. */
  private usable: boolean | null = null;
  private loaded = false;

  constructor(deps: SessionStoreDeps) {
    this.deps = deps;
  }

  private filePath(): string {
    return path.join(this.deps.dir(), FILE);
  }

  private canPersist(): boolean {
    if (this.usable === null) {
      try {
        this.usable = this.deps.isEncryptionAvailable();
      } catch {
        this.usable = false;
      }
      if (!this.usable) {
        // Dit une fois, pas a chaque ecriture : le journal doit rester lisible.
        this.deps.log?.(
          "[session] le trousseau du systeme est indisponible : la session vit en memoire seulement, " +
            "et il faudra se reconnecter au prochain lancement. Rien n'est ecrit en clair.",
        );
      }
    }
    return this.usable;
  }

  /** Relit le fichier une fois par lancement. Un fichier illisible - trousseau
   * d'un AUTRE utilisateur Windows, profil restaure depuis une sauvegarde - est
   * traite comme une absence de session, jamais comme une erreur fatale : la
   * bonne reponse a « je n'arrive pas a te reconnaitre » est un ecran de
   * connexion, pas un plantage. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.canPersist()) return;
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.filePath());
    } catch {
      return; // pas de session enregistree : l'etat normal d'une premiere fois
    }
    try {
      const parsed: unknown = JSON.parse(this.deps.decryptString(raw));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") this.memory.set(k, v);
        }
      }
    } catch {
      this.deps.log?.("[session] la session enregistree n'a pas pu etre relue : reconnexion demandee");
      // Le fichier n'est PAS supprime. Il appartient peut-etre a un autre profil
      // Windows monte au meme endroit, et effacer la session de quelqu'un
      // d'autre parce qu'on n'a pas su la lire serait pire que de l'ignorer.
    }
  }

  /** Ecriture atomique (tmp puis rename), meme discipline que les magasins que
   * cette refonte remplace : un lancement qui meurt au milieu ne doit pas
   * laisser un demi-jeton, qui se lirait comme une session corrompue. */
  private flush(): void {
    if (!this.canPersist()) return;
    const p = this.filePath();
    if (this.memory.size === 0) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* deja parti */
      }
      return;
    }
    const tmp = p + ".tmp";
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, this.deps.encryptString(JSON.stringify(Object.fromEntries(this.memory))), {
        mode: 0o600,
      });
      fs.renameSync(tmp, p);
    } catch (err) {
      // Ne jamais journaliser la valeur, seulement l'echec.
      this.deps.log?.(`[session] impossible d'enregistrer la session : ${(err as Error).message}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* au mieux */
      }
    }
  }

  getItem(key: string): string | null {
    this.load();
    return this.memory.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.load();
    this.memory.set(key, value);
    this.flush();
  }

  removeItem(key: string): void {
    this.load();
    this.memory.delete(key);
    this.flush();
  }

  /** Deconnexion : la memoire ET le disque, dans cet ordre.
   *
   * Le plan l'exige explicitement (« se deconnecter efface le jeton ») et c'est
   * la seule operation de ce fichier qui doit reussir meme en cas de degat :
   * un jeton qui survit a une deconnexion est le contraire exact de ce que
   * l'utilisateur vient de demander. */
  clear(): void {
    this.memory.clear();
    this.loaded = true;
    try {
      fs.rmSync(this.filePath(), { force: true });
    } catch (err) {
      this.deps.log?.(`[session] le fichier de session n'a pas pu etre efface : ${(err as Error).message}`);
    }
  }
}
