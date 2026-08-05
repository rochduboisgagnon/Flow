import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ACCESSIBILITY_WHY,
  accessibilityPaneUrl,
  accessibilityStatusLine,
  dictationBlocker,
  type AccessibilityVerdict,
} from "../src/shared/accessibility";
import type { HookHealth } from "../src/shared/hookWatchdog";

// ---------------------------------------------------------------------------
// 2026-08-04 : LA PANNE SILENCIEUSE QUE LE WATCHDOG NE PEUT PAS VOIR.
//
// Sur macOS, un processus sans approbation Accessibilite peut lancer MacKeyServer
// AVEC SUCCES et ne jamais recevoir un seul evenement clavier. hotkey.health()
// rend « armed », hookStatusLine() rend null, le watchdog n'a rien a redemarrer,
// et RIEN ne se declenche jamais. C'est precisement la forme de panne que tout ce
// depot chasse : un controle vert au-dessus de quelque chose qui ne marche pas.
//
// Roch, apres le premier lancement sur son MacBook : « le premier run a eu de la
// misere avec le keybinding de FN Shift, mais je l'ai rallume et ca a fonctionne. »
// Un redemarrage a masque le symptome ; personne n'a su pourquoi.
//
// Et ca va se reproduire a CHAQUE version : la signature ad-hoc de Flow change a
// chaque build, macOS attache l'autorisation a la signature, donc chaque mise a
// jour est une nouvelle application aux yeux de TCC.
// ---------------------------------------------------------------------------

function health(state: HookHealth["state"]): HookHealth {
  return { state, deaths: 0, restarts: 0, lastIncidentAt: null, lastIncidentDetail: null };
}

test("A11Y-1: a missing permission with a perfectly ARMED hook is the silent failure", () => {
  // Le cas qui prouve la fonctionnalite. Sans cette ligne, l'application dit
  // « tout va bien » a quelqu'un dont le raccourci ne repond pas.
  assert.equal(dictationBlocker(health("armed"), "missing"), "accessibility");
});

test("A11Y-2: a missing permission outranks EVERY hook state", () => {
  // Sur macOS une autorisation absente est ce qui fait mourir le serveur de
  // touches : la panne du crochet en est la consequence, pas une seconde cause.
  for (const s of ["armed", "starting", "restarting", "abandoned", "stopped"] as HookHealth["state"][]) {
    assert.equal(dictationBlocker(health(s), "missing"), "accessibility", `hook=${s}`);
  }
});

test("A11Y-3: with the permission GRANTED, a dead hook is still a dead hook", () => {
  assert.equal(dictationBlocker(health("abandoned"), "granted"), "hook");
  assert.equal(dictationBlocker(health("restarting"), "granted"), "hook");
  assert.equal(dictationBlocker(health("armed"), "granted"), "none");
});

test("A11Y-4: on Windows the question does not apply, and must not change any answer", () => {
  // "unknown" est la reponse partout ou la question ne se pose pas. Elle ne doit
  // JAMAIS se comporter comme "missing", sinon Windows heriterait d'un message
  // sur une permission macOS.
  assert.equal(dictationBlocker(health("armed"), "unknown"), "none");
  assert.equal(dictationBlocker(health("abandoned"), "unknown"), "hook");
  assert.equal(accessibilityStatusLine("unknown"), null);
  assert.equal(accessibilityStatusLine("granted"), null);
});

test("A11Y-5: the status line says GRANT, and never 'restart Flow'", () => {
  const line = accessibilityStatusLine("missing");
  assert.ok(line, "aucune ligne de statut pour une permission absente");
  assert.match(line, /accessibility/i);
  // C'est le conseil precisement FAUX que cette fonctionnalite existe pour
  // retirer : redemarrer Flow ne rend pas une autorisation que le systeme refuse.
  assert.doesNotMatch(line, /restart/i);
});

