import assert from "node:assert/strict";
import { test } from "node:test";

import { firstFree } from "./first-free.js";

test("the base itself when it is free", () => {
  assert.equal(firstFree("a", () => false), "a");
});

test("the first suffix is 2", () => {
  assert.equal(firstFree("a", (s) => s === "a"), "a-2");
});

test("-2, -3 … until free, and a gap is not filled behind a taken name", () => {
  const taken = new Set(["a", "a-2", "a-3", "a-5"]);
  assert.equal(firstFree("a", (s) => taken.has(s)), "a-4");
});

test("the join says where the suffix goes", () => {
  const taken = new Set(["cue", "cue_2"]);
  assert.equal(firstFree("cue", (s) => taken.has(s), (b, n) => `${b}_${n}`), "cue_3");
});
