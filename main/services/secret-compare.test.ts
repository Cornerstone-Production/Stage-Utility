// The one constant-time comparison for a presented secret, and the gates on it.
//
// WHAT IS NOT TESTED, and why: the timing itself. The difference between a `===`
// that stops at the first byte and one that stops at the last is tens of
// nanoseconds, under a SHA-256 that costs far more and varies per call, so a
// statistical test would be a coin flip on a loaded CI box. And a test reading
// source for the word `timingSafeEqual` is satisfied by a comment.
//
// What holds it instead: each gate is driven for real while crypto.timingSafeEqual
// is spied on, and must hand it two 32-byte digests for a right secret and a
// wrong one alike. A bare `===` never calls it. The log gate, the screen device
// secret and a cue confirmation are pinned the same way in log-routes.test.ts,
// kiosk-devices-store.test.ts and routes/cue-routes.test.ts; the cue token is
// pinned here.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "secret-compare-"));

const { secretsMatch } = await import("./secret-compare.js");
const { cueTokens } = await import("./cue-tokens.js");

const digestLengths = (spy: { mock: { calls: { arguments: unknown[] }[] } }) =>
  spy.mock.calls.map((c) => [(c.arguments[0] as Buffer).length, (c.arguments[1] as Buffer).length]);

describe("secretsMatch", () => {
  test("the same secret matches, and anything else does not", () => {
    assert.equal(secretsMatch("tok-1", "tok-1"), true);
    for (const other of ["tok-2", "tok-", "tok-1 ", "", "tök-1", "tok-1\u0000"]) {
      assert.equal(secretsMatch(other, "tok-1"), false, JSON.stringify(other));
    }
  });

  test("secrets of different lengths are refused rather than thrown at", (t) => {
    const spy = t.mock.method(crypto, "timingSafeEqual");
    assert.equal(secretsMatch("t", "a-much-longer-stored-secret"), false);
    assert.deepEqual(digestLengths(spy), [[32, 32]]);
  });
});

describe("a cue token is compared in constant time", () => {
  test("a right and a wrong token are both judged by timingSafeEqual, over 32-byte digests", async (t) => {
    const { secret } = await cueTokens.mint("the test");
    const spy = t.mock.method(crypto, "timingSafeEqual");
    assert.equal((await cueTokens.verify(secret))?.label, "the test");
    assert.equal(await cueTokens.verify(`${secret}x`), null);
    assert.deepEqual(digestLengths(spy), [[32, 32], [32, 32]]);
  });
});
