import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyLiveNotes,
  sanitizeNoteText,
  parseLiveNotesFile,
  applyNoteAdd,
  applyNoteEdit,
  applyNoteDelete,
  CURRENT_VERSION,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  type LiveNote,
} from "../src/shared/liveNotes";

// D7, the pure half. These notes are the one thing in a recording the user
// TYPED rather than said, which changes what a bug here costs: a dictation that
// goes wrong can be repeated, a note lost mid-meeting cannot. So the tests below
// care most about two things - a note never silently disappearing, and an edit
// never moving a stamp, because a note's value is that it points at a moment.

const N = (id: string, atMs: number, text: string): LiveNote => ({ id, atMs, text });

test("an empty file carries the version and nothing invented", () => {
  const f = emptyLiveNotes("2026-07-30T10:00:00.000Z");
  assert.equal(f.version, CURRENT_VERSION);
  assert.deepEqual(f.notes, []);
  assert.equal(f.startedIso, "2026-07-30T10:00:00.000Z");
});

// ---- sanitizing: refuse, never mangle into something plausible ----

test("sanitizeNoteText drops what is not text instead of coercing it", () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(sanitizeNoteText(bad), "", `${JSON.stringify(bad)} is not a note`);
  }
});

test("sanitizeNoteText keeps accents and punctuation - this is a French app", () => {
  const raw = "Réunion : vérifier l'échéance, très tôt, dès août.";
  assert.equal(sanitizeNoteText(raw), raw, "a clean French note must come back byte-for-byte");
});

test("sanitizeNoteText strips control characters but keeps the words around them", () => {
  // Built with fromCharCode so this SOURCE file never carries a raw control
  // byte - the module's own comment makes the same point about itself. Writing
  // them literally is also how this test quietly turned into a whitespace test
  // once, which is worse than no test: it passed while measuring nothing.
  const nul = String.fromCharCode(0);
  const unit = String.fromCharCode(31);
  assert.equal(sanitizeNoteText("avant" + nul + unit + " apres"), "avant apres");
  assert.equal(sanitizeNoteText("une" + String.fromCharCode(10) + "ligne"), "une ligne", "a newline cannot split a note into two");
});

test("a note longer than the cap is bounded, and the cap is a real number", () => {
  const s = sanitizeNoteText("x".repeat(MAX_NOTE_CHARS * 3));
  assert.ok(s.length <= MAX_NOTE_CHARS, `bounded to ${MAX_NOTE_CHARS}, got ${s.length}`);
  assert.ok(MAX_NOTE_CHARS >= 100, "a cap so small it truncates real notes would be its own bug");
});

// ---- add ----

test("adding keeps commit order and never reorders what is already stored", () => {
  // The module states this deliberately: sorting by stamp would silently
  // rearrange a hand-edited file instead of showing what is actually in it.
  let notes: LiveNote[] = [];
  const a = applyNoteAdd(notes, "premier", 5_000, "a");
  assert.ok("notes" in a);
  notes = a.notes;
  const b = applyNoteAdd(notes, "deuxieme", 1_000, "b"); // an EARLIER stamp
  assert.ok("notes" in b);
  assert.deepEqual(
    b.notes.map((n) => n.id),
    ["a", "b"],
    "the earlier stamp must not jump ahead of the note committed before it",
  );
});

test("an empty note is refused with a sentence, never stored as a blank row", () => {
  const r = applyNoteAdd([], "   \n\t ", 0, "a");
  assert.ok("error" in r);
  assert.ok(r.error.length > 5, "the refusal must be readable by a human");
});

test("a negative or fractional stamp is normalized, never stored as-is", () => {
  const r = applyNoteAdd([], "note", -500.7, "a");
  assert.ok("notes" in r);
  assert.equal(r.notes[0].atMs, 0, "a note cannot point before the start of the recording");
});

