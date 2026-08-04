const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const https = require("node:https");

// D1 : recupere llama-server, le TROISIEME binaire natif tiers de ce produit.
//
// Ecrit sur le patron exact de fetch-whisper.cjs, et pour la meme raison : ce
// binaire recoit le transcript ENTIER d'une reunion, donc il merite la meme
// discipline que whisper-server et WinKeyServer. Empreinte commitee, verifiee
// AVANT extraction, jamais apres.
//
// POURQUOI CE SCRIPT EXISTE. P9 a livre le fournisseur (main/llm/localSidecar.ts),
// les empreintes dans native-deps.json, et six tests. Il n'a livre ni le
// telechargement du binaire, ni son lanceur, ni le cablage - et la release
// 1.22.0 a annonce que l'invariant « un ami qui installe Flow a le produit
// complet » etait ferme. Il ne l'etait pas : la classe existait, rien ne
// l'appelait. Ce fichier est la premiere des trois pieces manquantes.
//
// L'EMPREINTE EPINGLEE A ETE VERIFIEE contre le vrai fichier le 2026-08-03 :
// 32,5 Mo telecharges, sha256 identique a celle du manifeste. Elle n'avait
// jamais ete confrontee au fichier avant.

const REPO = "ggml-org/llama.cpp";
const OUT_DIR = path.join(__dirname, "..", "resources", "bin");
// 2026-08-04, PORTAGE macOS. Deux differences avec Windows, et une seule compte :
// l'archive est un .tar.gz et le binaire n'a pas d'extension. Le reste - empreinte
// verifiee AVANT extraction, elagage de ce que Flow n'utilise pas - est identique,
// et doit l'etre : un binaire Mac non verifie serait la meme porte ouverte.
const MAC = process.platform === "darwin";
const EXE = path.join(OUT_DIR, MAC ? "llama-server" : "llama-server.exe");
// Les bibliotheques de calcul a garder : .dll sur Windows, .dylib sur macOS.
const LIB_RE = MAC ? /\.dylib$/i : /\.dll$/i;
const BIN_RE = MAC ? /^llama-server$/ : /\.exe$/i;

if (process.platform !== "win32" && !MAC) {
  console.log("[fetch-llama] windows and macOS only");
  process.exit(0);
}

if (fs.existsSync(EXE)) {
  console.log("[fetch-llama] already present:", EXE);
  process.exit(0);
}

/** GitHub limite les appels anonymes a 60 par heure PAR IP, et les runners
 * partagent les leurs avec le monde entier. Meme classe de panne que pour
 * whisper et keyspy, corrigee de la meme facon : envoyer le jeton quand
 * l'environnement en a un. */
function ghHeaders() {
  const h = { "User-Agent": "flow-fetch-llama" };
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: headers ?? ghHeaders() }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(res.headers.location, headers));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

