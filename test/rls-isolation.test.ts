import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFlowClient } from "../src/main/data/client";
import { audioObjectName } from "../src/shared/tus";

// ---------------------------------------------------------------------------
// A1, la preuve : un compte A ne lit AUCUNE ligne d'un compte B.
//
// « Prouve par un test qui essaie vraiment », dit le plan, et c'est la seule
// formulation qui vaille. Relire les politiques SQL et se declarer satisfait
// est exactement la facon dont une base finit ouverte : le RLS est une chose
// qu'on croit avoir active. Ce test se connecte a DEUX vrais comptes, ecrit
// avec l'un, et essaie de lire avec l'autre.
//
// ---------------------------------------------------------------------------
// POURQUOI IL SE TAIT QUAND LES IDENTIFIANTS SONT ABSENTS
// ---------------------------------------------------------------------------
//
// Il lui faut deux comptes et leurs mots de passe. Ces valeurs n'ont rien a
// faire dans un depot public, donc elles vivent dans .env - couvert par le
// .gitignore, verifie non suivi par git - et le test se passe de lui-meme
// quand elles n'y sont pas.
//
// C'EST UN COMPROMIS, ET IL FAUT LE DIRE PLUTOT QUE LE CACHER : un test qui
// peut se taire est un test qui peut se taire POUR TOUJOURS sans que personne
// ne le remarque. La compensation est en dessous - quand les identifiants sont
// la, ce fichier est bruyant, et quand ils ne le sont pas, il l'annonce.
//
// Les comptes attendus sont JETABLES. Ce test ecrit de vraies lignes dans les
// deux ; ce n'est pas une chose a faire dans un compte qui contient le travail
// de quelqu'un.
// ---------------------------------------------------------------------------

interface Creds {
  aEmail: string;
  aPassword: string;
  bEmail: string;
  bPassword: string;
}

/** Lit .env a la main : ce depot n'embarque pas dotenv, et une dependance de
 * plus pour quatre lignes serait un mauvais echange. */
function creds(): Creds | null {
  const p = path.join(__dirname, "..", ".env");
  let raw = "";
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].trim();
  }
  const c: Creds = {
    aEmail: env.FLOW_TEST_A_EMAIL ?? "",
    aPassword: env.FLOW_TEST_A_PASSWORD ?? "",
    bEmail: env.FLOW_TEST_B_EMAIL ?? "",
    bPassword: env.FLOW_TEST_B_PASSWORD ?? "",
  };
  return c.aEmail && c.aPassword && c.bEmail && c.bPassword ? c : null;
}

