#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Compile native/flow-mute/flow-mute.cpp -> resources/bin/flow-mute.exe
//
// 2026-08-04. C'est le seul morceau de code natif que ce depot compile lui-meme :
// whisper-server, llama-server et keyspy sont telecharges depuis des releases,
// verifies par empreinte. Celui-ci fait 200 lignes et n'a aucune raison de vivre
// ailleurs que dans le depot qui l'utilise.
//
// ---------------------------------------------------------------------------
// IL NE FAIT PAS ECHOUER UNE CONSTRUCTION LOCALE, ET IL DOIT FAIRE ECHOUER UNE
// RELEASE
// ---------------------------------------------------------------------------
//
// Le meme partage que `ensure-keyspy.cjs`, pour la meme raison : une machine de
// developpement n'a pas forcement de compilateur C++, et `npm run build` doit y
// fonctionner - Flow degrade proprement sans ce binaire (main/audioDuck.ts le dit
// une fois dans le journal et la dictee continue). Un INSTALLEUR, lui, ne doit
// jamais partir sans lui : c'est la panne de la 1.22.0 sous une autre forme
// (« l'installeur ne portait pas llama-server, et la fonctionnalite n'existait
// donc pas chez l'utilisateur »). Le garde-fou est dans le workflow de release,
// qui verifie la presence du binaire dans le zip.
//
// Deux compilateurs acceptes, dans cet ordre : `clang++` puis `cl` (MSVC). Les
// runners GitHub windows-latest ont les deux ; cette machine n'a que clang++.
// ---------------------------------------------------------------------------
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "native", "flow-mute", "flow-mute.cpp");
const OUT_DIR = path.join(ROOT, "resources", "bin");
const OUT = path.join(OUT_DIR, "flow-mute.exe");

/** Le chemin complet d'un compilateur, ou "".
 *
 * Resolu par `where` puis appele SANS shell. Node avertit qu'un `shell: true`
 * avec des arguments les concatene au lieu de les echapper ; ces arguments-ci
 * sont tous ecrits ici, mais un chemin de depot contenant une espace suffirait a
 * casser la commande, ce qui est une raison suffisante de ne pas passer par un
 * shell du tout. */
function which(bin) {
  const r = spawnSync("where", [bin], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return "";
  return r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
}

function main() {
  if (process.platform !== "win32") {
    console.log("[build-mute] skipped: Windows only");
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error(`[build-mute] source missing: ${SRC}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const clang = which("clang++");
  const cl = clang ? "" : which("cl");
  if (clang) {
    // -municode : le point d'entree est wmain, donc les chemins Unicode passent
    // intacts. Un chemin d'installation avec un accent ferait echouer la
    // comparaison qui epargne Flow, ce qui couperait son propre son.
    execFileSync(clang, ["-O2", "-municode", "-o", OUT, SRC, "-lole32", "-loleaut32"], { stdio: "inherit" });
  } else if (cl) {
    execFileSync(cl, ["/nologo", "/O2", "/EHsc", `/Fe:${OUT}`, SRC, "ole32.lib", "oleaut32.lib"], {
      stdio: "inherit",
      cwd: path.join(ROOT, "native", "flow-mute"),
    });
  } else {
    // Pas une erreur : voir le bandeau. La release, elle, a son propre garde-fou.
    console.warn(
      "[build-mute] no C++ compiler found (clang++ or cl). flow-mute.exe will be missing,\n" +
        "             so other applications are NOT muted during a dictation. Everything else works.",
    );
    return;
  }
  const size = fs.statSync(OUT).size;
  console.log(`[build-mute] ${path.relative(ROOT, OUT)} (${size} bytes)`);
}

main();
