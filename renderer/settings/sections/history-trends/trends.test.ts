// The arithmetic behind the Trends card.
//
// No DOM: what a tile averages, what it compares that against, and where a
// milestone lands are all arithmetic, and a render jsdom cannot lay out would
// tell us nothing about any of it. What IS visual — the tile grid's wrap, a
// milestone label colliding with its neighbour, the accent on a hovered mark —
// was driven in Chrome and is named in trends-card.tsx.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MIN_PRIOR_DAYS,
  TREND_WINDOW,
  dailyPeaks,
  measureOf,
  seriesChangeMilestones,
  trendMilestones,
  typeTrends,
  withinRange,
  type TrendRecording,
} from "./trends.js";

const DAY = 24 * 60 * 60_000;

/** A weekly service of one type, `peaks` oldest first — one service a week.
 *  `db` gives each recording a level too, for the sound measure. */
function weekly(
  typeId: string,
  peaks: (number | null)[],
  opts: { series?: (string | null)[]; from?: number; db?: (number | null)[] } = {},
): TrendRecording[] {
  const start = opts.from ?? Date.parse("2026-01-04T09:00:00Z");
  return peaks.map((p, i) => ({
    serviceKey: `${typeId}:${i}`,
    serviceTypeId: typeId,
    serviceTypeName: typeId === "weekend" ? "Weekend" : "Evening",
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: opts.series?.[i] ?? null,
    peakOccupancy: p,
    peakDb: opts.db?.[i] ?? null,
  }));
}

/** `weeks` Sundays, each running the services in `perDay` (peaks, in order,
 *  two hours apart) — the shape a church with a 9, an 11 and a 6 records. */
function sundays(typeId: string, weeks: number, perDay: number[]): TrendRecording[] {
  const start = Date.parse("2026-01-04T09:00:00Z");
  const out: TrendRecording[] = [];
  for (let w = 0; w < weeks; w++) {
    const day = start + w * 7 * DAY;
    perDay.forEach((peak, i) => {
      out.push({
        serviceKey: `${typeId}:${w}:${i}`,
        serviceTypeId: typeId,
        serviceTypeName: "Weekend",
        serviceDate: new Date(day).toISOString().slice(0, 10),
        t: day + i * 2 * 60 * 60_000,
        seriesTitle: null,
        peakOccupancy: peak,
        peakDb: 90 + i,
      });
    });
  }
  return out;
}

describe("a day's peak", () => {
  test("is the busiest service that day, at the day's first service's time", () => {
    // The maximum, not the sum and not the mean: attendance is people in the
    // room, so summing double-counts the family who came to one of the three,
    // and a mean answers "how full was a service" rather than "how many came".
    const days = dailyPeaks(sundays("weekend", 3, [1400, 700, 1100]));
    assert.deepEqual(days.map((d) => d.v), [1400, 1400, 1400]);
    assert.deepEqual(days.map((d) => d.count), [3, 3, 3]);
    const first = Date.parse("2026-01-04T09:00:00Z");
    assert.equal(days[0].t, first, "the node sits at the day's FIRST service, inside its own cluster");
  });

  test("a recording with no attendance record does not pull a day to zero", () => {
    const one = dailyPeaks(sundays("weekend", 1, [900]).concat(
      sundays("weekend", 1, [0]).map((r) => ({ ...r, serviceKey: "x", peakOccupancy: null })),
    ));
    assert.deepEqual(one.map((d) => [d.v, d.count]), [[900, 1]]);
  });
});

/**
 * The change a tile prints, as an ABSOLUTE difference, or null when there is no
 * comparison to make.
 *
 * One expression, here, so every case below reads the figure the same way the
 * card does. The tile rounds both means to the precision it prints and
 * subtracts those; these fixtures are all whole numbers, so the raw difference
 * is the same thing.
 */
function delta(tile: { averageRaw: number | null; priorAverageRaw: number | null }): number | null {
  if (tile.averageRaw == null || tile.priorAverageRaw == null) return null;
  return tile.averageRaw - tile.priorAverageRaw;
}

