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

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("A3: UN SEUL fichier importe la bibliotheque Supabase", () => {
  // Z5 verifiait qu'aucun fichier ne l'importait encore. A2 a ecrit le premier
  // appelant, donc la regle devient celle d'A3, telle que le plan la formule :
  // « un module unique par lequel passe toute lecture et toute ecriture ».
  //
  // Ce n'est pas de l'esthetique. Quand tout passe par un point unique, une
  // question comme « est-ce qu'une ecriture peut bloquer le chemin chaud de la
  // dictee ? » a UN endroit ou se verifier. Repandue sur douze fichiers, la
  // meme question ne se verifie plus, elle se croit.
  const src = path.join(__dirname, "..", "src");
  const users = walk(src)
    .filter((f) => /from "@supabase\/supabase-js"/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(src, f).replace(/\\/g, "/"));
  assert.deepEqual(users, ["main/data/client.ts"]);
});

test("A2: aucune inscription, nulle part dans le code", () => {
  // Decision de Roch, 2026-08-03 : personne ne cree son compte, Roch les cree
  // un par un depuis la console. Une fonction d'inscription sans appelant
  // serait une porte fermee mais pas verrouillee - elle survit aux
  // refactorisations et se rebranche en une ligne.
  //
  // L'autre moitie de la regle est cote serveur, et c'est celle qui compte : la
  // clef publiable part dans l'installeur, donc n'importe qui peut poster vers
  // /auth/v1/signup sans passer par notre interface. VERIFIE le 2026-08-03
  // contre le vrai projet : la reponse est 422 signup_disabled, et les sessions
  // anonymes rendent 422 anonymous_provider_disabled.
  const src = path.join(__dirname, "..", "src");
  // Un APPEL, pas le mot : les commentaires de auth.ts expliquent longuement
  // pourquoi ce verbe n'existe pas, et une regle qui interdit d'en parler
  // interdit surtout d'expliquer.
  const offenders = walk(src)
    .filter((f) => /\.signUp\s*\(/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(src, f).replace(/\\/g, "/"));
  assert.deepEqual(offenders, [], "aucun appel a signUp ne doit exister");

  // Et la config commitee dit la meme chose, pour que le jour ou quelqu'un
  // relance `supabase config push` la porte ne se rouvre pas toute seule.
  //
  // LE DRAPEAU VISE EST CELUI DE LA SECTION [auth], ET SEULEMENT LUI. Il y a
  // trois `enable_signup` dans ce fichier et ils ne parlent pas de la meme
  // chose - celui de [auth.email] est en realite l'interrupteur du FOURNISSEUR
  // courriel. L'avoir mis a faux en croyant fermer les inscriptions a coupe la
  // connexion pour tout le monde (422 email_provider_disabled), c'est-a-dire la
  // seule facon d'entrer dans Flow. Une regle ecrite en cherchant le mot
  // partout aurait exige de refaire cette panne.
  const cfg = fs.readFileSync(path.join(__dirname, "..", "supabase", "config.toml"), "utf8");
  const authSection = cfg.split(/^\[auth\]$/m)[1]?.split(/^\[/m)[0] ?? "";
  assert.ok(authSection, "la section [auth] doit exister");
  assert.match(authSection, /^enable_signup = false$/m, "[auth] ne doit pas autoriser l'inscription");
  assert.match(authSection, /^enable_anonymous_sign_ins = false$/m, "ni les sessions anonymes");

  // Et l'inverse, qui est aussi une regle : le fournisseur courriel doit RESTER
  // allume, sinon plus personne ne se connecte.
  const emailSection = cfg.split(/^\[auth\.email\]$/m)[1]?.split(/^\[/m)[0] ?? "";
  assert.match(emailSection, /^enable_signup = true$/m, "le fournisseur courriel doit rester actif");
});
