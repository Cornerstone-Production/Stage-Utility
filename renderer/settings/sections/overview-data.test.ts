// The Overview's derived figures, now shared by History and Home.
//
// The extraction that created this module moved ~170 lines out of a component. A
// refactor like that changes no behaviour right up until it does, and the way it
// would show is a number quietly differing between the two screens - which is the
// exact failure the shared module exists to prevent. So these pin the figures to
// known inputs rather than asserting the code merely runs.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { computeOverview, summarize, computeTrend, computeSplDelta } from "./overview-data.js";
import { leqOf } from "@main/services/spl-leq";
import type { SplServiceSummary } from "@main/types/stage";

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

// ── The SPL summary ──────────────────────────────────────────────────────────
//
// Decibels are logarithmic, so the arithmetic mean of a series of levels is not
// the average level — it understates it, and badly on anything dynamic. Every
// test below is built on a series where the two answers differ by ~9 dB, so a
// figure computed with `mean()` cannot pass any of them.

/** A weekend, with a level for one metric — SETTLED (endedAt set) by default.
 *  `count` is samples behind the level. Pass `{ endedAt: null }` for a
 *  recording that is still live. */
function spl(serviceDate: string, leq: number, over: Partial<SplServiceSummary> = {}): SplServiceSummary {
  return {
    serviceKey: `k-${serviceDate}`,
    serviceTypeId: "st1",
    serviceDate,
    endedAt: `${serviceDate}T11:00:00Z`,
    metrics: { "LAeq 10": { leq, count: 100 } },
    ...over,
  };
}

/** Five settled weekends: quiet, quiet, quiet, quiet, then one loud one. */
const WEEKENDS = ["2026-07-05", "2026-07-12", "2026-07-19", "2026-07-26", "2026-08-02"];
const LEVELS = [80, 80, 80, 80, 100];
const settledWeekends = WEEKENDS.map((d, i) =>
  att({ serviceKey: `k-${d}`, serviceDate: d, startedAt: `${d}T10:00:00Z`, endedAt: `${d}T11:00:00Z`, peakOccupancy: 100 + i }),
);

describe("the SPL summary", () => {
  test("averages the weekends by ENERGY, not arithmetically", () => {
    const o = computeOverview(
      WEEKENDS.map((d) => svc({ serviceKey: `k-${d}`, serviceDate: d })),
      settledWeekends,
      null, null, null,
      { splList: WEEKENDS.map((d, i) => spl(d, LEVELS[i])) },
    );
    const arithmetic = LEVELS.reduce((a, b) => a + b, 0) / LEVELS.length; // 84
    assert.ok(o.avgSpl != null, "no average level at all");
    assert.ok(
      Math.abs(o.avgSpl - leqOf(LEVELS)!) < 0.01,
      `average level is ${o.avgSpl!.toFixed(2)} dB, not the ${leqOf(LEVELS)!.toFixed(2)} dB these weekends actually averaged`,
    );
    assert.ok(
      o.avgSpl - arithmetic > 5,
      `average level is ${o.avgSpl!.toFixed(2)} dB — within ${(o.avgSpl! - arithmetic).toFixed(2)} dB of the arithmetic mean, so it was averaged as if decibels were linear`,
    );
  });

  test("compares the latest weekend to the prior window in DECIBELS", () => {
    const o = computeOverview(
      WEEKENDS.map((d) => svc({ serviceKey: `k-${d}`, serviceDate: d })),
      settledWeekends,
      null, null, null,
      { splList: WEEKENDS.map((d, i) => spl(d, LEVELS[i])) },
    );
    // The prior four are all 80, so their Leq is 80 and the loud one is +20.
    assert.ok(o.splDelta != null, "no comparison at all");
    assert.equal(o.splDelta.priorCount, 4);
    assert.equal(o.splDelta.dir, "up");
    assert.ok(Math.abs(o.splDelta.db - 20) < 0.01, `the latest weekend reads ${o.splDelta.db.toFixed(2)} dB up, not +20`);
  });

  test("reports nothing at all when no weekend in scope carries a level", () => {
    // Not zero, and not a dash: the caller omits the whole readout. A level of 0
    // dB is a claim about a silent room.
    const o = computeOverview(
      WEEKENDS.map((d) => svc({ serviceKey: `k-${d}`, serviceDate: d })),
      settledWeekends,
      null, null, null,
    );
    assert.equal(o.avgSpl, null);
    assert.equal(o.splDelta, null);
    assert.equal(o.splMetric, null, "a metric was chosen out of nothing");
  });

  test("excludes a weekend while ITS OWN SPL recording is still live", () => {
    // Attendance for this date is SETTLED — the OLD, attendance-coupled code
    // would have let this straight through, since attPoints would carry a
    // non-live point for it. Only SplServiceSummary's OWN endedAt
    // (main/types/history.ts) can catch this: a still-running recording's Leq
    // is a partial that will keep climbing. 999 dB is absurd on purpose: if it
    // leaked into the average, it could not be missed.
    const settledAttendanceOverALiveRecording = att({
      serviceKey: "k-2026-08-09", serviceDate: "2026-08-09",
      startedAt: "2026-08-09T10:00:00Z", endedAt: "2026-08-09T11:00:00Z", peakOccupancy: 150,
    });
    const o = computeOverview(
      WEEKENDS.map((d) => svc({ serviceKey: `k-${d}`, serviceDate: d })),
      [...settledWeekends, settledAttendanceOverALiveRecording],
      null, null, null,
      {
        splList: [
          ...WEEKENDS.map((d, i) => spl(d, LEVELS[i])),
          spl("2026-08-09", 999, { endedAt: null }),
        ],
      },
    );
    assert.ok(
      Math.abs(o.avgSpl! - leqOf(LEVELS)!) < 0.01,
      `average level is ${o.avgSpl!.toFixed(2)} dB — the still-recording weekend's partial level was folded in`,
    );
  });

  test("keeps a weekend's settled level even while its ATTENDANCE is still live", () => {
    // The other half of the same fix: SPL and attendance are separate
    // recorders, so a live occupancy sensor must not suppress a level Smaart
    // already finished recording for the same date.
    const live = att({
      serviceKey: "k-live", serviceDate: "2026-08-09",
      startedAt: "2026-08-09T10:00:00Z", endedAt: null, peakOccupancy: 20,
    });
    const o = computeOverview(
      WEEKENDS.map((d) => svc({ serviceKey: `k-${d}`, serviceDate: d })),
      [...settledWeekends, live],
      null, null, null,
      { splList: [...WEEKENDS.map((d, i) => spl(d, LEVELS[i])), spl("2026-08-09", 60)] },
    );
    assert.equal(o.attPoints.length, 6, "the live weekend still appears on the chart");
    const expected = leqOf([...LEVELS, 60])!;
    assert.ok(
      Math.abs(o.avgSpl! - expected) < 0.01,
      `average level is ${o.avgSpl!.toFixed(2)} dB, not ${expected.toFixed(2)} dB — a SETTLED SPL recording was dropped because attendance alone was still live`,
    );
  });

  test("keeps a weekend's level even when the occupancy sensor recorded nothing for it at all", () => {
    // The exact repro from the review that found this: five weekends of SPL,
    // only four with an attendance record — SenSource offline, absent, or a
    // genuine zero for the fifth. The level must not vanish because of an
    // unrelated sensor, and splDelta's "latest" must still be the loud
    // weekend, not an earlier one relabelled because the real latest had no
    // attendance point to hang off of.
    const o = computeOverview(
      WEEKENDS.map((d) => svc({ serviceKey: `k-${d}`, serviceDate: d })),
      settledWeekends.slice(0, 4), // no attendance record at all for the loud (5th) weekend
      null, null, null,
      { splList: WEEKENDS.map((d, i) => spl(d, LEVELS[i])) },
    );
    assert.equal(o.attPoints.length, 4, "sanity check: the fifth weekend really has no attendance point");
    assert.ok(o.avgSpl != null, "the whole SPL summary vanished because one sensor saw nothing");
    assert.ok(
      Math.abs(o.avgSpl! - leqOf(LEVELS)!) < 0.01,
      `average level is ${o.avgSpl!.toFixed(2)} dB, not ${leqOf(LEVELS)!.toFixed(2)} dB — the loudest weekend was dropped`,
    );
    assert.ok(o.splDelta != null, "no comparison at all");
    assert.equal(
      o.splDelta!.priorCount, 4,
      "the window slid — a weekend with no attendance record was treated as absent from SPL too",
    );
    assert.ok(
      Math.abs(o.splDelta!.db - 20) < 0.01,
      `latest weekend reads ${o.splDelta!.db.toFixed(2)} dB, not +20 — splDelta compared against the wrong "latest" weekend`,
    );
  });
});

