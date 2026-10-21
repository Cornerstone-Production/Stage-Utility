// auth.test.ts — who may publish.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PUBLISH_MIN_TOKEN_LENGTH } from "../../../main/types/servicecue-publish.js";
import { authorize, bearerToken, tokensMatch } from "./auth.js";

const SECRET = "k".repeat(PUBLISH_MIN_TOKEN_LENGTH) + "-the-real-one";

describe("bearerToken", () => {
  test("reads the token after Bearer, whatever the case of the scheme", () => {
    assert.equal(bearerToken("Bearer abc123"), "abc123");
    assert.equal(bearerToken("bearer abc123"), "abc123");
    assert.equal(bearerToken("BEARER abc123"), "abc123");
    assert.equal(bearerToken("Bearer   abc123  "), "abc123");
    assert.equal(bearerToken("Bearer a.b-c_d=="), "a.b-c_d==");
  });

  test("anything else carries no token", () => {
    for (const header of [null, "", "Bearer", "Bearer ", "Basic abc123", "abc123", "Bearer a b", "Token abc", "Bearerabc"]) {
      assert.equal(bearerToken(header), null, String(header));
    }
  });
});

describe("tokensMatch", () => {
  test("equal tokens match", async () => {
    assert.equal(await tokensMatch(SECRET, SECRET), true);
  });

  test("a token that differs in its first byte, its last byte, its length or its case does not", async () => {
    for (const wrong of ["X" + SECRET.slice(1), SECRET.slice(0, -1) + "X", SECRET + "x", SECRET.slice(0, -1), SECRET.toUpperCase(), "", " " + SECRET]) {
      assert.equal(await tokensMatch(wrong, SECRET), false, JSON.stringify(wrong));
    }
  });

  test("a token that is a prefix of the secret, or has it as a prefix, does not match", async () => {
    assert.equal(await tokensMatch(SECRET.slice(0, 10), SECRET), false);
    assert.equal(await tokensMatch(SECRET + SECRET, SECRET), false);
  });
});

describe("authorize", () => {
  test("the right token is let in", async () => {
    assert.deepEqual(await authorize(`Bearer ${SECRET}`, SECRET), { ok: true });
  });

  test("no token, or the wrong one, is a 401", async () => {
    for (const header of [null, "", "Bearer", "Basic abc", "Bearer wrong", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`]) {
      const result = await authorize(header, SECRET);
      assert.equal(result.ok, false, String(header));
      if (!result.ok) assert.equal(result.status, 401, String(header));
    }
  });

  test("a Worker with no secret, or a short one, refuses everyone with a 503 that says why, and not even the matching token gets in", async () => {
    for (const secret of [undefined, "", "short", "x".repeat(PUBLISH_MIN_TOKEN_LENGTH - 1)]) {
      for (const header of [null, `Bearer ${secret ?? ""}`, "Bearer anything"]) {
        const result = await authorize(header, secret);
        assert.equal(result.ok, false, `${JSON.stringify(secret)} ${header}`);
        if (!result.ok) {
          assert.equal(result.status, 503, `${JSON.stringify(secret)} ${header}`);
          assert.match(result.error, /PUBLISH_TOKEN/);
        }
      }
    }
  });

  test("a secret that is not a string is not one, whatever it stringifies to", async () => {
    // A binding can be a JSON value (`vars` in wrangler.jsonc takes objects and arrays): an array of
    // enough characters has a length, and an object stringifies to a token anyone could send.
    const longObject = { toString: () => SECRET, length: 99 };
    for (const secret of [{}, longObject, ["k".repeat(PUBLISH_MIN_TOKEN_LENGTH + 5)], 1e50, true, null]) {
      for (const header of [`Bearer ${SECRET}`, "Bearer [object Object]", `Bearer ${String(secret)}`]) {
        const result = await authorize(header, secret);
        assert.equal(result.ok, false, `${JSON.stringify(secret)} ${header}`);
        if (!result.ok) assert.equal(result.status, 503);
      }
    }
  });

  test("a secret of exactly the minimum length is accepted", async () => {
    const secret = "s".repeat(PUBLISH_MIN_TOKEN_LENGTH);
    assert.deepEqual(await authorize(`Bearer ${secret}`, secret), { ok: true });
  });
});
