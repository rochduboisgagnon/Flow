import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/main/data/sessionStore";

// ---------------------------------------------------------------------------
// A2 : le magasin du jeton de session.
//
// Ce que ces tests defendent tient en une phrase : le jeton de rafraichissement
// transforme un fichier en acces permanent au compte. Qui le lit obtient, sans
// mot de passe, les reglages, le dictionnaire, les dictees, les notes et
// l'audio de toutes les reunions. Le RLS ecrit en A1 n'y peut rien - il
// distingue les comptes, et celui qui presente le jeton EST le compte.
//
// Le chemin « pas de trousseau » est teste ici et NULLE PART AILLEURS : sur une
// vraie machine Windows, safeStorage marche toujours, donc ce chemin ne
// s'execute jamais tant qu'on ne le simule pas. C'est exactement le genre de
// branche qui pourrit sans bruit.
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-session-"));
}

/** Un faux trousseau : un chiffrement reversible et evidemment factice. Il ne
 * pretend rien - il verifie seulement que le magasin passe bien par lui, et
 * qu'aucun octet n'atterrit en clair. */
function fakeCrypto(marker = "ENC:") {
  return {
    encryptString: (s: string) => Buffer.from(marker + s, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith(marker)) throw new Error("not ours");
      return s.slice(marker.length);
    },
    isEncryptionAvailable: () => true,
  };
}

test("A2: le jeton n'atterrit JAMAIS en clair sur le disque", () => {
  const dir = tmpDir();
  const s = new SessionStore({ dir: () => dir, ...fakeCrypto() });
  s.setItem("sb-auth-token", "refresh-token-tres-secret-12345");

  const raw = fs.readFileSync(path.join(dir, "session.bin"));
  assert.ok(
    !raw.toString("utf8").includes("refresh-token-tres-secret-12345") ||
      raw.toString("utf8").startsWith("ENC:"),
    "le fichier doit etre passe par le chiffrement",
  );
  assert.ok(raw.toString("utf8").startsWith("ENC:"), "rien ne doit contourner encryptString");
});

test("A2: se connecter, fermer, rouvrir - toujours connecte", () => {
  // La promesse du plan, mot pour mot. Deux instances distinctes, comme deux
  // lancements de l'application.
  const dir = tmpDir();
  const crypto = fakeCrypto();
  new SessionStore({ dir: () => dir, ...crypto }).setItem("k", "v");
  assert.equal(new SessionStore({ dir: () => dir, ...crypto }).getItem("k"), "v");
});

test("A2: se deconnecter efface le jeton, du disque et pas seulement de la memoire", () => {
  const dir = tmpDir();
  const crypto = fakeCrypto();
  const s = new SessionStore({ dir: () => dir, ...crypto });
  s.setItem("k", "v");
  assert.ok(fs.existsSync(path.join(dir, "session.bin")));

  s.clear();
  assert.equal(s.getItem("k"), null);
  assert.equal(fs.existsSync(path.join(dir, "session.bin")), false, "le fichier doit disparaitre");
  // Et un lancement suivant ne doit rien retrouver : c'est ca, se deconnecter.
  assert.equal(new SessionStore({ dir: () => dir, ...crypto }).getItem("k"), null);
});

test("A2: retirer la derniere clef efface le fichier plutot que d'y laisser un objet vide", () => {
  const dir = tmpDir();
  const crypto = fakeCrypto();
  const s = new SessionStore({ dir: () => dir, ...crypto });
  s.setItem("k", "v");
  s.removeItem("k");
  assert.equal(fs.existsSync(path.join(dir, "session.bin")), false);
});

test("A2: SANS trousseau, rien n'est ecrit - et la session marche quand meme", () => {
  // La decision du plan : plutot se reconnecter au prochain lancement
  // qu'ecrire en clair un fichier qui ouvre le compte. Le piege serait
  // d'ecrire « en attendant » : rien ne casse, l'application marche mieux, et
  // le fichier reste.
  const dir = tmpDir();
  const logs: string[] = [];
  const s = new SessionStore({
    dir: () => dir,
    encryptString: () => {
      throw new Error("ne doit jamais etre appele sans trousseau");
    },
    decryptString: () => {
      throw new Error("ne doit jamais etre appele sans trousseau");
    },
    isEncryptionAvailable: () => false,
    log: (m) => logs.push(m),
  });

  s.setItem("k", "v");
  assert.equal(s.getItem("k"), "v", "la session doit vivre en memoire, l'application fonctionne");
  assert.equal(fs.existsSync(path.join(dir, "session.bin")), false, "rien sur le disque");
  assert.equal(fs.readdirSync(dir).length, 0, "pas meme un fichier temporaire");
  assert.equal(logs.length, 1, "dit une fois, pas a chaque ecriture");
  assert.match(logs[0], /memoire/);
});

