import assert from "node:assert/strict";
import { test } from "node:test";

import { retryAfterMs } from "./retry-after.js";

const NOW = Date.parse("2026-11-28T12:00:00Z");

test("delta-seconds, with a fraction tolerated and 0 honoured", () => {
  assert.equal(retryAfterMs("120", NOW), 120_000);
  assert.equal(retryAfterMs(" 5 ", NOW), 5000);
  assert.equal(retryAfterMs("1.5", NOW), 1500);
  assert.equal(retryAfterMs("0", NOW), 0);
});

test("an HTTP date is measured from now, and a past date is 0", () => {
  assert.equal(retryAfterMs("Sat, 28 Nov 2026 12:00:30 GMT", NOW), 30_000);
  assert.equal(retryAfterMs("Sat, 28 Nov 2026 11:00:00 GMT", NOW), 0);
});

test("a header that is not a Retry-After is null, not a wait", () => {
  for (const header of [null, undefined, "", "   ", "soon", "0x10", "1e3", "-5"]) {
    assert.equal(retryAfterMs(header, NOW), null, JSON.stringify(header));
  }
});

test("the ceiling applies to both forms, and is the caller's to choose", () => {
  assert.equal(retryAfterMs("86400", NOW, 15_000), 15_000);
  assert.equal(retryAfterMs("Sun, 29 Nov 2026 12:00:00 GMT", NOW, 15_000), 15_000);
  assert.equal(retryAfterMs("86400", NOW), 86_400_000);
  assert.equal(retryAfterMs("5", NOW, 15_000), 5000);
});
