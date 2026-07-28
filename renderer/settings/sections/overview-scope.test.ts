// The Overview's two scopes. These diverged deliberately: the trend chart shows the
// service that is recording right now, but the cross-service average does not fold
// in a peak that is still climbing — that would make the headline number read as
// broken at 9am and "recover" by noon.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { inTrendScope, inAverageScope } from "./overview-scope.js";

const rec = (over: { endedAt?: string | null; serviceTypeId?: string | null; serviceDate?: string } = {}) => ({
  endedAt: over.endedAt === undefined ? "2026-07-26T11:00:00Z" : over.endedAt,
  serviceTypeId: over.serviceTypeId === undefined ? "st1" : over.serviceTypeId,
  serviceDate: over.serviceDate ?? "2026-07-26",
});

describe("trend scope", () => {
  test("includes a finished service", () => {
    assert.equal(inTrendScope(rec(), null, null), true);
  });

  test("includes the service recording right now", () => {
    // The whole point of the change.
    assert.equal(inTrendScope(rec({ endedAt: null }), null, null), true);
  });

  test("still honours the service-type filter", () => {
    assert.equal(inTrendScope(rec({ serviceTypeId: "st2" }), "st1", null), false);
    assert.equal(inTrendScope(rec({ serviceTypeId: "st1" }), "st1", null), true);
  });

  test("still honours the as-of cutoff", () => {
    assert.equal(inTrendScope(rec({ serviceDate: "2026-08-02" }), null, "2026-07-26"), false);
    assert.equal(inTrendScope(rec({ serviceDate: "2026-07-19" }), null, "2026-07-26"), true);
  });

  test("a running service outside the type filter is still excluded", () => {
    assert.equal(inTrendScope(rec({ endedAt: null, serviceTypeId: "st2" }), "st1", null), false);
  });
});

describe("average scope", () => {
  test("includes a finished service", () => {
    assert.equal(inAverageScope(rec(), null, null), true);
  });

  test("EXCLUDES the service recording right now", () => {
    assert.equal(inAverageScope(rec({ endedAt: null }), null, null), false);
  });

  test("applies the same type and date filters as the trend", () => {
    assert.equal(inAverageScope(rec({ serviceTypeId: "st2" }), "st1", null), false);
    assert.equal(inAverageScope(rec({ serviceDate: "2026-08-02" }), null, "2026-07-26"), false);
  });
});