test("A2: un trousseau qui repond en RETARD est rattrape, pas condamne", () => {
  // LE DEFAUT QUE LE LANCEMENT DE L'APPLICATION A TROUVE, et qu'aucune des
  // quatre portes ne pouvait voir.
  //
  // Le client Supabase interroge son stockage des sa CONSTRUCTION, donc au
  // chargement du module, bien avant `app.whenReady()`. Sur Windows,
  // safeStorage repond faux tant que l'application n'est pas prete. La premiere
  // version mettait cette reponse en cache et concluait « pas de trousseau sur
  // cette machine » pour toute la session - sur une machine ou le trousseau
  // marche parfaitement.
  //
  // Panne silencieuse au sens qui compte : rien ne casse, la dictee fonctionne,
  // et l'utilisateur se reconnecte a chaque lancement en croyant que Flow est
  // comme ca.
  const dir = tmpDir();
  const crypto = fakeCrypto();
  let ready = false;
  const logs: string[] = [];
  const s = new SessionStore({
    dir: () => dir,
    encryptString: crypto.encryptString,
    decryptString: crypto.decryptString,
    isEncryptionAvailable: () => ready,
    log: (m) => logs.push(m),
  });

  // Avant que l'application soit prete : rien sur le disque, et c'est correct.
  s.setItem("k", "avant");
  assert.equal(fs.existsSync(path.join(dir, "session.bin")), false);

  // L'application devient prete. L'ecriture SUIVANTE doit atterrir.
  ready = true;
  s.setItem("k", "apres");
  assert.equal(fs.existsSync(path.join(dir, "session.bin")), true, "le trousseau repond : on persiste");
  assert.equal(logs.length, 1, "l'avertissement ne doit pas se repeter une fois le trousseau la");
});

test("A2: une session ecrite AVANT est relue une fois le trousseau disponible", () => {
  // Le second defaut, jumeau du premier et qui aurait survecu a sa correction :
  // la toute premiere lecture arrive trop tot et ne trouve rien. La marquer
  // « faite » condamnerait la session enregistree a ne jamais etre relue, et
  // l'utilisateur se reconnecterait a chaque lancement avec son jeton valide
  // sagement pose a cote sur le disque.
  const dir = tmpDir();
  const crypto = fakeCrypto();
  new SessionStore({ dir: () => dir, ...crypto }).setItem("k", "v");

  let ready = false;
  const s = new SessionStore({
    dir: () => dir,
    encryptString: crypto.encryptString,
    decryptString: crypto.decryptString,
    isEncryptionAvailable: () => ready,
  });
  assert.equal(s.getItem("k"), null, "trop tot : rien a rendre, et c'est normal");
  ready = true;
  assert.equal(s.getItem("k"), "v", "l'application est prete : la session doit revenir");
});

test("A2: un fichier illisible vaut « pas de session », jamais un plantage", () => {
  // Cas reel : le trousseau d'un AUTRE utilisateur Windows, ou un profil
  // restaure depuis une sauvegarde. La bonne reponse a « je n'arrive pas a te
  // reconnaitre » est un ecran de connexion.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "session.bin"), Buffer.from("des octets qui ne sont pas les notres"));
  const logs: string[] = [];
  const s = new SessionStore({ dir: () => dir, ...fakeCrypto(), log: (m) => logs.push(m) });

  assert.doesNotThrow(() => s.getItem("k"));
  assert.equal(s.getItem("k"), null);
  assert.equal(logs.length, 1);
  // Et il n'est PAS supprime : effacer la session de quelqu'un d'autre parce
  // qu'on n'a pas su la lire serait pire que de l'ignorer.
  assert.ok(fs.existsSync(path.join(dir, "session.bin")), "le fichier d'un autre profil est laisse en place");
});

