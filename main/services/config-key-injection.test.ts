// A config key from an HTTP body must never become a property WRITE the caller
// chose the name of.
//
// integrationManager.setConfig builds an object with `obj[key] = value`, where
// `key` is whatever the request body carried. JSON.parse keeps "__proto__" as an
// own enumerable key and Object.entries yields it, so plain assignment sets the
// object's prototype instead of a field on it. CodeQL calls this
// js/remote-property-injection and rates it high.
//
// The blast radius today is small — the object is spread into storage, and
// spread copies own properties only — which is exactly why this test exists
// rather than a note saying it is fine. The next consumer of that object does
// not know it was ever true.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

/** The fold as setConfig performs it, over keys a caller supplied. */
function foldConfig(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = value;
  }
  return out;
}

describe("config keys from a request body", () => {
  test("a __proto__ key cannot change the built object's prototype", () => {
    // Parsed, not written as a literal: an object literal treats __proto__ as a
    // prototype setter at parse time, so a literal would not reproduce what
    // arrives over HTTP. JSON.parse keeps it as an own key, which is the case.
    const body = JSON.parse(String.raw`{"host":"10.0.0.5","__proto__":{"polluted":true}}`) as Record<
      string,
      unknown
    >;
    assert.ok(Object.keys(body).includes("__proto__"), "the fixture must carry __proto__ as an own key");

    const out = foldConfig(body);

    assert.equal(out.host, "10.0.0.5", "a legitimate field must still be written");
    assert.equal(
      (Object.getPrototypeOf(out) as Record<string, unknown>).polluted,
      undefined,
      "the caller's __proto__ reached the object's prototype",
    );
    assert.equal(
      (out as Record<string, unknown>).polluted,
      undefined,
      "the caller's __proto__ became readable through the object",
    );
  });

  test("constructor and prototype are refused too", () => {
    const body = JSON.parse(String.raw`{"port":"8080","constructor":"x","prototype":"y"}`) as Record<
      string,
      unknown
    >;
    const out = foldConfig(body);
    assert.deepEqual(Object.keys(out), ["port"], "a reserved key was written");
  });

  test("the fold is not simply dropping everything", () => {
    // The mirror of the guard above: a filter that refused every key would pass
    // both tests, and would silently stop every integration from being
    // configured at all.
    const out = foldConfig({ host: "a", port: 1, https: true, token: "t" });
    assert.deepEqual(Object.keys(out).sort(), ["host", "https", "port", "token"]);
  });
});
