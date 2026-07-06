import test from "node:test";
import assert from "node:assert/strict";
import { snapshotIsRestorable, RESTORE_DELAY_MS } from "../src/shared/clipboardSnapshot";

test("text and image snapshots are restorable", () => {
  assert.equal(snapshotIsRestorable({ kind: "text", text: "hello" }), true);
  assert.equal(snapshotIsRestorable({ kind: "text", text: "" }), true); // an empty string was still a real clipboard state
  assert.equal(snapshotIsRestorable({ kind: "image", hasImage: true }), true);
});

test("an empty clipboard is not restored (no clobber with nothing)", () => {
  assert.equal(snapshotIsRestorable({ kind: "empty" }), false);
});

test("restore delay leaves the paste time to land but stays brief", () => {
  assert.ok(RESTORE_DELAY_MS >= 150 && RESTORE_DELAY_MS <= 400);
});