(async () => {
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, "native-deps.json"), "utf8")).llama;
  // 2026-08-04 : L'ASSET DE CETTE PLATEFORME, et non le premier de la liste.
  //
  // Cette ligne prenait `Object.keys(...)[0]`, ce qui etait juste tant qu'il n'y
  // avait qu'un asset epingle. Depuis le portage il y en a deux, et le premier est
  // celui de Windows : sur macOS, ce script aurait telecharge un zip Windows,
  // verifie son empreinte avec succes, et livre un installeur Mac sans moteur de
  // redaction. Une panne qui aurait passe tous les controles.
  const tag = MAC ? "macos" : "win";
  const zipName = Object.keys(pinned.assets).find((n) => n.includes(tag));
  if (!zipName) throw new Error(`aucun asset llama epingle pour « ${tag} » dans native-deps.json`);
  const url = `https://github.com/${REPO}/releases/download/${pinned.version}/${zipName}`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`[fetch-llama] ${pinned.version} / ${zipName} ...`);
  fs.writeFileSync(zipPath, await get(url));

  // AVANT extraction, jamais apres : une archive qui echoue ce controle ne doit
  // pas avoir eu l'occasion d'ecrire un seul fichier dans resources/bin.
  execSync(`node "${path.join(__dirname, "verify-native-deps.cjs")}" llama "${zipPath}"`, {
    stdio: "inherit",
  });

  // Windows 10+ livre bsdtar dans System32, qui lit les zips. Le chemin ABSOLU
  // compte : Git Bash met le tar GNU en premier, et lui ne lit ni les zips ni
  // « C:\ ». Piege paye deux fois ailleurs dans ce depot.
  // Sur macOS le tar du systeme lit le .tar.gz sans piege ; sur Windows il faut le
  // bsdtar de System32 par chemin ABSOLU (Git Bash met le tar GNU en premier, et
  // lui ne lit ni les zips ni « C:\ »).
  const sysTar = MAC ? "tar" : path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execSync(`"${sysTar}" -xf "${zipName}"`, { stdio: "inherit", cwd: OUT_DIR });
  fs.unlinkSync(zipPath);

  // L'archive de llama.cpp deballe une arborescence : on remonte le binaire et ses
  // bibliotheques de calcul a plat dans resources/bin, la ou le lanceur les
  // cherchera. Les motifs dependent de la plateforme (BIN_RE / LIB_RE en tete de
  // fichier) : .exe + .dll sur Windows, un binaire sans extension + .dylib sur mac.
  if (!fs.existsSync(EXE)) {
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (BIN_RE.test(e.name) || LIB_RE.test(e.name)) found.push(p);
      }
    };
    walk(OUT_DIR);
    for (const p of found) {
      const dest = path.join(OUT_DIR, path.basename(p));
      if (p !== dest && !fs.existsSync(dest)) fs.renameSync(p, dest);
    }
  }
  if (!fs.existsSync(EXE)) throw new Error(`${path.basename(EXE)} absent apres extraction`);
  // Une archive ne porte pas toujours le bit d'execution, et un binaire non
  // executable echoue au `spawn` avec EACCES - une panne qui ressemble a un
  // fichier manquant. Sans effet sur Windows.
  if (MAC) fs.chmodSync(EXE, 0o755);

  // -------------------------------------------------------------------------
  // ELAGAGE, mesure du 2026-08-03.
  //
  // L'archive de llama.cpp deballe 54 fichiers, dont VINGT-DEUX executables
  // dont Flow n'a aucun usage : llama-cli, llama-bench, llama-tts,
  // llama-quantize, llama-imatrix, ggml-rpc-server... Ils partiraient dans
  // l'installeur, seraient signes avec lui, et resteraient sur le disque de
  // chaque utilisateur. `ggml-rpc-server.exe` merite d'etre nomme : il ouvre un
  // backend de calcul SUR LE RESEAU. Personne ne le lancerait volontairement, et
  // c'est exactement ce qu'on dit de tout binaire qui traine.
  //
  // CE QUE CET ELAGAGE N'EST PAS : une economie de place. Mesure : 28 fichiers
  // retires pour 6 Mo. Les executables de llama.cpp sont des lanceurs minces,
  // tout le poids vit dans les DLL de calcul qu'on garde. Ecrire ici « ca allege
  // l'installeur » serait faux, et c'est le genre de justification qu'on ne
  // reverifie jamais. L'argument est la SURFACE : vingt-deux executables de
  // moins a signer et a laisser sur la machine de quelqu'un.
  //
  // VERIFIE EN LE FAISANT, pas deduit d'une lecture de dependances : le jeu
  // elague charge Qwen2.5-3B en 2,3 s et repond une vraie completion, avec le
  // meme journal de demarrage que le jeu complet - meme backend, meme
  // comportement. La seule difference est ce qui n'est plus la.
  // -------------------------------------------------------------------------
  let removed = 0;
  let removedBytes = 0;
  const drop = (name) => {
    const p = path.join(OUT_DIR, name);
    removedBytes += fs.statSync(p).size;
    fs.unlinkSync(p);
    removed++;
  };

  // 1. Les executables de llama.cpp, sauf le seul qu'on lance. Les binaires de
  //    whisper vivent dans le meme dossier et ne portent pas ces prefixes.
  const keep = path.basename(EXE);
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name === keep) continue;
    // Sur macOS les outils n'ont pas d'extension : « llama-cli », « llama-bench »,
    // « rpc-server ». Le motif nomme donc les PREFIXES, sans dependre d'une
    // extension qui n'existe pas.
    const isTool = MAC
      ? /^(llama|ggml|rpc)([-.].*)?$/.test(name) && !LIB_RE.test(name)
      : /^(llama|ggml)([-.].*)?\.exe$/i.test(name);
    if (isTool) drop(name);
  }
  // 2. PUIS les `X-impl.dll` devenus orphelins - l'ordre compte, leur `X.exe`
  //    existait encore pendant le premier passage.
  const implRe = MAC ? /-impl(\.\d+)*\.dylib$/i : /-impl\.dll$/i;
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (!implRe.test(name)) continue;
    // Le binaire dont cette bibliotheque est l'implementation : « llama-cli-impl.dll »
    // -> « llama-cli.exe », « libllama-server-impl.dylib » -> « llama-server ».
    const owner = MAC
      ? name.replace(/^lib/, "").replace(implRe, "")
      : name.replace(implRe, ".exe");
    if (fs.existsSync(path.join(OUT_DIR, owner))) continue;
    drop(name);
  }
  console.log(`[fetch-llama] elague: ${removed} fichiers, ${(removedBytes / 1048576).toFixed(0)} Mo`);

  if (!fs.existsSync(EXE)) throw new Error(`l'elagage a retire ${path.basename(EXE)}`);
  console.log("[fetch-llama] ready:", EXE);
})().catch((e) => {
  console.error("[fetch-llama] FAILED:", e.message);
  process.exit(1);
});
