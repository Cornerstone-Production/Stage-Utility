// Why a cue call was refused, in one phrase.
//
// "no valid token" is what the log said for an hour while a Home Assistant
// install had the right token and a secrets.yaml holding it without the
// "Bearer " scheme. The three cases look identical from the outside and are
// fixed in three different places, so the log has to tell them apart. It must
// never print the token or any part of it.

import assert from "node:assert/strict";
import { test } from "node:test";

const { refusalReason } = await import("./cue-tokens.js");

test("no header at all", () => {
  assert.equal(refusalReason(undefined), "no Authorization header");
  assert.equal(refusalReason("   "), "no Authorization header");
});

test("a header without the Bearer scheme — the secrets.yaml mistake", () => {
  assert.match(refusalReason("su_abcdef0123456789"), /not "Bearer <token>"/);
  assert.match(refusalReason("Basic dXNlcjpwYXNz"), /not "Bearer <token>"/);
});

test("a well-formed token this server does not know", () => {
  assert.match(refusalReason("Bearer su_wrong"), /not recognised/);
});

test("the phrase never carries the token", () => {
  for (const h of ["su_secret_value_here", "Bearer su_secret_value_here", "Basic c2VjcmV0"]) {
    const r = refusalReason(h);
    assert.equal(r.includes("secret"), false, `the log line leaked part of the header: ${r}`);
    assert.equal(r.includes("c2Vj"), false);
  }
});
