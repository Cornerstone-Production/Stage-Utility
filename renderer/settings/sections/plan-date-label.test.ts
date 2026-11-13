// A plan's date as stage plots names it, on the app's calendar, and the time
// added only where two plans fall on one day.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { planDateLabel, planNamer, zonedDayLabel } from "./plan-date-label.js";

const plan = (planId: string, sortDate: string | null, dates: string | null = null) => ({
  serviceTypeId: "st",
  serviceTypeName: "Service",
  planId,
  title: "Week",
  sortDate,
  dates,
  isCurrent: false,
});

describe("plan date labels", () => {
  test("are the day on the app's calendar, never the host's", () => {
    // 01:30 UTC on Sunday 15 Nov is still Saturday evening in Chicago. One
    // instant, two app zones, two days: no host zone passes both lines.
    const at = Date.parse("2026-11-15T01:30:00Z");
    assert.equal(zonedDayLabel(at, "America/Chicago"), "Sat 14 Nov");
    assert.equal(zonedDayLabel(at, "UTC"), "Sun 15 Nov");
    assert.equal(zonedDayLabel(at, "Europe/Berlin", { year: true }), "Sun 15 Nov 2026");
  });

  test("read an ISO sort date, else Planning Center's words, else nothing", () => {
    assert.equal(planDateLabel("2026-11-15T15:00:00Z", "America/Chicago"), "Sun 15 Nov");
    assert.equal(planDateLabel("2026-11-15T15:00:00Z", "America/Chicago", { withTime: true }), "Sun 15 Nov 9:00");
    assert.equal(planDateLabel(null, "UTC", { dates: "November 15, 2026" }), "November 15, 2026");
    assert.equal(planDateLabel("soon", "UTC"), null);
  });

  test("a time only where two plans share a day, from the list or a stored override", () => {
    const name = planNamer(
      [plan("a", "2026-11-22T15:00:00Z"), plan("b", "2026-11-22T17:00:00Z"), plan("c", "2026-11-29T15:00:00Z"), plan("d", null, "Some day")],
      "America/Chicago",
      [{ planId: "e", planDate: "2026-12-06T15:00:00.000Z" }, { planId: "f", planDate: "2026-12-06T23:00:00.000Z" }],
    );
    assert.equal(name({ planId: "a" }), "Sun 22 Nov 9:00");
    assert.equal(name({ planId: "b" }), "Sun 22 Nov 11:00");
    assert.equal(name({ planId: "c" }), "Sun 29 Nov");
    assert.equal(name({ planId: "d" }), "Some day");
    assert.equal(name({ planId: "e", planDate: "2026-12-06T15:00:00.000Z" }), "Sun 6 Dec 9:00");
    assert.equal(name({ planId: "x", planDate: null }), "A plan with no date");
  });
});
