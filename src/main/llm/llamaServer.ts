import { spawn, execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { childEnv } from "../../shared/childEnv";
import { socketOwnedBy } from "../asr/portOwner";

// ---------------------------------------------------------------------------
// D1 : le lanceur de llama-server, la piece que P9 n'avait pas livree.
//
// P9 a ecrit le fournisseur (localSidecar.ts), epingle les empreintes et fourni
// six tests. Rien ne lancait le serveur, donc rien n'appelait le fournisseur, et
// la release 1.22.0 a tout de meme annonce que l'invariant « un ami qui installe
// Flow a le produit complet » etait ferme. Il ne l'etait pas.
//
// ECRIT SUR LE PATRON DE asr/sidecar.ts, mais deliberement plus SIMPLE : pas de
// liste de backends a essayer, pas de sonde de decodage, pas de retrogradation.
// Il y a un binaire et un modele ; s'ils ne demarrent pas, les notes ne
// s'ecrivent pas et le document sort avec son transcript, ce que tous les
// appelants savent deja traiter.
//
// ---------------------------------------------------------------------------
// LES DEUX CONTROLES QUE CE FICHIER HERITE, ET QU'IL SERAIT ABSURDE DE REFAIRE
// ---------------------------------------------------------------------------
//
// LA PROPRIETE DU PORT. Le port est choisi par sonder-puis-relacher, exactement
// comme pour whisper : on lie un candidat, on le referme, et on passe le NUMERO
// a l'enfant. Personne ne possede ce port pendant tout l'intervalle de
// lancement plus chargement du modele, et 1,9 Go de poids prennent des
// secondes. Un processus local qui gagne cette course recevrait le transcript
// ENTIER de la reunion et deciderait du texte des notes.
//
// Le scan de securite du 2026-08-02 a trouve ca sur whisper (F4/F5), et le
// SECOND scan a trouve que le premier correctif se contournait deux fois. La
// version qui tient est dans asr/portOwner.ts, et elle est reutilisee ICI telle
// quelle : verifier que la socket qui repond appartient a l'enfant qu'on a
// lance. Reecrire ce controle a cote aurait garanti de reintroduire l'un des
// deux contournements.
//
// LE PROCESSUS EST TUE EN ARBRE. `child.kill()` n'atteint pas les
// petits-enfants sur Windows ; il faut `taskkill /PID <pid> /T /F`. Sans ca, un
// llama-server survit a la fermeture de Flow et garde la VRAM.
//
// ---------------------------------------------------------------------------
// ET UN TROISIEME CONTROLE, CELUI-LA MESURE PLUTOT QUE DEDUIT
// ---------------------------------------------------------------------------
//
// Au premier lancement reel, llama-server a imprime lui-meme son avertissement :
//
//   CORS is set to allow all origins ('*') and no API key is set
//   this can be a security risk (cross-origin attacks)
//
// C'est exact, et `--no-webui` n'y change rien. Le serveur n'ecoute que sur
// 127.0.0.1, donc personne d'ailleurs ne l'atteint ; mais sur CETTE machine, une
// page web ouverte dans un navigateur peut lui poster une requete et en LIRE la
// reponse, precisement parce que l'origine est autorisee en grand.
//
// Ce qu'un attaquant y gagne est modeste - le serveur est sans etat, il ne
// detient aucun transcript passe - mais ce n'est pas rien : l'ordinateur de
// quelqu'un d'autre calcule pour lui, et la page apprend au passage que Flow
// tourne ici et avec quel modele.
//
// Le correctif est une clef tiree au hasard A CHAQUE LANCEMENT, jamais ecrite
// sur le disque et jamais journalisee : elle vit dans cette instance et dans le
// fournisseur qui l'interroge, et elle meurt avec le processus.
// ---------------------------------------------------------------------------

const PORT_START = 8210;
const PORT_END = 8229;
/** Charger 1,9 Go de poids prend des secondes, plus sur un disque lent et une
 * carte froide. Genereux, parce que le cout d'un abandon premature est « pas de
 * notes » et que personne n'attend devant l'ecran. */
const STARTUP_TIMEOUT_MS = 120_000;

export interface LlamaServerDeps {
  /** Le binaire. Absent = rien ne demarre, et c'est un etat normal. */
  binPath(): string;
  /** Le fichier .gguf. Absent = pas encore telecharge, etat normal aussi. */
  modelPath(): string;
  log?(msg: string): void;
  /** Couture de test : lancer sans processus reel. */
  spawnProc?(command: string, args: string[]): ChildProcess;
}

function findFreePort(from: number, to: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > to) return reject(new Error("no free port for llama-server"));
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(p)));
    };
    tryPort(from);
  });
}

/** Tuer l'ARBRE. Voir le bandeau. */
function killTree(pid: number): void {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* deja parti */
    }
    return;
  }
  try {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } catch {
    /* au mieux : le processus peut deja etre mort */
  }
}

