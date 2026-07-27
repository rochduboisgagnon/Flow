import test from "node:test";
import assert from "node:assert/strict";
import pkg from "../package.json";

// CI stays green from the very first commit; real suites arrive with each brick.
test("package identity", () => {
  assert.equal(pkg.name, "flow");
  assert.equal(pkg.license, "MIT");
});
