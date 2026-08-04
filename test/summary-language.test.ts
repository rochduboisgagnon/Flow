import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSummaryLanguage,
  summaryShape,
  stripLeadingSummaryHeading,
  SUMMARY_HEADINGS,
  spokenTextOnly,
} from "../src/shared/summaryLanguage";
import { summaryPrompt } from "../src/shared/longform";

// ---------------------------------------------------------------------------
// 2026-08-04 : « si le transcript est en francais, ca sort en francais ; en
// anglais, ca sort en anglais ; dans d'autres langues, dans les autres langues
// respectives. » (Roch)
//
// CE QUE CES TESTS DEFENDENT, ET CE QU'ILS NE PEUVENT PAS DEFENDRE.
//
// Ils prouvent ce qui est DETERMINISTE : la langue lue dans le texte, les titres
// qui en decoulent, et le nettoyage de la sortie. Ce qu'un test unitaire ne peut
// pas prouver est l'obeissance du modele - ca s'est mesure contre le vrai modele
// (quatre executions, le 2026-08-04) et la mesure est ecrite dans le bandeau de
// shared/summaryLanguage.ts, pas simulee ici.
// ---------------------------------------------------------------------------

const FR = `[00:00:00] Bonjour tout le monde, on commence la reunion hebdomadaire.
[00:00:12] Le premier point, c'est le retard sur la livraison du module de facturation.
[00:00:31] Marie, tu disais que l'equipe avait besoin de deux semaines de plus.
[00:01:02] Bon, on decale la livraison au quinze septembre, et je previens le client aujourd'hui.
[00:01:55] Dernier point : le budget a augmente de trente pour cent, il faut qu'on regarde ca.`;

const EN = `[00:00:00] Alright everyone, let's start the weekly sync.
[00:00:12] First item is the delay on the billing module delivery.
[00:00:31] Marie, you said that the team needed two more weeks.
[00:01:02] Fine, we push the delivery to September fifteenth, and I will tell the client today.
[00:01:55] Last item: the cloud budget went up thirty percent, we need to look at that.`;

test("un transcript francais SANS accents est reconnu comme francais", () => {
  // Le cas qui compte : le moteur produit du francais sans accents quand la
  // langue n'est pas forcee, donc les mots outils doivent suffire a eux seuls.
  assert.doesNotMatch(FR, /[éèêàçô]/, "ce transcript est deliberement sans accents");
  assert.equal(detectSummaryLanguage(FR), "fr");
});

test("un transcript anglais est reconnu comme anglais", () => {
  assert.equal(detectSummaryLanguage(EN), "en");
});

test("les accents renforcent le francais sans etre necessaires", () => {
  const accented = FR.replace("reunion", "réunion").replace("decale", "décale").replace("augmente", "augmenté");
  assert.equal(detectSummaryLanguage(accented), "fr");
});

test("trop court pour trancher rend NULL, jamais une devinette", () => {
  assert.equal(detectSummaryLanguage(""), null);
  assert.equal(detectSummaryLanguage("[00:00:00] Bonjour."), null);
  assert.equal(detectSummaryLanguage("[00:00:00] Hello."), null);
});

test("une reunion BILINGUE rend NULL plutot que d'etre tranchee a une voix pres", () => {
  // Deux personnes qui changent de langue. Nommer l'une des deux ferait traduire
  // la moitie de la reunion ; ne rien nommer laisse le modele suivre le texte.
  assert.equal(detectSummaryLanguage(FR + "\n" + EN), null);
});

test("une langue inconnue de cette fonction rend NULL", () => {
  // De l'espagnol : ni les mots francais ni les mots anglais ne s'y trouvent en
  // nombre. C'est le troisieme chemin du prompt, pas un echec.
  const es = `[00:00:00] Buenos dias a todos, empezamos la reunion semanal.
[00:00:12] El primer punto es el retraso en la entrega del modulo de facturacion.
[00:00:31] Maria, decias que el equipo necesitaba dos semanas mas.
[00:01:02] Bien, movemos la entrega al quince de septiembre y aviso al cliente hoy.`;
  assert.equal(detectSummaryLanguage(es), null);
});