describe("a service type's trend tile", () => {
  test("the change is this window's average against the eight DAYS before it", () => {
    // Sixteen Sundays: the first eight average 100, the last eight 120. A 20%
    // rise, and the tile must not average all sixteen.
    const peaks = [...Array(8).fill(100), ...Array(8).fill(120)];
    const [tile] = typeTrends(weekly("weekend", peaks));
    assert.equal(tile.recent.length, TREND_WINDOW);
    assert.equal(tile.average, 120, "the average is over the RECENT window, not the whole history");
    assert.equal(tile.priorAverage, 100);
    assert.equal(tile.priorCount, 8);
    assert.ok(delta(tile) != null);
    assert.equal(delta(tile), 20, "120 against 100 is +20 people");
  });

  test("a day's several services count once, at the busiest", () => {
    // Sixteen Sundays of three services each. The tile averages what the chart
    // LINE plots — the day's busiest — so the two halves of the card quote the
    // same kind of number. Averaging every recording gave (1400+700+1100)/3.
    const older = sundays("weekend", 8, [1000, 500, 800]);
    const newer = sundays("weekend", 8, [1200, 600, 900]).map((r, i) => ({
      ...r,
      serviceKey: `later:${i}`,
      serviceDate: new Date(Date.parse(`${r.serviceDate}T00:00:00Z`) + 56 * DAY).toISOString().slice(0, 10),
      t: r.t + 56 * DAY,
    }));
    const [tile] = typeTrends([...older, ...newer]);
    assert.equal(tile.recent.length, 8, "eight DAYS, not twenty-four recordings");
    assert.equal(tile.average, 1200, "the day's busiest, not the mean of its three services");
    assert.equal(tile.priorAverage, 1000);
    assert.equal(delta(tile), 200, "1,200 against 1,000");
  });

  test("more than sixteen days still compares eight against the eight before", () => {
    // A leading run of 10s must not drag the prior window down: only the eight
    // immediately before the recent window count.
    const peaks = [...Array(10).fill(10), ...Array(8).fill(200), ...Array(8).fill(300)];
    const [tile] = typeTrends(weekly("weekend", peaks));
    assert.equal(tile.average, 300);
    assert.equal(tile.priorCount, 8);
    assert.equal(delta(tile), 100, "300 against 200 is +100");
  });

  test("the tile compares against the prior days it HAS, once there are four", () => {
    // The 9-to-15 band, which used to show nothing at all: requiring a full
    // eight meant no change figure until sixteen Sundays, four months in, and
    // the tile was right and useless for a season. Below MIN_PRIOR_DAYS the
    // "average" is one or two readings and a percentage off them is noise
    // wearing a direction.
    // One line per case, so two branches adding different ones merge cleanly.
    const at = (n: number) => {
      const [tile] = typeTrends(weekly("weekend", Array(n).fill(100)));
      return [n, delta(tile), tile.priorCount, tile.priorAverage];
    };
    assert.deepEqual(
      [1, 2, 8, 9, 11, 12, 15, 16, 20].map(at),
      [
        [1, null, 0, null],
        [2, null, 0, null],
        // Eight days is the whole recent window with nothing before it.
        [8, null, 0, null],
        // Nine is one prior day — not an average.
        [9, null, 0, null],
        // Eleven is three prior days: the first history that compares, and the
        // shape of the real three-month archive this was built against.
        [11, 0, 3, 100],
        [12, 0, 4, 100],
        [15, 0, 7, 100],
        [16, 0, 8, 100],
        // Never more than eight, however long the history.
        [20, 0, 8, 100],
      ],
    );
  });

  test("a prior average of zero is no comparison, and says so in both fields", () => {
    // `change` already refused to divide by it. `priorCount` did not, so a tile
    // could read "no prior window yet" beside a count of 4 — a label for a
    // comparison that was never made. One condition, read by both.
    const [tile] = typeTrends(weekly("weekend", [...Array(4).fill(0), ...Array(8).fill(150)]));
    assert.equal(tile.priorAverage, 0, "the window is there and its average really is zero");
    assert.equal(delta(tile), null, "a zero prior window is not something to compare against");
    assert.equal(tile.priorCount, 0, "so nothing was compared against, and the label must not claim otherwise");
  });

  test("a thin comparison reports the count it actually used", () => {
    // The label reads "vs prior 4". It must be the REAL number, not the window
    // the tile would like to have had — a four-day comparison dressed up as
    // eight is the thing relaxing the rule could easily have introduced.
    const twelve = typeTrends(weekly("weekend", [...Array(4).fill(100), ...Array(8).fill(150)]))[0];
    assert.equal(twelve.priorCount, 4);
    assert.equal(twelve.priorAverage, 100);
    assert.equal(twelve.average, 150);
    assert.equal(delta(twelve), 50, "150 against 100 is +50");
  });

  test("the floor is where MIN_PRIOR_DAYS says, not a number typed twice", () => {
    // Pins the constant to the behaviour, so moving one moves both.
    const below = typeTrends(weekly("weekend", Array(TREND_WINDOW + MIN_PRIOR_DAYS - 1).fill(100)))[0];
    const atFloor = typeTrends(weekly("weekend", Array(TREND_WINDOW + MIN_PRIOR_DAYS).fill(100)))[0];
    assert.equal(delta(below), null);
    assert.equal(delta(atFloor), 0);
    assert.equal(atFloor.priorCount, MIN_PRIOR_DAYS);
  });

  test("a type with fewer than two recordings shows no change at all", () => {
    // The bug this forbids is a change computed from an EMPTY prior window:
    // dividing by a mean of nothing gives Infinity or NaN, and a tile reading
    // "+Infinity%" on a church's first recorded Sunday is worse than a tile
    // that says it cannot tell yet.
    const [one] = typeTrends(weekly("weekend", [250]));
    assert.equal(one.average, 250, "one recording still has an average — itself");
    assert.equal(delta(one), null, "with nothing before it, there is no change to show");
    assert.equal(one.priorCount, 0);
    assert.deepEqual(typeTrends([]), [], "no recordings at all is no tile, not an empty one");
  });

  test("a recording with no attendance record is not plotted as zero", () => {
    // A service nobody counted is not a service of nobody.
    const [tile] = typeTrends(weekly("weekend", [100, null, 100]));
    assert.deepEqual(tile.recent.map((d) => d.v), [100, 100]);
    assert.equal(tile.average, 100);
  });

  test("one tile per service type, busiest first", () => {
    const tiles = typeTrends([...weekly("evening", [90, 95]), ...weekly("weekend", [800, 820])]);
    assert.deepEqual(tiles.map((t) => t.serviceTypeId), ["weekend", "evening"]);
  });
});

