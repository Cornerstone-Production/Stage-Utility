// The Overview's derived figures, now shared by History and Home.
//
// The extraction that created this module moved ~170 lines out of a component. A
// refactor like that changes no behaviour right up until it does, and the way it
// would show is a number quietly differing between the two screens - which is the
// exact failure the shared module exists to prevent. So these pin the figures to
// known inputs rather than asserting the code merely runs.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { computeOverview, summarize, computeTrend } from "./overview-data.js";

function svc(over: Partial<ServiceTimeline> = {}): ServiceTimeline {
  return {
    serviceKey: "k1",
    serviceDate: "2026-07-26",
    serviceTypeId: "st1",
    startedAt: "2026-07-26T10:00:00Z",
    endedAt: "2026-07-26T11:00:00Z",
    serviceTimeStartsAt: "2026-07-26T10:00:00Z",
    items: [],
    ...over,
  } as ServiceTimeline;
}

function item(over: Record<string, unknown> = {}) {
  return {
    title: "Song",
    startedAt: "2026-07-26T10:00:00Z",
    endedAt: "2026-07-26T10:05:00Z",
    plannedLengthSec: 300,
    actualDurationSec: 300,
    preService: false,
    ...over,
  } as unknown as ServiceTimelineItem;
}

function att(over: Partial<ServiceAttendance> = {}): ServiceAttendance {
  return {
    serviceKey: "k1",
    serviceDate: "2026-07-26",
    serviceTypeId: "st1",
    startedAt: "2026-07-26T10:00:00Z",
    endedAt: "2026-07-26T11:00:00Z",
    peakOccupancy: 100,
    ...over,
  } as ServiceAttendance;
}

describe("computeOverview", () => {
  test("with nothing recorded, reports no figures rather than zeroes", () => {
    // "—" and 0 mean different things: 0 attendance is a claim, "—" is honesty.
    const o = computeOverview([], [], null, null, null);
    assert.equal(o.avgAttendance, "—");
    assert.equal(o.peakAttendance, "—");
    assert.equal(o.attTrend, null);
    assert.equal(o.services, "0");
  });

  test("a weekend's attendance is the TOTAL across that day's services", () => {
    // Two services on one date read as ONE point whose value is their sum - not
    // two points, and not an average.
    const o = computeOverview(
      [svc({ serviceKey: "a" }), svc({ serviceKey: "b" })],
      [
        att({ serviceKey: "a", peakOccupancy: 100 }),
        att({ serviceKey: "b", startedAt: "2026-07-26T12:00:00Z", peakOccupancy: 150 }),
      ],
      null, null, null,
    );
    assert.equal(o.attPoints.length, 1, "one weekend is one point");
    assert.equal(o.attPoints[0].value, 250);
    assert.equal(o.avgAttendance, "250");
  });

  test("a service still recording is charted but kept OUT of the average", () => {
    // The reason the two scopes diverge. A peak still climbing would drag the
    // headline average down all morning and "recover" by noon.
    const settled = att({ serviceKey: "a", serviceDate: "2026-07-19", peakOccupancy: 200 });
    const live = att({ serviceKey: "b", serviceDate: "2026-07-26", endedAt: null, peakOccupancy: 20 });
    const o = computeOverview([svc({ serviceKey: "a" })], [settled, live], null, null, null);

    assert.equal(o.attPoints.length, 2, "the live weekend still appears on the chart");
    assert.ok(o.attPoints.some((p) => p.live), "and is marked live");
    assert.equal(o.avgAttendance, "200", "but the average ignores it");
  });

  test("scopes to a service type", () => {
    const o = computeOverview(
      [svc({ serviceKey: "a", serviceTypeId: "st1" }), svc({ serviceKey: "b", serviceTypeId: "st2" })],
      [att({ serviceKey: "a", serviceTypeId: "st1", peakOccupancy: 100 }),
       att({ serviceKey: "b", serviceTypeId: "st2", serviceDate: "2026-07-19", peakOccupancy: 900 })],
      null, "st1", "Weekend",
    );
    assert.equal(o.avgAttendance, "100", "the other service type must not leak in");
    assert.equal(o.scopeName, "Weekend");
  });
});

describe("summarize", () => {
  test("excludes buffer and pre-service items from the timings", () => {
    // Doors and Stream Buffer routinely run long; counting them made every
    // service look overrun.
    const rec = svc({
      items: [
        item({ title: "Doors", preService: true, actualDurationSec: 1800, plannedLengthSec: 0 }),
        item({ title: "Song", actualDurationSec: 300, plannedLengthSec: 300 }),
        item({ title: "Stream Buffer", actualDurationSec: 1800, plannedLengthSec: 0 }),
      ],
    });
    assert.equal(summarize(rec).actual, 300, "only the counted item contributes");
  });
});

describe("computeTrend", () => {
  test("refuses to guess a direction without prior data", () => {
    assert.equal(computeTrend([5], true), null);
    assert.equal(computeTrend([], true), null);
  });

  test("maps direction onto good/bad per metric", () => {
    // Attendance up is good; overrun up is bad. Same numbers, opposite tone.
    assert.equal(computeTrend([10, 10, 10, 40], true)?.tone, "good");
    assert.equal(computeTrend([10, 10, 10, 40], false)?.tone, "bad");
  });

  test("a change inside the deadband reads neutral, not a direction", () => {
    assert.equal(computeTrend([100, 100, 100, 101], true)?.tone, "neutral");
  });
});
