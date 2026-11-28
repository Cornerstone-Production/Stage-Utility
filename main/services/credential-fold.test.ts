// What one value in a credential field asks for. The folds that read each field
// through this are pinned end to end in integration-secret-fold.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { foldSecret } from "./credential-fold.js";
import { FORM_MASK, MASK } from "./mask.js";

test("a mask of any length keeps what is stored", () => {
  for (const v of [MASK, FORM_MASK, "•"]) assert.deepEqual(foldSecret(v), { kind: "keep" }, v);
});

test("blank or whitespace clears", () => {
  for (const v of ["", " ", "\t\n "]) assert.deepEqual(foldSecret(v), { kind: "clear" }, JSON.stringify(v));
});

test("any other string is set as it came, spaces included", () => {
  assert.deepEqual(foldSecret("hunter2"), { kind: "set", value: "hunter2" });
  assert.deepEqual(foldSecret(" pass "), { kind: "set", value: " pass " });
  // A mask with something else in it is a string somebody typed.
  assert.deepEqual(foldSecret(`${MASK}x`), { kind: "set", value: `${MASK}x` });
});

test("a non-string is ignored, and names its type, never its value", () => {
  assert.deepEqual(foldSecret(null), { kind: "ignore", type: "null" });
  assert.deepEqual(foldSecret(undefined), { kind: "ignore", type: "undefined" });
  assert.deepEqual(foldSecret(42), { kind: "ignore", type: "number" });
  assert.deepEqual(foldSecret(true), { kind: "ignore", type: "boolean" });
  assert.deepEqual(foldSecret({ a: 1 }), { kind: "ignore", type: "object" });
  assert.deepEqual(foldSecret(["x"]), { kind: "ignore", type: "object" });
});
