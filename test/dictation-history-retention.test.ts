import test from "node:test";
import assert from "node:assert/strict";
import { WorkingCopy } from "../src/main/data/workingCopy";
import { DictationHistoryStore } from "../src/main/dictationHistory";
import type { Repo, RepoResult, Snapshot } from "../src/main/data/repo";
import { RETENTION_DAYS, retentionCutoff, type HistoryEntry } from "../src/shared/dictationHistory";

// ---------------------------------------------------------------------------
// F3 / F9, apres B2 : la retention a change de place, pas de raison d'etre.
//
// D'OU ELLE VIENT. Le scan de securite du 2026-08-02 (constats F3 et F9). Flow
// ecrit ce que quelqu'un dicte : des mots de passe epeles, des adresses, des
// choses dites a un medecin. La promesse qui rend ca acceptable est qu'elles ne
// s'accumulent pas indefiniment - un mois glissant, et c'est tout.
//
// CE QUI A CHANGE. Elle etait une propriete du FICHIER : chaque ecriture de
// history.json purgeait en passant, et `start()` / `stop()` purgeaient meme sur
// une machine ou personne ne dicte jamais - c'etait exactement le cas que F3
// nommait. Le fichier a disparu avec B2 ; la purge ne devait pas disparaitre
// avec lui, et ces tests sont la pour que la disparition se voie si elle
// arrive.
//
// OU ELLE EST MAINTENANT. Au chargement du compte : le seul instant garanti de
// chaque session, y compris sur une machine ou personne ne dicte. Cote base,
// donc elle vaut aussi pour les lignes ecrites par l'AUTRE ordinateur - ce que
// la version fichier ne pouvait pas faire.
// ---------------------------------------------------------------------------

const OK = <T,>(data: T): RepoResult<T> => ({ ok: true, data, error: "" });
const KO = <T,>(data: T, error = "hors ligne"): RepoResult<T> => ({ ok: false, data, error });
const EMPTY: Snapshot = { settings: {}, dictionary: [], stats: [], dictations: [] };

function fakeRepo(over: Record<string, unknown> = {}) {
  const purges: number[] = [];
  const repo = {
    loadAll: () => Promise.resolve(OK(EMPTY)),
    purgeOldDictations: (now: number) => {
      purges.push(now);
      return Promise.resolve(OK(null));
    },
    saveSettings: () => Promise.resolve(OK(null)),
    upsertDictEntry: () => Promise.resolve(OK(null)),
    deleteDictEntry: () => Promise.resolve(OK(null)),
    saveStatsDay: () => Promise.resolve(OK(null)),
    addDictation: () => Promise.resolve(OK(null)),
    clearDictations: () => Promise.resolve(OK(null)),
    clearStats: () => Promise.resolve(OK(null)),
    reportWriteFailure: () => {},
    ...over,
  } as unknown as Repo;
  return { repo, purges };
}

const settle = () => new Promise((r) => setImmediate(r));

test("F3: charger le compte purge, meme si personne n'a jamais dicte sur cette machine", async () => {
  // Le cas exact du constat : un poste ou Flow tourne et ou personne ne dicte.
  // La version fichier purgeait au demarrage pour cette raison ; le chargement
  // du compte est l'equivalent, et il est garanti a chaque session.
  const f = fakeRepo();
  const wc = new WorkingCopy({ repo: f.repo, now: () => 1_000_000 });
  await wc.load();
  await settle();
  assert.deepEqual(f.purges, [1_000_000], "un chargement doit purger, une fois");
});

test("F3: la coupure est bien un mois glissant", () => {
  // La regle elle-meme n'a pas bouge, et c'est volontaire : B2 deplace la
  // retention, il ne la renegocie pas.
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(RETENTION_DAYS, 31);
  assert.equal(now - retentionCutoff(now), 31 * 24 * 60 * 60 * 1000);
});

test("F3: une purge qui ECHOUE ne casse pas la connexion et sera refaite", async () => {
  // Hors ligne au lancement, par exemple. La connexion doit reussir ; la purge
  // repartira au prochain chargement.
  const logs: string[] = [];
  const f = fakeRepo({ purgeOldDictations: () => Promise.resolve(KO(null)) });
  const wc = new WorkingCopy({ repo: f.repo, log: (m) => logs.push(m) });
  const r = await wc.load();
  await settle();
  assert.equal(r.ok, true, "la connexion reussit meme si la purge echoue");
  assert.equal(wc.isReady(), true);
  assert.match(logs.join(" "), /purge/, "et l'echec est dit, pas avale");
});