test("les horodatages et l'entete ne pesent pas dans la balance", () => {
  const stripped = spokenTextOnly("# Reunion\n\n- recorded: 2026-08-04T13:00:00.000Z\n- engine: AGR Flow\n\n[00:01:02] bonjour");
  assert.doesNotMatch(stripped, /00:01:02/);
  assert.doesNotMatch(stripped, /recorded|engine|reunion/);
  assert.match(stripped, /bonjour/);
});

// ---------------------------------------------------------------------------
// LA FORME DU PROMPT
// ---------------------------------------------------------------------------

test("le prompt NOMME la langue et pose les titres dans cette langue", () => {
  const fr = summaryPrompt(FR, []);
  assert.match(fr, /transcript is in FRENCH/);
  assert.match(fr, /## Points clés/);
  assert.match(fr, /## Décisions/);
  assert.match(fr, /## Suivis/);
  assert.doesNotMatch(fr, /## Key points/, "aucun titre anglais dans un prompt francais");

  const en = summaryPrompt(EN, []);
  assert.match(en, /transcript is in ENGLISH/);
  assert.match(en, /## Key points/);
  assert.match(en, /## Follow-ups/);
  // LE DEFAUT MESURE : ce prompt-la imposait « ## Points cles » et « ## Suivis »
  // a un transcript anglais, et le modele rendait de la prose anglaise dessous.
  assert.doesNotMatch(en, /Points cl/, "plus aucun titre francais dans un prompt anglais");
  assert.doesNotMatch(en, /## Suivis/);
});

test("langue indeterminee : rien n'est nomme, et le modele doit traduire les titres", () => {
  const shape = summaryShape(null);
  assert.match(shape, /SAME language the transcript is written in/);
  assert.match(shape, /TRANSLATED into the language of the transcript/);
  assert.match(shape, /never fall back to English/);
  assert.doesNotMatch(shape, /is in FRENCH|is in ENGLISH/);
});

test("les quatre titres existent dans les deux langues, et ne se melangent pas", () => {
  for (const lang of ["fr", "en"] as const) {
    const h = SUMMARY_HEADINGS[lang];
    for (const v of [h.key, h.decisions, h.actions, h.follow]) {
      assert.ok(v.length > 0);
      assert.doesNotMatch(v, /^#/, "le titre est le TEXTE, la mise en forme est ajoutee par le prompt");
    }
  }
  assert.notEqual(SUMMARY_HEADINGS.fr.key, SUMMARY_HEADINGS.en.key);
  // Le francais est accentue : c'est du contenu que quelqu'un lit.
  assert.match(SUMMARY_HEADINGS.fr.key, /clés/);
  assert.match(SUMMARY_HEADINGS.fr.decisions, /Décisions/);
});

// ---------------------------------------------------------------------------
// LE NETTOYAGE DE LA SORTIE
// ---------------------------------------------------------------------------

test("un « ## Summary » en tete est retire - le document a deja son titre", () => {
  // Mesure du 2026-08-04 : le modele l'ecrit malgre la consigne qui l'interdit.
  assert.equal(stripLeadingSummaryHeading("## Summary\n\nLa reunion a couvert trois points."), "La reunion a couvert trois points.");
  assert.equal(stripLeadingSummaryHeading("## Résumé\nDeux decisions."), "Deux decisions.");
  assert.equal(stripLeadingSummaryHeading("# Overview\n\ntexte"), "texte");
});

test("une VRAIE section en premiere ligne survit", () => {
  // La difference qui compte : « ## Points cles » est une section du document, pas
  // un titre redondant. La confondre avec l'autre supprimerait du contenu.
  const notes = "## Points clés\n\n- quelque chose";
  assert.equal(stripLeadingSummaryHeading(notes), notes);
  const en = "## Key points\n\n- something";
  assert.equal(stripLeadingSummaryHeading(en), en);
});

test("du texte sans titre en tete n'est pas touche", () => {
  const notes = "La reunion a couvert trois points.\n\n## Points clés\n\n- un";
  assert.equal(stripLeadingSummaryHeading(notes), notes);
});

test("le nettoyage ne touche QUE la premiere ligne", () => {
  // Un « ## Summary » au MILIEU du document est peut-etre voulu ; ce n'est en
  // tout cas pas le doublon que cette fonction existe pour retirer.
  const notes = "Un paragraphe.\n\n## Summary\n\n- un";
  assert.equal(stripLeadingSummaryHeading(notes), notes);
});
