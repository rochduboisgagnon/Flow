import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { updateChannelFor } from "../src/shared/updateChannelChoice";

// 2026-08-04 : le meme patron que test/platform.test.ts, pour le meme genre de
// fait. Une fonction pure qui prend la plateforme en argument se teste sans deux
// machines ; un `process.platform` cache dans un module ne se teste pas du tout.

const SRC = path.join(process.cwd(), "src");

test("UC-1: Windows keeps the mechanism that already works", () => {
  assert.equal(updateChannelFor("win32"), "electron-updater");
});

test("UC-2: an unknown platform gets NO channel, rather than a guess", () => {
  // Meme defaut prudent que capabilitiesFor : une mise a jour qu'on croit
  // possible et qui ne l'est pas produit un bouton qui a l'air vivant.
  assert.equal(updateChannelFor("linux"), null);
  assert.equal(updateChannelFor("freebsd"), null);
  assert.equal(updateChannelFor(""), null);
});

test("UC-3: macOS has no channel until BOTH the mechanism and the feed exist", () => {
  // Ce test change en une ligne au commit de basculement, et c'est voulu : il
  // interdit de brancher l'updater mac sur un document que la chaine de
  // publication n'ecrit pas encore. Le mauvais ordre donnerait un updater qui
  // interroge un 404 quatre fois par jour en se croyant a jour.
  assert.equal(updateChannelFor("darwin"), null);
});

test("UC-4: nothing but updateChannelFor decides which channel gets built", () => {
  // Canari de source, exactement comme test/platform.test.ts le fait pour CAPS.
  // Sans lui, une session future pourrait rebrancher le canal sur un
  // `process.platform === "darwin"` ecrit sur place, et la fonction pure
  // deviendrait un ornement teste qui ne decide plus rien.
  const index = fs.readFileSync(path.join(SRC, "main", "index.ts"), "utf8");
  assert.match(index, /const UPDATE_CHANNEL = updateChannelFor\(process\.platform\)/);
  // Chaque canal se construit derriere une comparaison au NOM, jamais derriere une
  // lecture de plateforme ecrite sur place. Asserte sur l'intention et non sur la
  // forme : ce test a deja epingle un ternaire, et le remplacer par un if/else -
  // qui respectait parfaitement la regle - l'a fait echouer pour rien.
  assert.match(index, /UPDATE_CHANNEL === "electron-updater"[\s\S]{0,80}new ElectronUpdaterChannel/);
  assert.match(index, /UPDATE_CHANNEL === "mac-zip"[\s\S]{0,200}new MacZipChannel/);
  // Et process.platform n'est lu que DEUX fois dans tout index.ts : pour CAPS et
  // pour UPDATE_CHANNEL. C'est la regle « un fait de plateforme, un seul lecteur »,
  // et elle est ce qui garde les deux fonctions pures reellement decisives.
  const platformReads = (index.match(/capabilitiesFor\(process\.platform\)|updateChannelFor\(process\.platform\)/g) ?? [])
    .length;
  assert.equal(platformReads, 2, "index.ts a gagne ou perdu une lecture de plateforme");
});

test("UC-5: the update policy knows nothing about platforms", () => {
  // L'invariant que la refonte du 2026-08-04 a achete, et le seul qui garde le
  // sas calme testable : updater.ts n'importe ni electron, ni electron-updater,
  // et ne lit pas process.platform.
  const updater = fs.readFileSync(path.join(SRC, "main", "updater.ts"), "utf8");
  assert.doesNotMatch(updater, /process\.platform/, "un process.platform est revenu dans la politique");
  assert.doesNotMatch(updater, /from "electron"/, "updater.ts importe electron : il redevient intestable");
  assert.doesNotMatch(updater, /from "electron-updater"/, "updater.ts importe electron-updater");
});
