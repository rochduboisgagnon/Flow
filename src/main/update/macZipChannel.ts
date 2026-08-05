import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawn } from "node:child_process";
import { childEnv } from "../../shared/childEnv";
import { fetchToFile } from "../net/fetchVerified";
import {
  MAC_MANIFEST_URL,
  githubReleaseRedirectAllowed,
  parseMacManifest,
  type MacManifestVerdict,
} from "./macManifest";
import type { ChannelEvent, CheckOutcome, UpdateChannel } from "./channel";

// ---------------------------------------------------------------------------
// 2026-08-04 : LA MISE A JOUR macOS, SANS CERTIFICAT.
//
// Roch : « j'aimerais faire en sorte que l'app sur macOS se update sans devoir
// installer l'ancienne version. »
//
// electron-updater est hors jeu ici : Squirrel.Mac exige une signature Developer
// ID, et la decision de Roch est qu'aucun certificat ne sera achete. Ce canal fait
// donc le travail lui-meme : lire un manifeste, telecharger un zip, verifier son
// empreinte, le detendre avec ditto, INSPECTER ce qui en sort, puis - et seulement
// quand le sas calme de FlowUpdater le permet - echanger le bundle par un script
// detache et relancer.
//
// CE QUE CE CANAL NE DECIDE PAS : quand installer. C'est la politique, elle vit
// dans updater.ts, et elle est la meme que sur Windows - jamais pendant une dictee
// ou un enregistrement. Ce fichier ne fait qu'annoncer « pret » et obeir.
//
// ---------------------------------------------------------------------------
// L'ORDRE, ET POURQUOI C'EST CELUI-LA
// ---------------------------------------------------------------------------
//
//  1. le dossier parent est-il inscriptible ? AVANT de telecharger 200 Mo.
//  2. fetchToFile vers <nom>.zip.part, empreinte calculee au fil de l'arrivee
//  3. taille exacte, puis EMPREINTE COMPAREE AVANT LE RENOMMAGE. La raison est
//     deja ecrite dans modelStore.ts et s'applique mot pour mot : verifier apres
//     voudrait dire que le fichier non verifie a deja pris le nom sous lequel
//     quelque chose le charge. Ici, ce qui le charge est ditto.
//  4. ditto -x -k, en spawn et JAMAIS execSync : ce processus porte le crochet
//     clavier, et un execSync de 200 Mo le gelerait aussi longtemps que la
//     decompression.
//  5. inspection du bundle detendu. C'est le jumeau applicatif de l'etape
//     « Inspect the artifact BEFORE handing it over » du workflow, et ce n'est pas
//     optionnel : la lecon de la 1.22.0 est qu'un paquet peut se lancer, dicter,
//     et ne jamais rendre de notes.
//  6. seulement alors : l'evenement « downloaded », qui demarre le sas calme.
// ---------------------------------------------------------------------------

/** Le dossier de travail, dans ~/.flow : il SURVIT au remplacement du bundle
 * (mesure : dataDir() derive de os.homedir()), ce qui est ce qui rend la reprise
 * apres un plantage possible. */
function updateDir(dataDir: string): string {
  return path.join(dataDir, "update");
}

export interface MacZipChannelDeps {
  /** ~/.flow */
  dataDir(): string;
  /** app.getVersion() */
  currentVersion(): string;
  /** app.getPath("exe") : .../Flow.app/Contents/MacOS/Flow */
  exePath(): string;
  /** resourcePath("mac-swap.sh") */
  swapScriptSource(): string;
  log(msg: string): void;
  /** app.quit() : la fermeture NORMALE, celle qui passe par before-quit et ses
   * sauvetages synchrones. Jamais app.exit(). */
  quit(): void;
}

/** Le bundle .app depuis le chemin de l'executable. */
export function bundleFromExe(exe: string): string {
  // .../Flow.app/Contents/MacOS/Flow -> .../Flow.app
  return path.resolve(exe, "..", "..", "..");
}

export class MacZipChannel implements UpdateChannel {
  readonly kind = "mac-zip";
  private deps: MacZipChannelDeps;
  private emit: (e: ChannelEvent) => void = () => {};
  /** Le bundle detendu et INSPECTE, pret a prendre la place. */
  private staged: { dir: string; version: string } | null = null;
  /** Le script est arme : ni deux fois, ni une fois de trop au moment du quit. */
  private swapArmed = false;
  private working = false;