test("F3: la connexion N'ATTEND PAS la purge", async () => {
  // Une suppression cote base peut prendre du temps sur un gros compte, et
  // personne ne doit regarder un ecran de chargement pour ca.
  const held: Array<() => void> = [];
  const f = fakeRepo({
    purgeOldDictations: () => new Promise((res) => held.push(() => res(OK(null)))),
  });
  const wc = new WorkingCopy({ repo: f.repo });
  const r = await wc.load();
  assert.equal(r.ok, true, "load() rend la main pendant que la purge tourne encore");
  assert.equal(wc.isReady(), true);
  held.forEach((h) => h());
});

test("F3: un chargement RATE ne purge pas", async () => {
  // Supprimer sur la foi d'une lecture qui a echoue serait la pire des
  // combinaisons : on ne sait pas ce qu'il y a, et on efface quand meme.
  const f = fakeRepo({ loadAll: () => Promise.resolve(KO(EMPTY)) });
  const wc = new WorkingCopy({ repo: f.repo });
  await wc.load();
  await settle();
  assert.deepEqual(f.purges, [], "aucune purge apres une lecture ratee");
});

// ---------------------------------------------------------------------------
// Le magasin d'historique lui-meme, devenu une coquille mince
// ---------------------------------------------------------------------------

function fakeBacking() {
  const items: HistoryEntry[] = [];
  return {
    backing: {
      readDictations: () => items,
      addDictation: (e: HistoryEntry) => void items.unshift(e),
      clearDictations: () => void (items.length = 0),
    },
    items,
  };
}

test("B2: dicter AVANT la connexion ne perd pas le texte", () => {
  // Flow demarre avec Windows et arme le clavier avant que le compte soit
  // charge. Quelqu'un qui dicte dans cette fenetre ne doit pas voir sa phrase
  // disparaitre de la page.
  let b: ReturnType<typeof fakeBacking>["backing"] | null = null;
  const h = new DictationHistoryStore({ backing: () => b });
  h.record("dite avant la connexion");
  assert.equal(h.read().entries[0].text, "dite avant la connexion");

  const f = fakeBacking();
  b = f.backing;
  h.adopt();
  assert.equal(f.items.length, 1, "et elle remonte vers le compte a la connexion");
  assert.equal(h.read().entries.length, 1, "sans etre comptee deux fois");
});

test("B2: l'ordre d'arrivee dans le compte suit l'ordre des paroles", () => {
  let b: ReturnType<typeof fakeBacking>["backing"] | null = null;
  const h = new DictationHistoryStore({ backing: () => b });
  h.record("premiere");
  h.record("deuxieme");
  const f = fakeBacking();
  b = f.backing;
  h.adopt();
  // addDictation empile en tete : la derniere arrivee est la plus recente.
  assert.deepEqual(
    f.items.map((e) => e.text),
    ["deuxieme", "premiere"],
  );
});

test("B2: le texte trop long est coupe ET signale, pas presente comme le tout", () => {
  // La seule vraie logique qui restait dans ce module, et elle n'avait rien a
  // voir avec un fichier.
  const f = fakeBacking();
  const h = new DictationHistoryStore({ backing: () => f.backing });
  h.record("x".repeat(10_000));
  assert.equal(f.items[0].truncated, true);
  assert.ok(f.items[0].text.length < 10_000);
});

test("B2: du texte vide n'est jamais enregistre", () => {
  const f = fakeBacking();
  const h = new DictationHistoryStore({ backing: () => f.backing });
  h.record("   ");
  h.record("");
  assert.deepEqual(f.items, []);
});

test("B2: effacer l'historique vide les deux cotes", () => {
  const f = fakeBacking();
  const h = new DictationHistoryStore({ backing: () => f.backing });
  h.record("a");
  assert.equal(h.clear().entries.length, 0);
  assert.deepEqual(f.items, [], "le compte aussi, pas seulement la page");
});