describe("milestones", () => {
  test("one mark per series change, and none for the first series", () => {
    // A, A, B, B, C — two changes. The leading A is not a change: there is
    // nothing it changed from.
    const recs = weekly("weekend", [100, 100, 100, 100, 100], {
      series: ["Rooted", "Rooted", "Everyday", "Everyday", "Advent"],
    });
    const marks = seriesChangeMilestones(recs);
    assert.deepEqual(
      marks.map((m) => m.label),
      ["Everyday", "Advent"],
    );
    assert.deepEqual(marks.map((m) => m.t), [recs[2].t, recs[4].t], "each mark sits on the first recording of the new series");
    assert.deepEqual(new Set(marks.map((m) => m.kind)), new Set(["series"]));
  });

  test("a recording with no series title is an absence, not two changes", () => {
    // Without stepping over it, the untitled plan in the middle produces a mark
    // leaving Rooted and another arriving back at it.
    const recs = weekly("weekend", [100, 100, 100], { series: ["Rooted", null, "Rooted"] });
    assert.deepEqual(seriesChangeMilestones(recs), []);
  });

  test("two service types do not mark each other's series changes", () => {
    const recs = [
      ...weekly("weekend", [100, 100], { series: ["Rooted", "Everyday"] }),
      ...weekly("evening", [50, 50], { series: ["Kickoff", "Kickoff"] }),
    ];
    const marks = seriesChangeMilestones(recs);
    assert.deepEqual(marks.map((m) => [m.serviceTypeId, m.label]), [["weekend", "Everyday"]]);
  });

  test("a stored entry with a bad date is skipped, and the rest are drawn", () => {
    const recs = weekly("weekend", [100, 100, 100]);
    // The domain deliberately runs on past the bad dates, so the only thing
    // that can reject them is the rule. An end at the last recording would have
    // clipped "2026-02-31" (which parses, and lands on the 2nd of March) for
    // the wrong reason, and the guard would have passed on the bug.
    const domain = { startMs: recs[0].t - DAY, endMs: recs[2].t + 120 * DAY };
    const marks = trendMilestones(
      [
        { id: "good", date: recs[1].serviceDate, label: "New building", serviceTypeId: null },
        // The 31st of February parses in JavaScript and lands on 2 or 3 March.
        { id: "bad", date: "2026-02-31", label: "Two services", serviceTypeId: null },
        { id: "junk", date: "whenever", label: "Kickoff", serviceTypeId: null },
      ],
      recs,
      domain,
    );
    assert.deepEqual(
      marks.map((m) => m.label),
      ["New building"],
      "an entry whose date cannot be read must not be drawn at the left edge, where it would mean a date it does not",
    );
  });

  test("a stored milestone keeps the service type it was scoped to", () => {
    // The field was stored, documented, and dropped on the way to the chart, so
    // a mark scoped to the Youth service drew across the Weekend line. It is
    // what the chart scopes and colours the mark by; losing it here loses both.
    const recs = weekly("weekend", [100, 100]);
    const marks = trendMilestones(
      [
        { id: "scoped", date: recs[0].serviceDate, label: "Youth moved", serviceTypeId: "youth" },
        { id: "all", date: recs[1].serviceDate, label: "New building", serviceTypeId: null },
      ],
      recs,
      { startMs: recs[0].t - DAY, endMs: recs[1].t + DAY },
    );
    assert.deepEqual(
      marks.map((m) => [m.label, m.serviceTypeId]),
      [["Youth moved", "youth"], ["New building", null]],
    );
  });

  test("a mark outside the drawn range is clipped, not squeezed onto an edge", () => {
    const recs = weekly("weekend", [100, 100]);
    const marks = trendMilestones(
      [{ id: "old", date: "2020-01-01", label: "Old building", serviceTypeId: null }],
      recs,
      { startMs: recs[0].t, endMs: recs[1].t },
    );
    assert.deepEqual(marks, []);
  });
});

