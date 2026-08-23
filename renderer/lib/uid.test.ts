// The app's unique id.
//
// Two properties matter and both have bitten before. It must not depend on
// crypto.randomUUID, which exists only in a SECURE context — production is
// served over plain HTTP, so a call that works on localhost is undefined on the
// wall. And it must always carry its prefix: a stray id in a log should say what
// it belongs to, and `uid` used to return a bare UUID on localhost and a
// prefixed one in production, so the same code produced two shapes.
//
// The signage feature shipped a second copy of this (`newSignageId`) whose
// header cited the same gotcha. One function now.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { uid } from "./uid";

/**
 * Run `fn` with crypto.randomUUID present or absent, then put it back.
 *
 * defineProperty, not assignment: Node exposes `globalThis.crypto` through a
 * getter only, so `globalThis.crypto = …` throws.
 */
function withRandomUUID(present: boolean, fn: () => void) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: present ? { randomUUID: () => `id-${Math.random()}` } : undefined,
  });
  try {
    fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "crypto", had);
  }
}

describe("uid", () => {
  test("carries its prefix in a SECURE context", () => {
    withRandomUUID(true, () => {
      assert.match(uid("pl"), /^pl-/);
    });
  });

  test("and in an insecure one, which is what production is", () => {
    withRandomUUID(false, () => {
      assert.match(uid("pl"), /^pl-/);
    });
  });

  test("never throws where crypto.randomUUID does not exist", () => {
    // The whole reason this function exists. A bare crypto.randomUUID() call
    // works on localhost and is undefined on a wall served over plain HTTP.
    withRandomUUID(false, () => {
      assert.ok(uid("x").length > 2);
    });
  });

  test("two ids in a row differ", () => {
    withRandomUUID(false, () => {
      const seen = new Set(Array.from({ length: 200 }, () => uid("g")));
      assert.equal(seen.size, 200, "ids collided");
    });
  });

  test("has a default prefix rather than an unlabelled id", () => {
    withRandomUUID(false, () => {
      assert.match(uid(), /^id-/);
    });
  });
});
