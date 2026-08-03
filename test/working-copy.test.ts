import test from "node:test";
import assert from "node:assert/strict";
import { WorkingCopy } from "../src/main/data/workingCopy";
import type { Repo, RepoResult, Snapshot } from "../src/main/data/repo";
import type { DictEntry } from "../src/shared/ipcContracts";

// ---------------------------------------------------------------------------
// B1 : la copie de travail.
//
// Ce que ces tests defendent, dans l'ordre d'importance :
//
//  1. LE CHEMIN CHAUD. Aucune lecture ne doit pouvoir attendre le reseau.
//  2. HORS LIGNE, on ne perd rien et on ne bloque personne.
//  3. LA FERMETURE. Rien ici ne doit pouvoir retenir before-quit.
//  4. Un chargement RATE n'est pas un chargement VIDE.
// ---------------------------------------------------------------------------

const OK = <T,>(data: T): RepoResult<T> => ({ ok: true, data, error: "" });
const KO = <T,>(data: T, error = "reseau"): RepoResult<T> => ({ ok: false, data, error });

const EMPTY: Snapshot = { settings: {}, dictionary: [], stats: [], dictations: [] };

function entry(id: string, term = "AGR"): DictEntry {
  return { id, term, aliases: [], kind: "vocabulary", starred: false, createdIso: "2026-01-01T00:00:00.000Z" };
}

/** Un faux depot qui compte ses appels et peut tomber en panne a volonte. */
function fakeRepo(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  let online = true;
  const answer = <T,>(name: string, data: T) => {
    calls.push(name);
    return Promise.resolve(online ? OK(data) : KO(data));
  };
  const repo = {
    loadAll: () => answer("loadAll", EMPTY),
    saveSettings: () => answer("saveSettings", null),
    upsertDictEntry: () => answer("upsertDictEntry", null),
    deleteDictEntry: () => answer("deleteDictEntry", null),
    saveStatsDay: () => answer("saveStatsDay", null),
    addDictation: () => answer("addDictation", null),
    clearDictations: () => answer("clearDictations", null),
    clearStats: () => answer("clearStats", null),
    reportWriteFailure: () => {},
    ...over,
  } as unknown as Repo;
  return {
    repo,
    calls,
    goOffline: () => void (online = false),
    goOnline: () => void (online = true),
  };
}

/** Laisse les promesses deja resolues s'executer, sans horloge. */
const settle = () => new Promise((r) => setImmediate(r));

test("B1: toutes les lectures sont SYNCHRONES - une lecture ne peut pas attendre le reseau", () => {
  // L'invariant du chemin chaud, tenu par la forme du code plutot que par la
  // discipline : le dictionnaire est applique a chaque enonce, et une methode
  // synchrone ne PEUT PAS attendre Supabase. Un futur appelant ne peut pas
  // contourner ca par distraction.
  const wc = new WorkingCopy({ repo: fakeRepo().repo });
  for (const m of ["readSettings", "readDictionary", "readStats", "readDictations", "isReady", "pending"] as const) {
    const out = (wc as unknown as Record<string, () => unknown>)[m]();
    assert.ok(!(out instanceof Promise), `${m}() rend une promesse : le chemin chaud peut attendre le reseau`);
  }
});

test("B1: une ecriture rend la main tout de suite, sans attendre l'envoi", async () => {
  // Un tableau plutot qu'une variable : TypeScript reduit a `never` une
  // variable assignee uniquement dans une fermeture, et `resolveIt?.()`
  // devient alors non appelable.
  const held: Array<() => void> = [];
  const f = fakeRepo({
    saveSettings: () => new Promise((res) => held.push(() => res(OK(null)))),
  });
  const wc = new WorkingCopy({ repo: f.repo });

  wc.writeSettings({ language: "fr" });
  // L'envoi est en cours et ne se terminera jamais tant qu'on ne le decide pas.
  assert.equal(wc.readSettings().language, "fr", "la memoire est deja a jour");
  assert.equal(wc.pending(), 1, "et l'envoi est en attente, pas termine");
  held.forEach((h) => h());
});

test("B1: vingt mouvements d'un curseur ne font pas vingt envois", async () => {
  // Un reglage est un ETAT : seule la derniere valeur compte. Sans fusion, un
  // glissement de curseur produirait une vingtaine de PUT sur la meme ligne.
  const f = fakeRepo();
  const wc = new WorkingCopy({ repo: f.repo });
  for (let i = 0; i < 20; i++) wc.writeSettings({ volume: i });
  await settle();
  await settle();
  const sends = f.calls.filter((c) => c === "saveSettings").length;
  assert.ok(sends < 20, `${sends} envois pour 20 mutations : la fusion ne fonctionne pas`);
  assert.equal(wc.readSettings().volume, 19, "et c'est la DERNIERE valeur qui monte");
});

test("B1: une dictee n'est JAMAIS fusionnee avec une autre", async () => {
  // Contre-partie du test precedent : une dictee est un EVENEMENT. Les fusionner
  // ferait disparaitre le texte de quelqu'un.
  const f = fakeRepo();
  const wc = new WorkingCopy({ repo: f.repo });
  wc.addDictation({ at: 1, text: "premiere" });
  wc.addDictation({ at: 2, text: "deuxieme" });
  wc.addDictation({ at: 3, text: "troisieme" });
  await settle();
  await settle();
  await settle();
  assert.equal(f.calls.filter((c) => c === "addDictation").length, 3);
});

