import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotIsRestorable,
  planRestore,
  restoreFlavours,
  RESTORE_DELAY_MS,
  type RestorePlan,
} from "../src/shared/clipboardSnapshot";

test("text and image snapshots are restorable", () => {
  assert.equal(snapshotIsRestorable({ kind: "text", text: "hello" }), true);
  assert.equal(snapshotIsRestorable({ kind: "text", text: "" }), true); // an empty string was still a real clipboard state
  assert.equal(snapshotIsRestorable({ kind: "image", hasImage: true }), true);
});

test("a rich (text + html) snapshot is restorable", () => {
  // Word / browser content: restoring it text-only was the formatting loss.
  assert.equal(
    snapshotIsRestorable({ kind: "rich", text: "hello", html: "<b>hello</b>" }),
    true,
  );
});

test("an empty clipboard is not restored (no clobber with nothing)", () => {
  assert.equal(snapshotIsRestorable({ kind: "empty" }), false);
});

// U3g (review, major): the regression the HTML flavour introduced. The adapter
// restored the FIRST flavour it found, testing html before image, in an
// exclusive if/else - so an html+bitmap clipboard came back without its bitmap,
// on every single dictation. Before the html flavour existed, that same
// clipboard fell through to writeImage and the bitmap survived.
test("html + image with NO text: the bitmap comes back too, not just the html", () => {
  const f = restoreFlavours({ kind: "rich", html: "<b>copied from a web page</b>", hasImage: true });
  assert.notEqual(f, null);
  assert.equal(f?.html, "<b>copied from a web page</b>");
  assert.equal(f?.image, true, "the bitmap was captured; dropping it is the bug");
  assert.equal(f?.text, undefined, "a clipboard with no text must not be given an empty text flavour");
});

test("every captured flavour is restored together, never ranked", () => {
  const all = restoreFlavours({ kind: "rich", text: "hello", html: "<b>hello</b>", hasImage: true });
  assert.deepEqual(all, { text: "hello", html: "<b>hello</b>", image: true });

  // And the plainer shapes keep exactly what they had, nothing invented.
  assert.deepEqual(restoreFlavours({ kind: "text", text: "hello" }), { text: "hello", image: false });
  assert.deepEqual(restoreFlavours({ kind: "image", hasImage: true }), { image: true });
  assert.deepEqual(restoreFlavours({ kind: "rich", text: "", html: "<i>x</i>" }), {
    text: "",
    html: "<i>x</i>",
    image: false,
  });
});

test("text + image with no html: the image is not lost either", () => {
  // The other half of the same ranking bug: "text" used to win over "image".
  assert.deepEqual(restoreFlavours({ kind: "text", text: "a caption", hasImage: true }), {
    text: "a caption",
    image: true,
  });
});

test("an empty snapshot has nothing to write back", () => {
  assert.equal(restoreFlavours({ kind: "empty" }), null);
});

// Burst model: mirrors exactly what insert.ts does around each paste, without
// Electron. `onClipboard` is what a fresh snapshot would see at that instant -
// after the first insertion that is OUR dictation, which is the whole trap.
function simulateBurst(userClipboard: string, dictations: string[]) {
  let pending: string | null = null;
  let onClipboard = userClipboard;
  let armed = 0;
  let cancelled = 0;
  for (const dictation of dictations) {
    // Annotated on purpose: `pending` is both an input here and the target of
    // the assignment below, so letting TS infer `plan` would be circular.
    const plan: RestorePlan<string> = planRestore(pending, onClipboard);
    if (plan.cancelPrevious) cancelled++;
    pending = plan.prior;
    onClipboard = dictation; // the insertion writes the dictation, then pastes
    armed++;
  }
  return { prior: pending, restores: armed - cancelled };
}

test("two insertions inside the restore window give back the pre-burst clipboard", () => {
  const burst = simulateBurst("user's precious text", ["dictation one", "dictation two"]);
  assert.equal(burst.prior, "user's precious text");
  assert.notEqual(burst.prior, "dictation one"); // the bug: prior became our own text
  assert.equal(burst.restores, 1);
});

test("three insertions inside the restore window still restore once, to the pre-burst clipboard", () => {
  const burst = simulateBurst("user's precious text", ["one", "two", "three"]);
  assert.equal(burst.prior, "user's precious text");
  assert.equal(burst.restores, 1);
});

test("an isolated insertion is unchanged: capture, arm, restore that capture", () => {
  const burst = simulateBurst("user's precious text", ["only dictation"]);
  assert.equal(burst.prior, "user's precious text");
  assert.equal(burst.restores, 1);
});

test("once the pending restore has fired, the next insertion captures fresh again", () => {
  // Timer fired => pending cleared => a later, unrelated dictation must adopt
  // whatever the user has copied SINCE, not the value from the last burst.
  const plan = planRestore(null, "something copied later");
  assert.equal(plan.prior, "something copied later");
  assert.equal(plan.cancelPrevious, false);
});

test("restore delay leaves the paste time to land but stays brief", () => {
  assert.ok(RESTORE_DELAY_MS >= 150 && RESTORE_DELAY_MS <= 400);
});
