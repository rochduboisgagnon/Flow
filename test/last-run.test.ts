import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLastRun, versionChanged, writeLastRun } from "../src/main/data/lastRun";

// ---------------------------------------------------------------------------
// 2026-08-04 : « VOUS VENEZ DE METTRE A JOUR » DOIT ETRE VRAI POUR L'ETRE.
//
// Ce fichier existe pour qu'une ligne de journal puisse NOMMER la cause plutot que
// decrire le symptome : sur macOS, « le trousseau a refuse la session » et « la
// version vient de changer » sont le meme evenement, parce que safeStorage s'y
// appuie sur un element du trousseau dont l'ACL s'exprime en termes de la
// signature de l'application, et que la signature ad-hoc de Flow change a chaque
// version.
//
// Le piege est le premier lancement : sans fichier, il n'y a PAS eu de mise a
// jour, et dire le contraire a quelqu'un qui vient d'installer Flow serait une
// explication fausse pour un probleme reel, ce qui est pire que pas d'explication.
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-lastrun-"));
}

test("LR-1: a first install is NOT an update", () => {
  assert.deepEqual(versionChanged(null, "2.6.0"), { changed: false, from: "" });
});

test("LR-2: the same version twice is not an update either", () => {
  assert.deepEqual(versionChanged({ version: "2.6.0", atIso: "x" }, "2.6.0"), { changed: false, from: "2.6.0" });
});

test("LR-3: a version change names what ran before", () => {
  assert.deepEqual(versionChanged({ version: "2.5.0", atIso: "x" }, "2.6.0"), { changed: true, from: "2.5.0" });
  // Une RETROGRADATION est aussi un changement : la signature a change, donc le
  // trousseau et TCC se comportent pareil. Ce fait ne juge pas le sens.
  assert.deepEqual(versionChanged({ version: "2.6.0", atIso: "x" }, "2.5.0"), { changed: true, from: "2.6.0" });
});

test("LR-4: what is written comes back", () => {
  const dir = tmpDir();
  writeLastRun({ dir: () => dir }, "2.6.0");
  const back = readLastRun({ dir: () => dir });
  assert.equal(back?.version, "2.6.0");
  assert.match(back?.atIso ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("LR-5: nothing on disk, or garbage on disk, is null and never an exception", () => {
  // Cette lecture est sur le chemin du demarrage : un fichier de diagnostic ne
  // peut pas empecher un lancement.
  const dir = tmpDir();
  assert.equal(readLastRun({ dir: () => dir }), null);
  fs.writeFileSync(path.join(dir, "last-run.json"), "{ pas du json", "utf8");
  assert.equal(readLastRun({ dir: () => dir }), null);
  fs.writeFileSync(path.join(dir, "last-run.json"), JSON.stringify({ version: 7 }), "utf8");
  assert.equal(readLastRun({ dir: () => dir }), null);
  fs.writeFileSync(path.join(dir, "last-run.json"), JSON.stringify({ version: "", atIso: "x" }), "utf8");
  assert.equal(readLastRun({ dir: () => dir }), null, "une version vide n'est pas une version");
});

test("LR-6: the file holds nothing secret, so it survives the keychain refusing", () => {
  // En clair, delibere : le faire passer par safeStorage le rendrait illisible
  // exactement dans le cas ou il sert.
  const dir = tmpDir();
  writeLastRun({ dir: () => dir }, "2.6.0");
  const raw = fs.readFileSync(path.join(dir, "last-run.json"), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["atIso", "version"]);
});

test("LR-7: a write that cannot happen is logged, never thrown", () => {
  const logs: string[] = [];
  // Un chemin qui ne peut pas devenir un dossier : le fichier existe deja.
  const dir = tmpDir();
  const asFile = path.join(dir, "not-a-dir");
  fs.writeFileSync(asFile, "x", "utf8");
  writeLastRun({ dir: () => asFile, log: (m) => logs.push(m) }, "2.6.0");
  assert.ok(logs.some((l) => l.includes("[lastrun]")), `rien n'a ete journalise : ${JSON.stringify(logs)}`);
});
