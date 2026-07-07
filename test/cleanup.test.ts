import test from "node:test";
import assert from "node:assert/strict";
import { buildCleanupPrompt, extractCleanedText, CLEANUP_MIN_CHARS } from "../src/shared/cleanup";

test("prompt carries the dictation and the voice-command rules", () => {
  const p = buildCleanupPrompt("bonjour nouvelle ligne merci");
  assert.ok(p.includes("bonjour nouvelle ligne merci"));
  assert.ok(p.includes("nouvelle ligne"));
  assert.ok(p.includes("scratch that"));
  assert.ok(p.includes("NEVER add content"));
});

test("clean answers pass through trimmed", () => {
  assert.equal(extractCleanedText("  Bonjour, merci.\n", "bonjour merci"), "Bonjour, merci.");
});

test("wrapping fences and quotes are stripped", () => {
  assert.equal(extractCleanedText("```\nBonjour.\n```", "bonjour"), "Bonjour.");
  assert.equal(extractCleanedText('"Bonjour."', "bonjour"), "Bonjour.");
  assert.equal(extractCleanedText("«Bonjour.»", "bonjour"), "Bonjour.");
});

test("empty or chatty answers fall back to the original", () => {
  assert.equal(extractCleanedText("", "texte original"), "texte original");
  assert.equal(extractCleanedText("   ", "texte original"), "texte original");
  const chatty = "Here is the cleaned text you asked for! ".repeat(20);
  assert.equal(extractCleanedText(chatty, "court"), "court");
});

test("a dictation that legitimately starts with quotes keeps them", () => {
  const original = '"citation" disait-il, et la suite du texte continue ici même';
  assert.equal(extractCleanedText(original, original), original);
});

test("threshold constant matches the plan (50 chars)", () => {
  assert.equal(CLEANUP_MIN_CHARS, 50);
});
