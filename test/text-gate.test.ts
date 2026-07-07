import test from "node:test";
import assert from "node:assert/strict";
import { gateTranscript, isHallucination, normalizeForGate } from "../src/shared/textGate";

test("real dictation passes untouched (trimmed)", () => {
  assert.equal(
    gateTranscript("  Bonjour, peux-tu m'envoyer le rapport demain matin ? "),
    "Bonjour, peux-tu m'envoyer le rapport demain matin ?",
  );
  assert.equal(gateTranscript("Merci"), "Merci"); // a plain thanks is legit
  assert.equal(gateTranscript("Thank you so much for the update."), "Thank you so much for the update.");
});

test("the classic Whisper silence hallucinations are dropped", () => {
  for (const phantom of [
    "Sous-titres réalisés par la communauté d'Amara.org",
    " Sous-titres realises para la communaute d'Amara.org",
    "Subtitles by the Amara.org community",
    "Merci d'avoir regardé cette vidéo.",
    "Thank you for watching!",
    "N'oubliez pas de vous abonner",
    "Sous-titrage Société Radio-Canada",
  ]) {
    assert.equal(gateTranscript(phantom), null, phantom);
  }
});

test("sound tags and empty output are dropped", () => {
  for (const phantom of ["[BLANK_AUDIO]", "[Musique]", "(bruit de fond)", "*rires*", "...", " ", "♪ ♪"]) {
    assert.equal(gateTranscript(phantom), null, JSON.stringify(phantom));
  }
});

test("normalization strips accents and punctuation", () => {
  assert.equal(
    normalizeForGate("Sous-titres RÉALISÉS par la communauté d'Amara.org !"),
    "sous titres realises par la communaute d amara org",
  );
});

test("sentences that merely mention watching or subscribing pass", () => {
  assert.equal(isHallucination("Je viens de regarder la vidéo que tu m'as envoyée."), false);
  assert.equal(isHallucination("Peux-tu t'abonner au journal pour le bureau ?"), false);
});
