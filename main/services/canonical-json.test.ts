import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, sameJson } from "./canonical-json.js";

test("keys are sorted at every depth, and array order is kept", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }, 2] } }), '{"a":{"c":[{"y":2,"z":1},2],"d":1},"b":1}');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
});

test("an undefined property is the same as an absent one", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assert.equal(canonicalJson({ a: { b: undefined } }), canonicalJson({ a: {} }));
  assert.ok(sameJson({ a: undefined, b: 2 }, { b: 2 }));
});

test("null is not undefined, and a different value is a difference", () => {
  assert.ok(!sameJson({ a: null }, {}));
  assert.ok(!sameJson({ a: 1 }, { a: 2 }));
  assert.ok(!sameJson([1, 2], [2, 1]));
});

test("a bare undefined (a record that is not there) is 'null', never a non-string", () => {
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson(null), "null");
});

test("two records that differ only in field order are the same", () => {
  assert.ok(sameJson({ host: "a", port: 1, tls: undefined }, { tls: undefined, port: 1, host: "a" }));
});
