// Why a cue call was refused, in one phrase.
//
// "no valid token" is what the log said for an hour while a Home Assistant
// install had the right token and a secrets.yaml holding it without the
// "Bearer " scheme. The three cases look identical from the outside and are
// fixed in three different places, so the log has to tell them apart. It must
// never print the token or any part of it.

import assert from "node:assert/strict";
import { test } from "node:test";

const { bearerOf, refusalReason } = await import("./cue-tokens.js");

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

// ── The Authorization header itself ──────────────────────────────────────────
//
// `bearerOf` has always been case-insensitive "per RFC 7235" and nothing has
// ever exercised it: /^Bearer (.*)$/ — case-sensitive, untrimmed, and greedy —
// passes every other test in this repo. `Authorization: bearer su_x` in lower
// case is legal, and it is what a hand-written Home Assistant `rest_command`
// header emits, which is the documented integration path. A caller that spelled
// it that way got 401 "token not recognised", pointing at the token.

test("the scheme is read in any case", () => {
  assert.equal(bearerOf("bearer su_x"), "su_x");
  assert.equal(bearerOf("BEARER su_x"), "su_x");
  assert.equal(bearerOf("BeArEr su_x"), "su_x");
});

test("the whitespace around the value does not travel with it", () => {
  // A token pasted out of a YAML file arrives with whatever was around it.
  assert.equal(bearerOf("Bearer  su_x "), "su_x");
  assert.equal(bearerOf("   Bearer su_x   "), "su_x");
  assert.equal(bearerOf("\tBearer\tsu_x\t"), "su_x");
});

test("and what is still not a bearer header at all", () => {
  assert.equal(bearerOf("su_x"), null);
  assert.equal(bearerOf("Basic c2VjcmV0"), null);
  assert.equal(bearerOf("Bearer"), null);
  assert.equal(bearerOf("Bearer "), null);
  // Not greedy: a second word is not part of the token.
  assert.equal(bearerOf("Bearer su_x extra"), null);
  assert.equal(bearerOf(undefined), null);
});

// ── The comparison itself ────────────────────────────────────────────────────
//
// That a token is compared in constant time is pinned in secret-compare.test.ts,
// by running cueTokens.verify with crypto.timingSafeEqual spied on. The cue
// token, the screen device secret and the log token share one comparison
// (secret-compare.ts), so a second implementation would have to be written on
// purpose.
