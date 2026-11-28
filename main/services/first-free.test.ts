import assert from "node:assert/strict";
import { test } from "node:test";

import { firstFree, firstFreeNumbered, truncatingJoin } from "./first-free.js";

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

// firstFreeNumbered: the default name a new thing gets ("OSC target 3").

test("firstFreeNumbered: start is the first number tried, and a taken one walks on", () => {
  assert.equal(firstFreeNumbered("Sheet", () => false, 1), "Sheet 1");
  assert.equal(firstFreeNumbered("Sheet", () => false, 4), "Sheet 4");
  const taken = new Set(["Sheet 3", "Sheet 4"]);
  assert.equal(firstFreeNumbered("Sheet", (s) => taken.has(s), 3), "Sheet 5");
});

test("firstFreeNumbered: add three, delete the second, add one -> no duplicate", () => {
  const names: string[] = [];
  const add = () => {
    const n = firstFreeNumbered("OSC target", (s) => names.includes(s), names.length + 1);
    names.push(n);
  };
  add(); add(); add();
  names.splice(1, 1); // delete "OSC target 2"
  add();
  assert.equal(new Set(names).size, names.length, `duplicate in ${JSON.stringify(names)}`);
});

// truncatingJoin: the suffix goes on after the base has given up room for it.

test("truncatingJoin: the base is cut to leave room, and no hyphen is left dangling", () => {
  const join = truncatingJoin(8);
  assert.equal(join("abcd", 2), "abcd-2");
  assert.equal(join("abcdefgh", 2), "abcdef-2");
  assert.equal(join("abcdef-h", 10), "abcde-10");
  assert.equal(join("abc-----", 2), "abc-2");
});