describe("the range control", () => {
  test("the range is measured back from the newest recording, not from the clock", () => {
    // A history that stopped in June must still draw when it is opened in
    // September, rather than showing an empty chart.
    const long = weekly("weekend", Array(60).fill(100), { from: Date.parse("2024-01-07T09:00:00Z") });
    const eight = withinRange(long, 8);
    const fiftyTwo = withinRange(long, 52);
    assert.ok(eight.length > 0, "a range measured from the clock would return nothing here");
    assert.ok(eight.length <= 9, `8 weeks of weekly services is ~9 recordings, got ${eight.length}`);
    assert.ok(fiftyTwo.length > eight.length, "a longer range must include more");
    assert.equal(eight[eight.length - 1].t, long[long.length - 1].t, "the newest recording is always in range");
  });
});

describe("the sound measure", () => {
  const db = (v: number | null) => v;

  test("a day's peak is the LOUDEST service that day, not the busiest", () => {
    // Three Sunday services: the 9 is the fullest and the 6 is the loudest.
    // Switching measure must switch which one the day is represented by.
    const recs = sundays("weekend", 2, [1400, 700, 1100]).map((r, i) => ({
      ...r,
      peakDb: [96, 99, 104][i % 3],
    }));
    assert.deepEqual(dailyPeaks(recs, measureOf("sound")).map((d) => d.v), [104, 104]);
    assert.deepEqual(dailyPeaks(recs, measureOf("attendance")).map((d) => d.v), [1400, 1400]);
  });

  test("the tiles average decibels, with the same window and the same change rule", () => {
    const older = Array(4).fill(94);
    const newer = Array(8).fill(100);
    const [tile] = typeTrends(
      weekly("weekend", Array(12).fill(500), { db: [...older, ...newer].map(db) }),
      { pick: measureOf("sound") },
    );
    assert.equal(tile.average, 100);
    assert.equal(tile.priorAverage, 94);
    assert.equal(tile.priorCount, 4, "the relaxed floor applies to sound too");
    assert.ok((delta(tile) as number) > 0);
  });

  test("a type with no SPL records keeps its tile, with nothing in it", () => {
    // Dropping it would read as the service type having disappeared the moment
    // you switched measure. The tile stays and the card says "no sound
    // recorded" against a null average.
    const tiles = typeTrends(
      [
        ...weekly("weekend", Array(3).fill(900), { db: Array(3).fill(101) }),
        ...weekly("evening", Array(3).fill(200)),
      ],
      { pick: measureOf("sound") },
    );
    assert.deepEqual(
      tiles.map((t) => [t.serviceTypeId, t.average]),
      [["weekend", 101], ["evening", null]],
      "a type with no level must keep its tile and sort last",
    );
    assert.deepEqual(tiles.find((t) => t.serviceTypeId === "evening")!.recent, []);
  });

  test("no recordings at all is still no tile, under either measure", () => {
    assert.deepEqual(typeTrends([], { pick: measureOf("sound") }), []);
    assert.deepEqual(typeTrends([], { pick: measureOf("attendance") }), []);
  });

  test("the range filters on the measure being plotted", () => {
    // A recording with attendance and no level is in range for one measure and
    // not the other. Filtering on attendance while plotting sound put an
    // undefined into the series.
    const recs = weekly("weekend", [100, 100, 100], { db: [null, 97, null] });
    assert.equal(withinRange(recs, 52, measureOf("attendance")).length, 3);
    assert.deepEqual(
      withinRange(recs, 52, measureOf("sound")).map((r) => r.peakDb),
      [97],
    );
  });
});
