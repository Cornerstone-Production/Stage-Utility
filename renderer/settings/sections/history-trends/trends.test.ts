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
    complete: true,
  }));
}

/**
 * `weeks` Sundays, each running the services in `perDay` (peaks, in order, two
 * hours apart) — the shape a church with a 9, an 11 and a 6 records.
 *
 * `doneOnLastDay` is how many of the FINAL day's services have ended; the rest
 * are still running. Every fixture in this file used to be finished days only,
 * which is why a partial Sunday could be compared against whole ones for a whole
 * release without a test noticing.
 */
function sundays(
  typeId: string,
  weeks: number,
  perDay: number[],
  opts: { doneOnLastDay?: number } = {},
): TrendRecording[] {
  const start = Date.parse("2026-01-04T09:00:00Z");
  const out: TrendRecording[] = [];
  for (let w = 0; w < weeks; w++) {
    const day = start + w * 7 * DAY;
    const done = w === weeks - 1 ? opts.doneOnLastDay ?? perDay.length : perDay.length;
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
        complete: i < done,
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
    assert.equal(tile.serviceCount, 1, "one service a week, so the slice is one");
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

  test("the change runs over ALL of it, not the window the sparkline draws", () => {
    // The sparkline holds eight days; the comparison holds every day on record.
    // Eleven Sundays at 100 then one at 200: bounded by the window the basis
    // would be seven days of 100 and identical, so the fixture is built to tell
    // the two apart — 11 prior days is the answer only an all-time basis gives.
    const [tile] = typeTrends(weekly("weekend", [...Array(11).fill(100), 200]));
    assert.equal(tile.recent.length, TREND_WINDOW, "the sparkline still draws a window");
    assert.equal(tile.latest, 200);
    assert.equal(tile.priorCount, 11, "the basis was clipped to the sparkline's window");
    assert.equal(tile.priorAverage, 100);
    assert.equal(delta(tile), 100, "200 against 100 is +100");
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
        // And from there it keeps every prior day, however long the history —
        // the sparkline's window bounds the drawing, not the arithmetic.
        [8, 0, 7, 100],
        [9, 0, 8, 100],
        [20, 0, 19, 100],
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
    // TREND_WINDOW bounds the SPARKLINE and nothing else: the basis keeps every
    // prior day, which here is one short of three windows.
    const long = typeTrends(weekly("weekend", Array(TREND_WINDOW * 3).fill(100)))[0];
    assert.equal(long.recent.length, TREND_WINDOW);
    assert.equal(long.priorCount, TREND_WINDOW * 3 - 1);
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

describe("a day that is only part way through", () => {
  /**
   * Six finished Sundays of 1,000 + 500 + 800, then a seventh with `done` of
   * its three services ended.
   *
   * The three differ, deliberately: the first-one basis (1,000), the first-two
   * basis (1,500) and the whole-day basis (2,300) are three different numbers,
   * so a comparison taken at the wrong slice cannot come out right by accident.
   */
  function partSunday(done: number, last: number[] = [1100, 600, 900]): TrendRecording[] {
    const older = sundays("weekend", 6, [1000, 500, 800]);
    const newer = sundays("weekend", 1, last, { doneOnLastDay: done }).map((r, i) => ({
      ...r,
      serviceKey: `later:${i}`,
      serviceDate: new Date(Date.parse(`${r.serviceDate}T00:00:00Z`) + 42 * DAY).toISOString().slice(0, 10),
      t: r.t + 42 * DAY,
    }));
    return [...older, ...newer];
  }

  test("ONE of three done compares against prior FIRST services, not whole days", () => {
    // The defect this exists for: a Sunday morning with the 9 o'clock finished
    // showing 1,100 against a basis of 2,300 — every week reading as a collapse
    // of half the church until the evening service ends.
    const [tile] = typeTrends(partSunday(1));
    assert.equal(tile.serviceCount, 1, "the day counted services that had not finished");
    assert.equal(tile.latest, 1100, "the headline is not the finished service on its own");
    assert.equal(tile.priorAverage, 1000, "the basis is not the prior days' FIRST service");
    assert.equal(delta(tile), 100, "1,100 against 1,000");
    assert.equal(tile.priorCount, 6);
  });

  test("TWO of three done compares against prior first TWO", () => {
    const [tile] = typeTrends(partSunday(2));
    assert.equal(tile.serviceCount, 2);
    assert.equal(tile.latest, 1700, "1,100 + 600");
    assert.equal(tile.priorAverage, 1500, "1,000 + 500");
    assert.equal(delta(tile), 200);
  });

  test("all three done compares against whole days again", () => {
    const [tile] = typeTrends(partSunday(3));
    assert.equal(tile.serviceCount, 3);
    assert.equal(tile.latest, 2600, "1,100 + 600 + 900");
    assert.equal(tile.priorAverage, 2300);
    assert.equal(delta(tile), 300);
  });

  test("a day with NOTHING finished falls back to the last day that did", () => {
    // Zero is not the answer at five past nine. The tile shows last Sunday and
    // dates itself to it, rather than reporting a church of nobody every week
    // between the doors opening and the first service ending.
    const [tile] = typeTrends(partSunday(0));
    assert.equal(tile.serviceCount, 3, "it counted a service that had not finished");
    assert.equal(tile.latest, 2300, "the tile is showing the unfinished day");
    assert.equal(tile.latestDate, "2026-02-08", "the tile is dated the day it is not showing");
    assert.equal(delta(tile), 0, "five identical prior Sundays, so no change");
  });

  test("FIVE services work, and nothing here knows the number three", () => {
    // N comes from the data. A church running five must work with no code
    // change, and one that adds a sixth gets it the first Sunday it finishes.
    const five = [400, 500, 600, 700, 800];
    const older = sundays("weekend", 5, five);
    const newer = sundays("weekend", 1, [450, 550, 650, 750, 850], { doneOnLastDay: 4 }).map((r, i) => ({
      ...r,
      serviceKey: `later:${i}`,
      serviceDate: new Date(Date.parse(`${r.serviceDate}T00:00:00Z`) + 35 * DAY).toISOString().slice(0, 10),
      t: r.t + 35 * DAY,
    }));
    const [tile] = typeTrends([...older, ...newer]);
    assert.equal(tile.serviceCount, 4, "four of five finished");
    assert.equal(tile.latest, 2400, "450 + 550 + 650 + 750");
    assert.equal(tile.priorAverage, 2200, "400 + 500 + 600 + 700");
    assert.equal(delta(tile), 200);
  });

  test("a prior day that never ran N services is left out of the basis", () => {
    // A Sunday that only ever held two has no third service to offer. Averaging
    // its two into a three-service comparison drags the basis down for a reason
    // that is nothing to do with attendance.
    const three = sundays("weekend", 4, [1000, 500, 800]);
    const twoOnly = sundays("weekend", 1, [1000, 500]).map((r, i) => ({
      ...r,
      serviceKey: `short:${i}`,
      serviceDate: "2026-02-08",
      t: Date.parse("2026-02-08T09:00:00Z") + i * 2 * 60 * 60_000,
    }));
    const latest = sundays("weekend", 1, [1100, 600, 900]).map((r, i) => ({
      ...r,
      serviceKey: `latest:${i}`,
      serviceDate: "2026-02-15",
      t: Date.parse("2026-02-15T09:00:00Z") + i * 2 * 60 * 60_000,
    }));
    const [tile] = typeTrends([...three, ...twoOnly, ...latest]);
    assert.equal(tile.serviceCount, 3);
    assert.equal(tile.priorCount, 4, "the two-service Sunday was counted in a three-service comparison");
    assert.equal(tile.priorAverage, 2300, "a short day dragged the basis down");
  });

  test("SOUND takes the loudest of the first N, and still never adds", () => {
    // The partial-day rule reaches sound too, and it must not turn into a sum on
    // the way. `sundays` gives each service 90, 91, 92 dB in order, so a summed
    // first-two would be 181 and a summed day 273.
    const [tile] = typeTrends(partSunday(2), { measure: "sound" });
    assert.equal(tile.serviceCount, 2);
    assert.equal(tile.latest, 91, "the loudest of the first two, not their sum");
    assert.equal(tile.priorAverage, 91);
    assert.deepEqual(
      tile.recent.map((d) => d.v).filter((v) => v > 120),
      [],
      `a day's level was summed: ${tile.recent.map((d) => d.v).join(", ")} dB`,
    );
  });
});

describe("a recording that is still running", () => {
  test("is in nothing — not the tile, not the sparkline, not the line", () => {
    // A half-finished 9 o'clock is not a smaller 9 o'clock. Counting it makes
    // the headline climb while you watch it and the comparison meaningless.
    const recs = sundays("weekend", 4, [1000, 500, 800], { doneOnLastDay: 0 });
    assert.equal(dailyValues(recs, "attendance").length, 3, "an unfinished day is on the line");
    assert.equal(withinRange(recs, 52).length, 9, "an unfinished recording is in the plotted range");
    const [tile] = typeTrends(recs);
    assert.equal(tile.recent.length, 3, "an unfinished day is on the sparkline");
    assert.equal(tile.latestDate, "2026-01-18", "the tile is dated an unfinished day");
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