test("A11Y-6: the explanation names the cause, so it is not read as a bug", () => {
  // Roch va rencontrer ce texte apres chaque mise a jour. S'il ne dit pas
  // POURQUOI, il se lit comme une regression de Flow.
  assert.match(ACCESSIBILITY_WHY, /signature/i);
  assert.match(ACCESSIBILITY_WHY, /version/i);
  assert.doesNotMatch(ACCESSIBILITY_WHY, /—/, "em-dash interdit dans un texte visible");
});

test("A11Y-7: exactly ONE place in src/ asks macOS the question", () => {
  // Meme regle que « CAPS est lu une fois » : un fait de plateforme lu a deux
  // endroits finit par etre lu differemment. Et isTrustedAccessibilityClient
  // n'existe QUE sur macOS - un appel sans garde plante ailleurs.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(process.cwd(), "src"));
  const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes("isTrustedAccessibilityClient"));
  assert.deepEqual(
    hits.map((f) => path.basename(f)),
    ["macAccessibility.ts"],
    `la question est posee ailleurs que dans macAccessibility.ts : ${hits.join(", ")}`,
  );
});

test("A11Y-8: the probe never prompts, because a health check must have no side effect", () => {
  // prompt: true fait apparaitre un dialogue APPARTENANT AU SYSTEME, a un instant
  // que nous n'avons pas choisi. Une sonde qui tourne toutes les dix secondes ne
  // peut pas se le permettre.
  const src = fs.readFileSync(path.join(process.cwd(), "src", "main", "macAccessibility.ts"), "utf8");
  assert.match(src, /isTrustedAccessibilityClient\(false\)/);
  assert.doesNotMatch(src, /isTrustedAccessibilityClient\(true\)/);
  // Et la garde de plateforme, sans laquelle l'appel plante sur Windows.
  assert.match(src, /process\.platform !== "darwin"/);
});

test("A11Y-9: engineStatus() puts the permission ABOVE the hook outage", () => {
  // Canari de source, patron de test/platform.test.ts. L'ordre est le fait : une
  // ligne « keyboard shortcut unavailable - restart Flow » affichee alors que le
  // systeme refuse la permission envoie l'utilisateur redemarrer en boucle.
  const index = fs.readFileSync(path.join(process.cwd(), "src", "main", "index.ts"), "utf8");
  const accessAt = index.indexOf("accessibilityStatusLine(");
  const hookAt = index.indexOf("hookStatusLine(hotkey.health())");
  assert.ok(accessAt > 0, "engineStatus() ne consulte pas la permission");
  assert.ok(hookAt > 0);
  assert.ok(accessAt < hookAt, "la ligne du crochet est testee AVANT celle de la permission");
});

test("A11Y-10: the pane to open is a pure answer, and nothing on Windows", () => {
  // Meme forme que capabilitiesFor et updateChannelFor : la plateforme est un
  // ARGUMENT. C'est ce qui garde uiBridge.ts sans process.platform (un canari de
  // test/long-ipc-parity.test.ts l'interdit dans ce fichier) et ce qui rend les
  // deux reponses testables depuis Windows.
  assert.equal(accessibilityPaneUrl("win32"), null);
  assert.equal(accessibilityPaneUrl("linux"), null);
  const url = accessibilityPaneUrl("darwin");
  assert.ok(url, "aucun panneau a ouvrir sur macOS");
  assert.match(url, /^x-apple\.systempreferences:/);
  assert.match(url, /Privacy_Accessibility/);
});

test("A11Y-11: uiBridge names the destination, it never reads the platform", () => {
  const ui = fs.readFileSync(path.join(process.cwd(), "src", "main", "uiBridge.ts"), "utf8");
  assert.match(ui, /which === "accessibility-settings"/, "le canal n'a pas de destination Accessibilite");
  assert.match(ui, /ACCESSIBILITY_PANE_URL/);
  // La regle du canari existant, redite ici pour qu'elle echoue dans le fichier
  // qui explique POURQUOI plutot que dans celui du mode longue duree.
  assert.doesNotMatch(ui, /process\.platform/, "un fait de plateforme est revenu dans uiBridge.ts");
});

const _typecheck: AccessibilityVerdict[] = ["unknown", "granted", "missing"];
void _typecheck;