test("the note ceiling refuses rather than dropping the oldest note", () => {
  const full: LiveNote[] = Array.from({ length: MAX_NOTES }, (_, i) => N(`i${i}`, i * 1000, "n"));
  const r = applyNoteAdd(full, "une de trop", 1, "x");
  assert.ok("error" in r, "at the cap, the answer is a refusal");
  // Evicting silently would delete something the user typed, which is the one
  // thing this module must never do.
});

// ---- edit: the stamp is the point ----

test("an edit changes the text and leaves the STAMP where it was", () => {
  const notes = [N("a", 12_345, "avant")];
  const r = applyNoteEdit(notes, "a", "apres");
  assert.ok("notes" in r);
  assert.equal(r.notes[0].text, "apres");
  assert.equal(r.notes[0].atMs, 12_345, "moving the stamp would break what the note points AT");
});

test("an edit on an unknown id is REFUSED, never treated as a creation", () => {
  const r = applyNoteEdit([N("a", 0, "x")], "does-not-exist", "texte");
  assert.ok("error" in r);
  // Same rule as snippets.ts: a stale page must not be able to mint a row by
  // editing an id that has since gone.
});

test("an edit does not mutate the array it was handed", () => {
  const notes = [N("a", 0, "avant")];
  const r = applyNoteEdit(notes, "a", "apres");
  assert.ok("notes" in r);
  assert.equal(notes[0].text, "avant", "the input must be left untouched");
});

test("emptying a note through edit is refused, and the message says to delete instead", () => {
  const r = applyNoteEdit([N("a", 0, "x")], "a", "  ");
  assert.ok("error" in r);
  assert.match(r.error, /delete/i, "the refusal must name the right way to do it");
});

// ---- delete: idempotent on purpose ----

test("deleting an id that is already gone is a no-op, not an error", () => {
  const notes = [N("a", 0, "x")];
  assert.deepEqual(applyNoteDelete(notes, "gone"), notes);
  assert.deepEqual(applyNoteDelete(notes, "a"), []);
});

test("delete ignores anything that is not a string id", () => {
  const notes = [N("a", 0, "x")];
  for (const bad of [null, undefined, 7, {}]) {
    assert.deepEqual(applyNoteDelete(notes, bad), notes, "a malformed id must not clear the list");
  }
});

// ---- parsing: a damaged file must not cost the whole meeting ----

test("a file of the wrong shape parses to EMPTY and says so, never to a partial guess", () => {
  for (const bad of [null, undefined, 42, "text", [], { version: 99 }]) {
    const p = parseLiveNotesFile(bad);
    assert.deepEqual(p.file.notes, [], `${JSON.stringify(bad)} must not yield invented notes`);
    assert.ok(p.error, `${JSON.stringify(bad)} must report the refusal - the error IS the overwrite guard`);
  }
});

test("a file with SOME bad rows keeps the good ones and reports the loss", () => {
  const p = parseLiveNotesFile({
    version: CURRENT_VERSION,
    startedIso: "2026-07-30T10:00:00.000Z",
    notes: [
      { id: "a", atMs: 1000, text: "bonne" },
      { id: "b", atMs: "pas un nombre", text: "cassee" },
      null,
      { id: "c", atMs: 2000, text: "bonne aussi" },
    ],
  });
  const ids = p.file.notes.map((n) => n.id);
  assert.ok(ids.includes("a") && ids.includes("c"), "a damaged row must not take the good ones with it");
  assert.ok(p.error, "and the loss must be REPORTED: that error is what stops the cleaned-up copy from being written back over the original");
});

test("a good file round-trips through parse unchanged", () => {
  const file = {
    version: CURRENT_VERSION,
    startedIso: "2026-07-30T10:00:00.000Z",
    notes: [N("a", 1000, "premiere"), N("b", 2000, "deuxieme")],
  };
  const p = parseLiveNotesFile(file);
  assert.deepEqual(p.file.notes, file.notes);
  assert.equal(p.file.startedIso, file.startedIso);
  assert.equal(p.error, undefined, "a clean file must not be flagged, or it could never be written to again");
});
