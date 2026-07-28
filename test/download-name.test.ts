import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeTitleForFilename,
  historyDownloadStem,
  numberedFilename,
} from "../src/shared/downloadName";

// U5c: filesystem-safe naming for a downloaded history recording. Pure logic,
// exactly the kind of rule that breaks silently on one odd title - every edge
// case below is chosen from a real Windows/macOS gotcha, not a hypothetical.

test("sanitizeTitleForFilename strips every character Windows forbids in a filename", () => {
  // Hand-verified: each forbidden char becomes one space, adjacent runs of
  // spaces collapse to one, and the whole thing is trimmed.
  const out = sanitizeTitleForFilename('Report<2026>:"final"/version\\1|draft?*');
  assert.doesNotMatch(out, /[<>:"/\\|?*]/, "no forbidden character survives");
  assert.equal(out, "Report 2026 final version 1 draft");
});

test("sanitizeTitleForFilename strips C0 control characters", () => {
  const out = sanitizeTitleForFilename("Client\x00Kickoff\x1f Notes");
  // eslint-disable-next-line no-control-regex -- deliberate: asserting NO control char survived.
  assert.doesNotMatch(out, /[\x00-\x1f]/);
  assert.equal(out, "Client Kickoff Notes");
});

test("sanitizeTitleForFilename trims trailing dots and spaces (Windows silently strips these itself)", () => {
  assert.equal(sanitizeTitleForFilename("Client Update..."), "Client Update");
  assert.equal(sanitizeTitleForFilename("Trailing space   "), "Trailing space");
  assert.equal(sanitizeTitleForFilename("Mixed. . ."), "Mixed");
});

test("sanitizeTitleForFilename renames a bare Windows reserved device name", () => {
  for (const reserved of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
    const out = sanitizeTitleForFilename(reserved);
    assert.notEqual(out.toUpperCase(), reserved.toUpperCase(), `${reserved} must not survive verbatim`);
    assert.ok(out.length > 0);
  }
  // Reserved name WITH an extension-looking suffix is caught too.
  assert.notEqual(sanitizeTitleForFilename("NUL.txt").toUpperCase(), "NUL.TXT");
});

test("sanitizeTitleForFilename leaves a title that merely CONTAINS a reserved word untouched", () => {
  // "Contract Review" starts with "con" but is not the reserved name itself.
  assert.equal(sanitizeTitleForFilename("Contract Review"), "Contract Review");
});

test("sanitizeTitleForFilename falls back to a safe default when nothing printable survives", () => {
  assert.equal(sanitizeTitleForFilename("///"), "recording");
  assert.equal(sanitizeTitleForFilename(""), "recording");
  assert.equal(sanitizeTitleForFilename("   "), "recording");
  assert.equal(sanitizeTitleForFilename("..."), "recording");
});

test("sanitizeTitleForFilename bounds the length without splitting a unicode code point (emoji title)", () => {
  const emojiTitle = "\u{1F600}".repeat(200); // 200 grinning-face emoji, each a surrogate pair
  const out = sanitizeTitleForFilename(emojiTitle);
  assert.ok(out.length <= 220, "bounded, not left at 400 UTF-16 units");
  // Every remaining code point must be a WHOLE emoji, never half a surrogate
  // pair (which would show up as an unpaired surrogate / replacement char).
  for (const ch of out) assert.equal(ch, "\u{1F600}");
});

test("sanitizeTitleForFilename bounds an ordinary long ASCII title", () => {
  const out = sanitizeTitleForFilename("x".repeat(500));
  assert.ok(out.length <= 100, `expected a bounded title, got ${out.length} chars`);
});

test("sanitizeTitleForFilename preserves accented and non-Latin text (French titles are the common case)", () => {
  assert.equal(sanitizeTitleForFilename("Réunion clients - Ébauche"), "Réunion clients - Ébauche");
});

test("historyDownloadStem formats as \"YYYY-MM-DD Title\", sanitizing only the title", () => {
  assert.equal(historyDownloadStem("2026-07-27", "Client Kickoff"), "2026-07-27 Client Kickoff");
  // ":" and "?" in the title are forbidden chars, each becoming a space that
  // then collapses - the leading "2026-07-27 " prefix is untouched.
  assert.equal(historyDownloadStem("2026-07-27", "Q&A: Draft?"), "2026-07-27 Q&A Draft");
});

test("numberedFilename: variant 0 is the plain name, N>=1 inserts \" (N)\" before the extension", () => {
  assert.equal(numberedFilename("2026-07-27 Client Kickoff", "md", 0), "2026-07-27 Client Kickoff.md");
  assert.equal(numberedFilename("2026-07-27 Client Kickoff", "md", 1), "2026-07-27 Client Kickoff (1).md");
  assert.equal(numberedFilename("2026-07-27 Client Kickoff", "md", 2), "2026-07-27 Client Kickoff (2).md");
});

test("numberedFilename never confuses a dot inside the stem for the extension", () => {
  const stem = "2026-07-27 Q3 vs. Q4 Review";
  assert.equal(numberedFilename(stem, "wav", 0), "2026-07-27 Q3 vs. Q4 Review.wav");
  assert.equal(numberedFilename(stem, "wav", 3), "2026-07-27 Q3 vs. Q4 Review (3).wav");
});
