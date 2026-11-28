// The pure halves of plan-following.ts: whether a plan is still upcoming on
// the app's calendar, and how many unavailable answers it takes before
// /stageplots believes Planning Center is down. The dates themselves are
// plan-date-label.test.ts.
//
// The hook itself, over the real view and a stubbed server, is in
// stageplots-plan.test.tsx.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { REACH_UNKNOWN, UNREACHABLE_AFTER_READS, isUpcoming, nextReach, type Reach } from "./plan-following.js";

describe("an upcoming plan", () => {
  test("is decided on the app's calendar: one plan and one instant, upcoming in Chicago and past in UTC", () => {
    // The plan is 17:30 on Saturday 14 Nov in Chicago; now is 20:00 the same
    // Saturday there, but already Sunday 15 Nov in UTC.
    const plan = "2026-11-14T23:30:00Z";
    const now = Date.parse("2026-11-15T02:00:00Z");
    assert.equal(isUpcoming(plan, now, "America/Chicago"), true);
    assert.equal(isUpcoming(plan, now, "UTC"), false);
  });

  test("counts a plan from earlier today, not one from yesterday, nor a date that does not parse", () => {
    const now = Date.parse("2026-11-15T20:00:00Z");
    assert.equal(isUpcoming("2026-11-15T15:00:00Z", now, "America/Chicago"), true);
    assert.equal(isUpcoming("2026-11-14T15:00:00Z", now, "America/Chicago"), false);
    assert.equal(isUpcoming("soon", now, "America/Chicago"), false);
  });
});

describe("believing Planning Center is unreachable", () => {
  const read = (prev: Reach, at: number, unavailable: boolean) => nextReach(prev, { at, unavailable });

  test("one unavailable answer after a good one does not move the page", () => {
    let r = read(REACH_UNKNOWN, 1, false);
    r = read(r, 2, true);
    assert.equal(r.unreachable, false, "a single failed poll swapped every plot to its default");
    r = read(r, 3, false);
    assert.equal(r.unreachable, false);
  });

  test(`${UNREACHABLE_AFTER_READS} in a row do, and the first good answer brings it back`, () => {
    let r = read(REACH_UNKNOWN, 1, false);
    for (let i = 0; i < UNREACHABLE_AFTER_READS; i++) r = read(r, 2 + i, true);
    assert.equal(r.unreachable, true);
    r = read(r, 10, true);
    assert.equal(r.unreachable, true);
    r = read(r, 11, false);
    assert.equal(r.unreachable, false);
  });

  test("the first answer the page hears is believed at once: nothing is on screen to flicker", () => {
    assert.equal(read(REACH_UNKNOWN, 1, true).unreachable, true);
  });

  test("but not once the page has drawn without it: then it takes two like any other", () => {
    const first = nextReach(REACH_UNKNOWN, { at: 1, unavailable: true }, { drawn: true });
    assert.equal(first.unreachable, false, "a page drawn while the list hung swapped on its first answer");
    assert.equal(nextReach(first, { at: 2, unavailable: true }, { drawn: true }).unreachable, true);
  });

  test("the same read seen again is not a second answer", () => {
    let r = read(REACH_UNKNOWN, 1, false);
    r = read(r, 2, true);
    const again = read(r, 2, true);
    assert.equal(again, r);
    assert.equal(again.unreachable, false);
  });
});