export class LlamaServer {
  private proc: ChildProcess | null = null;
  private port = 0;
  /** D1 : le port a-t-il ete VERIFIE comme appartenant a notre enfant ?
   *
   * Meme raison que le drapeau du meme nom dans asr/sidecar.ts, et il vient du
   * meme defaut : la premiere version la-bas declarait le moteur pret des que le
   * port etait assigne, ce qui arrive AVANT la verification. Une requete pendant
   * le chargement partait alors vers une socket que personne n'avait verifiee. */
  private verified = false;
  private starting: Promise<void> | null = null;
  private stopped = false;
  /** Voir le troisieme bandeau. Tiree a chaque lancement, jamais persistee. */
  private key = "";
  private deps: LlamaServerDeps;

  constructor(deps: LlamaServerDeps) {
    this.deps = deps;
  }

  /** Ce que le fournisseur lit. "" tant que rien de verifie n'ecoute. */
  baseUrl(): string {
    return this.proc && this.port && this.verified ? `http://127.0.0.1:${this.port}` : "";
  }

  /** Le laissez-passer du lancement en cours. "" quand rien ne tourne, ce qui
   * fait que le fournisseur n'envoie pas d'en-tete vide a un serveur absent. */
  apiKey(): string {
    return this.baseUrl() ? this.key : "";
  }

  /** Le binaire ET le modele sont la. Deux `existsSync`, jamais un lancement :
   * cette question est posee par des pages et par des sondes. */
  ready(): boolean {
    try {
      return fs.existsSync(this.deps.binPath()) && fs.existsSync(this.deps.modelPath());
    } catch {
      return false;
    }
  }

  /** Demarrage idempotent ; les appelants concurrents partagent le meme. */
  ensureStarted(): Promise<void> {
    if (this.baseUrl()) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!this.ready()) throw new Error("llama-server or its model is not installed");
    this.stopped = false;
    this.port = await findFreePort(PORT_START, PORT_END);
    this.key = crypto.randomBytes(32).toString("hex");
    const args = [
      "--model",
      this.deps.modelPath(),
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port),
      // Le transcript d'une reunion d'une heure est long. 8192 jetons est ce que
      // le decoupage en morceaux de longform suppose deja.
      "--ctx-size",
      "8192",
      // Rien d'autre n'a besoin de parler a ce serveur.
      "--no-webui",
    ];
    const proc = this.deps.spawnProc
      ? this.deps.spawnProc(this.deps.binPath(), args)
      : spawn(this.deps.binPath(), args, {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          // Il n'a aucun usage des identifiants de qui que ce soit. La seule
          // chose qu'on lui AJOUTE est son propre laissez-passer, et il passe
          // par l'environnement plutot que par `--api-key` DELIBEREMENT : une
          // ligne de commande se lit depuis n'importe quel autre processus
          // (`wmic process get commandline`), ce qui aurait rendu la clef
          // publique sur la machine meme et le controle decoratif.
          env: { ...childEnv(), LLAMA_API_KEY: this.key },
        });
    proc.stderr?.on("data", (d: Buffer) => {
      this.deps.log?.(`[llama-server] ${String(d).trim().slice(0, 300)}`);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.port = 0;
      this.verified = false;
      this.key = "";
      if (!this.stopped) this.deps.log?.(`[llama-server] exited (${code})`);
    });
    this.proc = proc;
    await this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error("llama-server died during startup");
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(
          { hostname: "127.0.0.1", port: this.port, path: "/health", timeout: 1500 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) {
        // La verification de propriete, AVANT de declarer quoi que ce soit pret.
        // Le drapeau est pose ici, la ou la question est repondue, et pas a la
        // fin du demarrage : le poser plus tard a deja provoque une recursion
        // dans asr/sidecar.ts, ou la sonde de decodage relancait un sidecar.
        const owner = await socketOwnedBy(this.port, this.proc?.pid, { log: this.deps.log });
        this.verified = true;
        if (owner === false) {
          this.deps.log?.(
            `[llama-server] REFUSE: un autre processus possede le port ${this.port}. Rien ne lui est envoye.`,
          );
          this.hardStop();
          throw new Error(`another process owns port ${this.port}`);
        }
        if (owner === null) {
          // Dit a voix haute plutot qu'avale : un controle qui n'a pas pu
          // s'executer n'a pas reussi.
          this.deps.log?.(
            `[llama-server] impossible de confirmer que le port ${this.port} appartient au processus lance`,
          );
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.hardStop();
    throw new Error("llama-server did not become ready in 120 s (model load)");
  }

  private hardStop(): void {
    const p = this.proc;
    this.proc = null;
    this.port = 0;
    this.verified = false;
    this.key = "";
    if (p?.pid) killTree(p.pid);
  }

  /** A la fermeture de l'application. Sans ceci, un llama-server garde la VRAM
   * apres que Flow soit parti. */
  stop(): void {
    this.stopped = true;
    this.hardStop();
  }
}