test("A2: un echec d'ecriture ne laisse pas de .tmp derriere lui", () => {
  const dir = tmpDir();
  const s = new SessionStore({
    dir: () => dir,
    encryptString: () => {
      throw new Error("disque plein");
    },
    decryptString: () => "",
    isEncryptionAvailable: () => true,
    log: () => {},
  });
  assert.doesNotThrow(() => s.setItem("k", "v"));
  assert.deepEqual(fs.readdirSync(dir), [], "ni fichier final, ni temporaire");
});

test("A2: la valeur du jeton n'apparait dans AUCUN message de journal", () => {
  // Fuite numero 6 de la liste des regressions du plan. Un journal est ce qu'on
  // colle dans un rapport de bogue.
  const dir = tmpDir();
  const logs: string[] = [];
  const secret = "refresh-token-tres-secret-12345";
  const s = new SessionStore({
    dir: () => dir,
    encryptString: () => {
      throw new Error("disque plein");
    },
    decryptString: () => {
      throw new Error("illisible");
    },
    isEncryptionAvailable: () => true,
    log: (m) => logs.push(m),
  });
  s.setItem("sb-auth-token", secret);
  s.clear();
  for (const m of logs) assert.ok(!m.includes(secret), `un journal contient le jeton : ${m}`);
});

// ---------------------------------------------------------------------------
// 2026-08-04 : « ILLISIBLE » ET « ABSENT » NE SONT PAS LE MEME FAIT.
//
// Le portage macOS a rendu ce chemin probable au lieu d'exotique. safeStorage
// s'appuie la-bas sur un element du trousseau dont l'ACL s'exprime en termes de
// la SIGNATURE de l'application. Flow est signe ad-hoc, donc son identite change
// a chaque version : apres une mise a jour, macOS peut demander l'acces au
// trousseau, ou le refuser.
//
// Or les deux causes rendaient exactement le meme message a l'utilisateur
// (« aucune session enregistree »), alors que leurs remedes sont opposes : se
// connecter, contre autoriser Flow dans le trousseau. Un magasin qui ne sait pas
// dire lequel des deux s'est produit force a deviner.
// ---------------------------------------------------------------------------

test("2026-08-04: un trousseau qui REFUSE n'est pas une absence de session", () => {
  const dir = tmpDir();
  // Une session ecrite par une version precedente, avec un autre marqueur : c'est
  // exactement ce qu'un changement de signature produit du point de vue du code.
  const written = new SessionStore({ dir: () => dir, ...fakeCrypto("VERSION-PRECEDENTE:") });
  written.setItem("flow-session", JSON.stringify({ access_token: "a", refresh_token: "r" }));

  const logs: string[] = [];
  const s = new SessionStore({ dir: () => dir, ...fakeCrypto("APRES-MISE-A-JOUR:"), log: (m) => logs.push(m) });
  assert.equal(s.getItem("flow-session"), null, "une session illisible ne doit surtout pas etre servie");

  // Le fait, nomme, disponible pour qui doit l'expliquer.
  const failure = s.lastReadFailure();
  assert.ok(failure, "le magasin ne dit pas qu'il a ECHOUE a relire : indistinguable d'une premiere fois");
  assert.match(failure, /trousseau|keychain/i);

  // Et le fichier est TOUJOURS LA. C'est la partie qui compte le plus : il peut
  // redevenir lisible au prochain lancement (« Toujours autoriser »), et c'est du
  // jeton d'acces au compte. La mauvaise reponse a « je n'arrive pas a te
  // reconnaitre » est de detruire la preuve.
  assert.ok(fs.existsSync(path.join(dir, "session.bin")), "le jeton a ete efface au lieu d'etre laisse tranquille");
  assert.ok(
    logs.some((l) => /n'a pas pu etre relue/i.test(l)),
    `rien n'a ete journalise : ${JSON.stringify(logs)}`,
  );
});

test("2026-08-04: une premiere fois n'invente PAS un echec de trousseau", () => {
  // Le symetrique, sans lequel le champ ci-dessus mentirait dans l'autre sens.
  const dir = tmpDir();
  const s = new SessionStore({ dir: () => dir, ...fakeCrypto() });
  assert.equal(s.getItem("flow-session"), null);
  assert.equal(s.lastReadFailure(), null);
});
