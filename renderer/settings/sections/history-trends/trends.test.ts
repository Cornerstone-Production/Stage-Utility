// The arithmetic behind the Trends card.
//
// No DOM: what a day is worth, what a tile leads with, what it compares that
// against, and where a milestone lands are all arithmetic, and a render jsdom
// cannot lay out would tell us nothing about any of it. What IS visual — the
// tile grid's wrap, a milestone label colliding with its neighbour, the accent
// on a hovered mark — was driven in Chrome and is named in trends-card.tsx.
//
// NOT HERE: that the TILE and the chart's LINE are drawn from one derivation.
// A test in this file cannot check it — the line's points are built in
// trends-card.tsx, and nothing in this file renders. One that compared
// `typeTrends`'s own output against `dailyValues` lived here and read as if it
// did: reverting the card's series to one node per recording left it green.
// "adds up into one point, on the tile AND on the line" in trends-card.test.tsx
// is the guard, and it goes red on exactly that.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MIN_PRIOR_DAYS,
  TREND_WINDOW,
  dailyValues,
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

describe("what a day is worth", () => {
  test("attendance ADDS a day's services up, at the day's first service's time", () => {
    // A church running a 9, an 11 and a 6 held three services that Sunday and
    // the question a trend answers is "how many came", so the three add
    // together. The maximum answered "how full was the fullest service", which
    // the service page already answers per service.
    const days = dailyValues(sundays("weekend", 3, [1400, 700, 1100]), "attendance");
    assert.deepEqual(days.map((d) => d.v), [3200, 3200, 3200]);
    assert.notDeepEqual(days.map((d) => d.v), [1400, 1400, 1400], "the day is still the busiest single service");
    assert.deepEqual(days.map((d) => d.count), [3, 3, 3]);
    const first = Date.parse("2026-01-04T09:00:00Z");
    assert.equal(days[0].t, first, "the node sits at the day's FIRST service, inside its own cluster");
  });

  test("SOUND TAKES THE LOUDEST, and must never add", () => {
    // Decibels are logarithmic. Three services at 96, 99 and 104 did not make
    // 299 dB; adding them is not louder, it is meaningless, and it would put a
    // three-figure level on the card every Sunday.
    const recs = sundays("weekend", 2, [1400, 700, 1100]).map((r, i) => ({
      ...r,
      peakDb: [96, 99, 104][i % 3],
    }));
    const levels = dailyValues(recs, "sound").map((d) => d.v);
    assert.deepEqual(levels, [104, 104], "a day's level is its loudest recording");
    assert.deepEqual(
      levels.filter((v) => v > 120),
      [],
      `a day's level was summed: ${levels.join(", ")} dB`,
    );
    // The same recordings under the other measure DO add, so this is the
    // exception and not a derivation that never sums anything.
    assert.deepEqual(dailyValues(recs, "attendance").map((d) => d.v), [3200, 3200]);
  });

  test("a recording with no attendance record is skipped, not counted as zero", () => {
    // A service nobody counted is not a service of nobody — and a day where two
    // of three services had a counter running is the sum of those two.
    const counted = sundays("weekend", 1, [900, 300]);
    const uncounted = sundays("weekend", 1, [0]).map((r) => ({
      ...r,
      serviceKey: "x",
      t: r.t + 4 * 60 * 60_000,
      peakOccupancy: null,
    }));
    assert.deepEqual(
      dailyValues([...counted, ...uncounted], "attendance").map((d) => [d.v, d.count]),
      [[1200, 2]],
    );
  });
});

/**
 * The change a tile prints, as an ABSOLUTE difference, or null when there is no
 * comparison to make.
 *
 * One expression, here, so every case below reads the figure the same way the
 * card does. The tile rounds both figures to the precision it prints and
 * subtracts those; these fixtures are all whole numbers, so the raw difference
 * is the same thing.
 */
function delta(tile: { latestRaw: number | null; priorAverageRaw: number | null }): number | null {
  if (tile.latestRaw == null || tile.priorAverageRaw == null) return null;
  return tile.latestRaw - tile.priorAverageRaw;
}

