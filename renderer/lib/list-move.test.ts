import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { moveTo } from "./list-move.js";

describe("moveTo", () => {
  test("counts the list without the item moved", () => {
    assert.deepEqual(moveTo(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
    assert.deepEqual(moveTo(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
    assert.deepEqual(moveTo(["a", "b", "c"], "b", 1), ["a", "b", "c"]);
  });
  test("clamps the index to the ends", () => {
    assert.deepEqual(moveTo(["a", "b", "c"], "a", 99), ["b", "c", "a"]);
    assert.deepEqual(moveTo(["a", "b", "c"], "c", -4), ["c", "a", "b"]);
    assert.deepEqual(moveTo(["a", "b", "c"], "c", -1), ["c", "a", "b"], "splice counts a negative index from the end; the clamp stops that");
  });
  test("an item not in the list is inserted, and the input is not mutated", () => {
    const list = ["a", "b"];
    assert.deepEqual(moveTo(list, "z", 1), ["a", "z", "b"]);
    assert.deepEqual(list, ["a", "b"]);
  });
});
