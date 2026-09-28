import { strict as assert } from "node:assert";
import { test } from "node:test";
import { feedIdFor, FEED_ID_PATTERN } from "./feed-id.js";

test("slugs a name", () => assert.equal(feedIdFor("Program (IMAG)", new Set()), "program-imag"));
test("never empty", () => assert.equal(feedIdFor("!!!", new Set()), "feed"));
test("unique by suffix", () => assert.equal(feedIdFor("PTZ", new Set(["ptz", "ptz-2"])), "ptz-3"));
test("capped at 40 and still valid", () => {
  const id = feedIdFor("a".repeat(80), new Set());
  assert.ok(id.length <= 40 && FEED_ID_PATTERN.test(id));
});
test("prototype names are ordinary ids", () => {
  assert.equal(feedIdFor("__proto__", new Set()), "proto");
});
