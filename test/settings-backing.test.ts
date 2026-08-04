import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, saveSettings, useSettingsBacking, SETTINGS_DEFAULTS } from "../src/main/settings";

// ---------------------------------------------------------------------------
// B2 : les reglages ne vivent plus sur cette machine.
//
// Ce que ces tests defendent, c'est surtout le comportement quand il n'y a PAS
// de compte : au tout premier lancement, entre le demarrage et la connexion, et
// apres une deconnexion. C'est l'etat dans lequel Flow passe le plus de temps
// chez quelqu'un qui vient de l'installer, et celui qu'on teste le moins.
// ---------------------------------------------------------------------------

test("B2: sans magasin, on lit les defauts - jamais une erreur", () => {
  // Ce chemin s'execute avant la connexion, y compris pendant l'armement du
  // clavier. Une exception ici empecherait Flow de demarrer.
  useSettingsBacking(null);
  const s = loadSettings();
  assert.equal(s.language, SETTINGS_DEFAULTS.language);
  assert.deepEqual(s.combo, SETTINGS_DEFAULTS.combo);
});

test("B2: sans magasin, enregistrer ne fait rien et ne LANCE rien", () => {
  // Ecrire les reglages de personne quelque part serait pire que de ne pas les
  // ecrire. Mais lancer une exception serait pire encore : l'appelant est
  // applySettings, sur lequel repose toute l'interface.
  useSettingsBacking(null);
  assert.doesNotThrow(() => saveSettings(loadSettings()));
});

test("B2: avec un magasin, l'aller-retour conserve les reglages", () => {
  const held: Array<Record<string, unknown>> = [];
  useSettingsBacking({
    isReady: () => true,
    readSettings: () => held[held.length - 1] ?? {},
    writeSettings: (n) => void held.push(n),
  });

  const s = loadSettings();
  saveSettings({ ...s, language: "fr", sounds: false });
  const back = loadSettings();
  assert.equal(back.language, "fr");
  assert.equal(back.sounds, false);
});

test("B2: la combinaison de touches est COPIEE, jamais partagee", () => {
  // Le tableau `combo` est mute par le module qui enregistre le raccourci. Le
  // passer par reference ferait qu'une modification ulterieure changerait, en
  // silence, ce qui est deja parti vers Supabase - et les deux ordinateurs
  // divergeraient sans que rien ne l'explique. Cinquieme des sept regressions
  // du plan : « un reglage qui revient en arriere entre deux machines ».
  let stored: Record<string, unknown> = {};
  useSettingsBacking({
    isReady: () => true,
    readSettings: () => stored,
    writeSettings: (n) => void (stored = n),
  });
  const s = loadSettings();
  const combo = [...s.combo];
  saveSettings(s);
  s.combo.push("F13");
  assert.deepEqual(stored.combo, combo, "le tableau enregistre ne doit pas suivre les mutations d'apres coup");
});

test("B2: ce qui vient du compte passe TOUJOURS par sanitizeSettings", () => {
  // La source n'est plus un fichier mais elle reste une donnee qu'on n'a pas
  // ecrite : Supabase rend du JSON arbitraire. Un champ inconnu doit tomber, un
  // mauvais type revenir au defaut.
  useSettingsBacking({
    isReady: () => true,
    readSettings: () => ({ language: 42, jeNexistePas: true, sounds: "oui" }),
    writeSettings: () => {},
  });
  const s = loadSettings() as unknown as Record<string, unknown>;
  assert.equal(s.language, SETTINGS_DEFAULTS.language, "un mauvais type revient au defaut");
  assert.equal(s.sounds, SETTINGS_DEFAULTS.sounds);
  assert.equal("jeNexistePas" in s, false, "un champ inconnu ne doit pas survivre");
});

test("B2: settings.json n'est plus jamais ecrit par ce module", () => {
  // La regle de la vague, tenue par une porte plutot que par un commentaire :
  // ce qui reste dans ~/.flow est ce qui decrit CETTE machine - le jeton, la
  // geometrie de fenetre, le journal, le fichier de decouverte de l'API.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "settings.ts"), "utf8");
  assert.ok(!/writeFileSync|renameSync|mkdirSync/.test(src), "settings.ts n'ecrit plus rien sur le disque");
  assert.ok(!/from "node:fs"/.test(src), "et n'a plus de raison d'importer fs");
});

test("2026-08-04 : rien n'est ecrit avant que le compte soit charge", () => {
  // TROUVE DANS LE JOURNAL DE ROCH, une seconde apres le lancement de la 2.0.0 :
  // « [data] envoi impossible : les changements attendent en memoire », a chaque
  // demarrage a froid.
  //
  // Le magasin etait installe au chargement du module, donc il existait AVANT
  // toute connexion - et `applySettings({})` au demarrage lui envoyait les
  // reglages par defaut, qui echouaient sur « personne n'est connecte » et
  // restaient en tete de file. Le commentaire de `useSettingsBacking` decrivait
  // deja la bonne regle (« ecrire les reglages de personne quelque part serait
  // pire que de ne pas les ecrire ») et le cablage la contredisait.
  //
  // Rien n'etait PERDU - le travail en file ne porte pas de charge, il relit
  // l'etat courant a l'envoi - mais une file bloquee des le boot rend le compteur
  // « en attente » faux et la ligne de journal alarmante pour rien.
  const writes: Array<Record<string, unknown>> = [];
  let ready = false;
  useSettingsBacking({
    isReady: () => ready,
    readSettings: () => ({}),
    writeSettings: (next) => void writes.push(next),
  });

  saveSettings({ ...SETTINGS_DEFAULTS, combo: [...SETTINGS_DEFAULTS.combo] });
  assert.deepEqual(writes, [], "compte pas charge : aucun envoi, donc aucune file bloquee");

  ready = true;
  saveSettings({ ...SETTINGS_DEFAULTS, combo: [...SETTINGS_DEFAULTS.combo], language: "fr" });
  assert.equal(writes.length, 1, "compte charge : l'ecriture part normalement");
  assert.equal((writes[0] as Record<string, unknown>).language, "fr");

  useSettingsBacking(null);
});
