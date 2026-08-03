import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Z1 (refonte Supabase, 2026-08-03). Aucune cle de SERVICE ne doit exister dans
// un fichier suivi par git.
//
// Ce depot est PUBLIC. Un `.gitignore` protege des fichiers qu'on n'a pas voulu
// ajouter ; il ne protege de rien quand quelqu'un colle une cle dans un fichier
// source pour essayer quelque chose. Ce test est la deuxieme ligne, et c'est
// celle qui attrape la vraie erreur humaine.
//
// LA DISTINCTION QUI FAIT TOUT, et un test naif se tromperait dessus : Supabase
// donne trois valeurs, et DEUX d'entre elles ont le droit d'etre publiques.
//
//   URL du projet     public. Elle est dans l'installeur.
//   cle ANON          PUBLIQUE PAR CONCEPTION. Elle est dans l'installeur aussi,
//                     et c'est normal : ce qui protege les donnees est le Row
//                     Level Security, jamais le secret de cette cle.
//   cle de SERVICE    contourne le RLS. Elle ne doit exister que dans les Edge
//                     Functions. Jamais dans l'app, jamais dans le depot.
//
// Un test qui bannirait "toute chaine ressemblant a une cle Supabase" refuserait
// donc la cle anon, qu'on a le DROIT d'embarquer - et il serait desactive au
// premier faux positif. Il vise precisement la cle de service, dans ses deux
// formats.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, "..");

/** Le format recent : `sb_secret_...`. Le pendant public est `sb_publishable_`,
 * volontairement absent de cette liste. */
const SECRET_PREFIX = /\bsb_secret_[A-Za-z0-9_-]{8,}/;

/** Le format historique est un JWT, et l'anon en est un AUSSI : les deux
 * commencent par `eyJ`. Seule la charge utile les distingue, d'ou le decodage
 * plutot qu'une correspondance de surface. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

function isServiceRoleJwt(token: string): boolean {
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return /"role"\s*:\s*"service_role"/.test(json);
  } catch {
    return false;
  }
}

/** Ce que git suit REELLEMENT. Pas un parcours de dossier : un fichier ignore
 * n'est pas le sujet, et un fichier suivi mais range ailleurs l'est. */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

/** Les binaires n'ont pas de cle lisible et pesent le temps de lecture. */
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".ico", ".wav", ".woff2", ".ttf", ".zip", ".exe", ".bin", ".gz"]);

export function scanForServiceKeys(files: string[], read: (p: string) => string): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
    // Ce fichier-ci contient les motifs par necessite.
    if (rel.endsWith("test/no-service-key.test.ts")) continue;
    let text: string;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    if (SECRET_PREFIX.test(text)) {
      hits.push(`${rel}: une cle sb_secret_`);
      continue;
    }
    for (const m of text.match(JWT) ?? []) {
      if (isServiceRoleJwt(m)) {
        hits.push(`${rel}: un JWT dont le role est service_role`);
        break;
      }
    }
  }
  return hits;
}

test("Z1: aucun fichier suivi par git ne contient de cle de service Supabase", () => {
  const files = trackedFiles();
  assert.ok(files.length > 50, "git ls-files n'a presque rien rendu: le test ne mesure rien");
  const hits = scanForServiceKeys(files, (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8"));
  assert.deepEqual(hits, [], "une cle de service est dans un fichier suivi, et ce depot est public");
});

test("Z1: le scanner attrape une cle plantee expres, dans les deux formats", () => {
  // Sans ceci, le test ci-dessus serait vert sur un scanner casse, ce qui est
  // pire que pas de test: il donnerait une assurance qu'il ne fournit pas.
  const jwtHeader = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
  const jwtService = Buffer.from('{"iss":"supabase","role":"service_role"}').toString("base64url");
  const faux = {
    "a.ts": `const k = "sb_secret_abcdefghijklmnop";`,
    "b.ts": `const k = "${jwtHeader}.${jwtService}.zzzzzzzzzzzz";`,
  } as Record<string, string>;
  const hits = scanForServiceKeys(Object.keys(faux), (p) => faux[p]);
  assert.equal(hits.length, 2, "les deux formats doivent etre attrapes");
});

test("Z1: la cle ANON n'est PAS un echec - elle a le droit d'etre dans l'installeur", () => {
  // Le faux positif qui ferait desactiver ce test. La cle anon est un JWT, elle
  // commence par eyJ comme la cle de service, et elle est publique par
  // conception: ce qui protege les donnees est le RLS.
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
  const anon = Buffer.from('{"iss":"supabase","role":"anon"}').toString("base64url");
  const faux = { "c.ts": `const k = "${header}.${anon}.zzzzzzzzzzzz";` } as Record<string, string>;
  assert.deepEqual(scanForServiceKeys(Object.keys(faux), (p) => faux[p]), []);
});

test("Z1: .env est ignore par git, et .env.example ne l'est pas", () => {
  const ignored = (p: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored(".env"), true, "un .env cree pour Supabase partirait sur GitHub sans cette ligne");
  assert.equal(ignored("supabase/.temp/x"), true);
  assert.equal(ignored(".env.example"), false, "le gabarit sans valeurs doit rester versionnable");
});
