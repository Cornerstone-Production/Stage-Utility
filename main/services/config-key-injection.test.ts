// A config key from an HTTP body must never become a property WRITE whose name
// the caller chose.
//
// `setConfig` folds the request body with `out[key] = value`, where `key` is
// whatever arrived. `JSON.parse` keeps "__proto__" as an own enumerable key and
// `Object.entries` yields it, so a plain assignment sets the object's PROTOTYPE
// instead of a field on it. CodeQL calls this js/remote-property-injection and
// rates it high.
//
// WHY THIS FILE WAS REWRITTEN. Its first version defined its own `foldConfig` —
// a copy of the loop — and asserted against that. Deleting the real guard from
// integration-manager.ts left it green, which was demonstrated before this
// rewrite. A test that reimplements the code it guards proves the copy correct
// and says nothing about the shipped path.
//
// `setConfig` itself cannot be driven from a unit test: it needs `init()`,
// which starts the reconnect timers and never lets the process exit, and it
// ends by dialling the integration. So the fold was EXTRACTED instead. There is
// now one copy, `foldConfigEntries`, and this imports the same one `setConfig`
// calls.
//
// Addresses are from the documentation range (RFC 5737). This is a public
// repository and a fixture is not the place for anyone's LAN.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { foldConfigEntries } from "./integration-manager.js";

/** A body as it arrives over HTTP. Parsed, never written as a literal: an
 *  object literal treats `__proto__` as a prototype setter at PARSE time, so a
 *  literal cannot reproduce the case — the key would never be own. */
const hostile = () =>
  JSON.parse(
    String.raw`{"host":"203.0.113.7","password":"s3cret","__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2}}`,
  ) as Record<string, unknown>;

describe("config keys from a request body", () => {
  test("the fixture really carries the reserved names as own keys", () => {
    // Without this the file could pass by testing nothing: if the parse ever
    // stopped producing an own "__proto__", every assertion below would be
    // trivially true.
    const body = hostile();
    for (const k of ["__proto__", "constructor", "prototype"]) {
      assert.ok(Object.keys(body).includes(k), `fixture lost its own "${k}" key`);
    }
  });

  test("every config key the 16 integrations actually use is accepted", () => {
    // The pattern was chosen against the data. If a real key ever fails it, the
    // operator loses that setting silently on their next save — which is exactly
    // what an allowlist built from `configSchema` would have done to sensource's
    // zone selection, since neither key below is declared in any schema.
    const REAL = [
      "host", "port", "password", "appId", "secret", "clientId", "clientSecret",
      "apiToken", "pollSeconds", "url", "channel", "streamKey", "enabled",
      "zoneIds", "locationId",
    ];
    const { config } = foldConfigEntries(Object.fromEntries(REAL.map((k) => [k, 1])), [], "test");
    assert.deepEqual(Object.keys(config).sort(), [...REAL].sort(), "a real config key was rejected");
  });

  test("the real field is kept, the secret is split out, the reserved names are dropped", () => {
    const { config, secrets } = foldConfigEntries(hostile(), ["password"], "test");
    assert.equal(config.host, "203.0.113.7", "the legitimate field was lost");
    assert.equal(secrets.password, "s3cret", "the secret was not split out");
    assert.deepEqual(
      Object.keys(config).filter((k) => k === "__proto__" || k === "constructor" || k === "prototype"),
      [],
      "a reserved key survived into the config that gets persisted",
    );
  });

  test("nothing anywhere was polluted", () => {
    foldConfigEntries(hostile(), [], "test");
    // The payload's own word. Had the prototype been set, this would read
    // `true` on every object in the process, including ones made before it.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  test("and the target has no prototype to poison in the first place", () => {
    // Defence in depth that does not depend on the skip-list staying complete:
    // on a null-prototype object an assignment named "__proto__" would create an
    // ordinary own key rather than reaching any prototype.
    const { config, secrets } = foldConfigEntries({ a: 1 }, [], "test");
    assert.equal(Object.getPrototypeOf(config), null, "the config target has a prototype");
    assert.equal(Object.getPrototypeOf(secrets), null, "the secrets target has a prototype");
  });
});
