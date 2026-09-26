import assert from "node:assert/strict";
import { test } from "node:test";

import { joinWithAnd } from "./join-with-and.js";

test("zero items is an empty string", () => {
  assert.equal(joinWithAnd([]), "");
});

test("one item is itself, no glue at all", () => {
  assert.equal(joinWithAnd(["Meter"]), "Meter");
});

test("two items are joined with 'and', no comma", () => {
  assert.equal(joinWithAnd(["Meter", "Target"]), "Meter and Target");
});

test("three or more items get commas, and 'and' before the last only", () => {
  assert.equal(joinWithAnd(["a", "b", "c"]), "a, b and c");
  assert.equal(joinWithAnd(["a", "b", "c", "d"]), "a, b, c and d");
});
