import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFlowClient } from "../src/main/data/client";
import { Repo } from "../src/main/data/repo";

// ---------------------------------------------------------------------------
// A3 : le depot, essaye contre le VRAI projet.
//
// POURQUOI CE TEST EXISTE ALORS QUE LE TYPECHECK PASSE. TypeScript ne connait
// pas le schema : `from("dictionary").insert({ term: ... })` compile aussi bien
// avec `term` qu'avec `terme`, et un nom de colonne errone ne se voit qu'a
// l'execution - au moment ou quelqu'un ajoute un mot a son dictionnaire et ou
// rien ne se passe. C'est exactement la panne que Roch a signalee sur le
// dictionnaire local il y a deux jours, et la seule facon de ne pas la
// reproduire est d'ecrire une vraie ligne dans une vraie table.
//
// Il se tait sans les identifiants de test, comme la preuve d'isolation, et
// pour les memes raisons - avec la meme reserve : un test qui peut se taire
// peut se taire pour toujours.
// ---------------------------------------------------------------------------

function creds(): { email: string; password: string } | null {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  } catch {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].trim();
  }
  return env.FLOW_TEST_A_EMAIL && env.FLOW_TEST_A_PASSWORD
    ? { email: env.FLOW_TEST_A_EMAIL, password: env.FLOW_TEST_A_PASSWORD }
    : null;
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const C = creds();

test(
  "A3: chaque table du depot accepte vraiment ce que Flow lui envoie",
  { skip: C ? false : "FLOW_TEST_A_* absent de .env - les noms de colonnes N'ONT PAS ete confrontes au schema" },
  async () => {
    const c = C as { email: string; password: string };
    const client = createFlowClient({ storage: memoryStorage() });
    const sess = await client.auth.signInWithPassword(c);
    assert.equal(sess.error, null, `connexion impossible : ${sess.error?.message}`);
    const repo = new Repo({ client });

    const marker = "repo-live-" + String(sess.data.session?.user.id ?? "").slice(0, 8);
    const dictId = "00000000-0000-4000-8000-00000000beef";

    try {
      // --- ecrire dans les quatre magasins -------------------------------
      const w1 = await repo.saveSettings({ marker, language: "fr" });
      assert.equal(w1.ok, true, `settings: ${w1.error}`);

      const w2 = await repo.upsertDictEntry({
        id: dictId,
        term: marker,
        aliases: ["alias-un", "alias-deux"],
        kind: "vocabulary",
        starred: true,
        createdIso: new Date(0).toISOString(),
      });
      assert.equal(w2.ok, true, `dictionary: ${w2.error}`);

      const w3 = await repo.saveStatsDay({ date: "2001-01-02", words: 7, ms: 1234, utterances: 2 });
      assert.equal(w3.ok, true, `stats_days: ${w3.error}`);

      const w4 = await repo.addDictation({ at: 86_400_000, text: marker, truncated: true });
      assert.equal(w4.ok, true, `dictations: ${w4.error}`);

      // --- et tout relire d'un coup, comme a la connexion -----------------
      const all = await repo.loadAll();
      assert.equal(all.ok, true, `loadAll: ${all.error}`);
      assert.equal(all.data.settings.marker, marker, "les reglages doivent revenir tels quels");

      const term = all.data.dictionary.find((d) => d.id === dictId);
      assert.ok(term, "le terme ecrit doit revenir");
      // L'aller-retour COMPLET, pas seulement l'existence : un tableau
      // d'alias mal converti se lirait comme un terme sans alias, ce qui est
      // precisement une entree de dictionnaire qui ne fait rien.
      assert.deepEqual(term.aliases, ["alias-un", "alias-deux"]);
      assert.equal(term.kind, "vocabulary");
      assert.equal(term.starred, true);

      const day = all.data.stats.find((d) => d.date === "2001-01-02");
      assert.ok(day, "la journee de statistiques doit revenir");
      assert.equal(day.words, 7);
      assert.equal(day.ms, 1234);
      // `apps` ABSENT et pas `{}` : la difference entre « on ne mesurait pas »
      // et « on mesurait et il n'y avait rien ».
      assert.equal("apps" in day, false, "apps ne doit pas etre invente");

      const dictee = all.data.dictations.find((d) => d.text === marker);
      assert.ok(dictee, "la dictee doit revenir");
      assert.equal(dictee.at, 86_400_000, "l'instant doit survivre a l'aller-retour");
      assert.equal(dictee.truncated, true);

      // --- l'ecrasement, qui est la regle des statistiques ----------------
      await repo.saveStatsDay({ date: "2001-01-02", words: 99, ms: 1, utterances: 1 });
      const again = await repo.loadAll();
      assert.equal(again.data.stats.find((d) => d.date === "2001-01-02")?.words, 99);
    } finally {
      await repo.deleteDictEntry(dictId);
      await repo.clearDictations();
      await repo.clearStats();
      await client.from("settings").delete().eq("user_id", sess.data.session?.user.id ?? "");
      await client.auth.signOut({ scope: "local" });
    }
  },
);
