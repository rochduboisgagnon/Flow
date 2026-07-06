import test from "node:test";
import assert from "node:assert/strict";
import { decideRoute, parseFocusLine } from "../src/shared/route";

test("editable field -> insert", () => {
  assert.equal(decideRoute({ editable: true, control: "edit", app: "notepad" }), "insert");
  assert.equal(decideRoute({ editable: true, control: "document", app: "chrome" }), "insert");
});

test("non-editable focus -> clipboard", () => {
  assert.equal(decideRoute({ editable: false, control: "button", app: "explorer" }), "clipboard");
});

test("null probe (crash/timeout) -> clipboard, never a blind insert", () => {
  assert.equal(decideRoute(null), "clipboard");
});

test("parse a well-formed probe line", () => {
  assert.deepEqual(parseFocusLine('{"editable":true,"control":"edit","app":"notepad"}'), {
    editable: true,
    control: "edit",
    app: "notepad",
  });
});

test("parse the readiness line -> null (no editable field)", () => {
  assert.equal(parseFocusLine('{"ready":true}'), null);
});

test("malformed / partial output degrades to null, never throws", () => {
  assert.equal(parseFocusLine("not json"), null);
  assert.equal(parseFocusLine('{"editable":'), null);
  assert.equal(parseFocusLine(""), null);
  assert.equal(parseFocusLine("null"), null);
});

test("missing optional fields default cleanly", () => {
  assert.deepEqual(parseFocusLine('{"editable":false}'), {
    editable: false,
    control: "",
    app: "",
  });
});
