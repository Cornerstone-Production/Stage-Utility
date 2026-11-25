// A plan's date as stage plots names it, on the app's calendar, and the time
// added only where two plans fall on one day.

import assert from "node:assert/strict";
import { after, before as before_, describe, test } from "node:test";

import { planDateLabel, planLabel, planNamer, zonedDayLabel, zonedWeekdayMonthDay } from "./plan-date-label.js";
import { planWhen } from "../../main/servicecue-plan-choice.js";

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

describe("planLabel", () => {
  test("planLabel: a plan's sort date becomes a short weekday date", () => {
    // A fixed zone, so the assertion does not depend on where the box is.
    assert.equal(planLabel("2026-09-13T14:00:00Z", "September 13, 2026", "UTC"), "Sun, Sep 13");
  });

  test("planLabel falls back to Planning Center's own words with no sort date", () => {
    assert.equal(
      planLabel(null, "September 13-14, 2026", "UTC"),
      "September 13-14, 2026",
      "parsing what somebody typed into a weekday would be guessing, and a wrong date here points a save at the wrong week",
    );
  });

  test("planLabel falls back again with neither", () => {
    assert.equal(planLabel(null, null, null), "This plan");
  });

  test("planLabel: an unparseable sort date does not become Invalid Date", () => {
    assert.equal(planLabel("not-a-date", "September 13, 2026", "UTC"), "September 13, 2026");
  });
});

// A 7 pm Sunday service in Chicago is 01:00 Monday in UTC. The tests above name
// the zone on both sides of the assertion, which a formatter that dropped the
// zone would also satisfy on a Chicago laptop. Here the host clock IS UTC, so a
// dropped zone reads Monday.
describe("a 7 pm Sunday Chicago plan, read on a UTC host", () => {
  const SORT_DATE = "2026-11-16T01:00:00Z";
  const AT = Date.parse(SORT_DATE);
  let before: string | undefined;
  before_(() => {
    before = process.env.TZ;
    process.env.TZ = "UTC";
  });
  after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });

  test("every variant names Sunday", () => {
    assert.equal(zonedDayLabel(AT, "America/Chicago"), "Sun 15 Nov");
    assert.equal(planDateLabel(SORT_DATE, "America/Chicago"), "Sun 15 Nov");
    assert.match(zonedWeekdayMonthDay(AT, "America/Chicago"), /^Sun/);
    assert.match(planLabel(SORT_DATE, null, "America/Chicago"), /^Sun/);
    assert.match(planWhen(SORT_DATE, "America/Chicago").date ?? "", /^Sun/);
  });
});
