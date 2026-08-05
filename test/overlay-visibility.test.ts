import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OverlayVisibility } from "../src/main/overlayVisibility";

// Bug (Roch): re-pressing PTT while the previous utterance is still finalizing made the OLD
// flowDone() hide the NEW capture, so "sometimes the animation does not show on press".

test("re-press during finalize keeps the overlay up (the reported bug)", () => {
  const v = new OverlayVisibility();
  v.onStart(); // A: press, overlay shown
  v.onStop(); //  A: release, A now transcribing (pending)
  v.onStart(); // B: press again before A's pipeline finished, overlay shown for B
  assert.equal(v.onDone(), false, "A's flowDone must NOT hide while B is actively capturing");
  v.onStop(); //  B: release
  assert.equal(v.onDone(), true, "B's flowDone hides once nothing is live");
});

test("two quick utterances finishing out of order: hide only after BOTH are done", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop(); // A pending
  v.onStart();
  v.onStop(); // B pending (two in flight)
  assert.equal(v.onDone(), false, "first flowDone: the other utterance is still in flight");
  assert.equal(v.onDone(), true, "second flowDone: nothing left, hide");
});

test("a simple dictation still hides normally", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop();
  assert.equal(v.onDone(), true);
});

test("a tap/cancel while a previous utterance transcribes does not yank the overlay", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop(); // A transcribing
  v.onStart(); // B: quick tap...
  assert.equal(v.onCancel(), false, "cancel must not hide while A is still in flight");
  assert.equal(v.onDone(), true, "A's flowDone then hides");
});

test("a lone tap/cancel hides", () => {
  const v = new OverlayVisibility();
  v.onStart();
  assert.equal(v.onCancel(), true);
});

test("safety timeout hides a stuck pipeline, but yields to an active press", () => {
  const v = new OverlayVisibility();
  v.onStart();
  v.onStop(); // A pending, then its pipeline hangs (no onDone)
  assert.equal(v.onSafetyTimeout(), true, "stuck A: force hide");

  const v2 = new OverlayVisibility();
  v2.onStart();
  v2.onStop();
  v2.onStart(); // B is actively capturing when the (A) safety timer fires
  assert.equal(v2.onSafetyTimeout(), false, "must not hide from under an active press");
});

// ---------------------------------------------------------------------------
// 2026-08-04 : LA PASTILLE AU-DESSUS D'UNE APPLICATION EN PLEIN ECRAN (macOS).
//
// Roch, en utilisant Flow sur son MacBook : « quand je suis dans une window
// fullscreen, l'animation qui montre que ca ecoute ne s'affiche pas. Je pense
// qu'elle s'affiche dans le background derriere l'application. »
//
// Il avait raison sur le symptome ET sur la cause. Le niveau « screen-saver »
// regle la HAUTEUR dans la pile, ce qui suffit sur Windows. Sur macOS, une
// application en plein ecran occupe son propre ESPACE, et une fenetre ordinaire
// n'est visible que sur l'espace ou elle est nee : elle est donc parfaitement
// au-dessus de l'espace d'a cote, ce qui se voit comme « derriere ».
//
// CE QUE CES CANARIS DEFENDENT : les TROIS appels du correctif, ensemble. Aucun
// ne suffit seul, et c'est exactement le genre de trio qu'une relecture future
// simplifie de bonne foi. Ce qu'ils NE peuvent PAS prouver : que macOS se
// comporte comme documente - ca se verifie en plein ecran, sur le Mac.
// ---------------------------------------------------------------------------

const OVERLAY_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main", "overlay.ts"), "utf8");

test("plein ecran macOS : les trois appels du correctif sont la, ensemble", () => {
  // 1. La hauteur dans la pile. Deja la avant ce correctif, et toujours requise :
  //    sans elle, la pastille est sur le bon espace et sous les autres fenetres.
  assert.match(OVERLAY_SRC, /setAlwaysOnTop\(true, "screen-saver"\)/);
  // 2. Le TYPE de fenetre : un NSPanel flotte au-dessus du contenu en plein ecran,
  //    une fenetre ordinaire non.
  assert.match(OVERLAY_SRC, /type: "panel" as const/);
  // 3. L'ESPACE : la fenetre doit suivre l'utilisateur en plein ecran.
  assert.match(OVERLAY_SRC, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/);
});

test("plein ecran macOS : les deux ajouts sont bornes a darwin", () => {
  // Windows n'a pas d'espaces, et `type: "panel"` n'y existe pas. Un reglage
  // inapplicable qui traine est un reglage que quelqu'un devra un jour aller
  // verifier ; celui-la dit de lui-meme ou il s'applique.
  const panelAt = OVERLAY_SRC.indexOf('type: "panel" as const');
  const before = OVERLAY_SRC.slice(Math.max(0, panelAt - 200), panelAt);
  assert.match(before, /process\.platform === "darwin"/, "le type est conditionne a macOS");
  const method = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf("private showOverFullScreen()"));
  assert.match(method.slice(0, 200), /process\.platform !== "darwin"\) return/, "la methode sort tot ailleurs");
});

test("plein ecran macOS : l'espace est RE-AFFIRME a chaque apparition, comme le niveau", () => {
  // macOS reattribue une fenetre a un espace quand on change d'ecran, qu'on entre
  // en plein ecran, ou qu'on revient d'une veille. Le poser une fois a la
  // construction laisserait une pastille qui rate une dictee sur dix - et une
  // pastille a laquelle on ne fait plus confiance ne sert plus a rien.
  const start = OVERLAY_SRC.indexOf("startCapture(");
  const body = OVERLAY_SRC.slice(start, OVERLAY_SRC.indexOf("hotpath.mark(\"overlayStartSent\")", start));
  assert.match(body, /setAlwaysOnTop\(true, "screen-saver"\)/, "le niveau est re-affirme");
  assert.match(body, /this\.showOverFullScreen\(\)/, "et l'espace aussi");
});

test("plein ecran macOS : le correctif ne peut pas couter la dictee", () => {
  // Ce chemin est atteint depuis le gestionnaire de touches du crochet, qui n'a
  // pas de try/catch au-dessus de lui. Une exception ici ne couterait pas une
  // pastille, elle risquerait le crochet clavier lui-meme.
  const method = OVERLAY_SRC.slice(
    OVERLAY_SRC.indexOf("private showOverFullScreen()"),
    OVERLAY_SRC.indexOf("private reposition("),
  );
  assert.match(method, /try \{/, "l'appel est garde");
  assert.match(method, /catch \{/, "et son echec est avale plutot que propage");
});