/** Un stockage en memoire : chaque compte de ce test a le sien, pour que les
 * deux sessions ne se marchent pas dessus. Surtout, RIEN n'est ecrit sur le
 * disque - un test qui laisse un jeton derriere lui serait une jolie ironie. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const C = creds();

test("A1: l'isolation entre comptes est prouvee en essayant vraiment", { skip: C ? false : "identifiants de test absents de .env (FLOW_TEST_A_* / FLOW_TEST_B_*) - la preuve d'isolation N'A PAS ete faite" }, async () => {
  const c = C as Creds;
  const A = createFlowClient({ storage: memoryStorage() });
  const B = createFlowClient({ storage: memoryStorage() });

  const inA = await A.auth.signInWithPassword({ email: c.aEmail, password: c.aPassword });
  assert.equal(inA.error, null, `le compte A ne se connecte pas : ${inA.error?.message}`);
  const inB = await B.auth.signInWithPassword({ email: c.bEmail, password: c.bPassword });
  assert.equal(inB.error, null, `le compte B ne se connecte pas : ${inB.error?.message}`);

  const idA = inA.data.session?.user.id ?? "";
  const idB = inB.data.session?.user.id ?? "";
  assert.ok(idA && idB && idA !== idB, "deux comptes DISTINCTS sont necessaires a cette preuve");

  const marker = `rls-${idA.slice(0, 8)}-${idB.slice(0, 8)}`;

  try {
    // --- A ecrit dans chacune des six tables -------------------------------
    const written = [
      A.from("settings").upsert({ user_id: idA, data: { marker } }),
      A.from("dictionary").insert({ user_id: idA, term: marker, kind: "vocabulary" }),
      A.from("stats_days").upsert({ user_id: idA, day: "2001-01-01", words: 42 }),
      A.from("dictations").insert({ user_id: idA, said_at: new Date(0).toISOString(), text: marker }),
      A.from("recordings").insert({ user_id: idA, title: marker, started_at: new Date(0).toISOString() }),
      A.from("live_notes").insert({ user_id: idA, started_iso: marker, text: marker }),
    ];
    for (const r of await Promise.all(written)) {
      assert.equal(r.error, null, `A doit pouvoir ecrire chez lui : ${r.error?.message}`);
    }

    // --- B ne voit RIEN ----------------------------------------------------
    const tables = ["settings", "dictionary", "stats_days", "dictations", "recordings", "live_notes"];
    for (const t of tables) {
      const seen = await B.from(t).select("*");
      assert.equal(seen.error, null, `${t}: lire ses propres lignes ne doit pas etre une erreur`);
      assert.deepEqual(seen.data, [], `${t}: le compte B VOIT des lignes du compte A`);
      // Et la meme question posee frontalement, avec l'identifiant de A en main :
      // un filtre explicite ne doit pas ouvrir ce que le RLS ferme.
      const targeted = await B.from(t).select("*").eq("user_id", idA);
      assert.deepEqual(targeted.data, [], `${t}: B lit les lignes de A en les demandant par son id`);
    }

    // --- B ne peut pas ECRIRE au nom de A ----------------------------------
    // C'est ce que garde le `with check` des politiques. Sans lui, B pourrait
    // deposer une ligne qu'il ne reverrait jamais mais qui serait dans les
    // donnees de A - une falsification silencieuse.
    const forged = await B.from("dictations").insert({
      user_id: idA,
      said_at: new Date(0).toISOString(),
      text: "ecrit par B",
    });
    assert.notEqual(forged.error, null, "B a pu inserer une ligne au nom de A");

    // --- B ne peut ni modifier ni supprimer chez A -------------------------
    const changed = await B.from("dictionary").update({ term: "vole" }).eq("user_id", idA);
    assert.deepEqual(changed.data ?? [], [], "B a modifie une ligne de A");
    const deleted = await B.from("dictations").delete().eq("user_id", idA);
    assert.deepEqual(deleted.data ?? [], [], "B a supprime une ligne de A");

    // --- Et A retrouve bien ce qu'il a ecrit -------------------------------
    // Sans cette derniere verification, un RLS qui bloquerait TOUT le monde
    // passerait ce test avec les honneurs.
    const mine = await A.from("dictations").select("*").eq("text", marker);
    assert.equal(mine.data?.length, 1, "A doit lire ses propres lignes");
  } finally {
    // Nettoyage par A lui-meme : il n'y a pas de clef de service ici, et il n'y
    // en aura pas. Ce que le RLS interdit a B, il l'interdit aussi a ce test.
    await Promise.all([
      A.from("dictionary").delete().eq("term", marker),
      A.from("dictations").delete().eq("text", marker),
      A.from("recordings").delete().eq("title", marker),
      A.from("live_notes").delete().eq("started_iso", marker),
      A.from("stats_days").delete().eq("day", "2001-01-01"),
      A.from("settings").delete().eq("user_id", idA),
    ]);
    await A.auth.signOut({ scope: "local" });
    await B.auth.signOut({ scope: "local" });
  }
});

// ---------------------------------------------------------------------------
// B3c : LA MEME PREUVE, POUR LE SEAU.
//
// Les politiques de storage.objects existaient depuis la premiere migration et
// personne n'y avait jamais mis un octet. B3c est le premier utilisateur du
// seau, et un seau ouvert rendrait le RLS des tables DECORATIF : l'audio d'une
// reunion en dit autant que son transcript.
//
// La frontiere est le PREFIXE du nom de l'objet : `(storage.foldername(name))[1]
// = auth.uid()`. Ce test l'attaque des deux cotes - B ne doit ni lire l'objet de
// A, ni ecrire sous le prefixe de A. Et il verifie que A, lui, peut travailler
// chez lui : un seau ferme a tout le monde passerait autrement avec les honneurs.
// ---------------------------------------------------------------------------
test(
  "B3c: l'isolation du seau audio est prouvee en essayant vraiment",
  { skip: C ? false : "identifiants de test absents de .env - la preuve d'isolation du seau N'A PAS ete faite" },
  async () => {
    const c = C as Creds;
    const A = createFlowClient({ storage: memoryStorage() });
    const B = createFlowClient({ storage: memoryStorage() });
    const inA = await A.auth.signInWithPassword({ email: c.aEmail, password: c.aPassword });
    assert.equal(inA.error, null, `le compte A ne se connecte pas : ${inA.error?.message}`);
    const inB = await B.auth.signInWithPassword({ email: c.bEmail, password: c.bPassword });
    assert.equal(inB.error, null, `le compte B ne se connecte pas : ${inB.error?.message}`);
    const idA = inA.data.session?.user.id ?? "";
    const idB = inB.data.session?.user.id ?? "";
    assert.ok(idA && idB && idA !== idB, "deux comptes DISTINCTS sont necessaires a cette preuve");

    // Le MEME composeur de chemin que le televersement utilise, pour que ce test
    // prouve la frontiere reelle et pas une frontiere qui lui ressemble.
    const objectA = audioObjectName(idA, "rls-proof");
    const bucket = "recordings";
    const bytes = new Uint8Array([1, 2, 3, 4]);

    try {
      // --- A ecrit chez lui ------------------------------------------------
      const put = await A.storage.from(bucket).upload(objectA, bytes, { contentType: "audio/wav", upsert: true });
      assert.equal(put.error, null, `A doit pouvoir ecrire sous son prefixe : ${put.error?.message}`);

      // --- B ne le voit pas ------------------------------------------------
      const listed = await B.storage.from(bucket).list(idA);
      // Selon la version, une lecture refusee rend une erreur OU une liste vide.
      // Les deux sont acceptables ; ce qui ne l'est pas est de VOIR l'objet.
      assert.ok(
        listed.error !== null || (listed.data ?? []).every((f) => f.name !== "rls-proof.wav"),
        "le compte B VOIT l'audio du compte A",
      );
      const stolen = await B.storage.from(bucket).download(objectA);
      assert.notEqual(stolen.error, null, "le compte B a TELECHARGE l'audio du compte A");

      // --- B ne peut pas ecrire sous le prefixe de A -----------------------
      // Sans le `with check` du prefixe, B deposerait un objet dans les donnees
      // de A - qu'il ne reverrait jamais, mais qui serait la.
      const forged = await B.storage.from(bucket).upload(audioObjectName(idA, "forge"), bytes, { upsert: true });
      assert.notEqual(forged.error, null, "le compte B a ecrit sous le prefixe du compte A");

      // --- B ne peut pas le supprimer non plus -----------------------------
      const wiped = await B.storage.from(bucket).remove([objectA]);
      // `remove` rend la liste de ce qu'il a VRAIMENT supprime : une liste vide
      // est le refus, et c'est plus subtil qu'une erreur - il faut le verifier.
      assert.deepEqual(wiped.data ?? [], [], "le compte B a supprime l'audio du compte A");

      // --- Et A retrouve bien son objet ------------------------------------
      const back = await A.storage.from(bucket).download(objectA);
      assert.equal(back.error, null, `A doit pouvoir relire son audio : ${back.error?.message}`);
      assert.equal((await back.data!.arrayBuffer()).byteLength, bytes.length);

      // --- Le seau n'est PAS public ----------------------------------------
      // Une URL publique sur un seau prive ne rend rien : c'est la deuxieme
      // serrure, et elle se verifie sans jeton du tout.
      const pub = A.storage.from(bucket).getPublicUrl(objectA);
      const anon = await fetch(pub.data.publicUrl);
      assert.notEqual(anon.status, 200, "le seau repond a une requete SANS JETON : il est public");
    } finally {
      await A.storage.from(bucket).remove([objectA]);
      await A.auth.signOut({ scope: "local" });
      await B.auth.signOut({ scope: "local" });
    }
  },
);

test("A1: le fichier .env ne doit jamais etre suivi par git", () => {
  // La contrepartie de tout ce qui precede. Ce test-la, lui, ne se tait jamais.
  const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.match(gi, /^\.env$/m, ".gitignore doit couvrir .env");
});
