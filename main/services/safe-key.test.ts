import { strict as assert } from "node:assert";
import { test } from "node:test";

import { assertSafeKey, isSafeKey, withoutUnsafeKeys } from "./safe-key.js";

test("the three keys that reach the prototype chain are refused", () => {
  for (const k of ["__proto__", "constructor", "prototype"]) {
    assert.equal(isSafeKey(k), false, `${k} should be refused`);
  }
});

test("ordinary identifiers are allowed", () => {
  for (const k of ["display-1", "view-2", "1234567", "default", "proto", "__protox__", ""]) {
    assert.equal(isSafeKey(k), true, `${k} should be allowed`);
  }
});

test("the error names the field, so a log says which input was refused", () => {
  assert.throws(() => assertSafeKey("__proto__", "displayId"), /displayId.*__proto__/);
  assert.doesNotThrow(() => assertSafeKey("display-1", "displayId"));
});

test("the write shape this guards is genuinely unsafe without it", () => {
  // Not a demonstration of the guard — a demonstration of why it is needed.
  // This is the exact shape used by the keyed stores.
  const map: Record<string, Record<string, unknown>> = JSON.parse('{"display-1":{}}');
  const k = "__proto__";
  if (!map[k]) map[k] = {};
  map[k]["polluted"] = true;
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    true,
    "expected the unguarded shape to pollute — if this fails the runtime changed",
  );
  // Leave the process as we found it, or every later test sees the property.
  delete (Object.prototype as Record<string, unknown>).polluted;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("the same shape is safe once the key is checked", () => {
  const k = "__proto__";
  assert.throws(() => assertSafeKey(k, "displayId"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "nothing was written");
});

// ── Stripping, for data that arrives from disk ─────────────────────────────

test("a forbidden own key is dropped", () => {
  const dirty = JSON.parse('{"a":1,"__proto__":{"x":1},"b":2}');
  const clean = withoutUnsafeKeys(dirty);
  assert.deepEqual(Object.keys(clean), ["a", "b"]);
});

test("an object with nothing forbidden is returned unchanged, not copied", () => {
  const obj = { a: 1, b: 2 };
  assert.equal(withoutUnsafeKeys(obj), obj);
});

test("stripping does not mutate the input", () => {
  const dirty = JSON.parse('{"a":1,"constructor":2}');
  const clean = withoutUnsafeKeys(dirty);
  assert.ok(Object.prototype.hasOwnProperty.call(dirty, "constructor"), "input untouched");
  assert.equal(Object.prototype.hasOwnProperty.call(clean, "constructor"), false);
});
