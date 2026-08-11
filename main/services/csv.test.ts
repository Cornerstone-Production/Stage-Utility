import { strict as assert } from "node:assert";
import { test } from "node:test";

import { encodeRow, parseRows } from "./csv.js";

test("encodeRow terminates the line", () => {
  assert.equal(encodeRow(["a", "b"]), "a,b\n");
});

test("encodeRow renders null and undefined as empty", () => {
  assert.equal(encodeRow(["a", null, undefined, 3]), "a,,,3\n");
});

test("encodeRow quotes commas, quotes and newlines", () => {
  assert.equal(encodeRow(["a,b"]), '"a,b"\n');
  assert.equal(encodeRow(['say "hi"']), '"say ""hi"""\n');
  assert.equal(encodeRow(["two\nlines"]), '"two\nlines"\n');
});

test("encodeRow leaves plain values unquoted", () => {
  assert.equal(encodeRow(["plain", 12.5]), "plain,12.5\n");
});

test("parseRows round-trips encodeRow", () => {
  const text = encodeRow(["a", "b,c"]) + encodeRow(['q"d', 1]);
  assert.deepEqual(parseRows(text), [
    ["a", "b,c"],
    ['q"d', "1"],
  ]);
});

test("parseRows drops a truncated final line", () => {
  const text = encodeRow(["a", "b"]) + "c,d-but-the-power-w";
  assert.deepEqual(parseRows(text), [["a", "b"]]);
});

test("parseRows returns nothing for an empty or headerless-partial file", () => {
  assert.deepEqual(parseRows(""), []);
  assert.deepEqual(parseRows("no newline yet"), []);
});

test("parseRows keeps embedded newlines inside quotes", () => {
  assert.deepEqual(parseRows(encodeRow(["two\nlines", "x"])), [["two\nlines", "x"]]);
});

test("parseRows drops a final line truncated inside a quoted cell", () => {
  const text = encodeRow(["a"]) + '"unterminated';
  assert.deepEqual(parseRows(text), [["a"]]);
});