test("B1: HORS LIGNE, rien n'est perdu et rien ne bloque", async () => {
  const f = fakeRepo();
  const wc = new WorkingCopy({ repo: f.repo, retryDelayMs: 1, schedule: () => {} });
  f.goOffline();

  wc.addDictation({ at: 1, text: "dite pendant la coupure" });
  wc.writeSettings({ language: "fr" });
  await settle();
  await settle();

  // La memoire est a jour - la dictee a bien ete inseree au curseur, elle
  // existe, et la page la montre.
  assert.equal(wc.readDictations()[0].text, "dite pendant la coupure");
  assert.equal(wc.readSettings().language, "fr");
  // Et le travail attend, il n'est pas parti dans le neant.
  assert.ok(wc.pending() >= 1, "les changements doivent attendre en memoire");
});

test("B1: le retour du reseau vide la file, dans l'ordre", async () => {
  const f = fakeRepo();
  const pumps: Array<() => void> = [];
  const wc = new WorkingCopy({ repo: f.repo, retryDelayMs: 1, schedule: (fn) => pumps.push(fn) });

  f.goOffline();
  wc.addDictation({ at: 1, text: "une" });
  await settle();
  assert.equal(wc.pending(), 1);

  f.goOnline();
  pumps.forEach((p) => p());
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(wc.pending(), 0, "la file doit se vider une fois le reseau revenu");
});

test("B1: rien ne peut retenir la fermeture - pending() DIT, il n'attend pas", () => {
  // Troisieme des sept regressions du plan : « l'application ne se ferme plus,
  // parce qu'un televersement bloque un before-quit qui est synchrone ».
  const f = fakeRepo();
  const wc = new WorkingCopy({ repo: f.repo, retryDelayMs: 1, schedule: () => {} });
  f.goOffline();
  wc.addDictation({ at: 1, text: "x" });

  const n = wc.pending();
  assert.equal(typeof n, "number", "pending() doit etre synchrone et rendre un nombre");
  assert.ok(n >= 1);
  // Et il n'existe aucune methode qui attende la file : la chercher est le
  // meilleur moyen de ne pas l'ecrire un jour par commodite.
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(wc));
  for (const bad of ["flush", "waitForIdle", "drainNow", "close"]) {
    assert.ok(!names.includes(bad), `WorkingCopy.${bad}() existe : before-quit finira par l'appeler`);
  }
});

test("B1: un chargement RATE n'est pas un chargement VIDE", async () => {
  // Deuxieme des sept regressions, sous sa forme la plus vicieuse. Un
  // dictionnaire vide et un dictionnaire qu'on n'a pas pu lire se ressemblent,
  // et le second ferait dicter quelqu'un sans ses termes pendant qu'il croit
  // les avoir.
  const f = fakeRepo({ loadAll: () => Promise.resolve(KO(EMPTY, "reseau coupe")) });
  const wc = new WorkingCopy({ repo: f.repo });
  const r = await wc.load();
  assert.equal(r.ok, false);
  assert.equal(wc.isReady(), false, "la copie ne doit PAS se declarer prete");
});

test("B1: un chargement reussi rend la copie prete et servie depuis la memoire", async () => {
  const snap: Snapshot = {
    settings: { language: "fr" },
    dictionary: [entry("a", "AGR Labs")],
    stats: [{ date: "2026-08-03", words: 10, ms: 100, utterances: 1 }],
    dictations: [{ at: 5, text: "bonjour" }],
  };
  // Le compteur est LOCAL : remplacer loadAll dans le faux depot
  // court-circuiterait le sien, et l'assertion mesurerait alors le compteur
  // plutot que le comportement. (Trouve en le voyant rendre 0.)
  let loads = 0;
  const f = fakeRepo({
    loadAll: () => {
      loads++;
      return Promise.resolve(OK(snap));
    },
  });
  const wc = new WorkingCopy({ repo: f.repo });
  assert.equal((await wc.load()).ok, true);
  assert.equal(wc.isReady(), true);
  assert.equal(wc.readDictionary()[0].term, "AGR Labs");
  assert.equal(wc.readSettings().language, "fr");
  assert.equal(loads, 1, "UNE seule requete pour tout charger");
});

test("B1: se deconnecter vide la copie", async () => {
  // Sans ca, la personne suivante a se connecter sur cette machine verrait le
  // dictionnaire de la precedente jusqu'au premier rechargement.
  const snap: Snapshot = { ...EMPTY, dictionary: [entry("a", "secret")] };
  const f = fakeRepo({ loadAll: () => Promise.resolve(OK(snap)) });
  const wc = new WorkingCopy({ repo: f.repo });
  await wc.load();
  assert.equal(wc.readDictionary().length, 1);

  wc.reset();
  assert.deepEqual(wc.readDictionary(), []);
  assert.deepEqual(wc.readSettings(), {});
  assert.equal(wc.isReady(), false);
  assert.equal(wc.pending(), 0, "et la file de l'ancien compte ne doit pas survivre");
});

test("B1: un terme supprime avant son envoi ne fait pas echouer la file", async () => {
  // Course reelle : ajouter puis supprimer vite. L'envoi d'ajout trouve un
  // terme qui n'existe plus. Ce n'est pas un echec - la suppression est deja
  // derriere dans la file.
  const f = fakeRepo();
  const wc = new WorkingCopy({ repo: f.repo, retryDelayMs: 1, schedule: () => {} });
  wc.upsertDictEntry(entry("z"));
  wc.deleteDictEntry("z");
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(wc.pending(), 0, "la file doit se vider malgre la course");
});
