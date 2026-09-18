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
  TREND_WINDOW,
  seriesChangeMilestones,
  trendMilestones,
  typeTrends,
  withinRange,
  type TrendRecording,
} from "./trends.js";

const DAY = 24 * 60 * 60_000;

/** A weekly service of one type, `peaks` oldest first, ending today. */
function weekly(
  typeId: string,
  peaks: (number | null)[],
  opts: { series?: (string | null)[]; from?: number } = {},
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
  }));
}

describe("a service type's trend tile", () => {
  test("the change is this window's average against the eight before it", () => {
    // Sixteen recordings: the first eight average 100, the last eight average
    // 120. A 20% rise, and the tile must not average all sixteen.
    const peaks = [...Array(8).fill(100), ...Array(8).fill(120)];
    const [tile] = typeTrends(weekly("weekend", peaks));
    assert.equal(tile.recent.length, TREND_WINDOW);
    assert.equal(tile.average, 120, "the average is over the RECENT window, not the whole history");
    assert.equal(tile.priorCount, 8);
    assert.ok(tile.change != null);
    assert.equal(Math.round(tile.change * 1000) / 1000, 0.2, "120 against 100 is +20%");
  });

  test("more than sixteen recordings still compares eight against the eight before", () => {
    // A leading run of 10s must not drag the prior window down: only the eight
    // immediately before the recent window count.
    const peaks = [...Array(10).fill(10), ...Array(8).fill(200), ...Array(8).fill(300)];
    const [tile] = typeTrends(weekly("weekend", peaks));
    assert.equal(tile.average, 300);
    assert.equal(tile.priorCount, 8);
    assert.equal(Math.round((tile.change as number) * 100) / 100, 0.5, "300 against 200 is +50%");
  });

  test("a type with fewer than two recordings shows no change at all", () => {
    // The bug this forbids is a change computed from an EMPTY prior window:
    // dividing by a mean of nothing gives Infinity or NaN, and a tile reading
    // "+Infinity%" on a church's first recorded Sunday is worse than a tile
    // that says it cannot tell yet.
    const [one] = typeTrends(weekly("weekend", [250]));
    assert.equal(one.average, 250, "one recording still has an average — itself");
    assert.equal(one.change, null, "with nothing before it, there is no change to show");
    assert.equal(one.priorCount, 0);
    assert.deepEqual(typeTrends([]), [], "no recordings at all is no tile, not an empty one");
  });

  test("a recording with no attendance record is not plotted as zero", () => {
    // A service nobody counted is not a service of nobody.
    const [tile] = typeTrends(weekly("weekend", [100, null, 100]));
    assert.deepEqual(tile.recent.map((r) => r.peakOccupancy), [100, 100]);
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
