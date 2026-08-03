import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Z5 : la quatrieme dependance de Flow, et la seule epinglee au point.
//
// CE QU'ELLE APPORTE. `@supabase/supabase-js` est le client officiel : il
// detient la session de l'utilisateur, rafraichit son jeton, et fait passer
// TOUTE lecture et toute ecriture de ses donnees. Apres la refonte, il n'y a
// plus de disque a lire : s'il se trompe, Flow ne se trompe pas d'affichage,
// il se trompe de compte.
//
// POURQUOI CELLE-LA EST EPINGLEE AU POINT alors que les trois autres portent un
// accent circonflexe, ce qui est une incoherence assumee et pas un oubli : les
// trois autres font un travail que l'on VOIT echouer (le clavier ne repond
// plus, la mise a jour ne descend pas). Celle-ci fait un travail dont l'echec
// est silencieux et tardif - une session qui ne se rafraichit plus, une
// requete qui part sans en-tete d'autorisation. Un `^` invite npm a changer
// ca sans que rien dans le depot ne bouge.
//
// Le lock porte l'empreinte, comme pour les trois binaires natifs. Ici la porte
// verifie juste la chose que le lock ne peut pas dire : que la VERSION demandee
// est un point fixe, et pas une plage que le prochain `npm install` resoudra
// autrement.
// ---------------------------------------------------------------------------

function pkg(): { dependencies?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
}

test("Z5: le client Supabase est epingle au point, jamais a une plage", () => {
  const v = pkg().dependencies?.["@supabase/supabase-js"];
  assert.ok(v, "la dependance doit exister");
  assert.match(v, /^\d+\.\d+\.\d+$/, `version attendue exacte, recu "${v}"`);
});

test("Z5: le lock porte bien une empreinte pour ce paquet", () => {
  // Meme raison que pour whisper, llama et keyspy : une version nomme un
  // fichier, jamais ses octets. Seule une empreinte nomme les octets.
  const lock = fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8");
  const entry = JSON.parse(lock).packages?.["node_modules/@supabase/supabase-js"];
  assert.ok(entry, "le paquet doit etre dans le lock");
  assert.match(String(entry.integrity), /^sha\d+-/, "le lock doit porter une empreinte");
  assert.match(String(entry.version), /^\d+\.\d+\.\d+$/);
});

test("Z5: le client n'est pas encore appele - Z5 pose la dependance, rien d'autre", () => {
  // La discipline du plan : « les quatre portes passent avec la dependance en
  // place, AVANT qu'une seule ligne ne l'utilise ». Ce test tombera de lui-meme
  // quand A2 ecrira le module d'authentification, et c'est exactement le moment
  // ou il faudra le remplacer par la regle d'A3 : un seul fichier de src/ parle
  // a Supabase.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const src = path.join(__dirname, "..", "src");
  const users = walk(src).filter((f) => /@supabase\/supabase-js/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(users, [], "Z5 ne cable rien ; le premier appelant est A2");
});