describe("computeSplDelta", () => {
  test("refuses to guess without a prior weekend", () => {
    // A behaviour pin, not a guard on any one line: both inputs already return
    // null through the `priorLeq == null` check below (an empty `prior` slice
    // leqOf's to null either way) — there is no length<2 special case left to
    // exercise. Kept because "no prior weekend" is a real input worth pinning,
    // even though nothing in the function is written just for it.
    assert.equal(computeSplDelta([84]), null);
    assert.equal(computeSplDelta([]), null);
  });

  test("takes the prior window's Leq, not its arithmetic mean", () => {
    // Prior: 80, 80, 80, 100 → Leq 94.15, arithmetic mean 85. The latest is 90,
    // so the honest answer is DOWN by ~4 dB; averaged linearly it would read up
    // by 5 — a direction, not just a magnitude, decided by the wrong maths.
    const d = computeSplDelta([80, 80, 80, 100, 90])!;
    assert.equal(d.dir, "down", "the prior window was averaged as if decibels were linear");
    assert.ok(Math.abs(d.db - (90 - leqOf([80, 80, 80, 100])!)) < 0.01, `read ${d.db.toFixed(2)} dB`);
  });

  test("a change smaller than the deadband reads flat, not a direction", () => {
    // 80 four times, then 79.96 — a few hundredths of a dB, the normal case for
    // a room mixed by the same person to the same target. SplDelta is never
    // coloured, so an arrow here is the only signal in the block; "down" would
    // have rendered "▼ −0.0 dB" with nothing to say it doesn't mean anything.
    const d = computeSplDelta([80, 80, 80, 80, 79.96])!;
    assert.equal(d.dir, "flat", `a 0.04 dB nothing-change read as ${d.dir}`);
  });

  test("only looks back over the window", () => {
    // Ten weekends, the last five all at 80: the window is the four before the
    // latest, so the ancient loud ones cannot move it.
    const d = computeSplDelta([120, 120, 120, 120, 120, 80, 80, 80, 80, 80])!;
    assert.equal(d.priorCount, 4);
    assert.ok(Math.abs(d.db) < 0.01, `read ${d.db.toFixed(2)} dB — it looked back past the window`);
  });

  test("refuses to compare a latest reading that isn't a real number", () => {
    // leqOf already screens the PRIOR window for non-finite samples; the
    // latest reading went unchecked, so a NaN there produced `db: NaN` and
    // rendered as a comparison against a real prior window.
    assert.equal(computeSplDelta([80, 80, 80, 80, NaN]), null, "a NaN latest reading produced a comparison");
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
