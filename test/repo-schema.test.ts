import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// A3 : les colonnes que le depot ecrit existent-elles VRAIMENT ?
//
// POURQUOI CETTE PORTE EXISTE ALORS QUE LE TYPECHECK PASSE. TypeScript ne
// connait pas le schema : `from("dictionary").insert({ term: ... })` compile
// aussi bien avec `term` qu'avec `terme`. Un nom errone ne se voit qu'a
// l'execution - au moment ou quelqu'un ajoute un mot a son dictionnaire et ou
// rien ne se passe. C'est exactement la panne que Roch a signalee sur le
// dictionnaire local il y a deux jours.
//
// POURQUOI ELLE N'EST PAS LE TEST VIVANT. Il existe aussi (repo-live.test.ts),
// il ecrit de vraies lignes dans un vrai compte, et il est meilleur : lui seul
// prouve qu'une valeur SURVIT a l'aller-retour. Mais il a besoin de deux
// comptes jetables et il SE TAIT quand ils manquent - ce qui est le cas des
// que Roch fait le menage. Un test qui peut se taire peut se taire pour
// toujours.
//
// Celle-ci ne se tait jamais : elle lit la migration commitee et le code du
// depot, et compare. Elle ne prouve pas que Supabase accepte la ligne ; elle
// prouve que les deux fichiers du depot parlent de la meme base.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, "..");

/** Les colonnes declarees par la premiere migration, table par table. */
function schemaColumns(): Map<string, Set<string>> {
  const dir = path.join(ROOT, "supabase", "migrations");
  const sql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");

  const out = new Map<string, Set<string>>();
  const tableRe = /create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(sql)) !== null) {
    const cols = new Set<string>();
    for (const line of m[2].split("\n")) {
      const t = line.trim();
      // Les lignes de contrainte de table (primary key (...), check (...))
      // ne declarent pas de colonne.
      if (!t || t.startsWith("--") || /^(primary key|unique|check|constraint|foreign key)\b/i.test(t)) continue;
      const c = /^(\w+)\s/.exec(t);
      if (c) cols.add(c[1]);
    }
    out.set(m[1], cols);
  }
  return out;
}

/** Les colonnes que repo.ts ecrit, table par table.
 *
 * Lit le SOURCE plutot que d'appeler les methodes : les appeler demanderait un
 * client, donc un reseau, donc les identifiants dont on essaie justement de se
 * passer. */
function repoColumns(): Map<string, Set<string>> {
  const src = fs.readFileSync(path.join(ROOT, "src", "main", "data", "repo.ts"), "utf8");
  const out = new Map<string, Set<string>>();
  // `.from("table")` suivi, dans les ~800 caracteres qui suivent, d'un objet
  // litteral d'insertion ou de mise a jour.
  const re = /\.from\("(\w+)"\)\s*\n?\s*\.(?:upsert|insert)\(\s*\{([\s\S]{0,900}?)\}\s*,?\s*(?:\{[^}]*\})?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const set = out.get(m[1]) ?? new Set<string>();
    // Une cle en debut de ligne : `user_id,` (raccourci) ou `term: e.term`.
    for (const line of m[2].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("*")) continue;
      const k = /^(\w+)\s*[,:]/.exec(t);
      if (k) set.add(k[1]);
    }
    out.set(m[1], set);
  }
  return out;
}

test("A3: la migration declare bien les six tables du produit", () => {
  const schema = schemaColumns();
  for (const t of ["settings", "dictionary", "stats_days", "dictations", "recordings", "live_notes"]) {
    assert.ok(schema.has(t), `table absente de la migration : ${t}`);
  }
});

test("A3: chaque colonne que le depot ECRIT existe dans le schema", () => {
  const schema = schemaColumns();
  const repo = repoColumns();
  assert.ok(repo.size >= 4, "l'analyse du depot n'a rien trouve - la regex a cesse de correspondre au code");

  for (const [table, cols] of repo) {
    const known = schema.get(table);
    assert.ok(known, `le depot ecrit dans une table qui n'existe pas : ${table}`);
    for (const c of cols) {
      assert.ok(known.has(c), `${table}.${c} n'existe pas dans la migration`);
    }
  }
});

test("A3: le depot ne lit et n'ecrit AUCUNE table hors du schema", () => {
  // Attrape la faute de frappe dans le nom de table, que la porte precedente
  // ne verrait pas sur un `select` (elle ne regarde que les ecritures).
  const schema = schemaColumns();
  const src = fs.readFileSync(path.join(ROOT, "src", "main", "data", "repo.ts"), "utf8");
  const tables = new Set([...src.matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1]));
  assert.ok(tables.size > 0);
  for (const t of tables) {
    assert.ok(schema.has(t), `table inconnue du schema : ${t}`);
  }
});
