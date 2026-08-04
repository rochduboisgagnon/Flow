import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { childEnv } from "../shared/childEnv";

// ---------------------------------------------------------------------------
// 2026-08-04 : LE SILENCE PENDANT UNE DICTEE.
//
// Roch : « quand le raccourci est active et que le speech-to-text est en
// fonction, tous les bruits et les sons de toutes les applications de
// l'ordinateur sont muets jusqu'a ce que le raccourci soit lache. »
//
// Ce fichier ne coupe rien lui-meme. Il parle a `flow-mute.exe`
// (native/flow-mute/flow-mute.cpp), qui vit dans son propre processus - le
// raisonnement de cette separation est dans le bandeau du .cpp, et il tient en
// une phrase : le processus principal porte le crochet clavier, et une violation
// d'acces dans du code natif charge ici ne ralentirait pas la dictee, elle la
// tuerait au milieu d'une phrase.
//
// ---------------------------------------------------------------------------
// TROIS REGLES, ET LA PREMIERE EST LA SEULE QUI COMPTE VRAIMENT
// ---------------------------------------------------------------------------
//
//  1. RIEN ICI NE PEUT RETENIR UNE DICTEE. Chaque appel est une ecriture dans un
//     tuyau et rend la main tout de suite : pas d'attente, pas de promesse a
//     tenir, aucune valeur de retour a verifier. Si le helper est absent, lent ou
//     mort, la dictee part exactement comme avant - la seule difference est que
//     le son des autres applications continue.
//  2. LE HELPER EST LANCE UNE FOIS, PARESSEUSEMENT. Lancer un processus par
//     pression couterait des dizaines de millisecondes et attirerait l'antivirus
//     a chaque dictee (Bitdefender tourne sur cette machine). Il est donc lance a
//     la premiere dictee et vit aussi longtemps que Flow.
//  3. LE RETABLISSEMENT NE DEPEND PAS DE CE FICHIER. `unmute()` est appele sur
//     les trois fins possibles d'une dictee, mais le vrai filet est ailleurs :
//     quand Flow meurt - proprement, ou en plantant - le tuyau se ferme, le
//     helper lit une fin de fichier et retablit avant de sortir. Un processus qui
//     meurt n'execute plus rien ; celui-la n'est pas celui qui meurt.
//
// ---------------------------------------------------------------------------
// CE QUI N'EST PAS COUPE, ET C'EST DELIBERE : L'ENREGISTREMENT LONGUE DUREE
// ---------------------------------------------------------------------------
//
// Une reunion enregistree peut MELANGER le son du PC (un appel visio) avec le
// microphone : c'est une fonctionnalite, cochee sur la page Record. Couper le son
// des applications pendant une heure d'enregistrement detruirait exactement ce
// que l'utilisateur a demande de capturer. Le silence est donc reserve a la
// DICTEE, qui dure quelques secondes et n'enregistre que la voix.
// ---------------------------------------------------------------------------

export interface AudioDuckDeps {
  /** Le chemin de `flow-mute.exe`. Resolu par l'appelant (main/resources.ts) :
   * ce module ne sait pas ou vivent les ressources. */
  helperPath(): string;
  /** Le chemin de l'executable de Flow, A EPARGNER. Passe au helper plutot que
   * devine par lui : voir le bandeau du .cpp sur le service audio de Chromium,
   * qui joue le son de Flow depuis un AUTRE processus lance du meme fichier. */
  selfExePath(): string;
  log?(msg: string): void;
}

export class AudioDuck {
  private deps: AudioDuckDeps;
  private proc: ChildProcess | null = null;
  /** Le helper est-il introuvable ou mort-ne ? Dit UNE fois, puis on n'essaie
   * plus : un journal qui repete la meme ligne a chaque dictee est du bruit. */
  private unavailable = false;
  private muted = false;

  constructor(deps: AudioDuckDeps) {
    this.deps = deps;
  }

  /** Coupe le son des autres applications. Rend la main immediatement. */
  mute(): void {
    if (this.muted) return;
    this.muted = true;
    this.send("mute");
  }

  /** Retablit ce qui a ete coupe. Appelable sans avoir coupe : sans effet. */
  unmute(): void {
    if (!this.muted) return;
    this.muted = false;
    this.send("unmute");
  }

  /** A la fermeture de Flow. Fermer le tuyau SUFFIT - le helper retablit sur la
   * fin de fichier - mais le dire explicitement rend l'intention lisible et
   * couvre le cas ou le helper serait bloque en lecture. */
  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.muted = false;
    if (!p) return;
    try {
      p.stdin?.write("quit\n");
      p.stdin?.end();
    } catch {
      /* deja parti */
    }
  }

  private send(cmd: "mute" | "unmute"): void {
    const p = this.ensure();
    if (!p?.stdin?.writable) return;
    try {
      p.stdin.write(cmd + "\n");
    } catch (err) {
      // Une ecriture qui echoue veut dire que le helper est parti. On le note et
      // on laisse tomber : la prochaine dictee en relancera un.
      this.deps.log?.(`[mute] la commande n'est pas passee : ${err}`);
      this.proc = null;
    }
  }

  private ensure(): ChildProcess | null {
    if (this.proc) return this.proc;
    if (this.unavailable) return null;
    const bin = this.deps.helperPath();
    if (!bin || !fs.existsSync(bin)) {
      this.unavailable = true;
      this.deps.log?.(
        "[mute] flow-mute.exe est absent : le son des autres applications n'est pas coupe pendant une dictee. Tout le reste fonctionne.",
      );
      return null;
    }
    try {
      const p = spawn(bin, [this.deps.selfExePath()], {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        // UN ENVIRONNEMENT NETTOYE, et ce n'est pas de la ceremonie : un garde-fou
        // de ce depot (test/child-env.test.ts) exige que chaque site de `spawn`
        // en passe un, et il vient de m'attraper ici. Ce helper n'a l'usage
        // d'aucune variable ; lui transmettre l'environnement complet ferait
        // voyager les clefs de la machine vers un processus qui n'en a que faire.
        env: childEnv(),
      });
      p.stderr?.on("data", (d: Buffer) => this.deps.log?.(`[mute] ${String(d).trim().slice(0, 200)}`));
      p.on("exit", (code) => {
        if (this.proc !== p) return;
        this.proc = null;
        this.muted = false;
        if (code !== 0) this.deps.log?.(`[mute] flow-mute s'est arrete (${code})`);
      });
      // Une erreur de lancement (fichier corrompu, refus de l'antivirus) arrive
      // en evenement, pas en exception : sans ce gestionnaire elle deviendrait
      // une exception non capturee dans le processus qui porte le crochet.
      p.on("error", (err) => {
        if (this.proc === p) this.proc = null;
        this.unavailable = true;
        this.deps.log?.(`[mute] flow-mute n'a pas pu etre lance : ${err}`);
      });
      this.proc = p;
      return p;
    } catch (err) {
      this.unavailable = true;
      this.deps.log?.(`[mute] flow-mute n'a pas pu etre lance : ${err}`);
      return null;
    }
  }
}