describe("a service type's trend tile", () => {
  test("leads with the LATEST recorded day, not a mean of the window", () => {
    // The mean answered "what is a normal Sunday here", which does not change
    // week to week — a number that never moved, on the card an operator opens
    // to see the Sunday that just happened.
    const [tile] = typeTrends(weekly("weekend", [...Array(8).fill(100), 120]));
    assert.equal(tile.recent.length, TREND_WINDOW);
    assert.equal(tile.latest, 120, "the tile is averaging its window again");
    assert.equal(tile.priorAverage, 100);
    assert.equal(tile.priorCount, TREND_WINDOW - 1, "the change compares against the rest of the drawn window");
    assert.equal(delta(tile), 20, "120 against 100 is +20 people");
  });

  test("a day's several services are ONE point, at the day's total", () => {
    // The tile leads with what the chart LINE ends at, so the two halves of the
    // card quote the same number. Four Sundays of 1,000 + 500 + 800, then one of
    // 1,200 + 600 + 900.
    const older = sundays("weekend", 4, [1000, 500, 800]);
    const newer = sundays("weekend", 1, [1200, 600, 900]).map((r, i) => ({
      ...r,
      serviceKey: `later:${i}`,
      serviceDate: new Date(Date.parse(`${r.serviceDate}T00:00:00Z`) + 28 * DAY).toISOString().slice(0, 10),
      t: r.t + 28 * DAY,
    }));
    const [tile] = typeTrends([...older, ...newer]);
    assert.deepEqual(tile.recent.map((d) => d.v), [2300, 2300, 2300, 2300, 2700], "five DAYS, not fifteen recordings");
    assert.equal(tile.latest, 2700, "the latest day's total, not its busiest service");
    assert.equal(tile.priorAverage, 2300);
    assert.equal(tile.priorCount, 4);
    assert.equal(delta(tile), 400, "2,700 against 2,300");
  });

  test("the change never looks past the window the sparkline draws", () => {
    // A leading run of 10s must not drag the comparison down: only the days
    // drawn beside the latest count, so what the change was measured against is
    // the picture the reader is already looking at.
    const [tile] = typeTrends(weekly("weekend", [...Array(10).fill(10), ...Array(7).fill(200), 300]));
    assert.equal(tile.latest, 300);
    assert.equal(tile.priorCount, TREND_WINDOW - 1);
    assert.equal(tile.priorAverage, 200);
    assert.equal(delta(tile), 100, "300 against 200 is +100");
  });

  test("it compares against the prior days it HAS, once there are three", () => {
    // Below MIN_PRIOR_DAYS the "average" is one or two readings and a change off
    // them is noise wearing a direction.
    // One line per case, so two branches adding different ones merge cleanly.
    const at = (n: number) => {
      const [tile] = typeTrends(weekly("weekend", Array(n).fill(100)));
      return [n, delta(tile), tile.priorCount, tile.priorAverage];
    };
    assert.deepEqual(
      [1, 2, 3, 4, 8, 9, 20].map(at),
      [
        [1, null, 0, null],
        [2, null, 0, null],
        // Two prior days is not an average.
        [3, null, 0, null],
        // Four days is the first history that compares: the latest, and three
        // before it.
        [4, 0, 3, 100],
        // A full window is the latest and the seven drawn beside it.
        [8, 0, 7, 100],
        [9, 0, 7, 100],
        // Never more than the window, however long the history.
        [20, 0, 7, 100],
      ],
    );
  });

  test("a prior average of zero is no comparison, and says so in both fields", () => {
    // `change` already refused to divide by it. `priorCount` did not, so a tile
    // could read "no prior window yet" beside a count of 4 — a label for a
    // comparison that was never made. One condition, read by both.
    const [tile] = typeTrends(weekly("weekend", [...Array(4).fill(0), 150]));
    assert.equal(tile.priorAverage, 0, "the window is there and its average really is zero");
    assert.equal(delta(tile), null, "a zero prior window is not something to compare against");
    assert.equal(tile.priorCount, 0, "so nothing was compared against, and the label must not claim otherwise");
  });

  test("a thin comparison reports the count it actually used", () => {
    // The label reads "vs prior 3". It must be the REAL number, not the window
    // the tile would like to have had.
    const [tile] = typeTrends(weekly("weekend", [...Array(3).fill(100), 150]));
    assert.equal(tile.priorCount, 3);
    assert.equal(tile.priorAverage, 100);
    assert.equal(tile.latest, 150);
    assert.equal(delta(tile), 50, "150 against 100 is +50");
  });

  test("the floor and the window are where their constants say, not numbers typed twice", () => {
    // Pins both constants to the behaviour, so moving one moves both.
    const below = typeTrends(weekly("weekend", Array(MIN_PRIOR_DAYS).fill(100)))[0];
    const atFloor = typeTrends(weekly("weekend", Array(MIN_PRIOR_DAYS + 1).fill(100)))[0];
    assert.equal(delta(below), null);
    assert.equal(delta(atFloor), 0);
    assert.equal(atFloor.priorCount, MIN_PRIOR_DAYS);
    const long = typeTrends(weekly("weekend", Array(TREND_WINDOW * 3).fill(100)))[0];
    assert.equal(long.recent.length, TREND_WINDOW);
    assert.equal(long.priorCount, TREND_WINDOW - 1);
  });

  test("a type with one recorded day shows no change at all", () => {
    // The bug this forbids is a change computed from an EMPTY prior window:
    // dividing by a mean of nothing gives Infinity or NaN, and a tile reading
    // "+Infinity" on a church's first recorded Sunday is worse than a tile that
    // says it cannot tell yet.
    const [one] = typeTrends(weekly("weekend", [250]));
    assert.equal(one.latest, 250, "one recorded day still has a figure — itself");
    assert.equal(delta(one), null, "with nothing before it, there is no change to show");
    assert.equal(one.priorCount, 0);
    assert.deepEqual(typeTrends([]), [], "no recordings at all is no tile, not an empty one");
  });

  test("a recording with no attendance record is not plotted as zero", () => {
    // A service nobody counted is not a service of nobody.
    const [tile] = typeTrends(weekly("weekend", [100, null, 120]));
    assert.deepEqual(tile.recent.map((d) => d.v), [100, 120]);
    assert.equal(tile.latest, 120);
  });

  test("one tile per service type, ordered by the figure the tile SHOWS", () => {
    const tiles = typeTrends([...weekly("evening", [90, 95]), ...weekly("weekend", [800, 820])]);
    assert.deepEqual(tiles.map((t) => t.serviceTypeId), ["weekend", "evening"]);
  });

  test("the order follows the LATEST day, not an average across the window", () => {
    // The two rules disagree on this fixture: weekend averages 1,000 against
    // evening's 375, and evening's latest day is 1,200 against weekend's 1,000.
    // The tile shows the latest day, so the order has to follow that — a tile
    // reading 380 above one reading 3,541 gives no account of itself. The
    // ordinary fixture above has both rules agreeing and cannot tell them apart.
    const tiles = typeTrends([
      ...weekly("weekend", Array(4).fill(1000)),
      ...weekly("evening", [100, 100, 100, 1200]),
    ]);
    assert.deepEqual(
      tiles.map((t) => [t.serviceTypeId, t.latest]),
      [["evening", 1200], ["weekend", 1000]],
      "the tiles are ordered by something other than the number on them",
    );
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
  test("the tiles read decibels, with the same window and the same change rule", () => {
    const [tile] = typeTrends(
      weekly("weekend", Array(4).fill(500), { db: [94, 94, 94, 100] }),
      { measure: "sound" },
    );
    assert.equal(tile.latest, 100);
    assert.equal(tile.priorAverage, 94);
    assert.equal(tile.priorCount, MIN_PRIOR_DAYS, "the relaxed floor applies to sound too");
    assert.equal(delta(tile), 6);
  });

  test("A TILE'S LEVEL IS ONE RECORDING'S, whatever a day's traffic", () => {
    // The other half of the day-total change, at the tile: eight Sundays of
    // three services, each at 96/99/104. Every figure the tile prints must stay
    // inside the range a meter reads, not climb with the number of services.
    const recs = sundays("weekend", 8, [1400, 700, 1100]).map((r, i) => ({
      ...r,
      peakDb: [96, 99, 104][i % 3],
    }));
    const [tile] = typeTrends(recs, { measure: "sound" });
    assert.equal(tile.latest, 104);
    assert.equal(tile.priorAverage, 104);
    assert.deepEqual(
      tile.recent.map((d) => d.v).filter((v) => v > 120),
      [],
      `the tile added a day's levels together: ${tile.recent.map((d) => d.v).join(", ")} dB`,
    );
  });

  test("a type with no SPL records keeps its tile, with nothing in it", () => {
    // Dropping it would read as the service type having disappeared the moment
    // you switched measure. The tile stays and the card says "no sound
    // recorded" against a null figure.
    const tiles = typeTrends(
      [
        ...weekly("weekend", Array(3).fill(900), { db: Array(3).fill(101) }),
        ...weekly("evening", Array(3).fill(200)),
      ],
      { measure: "sound" },
    );
    assert.deepEqual(
      tiles.map((t) => [t.serviceTypeId, t.latest]),
      [["weekend", 101], ["evening", null]],
      "a type with no level must keep its tile and sort last",
    );
    assert.deepEqual(tiles.find((t) => t.serviceTypeId === "evening")!.recent, []);
  });

  test("no recordings at all is still no tile, under either measure", () => {
    assert.deepEqual(typeTrends([], { measure: "sound" }), []);
    assert.deepEqual(typeTrends([], { measure: "attendance" }), []);
  });

  test("the range filters on the measure being plotted", () => {
    // A recording with attendance and no level is in range for one measure and
    // not the other. Filtering on attendance while plotting sound put an
    // undefined into the series.
    const recs = weekly("weekend", [100, 100, 100], { db: [null, 97, null] });
    assert.equal(withinRange(recs, 52, "attendance").length, 3);
    assert.deepEqual(
      withinRange(recs, 52, "sound").map((r) => r.peakDb),
      [97],
    );
  });
});