  constructor(deps: MacZipChannelDeps) {
    this.deps = deps;
  }

  onEvent(cb: (e: ChannelEvent) => void): void {
    this.emit = cb;
  }

  /** Y a-t-il un bundle verifie qui attend ? Lu par le crochet `will-quit`, qui
   * est l'equivalent macOS d'autoInstallOnAppQuit : il rattrape une mise a jour
   * que le sas calme n'a jamais pu installer, quand l'utilisateur ferme a la main. */
  hasStagedUpdate(): boolean {
    return this.staged !== null && !this.swapArmed;
  }

  async check(): Promise<CheckOutcome> {
    if (this.working) return { ok: true, available: true, version: this.staged?.version ?? "" };
    if (this.staged) return { ok: true, available: true, version: this.staged.version };
    this.emit({ kind: "checking" });
    let raw: string;
    try {
      raw = await this.getText(MAC_MANIFEST_URL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // UN 404 N'EST PAS UNE ERREUR, et c'est une decision. Le job macOS tourne
      // APRES le job Windows sur le meme tag : entre les deux, la release existe
      // sans son manifeste mac. Afficher un message rouge pendant quinze minutes
      // pour une condition normale que Roch ne peut pas corriger serait le
      // contraire d'un diagnostic utile. Le client repasse dans quatre heures.
      if (/HTTP 404/.test(msg)) {
        this.deps.log("[updater] aucun paquet macOS publie pour la derniere version (normal si la release est fraiche)");
        this.emit({ kind: "not-available", version: this.deps.currentVersion() });
        return { ok: true, available: false, version: this.deps.currentVersion() };
      }
      this.emit({ kind: "error", message: msg });
      return { ok: false, message: msg };
    }

    const v: MacManifestVerdict = parseMacManifest(raw, this.deps.currentVersion(), process.arch);
    if (!v.ok) {
      // Un refus normal (rien de plus recent) et un refus anormal (document
      // malforme) se distinguent par le motif, et seul le second est une erreur.
      if (/rien de plus recent/.test(v.reason)) {
        this.emit({ kind: "not-available", version: this.deps.currentVersion() });
        return { ok: true, available: false, version: this.deps.currentVersion() };
      }
      this.deps.log(`[updater] manifeste macOS refuse : ${v.reason}`);
      this.emit({ kind: "error", message: v.reason });
      return { ok: false, message: v.reason };
    }

    this.emit({ kind: "available", version: v.version });
    // Pas attendu : le telechargement est du travail de fond, exactement comme
    // autoDownload sur Windows. Les evenements portent la suite.
    void this.download(v);
    return { ok: true, available: true, version: v.version };
  }

  install(): void {
    const staged = this.staged;
    if (!staged) {
      this.deps.log("[updater] install() sans bundle pret : rien a echanger");
      return;
    }
    if (this.swapArmed) return;
    const target = bundleFromExe(this.deps.exePath());
    let script: string;
    try {
      script = this.copyScript();
    } catch (err) {
      this.deps.log(`[updater] impossible de preparer le script d'echange : ${String(err)}`);
      this.emit({ kind: "error", message: "le script d'echange n'a pas pu etre prepare" });
      return;
    }
    const logFile = path.join(updateDir(this.deps.dataDir()), "swap.log");
    this.deps.log(`[updater] echange arme pour la version ${staged.version} ; journal : ${logFile}`);

    // L'ORDRE COMPTE, et il est asserte par un test. Le script est arme AVANT
    // qu'on demande la fermeture : un processus deja sorti ne peut plus rien
    // lancer, et « probablement encore vivant » n'est pas une garantie qu'on paie
    // quoi que ce soit a supprimer.
    const child = spawn("/bin/sh", [script, String(process.pid), staged.dir, target, logFile], {
      detached: true, // nouveau groupe de processus : pas tue avec le notre
      stdio: "ignore", // aucun tuyau qui garde une poignee sur nous
      env: childEnv(),
    });
    child.unref();
    this.swapArmed = true;

    // Et seulement ensuite, la fermeture NORMALE : celle qui passe par before-quit
    // et ses sauvetages synchrones. Jamais app.exit(), qui les sauterait.
    this.deps.quit();
  }

  /** Nettoie ce qu'un lancement precedent a laisse : un telechargement mort au
   * milieu, un bundle detendu jamais echange. Appele au demarrage, jamais sur le
   * chemin d'une dictee. */
  sweep(): void {
    const dir = updateDir(this.deps.dataDir());
    const week = 7 * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name === "swap.log") continue; // le journal survit : c'est lui qu'on lit apres coup
        const p = path.join(dir, name);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs < week) continue;
          fs.rmSync(p, { recursive: true, force: true });
          this.deps.log(`[updater] menage : ${name}`);
        } catch {
          /* un fichier qu'on n'arrive pas a retirer n'est pas une panne */
        }
      }
    } catch {
      /* pas de dossier update : rien a nettoyer, l'etat normal */
    }
    // Les bundles detendus vivent A COTE de l'application, pas dans ~/.flow (le mv
    // final doit etre un renommage et non une copie inter-volumes). Ils s'appellent
    // tous .Flow-update-*, donc ils se ramassent sans deviner.
    try {
      const parent = path.dirname(bundleFromExe(this.deps.exePath()));
      for (const name of fs.readdirSync(parent)) {
        if (!name.startsWith(".Flow-update-")) continue;
        try {
          fs.rmSync(path.join(parent, name), { recursive: true, force: true });
          this.deps.log(`[updater] menage : ${name}`);
        } catch {
          /* rien a faire de plus */
        }
      }
    } catch {
      /* dossier illisible : ce n'est pas au menage de s'en plaindre */
    }
  }

  // ---- le travail lui-meme -------------------------------------------------

  private async download(v: Extract<MacManifestVerdict, { ok: true }>): Promise<void> {
    this.working = true;
    try {
      const target = bundleFromExe(this.deps.exePath());
      const parent = path.dirname(target);
      // AVANT les 200 Mo. Sur un Mac gere, ou pour une application rangee
      // ailleurs, le dossier peut exiger une authentification. Telecharger pour
      // echouer ensuite serait faire attendre quelqu'un pour rien.
      try {
        fs.accessSync(parent, fs.constants.W_OK);
      } catch {
        const msg = `Flow ne peut pas ecrire dans ${parent} : deplacez-le dans votre dossier Applications personnel, ou mettez a jour a la main.`;
        this.deps.log(`[updater] ${msg}`);
        this.emit({ kind: "error", message: msg });
        return;
      }

      const dir = updateDir(this.deps.dataDir());
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, v.zip);
      const part = `${zip}.part`;

      const digest = await fetchToFile({
        url: v.url,
        dest: part,
        redirectAllowed: githubReleaseRedirectAllowed,
        onProgress: (pct) => this.emit({ kind: "progress", pct }),
        what: "macOS update",
      });

      const size = fs.statSync(part).size;
      if (size !== v.bytes) {
        fs.rmSync(part, { force: true });
        throw new Error(`taille inattendue : ${size} octets recus pour ${v.bytes} annonces`);
      }
      // LE CONTROLE QUI COMPTE, et il a lieu AVANT LE RENOMMAGE. Verifier apres
      // voudrait dire que les octets non verifies ont deja pris le nom sous lequel
      // ditto va les detendre.
      if (digest !== v.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`INTEGRITE : empreinte ${digest}, attendue ${v.sha256}`);
      }
      fs.renameSync(part, zip);

      const staging = path.join(path.dirname(target), `.Flow-update-${v.version}`);
      fs.rmSync(staging, { recursive: true, force: true });
      await this.ditto(zip, staging);

      const app = this.findBundle(staging);
      if (!app) throw new Error("l'archive ne contient pas de .app");
      this.inspect(app);

      // Le zip a fait son travail : 200 Mo qui ne servent plus a rien.
      fs.rmSync(zip, { force: true });
      this.staged = { dir: app, version: v.version };
      if (v.adhoc) {
        // « Prevenir », deuxieme moitie : la carte Home le dira aussi, mais le
        // journal doit porter la cause pour qui lit apres coup.
        this.deps.log(
          "[updater] paquet signe ad-hoc : macOS redemandera l'autorisation Accessibilite apres l'echange.",
        );
      }
      this.emit({ kind: "downloaded", version: v.version });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log(`[updater] mise a jour macOS abandonnee : ${msg}`);
      this.emit({ kind: "error", message: msg });
    } finally {
      this.working = false;
    }
  }

  /** `ditto -x -k` et pas `unzip`, et ce n'est pas une preference.
   *
   * Un .app Electron contient des liens symboliques STRUCTURELS
   * (Contents/Frameworks/Electron Framework.framework/Versions/Current -> A) et
   * des bits d'execution. Une decompression qui materialise un lien en fichier, ou
   * qui perd le +x de Contents/MacOS/Flow, produit un bundle qui echoue la
   * validation de signature et refuse de se lancer. ditto est l'outil d'Apple, et
   * c'est celui que Squirrel.Mac utilise lui-meme.
   *
   * En spawn, jamais execSync : ce processus porte le crochet clavier. */
  private ditto(zip: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn("/usr/bin/ditto", ["-x", "-k", zip, dest], { stdio: ["ignore", "ignore", "pipe"], env: childEnv() });
      let err = "";
      p.stderr?.on("data", (c: Buffer) => {
        err += c.toString();
      });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ditto a rendu ${code} : ${err.trim()}`))));
    });
  }

  private findBundle(staging: string): string | null {
    try {
      for (const name of fs.readdirSync(staging)) {
        if (name.endsWith(".app")) return path.join(staging, name);
      }
    } catch {
      /* rien */
    }
    return null;
  }

  /** Le jumeau applicatif de l'inspection du workflow.
   *
   * La lecon de la 1.22.0 : un paquet peut se lancer, dicter, et ne jamais rendre
   * de notes. Un echange qui installerait ca laisserait Roch avec une application
   * qui a l'air de marcher, ce qui est pire qu'une mise a jour refusee. */
  private inspect(app: string): void {
    const must = [
      "Contents/Info.plist",
      "Contents/MacOS/Flow",
      "Contents/Resources/bin/whisper-server-darwin-arm64",
      "Contents/Resources/bin/llama-server",
    ];
    for (const rel of must) {
      const p = path.join(app, rel);
      if (!fs.existsSync(p)) throw new Error(`le nouveau bundle est incomplet : ${rel} manque`);
    }
    // Un bit d'execution perdu echoue au spawn avec EACCES, une panne qui
    // ressemble a un fichier manquant.
    for (const rel of ["Contents/MacOS/Flow", "Contents/Resources/bin/llama-server"]) {
      try {
        fs.accessSync(path.join(app, rel), fs.constants.X_OK);
      } catch {
        throw new Error(`le nouveau bundle a perdu le bit d'execution sur ${rel}`);
      }
    }
  }

  /** Copie le script hors du bundle, avec un chmod explicite. Voir le bandeau de
   * resources/mac-swap.sh : `sh` lit son script de facon incrementale, donc un
   * script qui vit dans le bundle qu'il supprime peut se faire couper en deux. */
  private copyScript(): string {
    const dir = updateDir(this.deps.dataDir());
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, "mac-swap.sh");
    fs.copyFileSync(this.deps.swapScriptSource(), dst);
    fs.chmodSync(dst, 0o755);
    return dst;
  }

  private getText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            if (!githubReleaseRedirectAllowed(next)) {
              return reject(new Error(`refusing a manifest redirect off the pinned host: ${next}`));
            }
            return resolve(this.getText(next));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`manifest fetch failed: HTTP ${res.statusCode}`));
          }
          // Un manifeste fait quelques centaines d'octets. Le plafond est la pour
          // qu'une reponse inattendue ne remplisse pas la memoire du processus qui
          // porte le crochet clavier.
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            body += c;
            if (body.length > 64 * 1024) {
              res.destroy();
              reject(new Error("manifeste macOS invraisemblablement gros"));
            }
          });
          res.on("end", () => resolve(body));
          res.on("error", reject);
        })
        .on("error", reject);
    });
  }
}
