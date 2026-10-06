import { strict as assert } from "node:assert";
import { test } from "node:test";
import { plural } from "./plural.js";

test("one takes the singular, every other count the plural", () => {
  assert.equal(plural(1, "feed"), "1 feed");
  assert.equal(plural(0, "feed"), "0 feeds");
  assert.equal(plural(2, "feed"), "2 feeds");
});

test("a word that does not just add an s names its plural", () => {
  assert.equal(plural(1, "feed has", "feeds have"), "1 feed has");
  assert.equal(plural(3, "feed has", "feeds have"), "3 feeds have");
});
