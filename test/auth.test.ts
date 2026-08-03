import test from "node:test";
import assert from "node:assert/strict";
import { Auth, type AuthDeps } from "../src/main/data/auth";
import { snapshotOf } from "../src/main/data/client";

// ---------------------------------------------------------------------------
// A2 : connexion, deconnexion, et ce qui ne doit jamais sortir du module.
//
// Le client Supabase est remplace par un faux : ces tests ne verifient pas que
// Supabase fonctionne - c'est son travail - mais que Flow traite ses reponses
// correctement, y compris les deux qui font mal (le serveur qui refuse, et le
// serveur qui ne repond pas du tout).
// ---------------------------------------------------------------------------

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInWithPassword: async () => ({ data: { session: null }, error: null }),
      signOut: async () => ({ error: null }),
      ...over,
    },
  } as unknown as AuthDeps["client"];
}

function store() {
  let cleared = 0;
  return { clear: () => void cleared++, count: () => cleared };
}

const SESSION = {
  access_token: "AT-secret",
  refresh_token: "RT-secret",
  user: { id: "11111111-1111-1111-1111-111111111111", email: "roch@example.com" },
};

test("A2: un instantane de compte ne contient AUCUN jeton", () => {
  // La regression numero 6 du plan, prise a la racine : elle n'arrive jamais
  // par malveillance, elle arrive parce qu'on passe l'objet Session complet a
  // une page pour en afficher le courriel.
  const snap = snapshotOf(SESSION as never);
  assert.deepEqual(Object.keys(snap).sort(), ["email", "signedIn", "userId"]);
  const asText = JSON.stringify(snap);
  assert.ok(!asText.includes("AT-secret"), "aucun jeton d'acces");
  assert.ok(!asText.includes("RT-secret"), "aucun jeton de rafraichissement");
});

test("A2: pas de session = pas connecte, et aucun champ invente", () => {
  assert.deepEqual(snapshotOf(null), { signedIn: false, email: "", userId: "" });
});

test("A2: une connexion reussie rend le compte, jamais la session", async () => {
  const s = store();
  const a = new Auth({
    client: fakeClient({ signInWithPassword: async () => ({ data: { session: SESSION }, error: null }) }),
    store: s,
  });
  const r = await a.signIn("roch@example.com", "x");
  assert.equal(r.ok, true);
  assert.equal(r.account.email, "roch@example.com");
  assert.ok(!JSON.stringify(r).includes("RT-secret"));
});

test("A2: un refus est traduit, et l'adresse n'entre pas dans le journal", async () => {
  const logs: string[] = [];
  const a = new Auth({
    client: fakeClient({
      signInWithPassword: async () => ({ data: { session: null }, error: { message: "Invalid login credentials" } }),
    }),
    store: store(),
    log: (m) => logs.push(m),
  });
  const r = await a.signIn("roch@example.com", "mauvais");
  assert.equal(r.ok, false);
  assert.match(r.error, /incorrect/i);
  assert.equal(r.account.signedIn, false);
  for (const m of logs) assert.ok(!m.includes("roch@example.com"), "l'adresse n'a rien a faire dans un journal");
});

test("A2: « courriel non confirme » est explique plutot que recopie", async () => {
  // Le message brut de Supabase est exact et incomprehensible pour quelqu'un
  // dont Roch vient de creer le compte.
  const a = new Auth({
    client: fakeClient({
      signInWithPassword: async () => ({ data: { session: null }, error: { message: "Email not confirmed" } }),
    }),
    store: store(),
  });
  assert.match((await a.signIn("a@b.c", "x")).error, /confirm/i);
});

test("A2: se deconnecter HORS LIGNE efface tout de meme le jeton du disque", async () => {
  // Le cas qui compte. signOut commence par un appel reseau ; sans l'effacement
  // qui suit, une deconnexion demandee sans reseau laisserait le jeton sur le
  // disque en affichant « deconnecte ».
  const s = store();
  const a = new Auth({
    client: fakeClient({
      signOut: async () => {
        throw new Error("fetch failed");
      },
    }),
    store: s,
  });
  const r = await a.signOut();
  assert.equal(s.count(), 1, "le magasin DOIT etre vide meme quand le serveur ne repond pas");
  assert.equal(r.ok, true, "sur cette machine, le jeton est bien parti");
  assert.match(r.error, /fetch failed/);
});

test("A2: une deconnexion normale efface aussi, et sans erreur", async () => {
  const s = store();
  const a = new Auth({ client: fakeClient(), store: s });
  assert.deepEqual(await a.signOut(), { ok: true, error: "" });
  assert.equal(s.count(), 1);
});

test("A2: la revocation par defaut est CET appareil, pas tous", async () => {
  // Le plan demande « revocation par appareil ». Se deconnecter de son portable
  // ne doit pas jeter dehors la machine de bureau qui enregistre une reunion.
  let seen: unknown = null;
  const a = new Auth({
    client: fakeClient({
      signOut: async (opts: unknown) => {
        seen = opts;
        return { error: null };
      },
    }),
    store: store(),
  });
  await a.signOut();
  assert.deepEqual(seen, { scope: "local" });
  await a.signOut("global");
  assert.deepEqual(seen, { scope: "global" });
});

test("A2: lire le compte ne declenche aucun appel reseau", async () => {
  // C'est la fonction que la poussee d'etat a 1 Hz appelle.
  let calls = 0;
  const a = new Auth({
    client: fakeClient({
      getSession: async () => {
        calls++;
        return { data: { session: SESSION } };
      },
      signInWithPassword: async () => {
        throw new Error("ne doit pas etre appele");
      },
    }),
    store: store(),
  });
  const snap = await a.account();
  assert.equal(snap.signedIn, true);
  assert.equal(calls, 1, "getSession lit la session en memoire, il ne la re-demande pas au serveur");
});
