// geometry.test.ts — the chart's arithmetic.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  TEN_MINUTES_MS,
  areaPathD,
  linePathD,
  dateTicks,
  nearestIndex,
  niceAxis,
  splitRuns,
  tenMinuteDomainEnd,
  timeTicks,
} from "./geometry.js";

describe("niceAxis", () => {
  test("counts run from zero to a round top with headroom", () => {
    assert.deepEqual(niceAxis([0, 310, 531], { kind: "count" }), { lo: 0, hi: 1000, ticks: [0, 500, 1000] });
  });

  test("a value exactly on a round top is given the next one, so the peak is not on the frame", () => {
    assert.equal(niceAxis([1000], { kind: "count" }).hi > 1000, true);
  });

  test("an empty series still has an axis", () => {
    assert.deepEqual(niceAxis([], { kind: "count" }), { lo: 0, hi: 2, ticks: [0, 1, 2] });
  });

  test("a BANDED count frames the data instead of running from zero", () => {
    // The mockup's own trends numbers: three service types between 800 and
    // 1,600. Anchored at zero they draw as three lines in the top fifth of the
    // plot and a hundred-person week is invisible.
    const a = niceAxis([800, 1196, 1388, 1502, 1600], { kind: "count", banded: true });
    assert.deepEqual(a, { lo: 800, hi: 1600, ticks: [800, 1200, 1600] });
  });

  test("banding never starts below zero, and takes zero when the data reaches it", () => {
    // A count has a real floor. One line per case, so two branches adding
    // different ones merge cleanly.
    assert.equal(niceAxis([0, 40, 90], { kind: "count", banded: true }).lo, 0);
    assert.equal(niceAxis([3, 8, 11], { kind: "count", banded: true }).lo >= 0, true);
    // And a spread too wide to clear zero falls back to zero rather than to a
    // silly number of gridlines.
    const wide = niceAxis([435, 1616], { kind: "count", banded: true });
    assert.equal(wide.lo >= 0, true);
    assert.equal(wide.hi >= 1616, true);
    assert.equal(wide.ticks.length <= 7, true, `too many gridlines: ${wide.ticks.join(",")}`);
  });

  test("a flat banded series is framed, not drawn on an edge", () => {
    const a = niceAxis([1200, 1200, 1200], { kind: "count", banded: true });
    assert.equal(a.lo < 1200, true, `the line sits on the floor: ${JSON.stringify(a)}`);
    assert.equal(a.hi > 1200, true, `the line sits on the ceiling: ${JSON.stringify(a)}`);
  });

  test("banding is opt-in — an unbanded count still runs from zero", () => {
    // The attendance chart depends on it: the curve starts at an empty room and
    // its gradient fills to a floor that means something.
    assert.equal(niceAxis([800, 1600], { kind: "count" }).lo, 0);
  });

  test("decibels do NOT floor at zero", () => {
    // The whole interesting band of a service is ~20 dB wide. Anchoring at 0
    // squeezes it into the top eighth of the plot and the line reads flat.
    const a = niceAxis([78.2, 91.4, 84], { kind: "db" });
    assert.equal(a.lo, 75);
    assert.equal(a.hi, 95);
    assert.deepEqual(a.ticks, [75, 85, 95]);
  });

  test("the dB band is a multiple of ten, so the middle tick is a round number", () => {
    // 72–95 gives 65 and a rough top of 100, whose midpoint is 82.5 → "83".
    // A gridline labelled 83 reads as a data value. Widened to 65–105, mid 85.
    assert.deepEqual(niceAxis([72, 95], { kind: "db" }), { lo: 65, hi: 105, ticks: [65, 85, 105] });
  });

  test("every dB tick is a whole multiple of five", () => {
    for (let min = 40; min <= 110; min++) {
      for (const width of [1, 7, 18, 33]) {
        const a = niceAxis([min, min + width], { kind: "db" });
        for (const t of a.ticks) {
          assert.equal(t % 5, 0, `tick ${t} from ${min}..${min + width} is not a multiple of 5`);
        }
      }
    }
  });

  test("a single dB reading still gets a band to sit in", () => {
    const a = niceAxis([88], { kind: "db" });
    assert.ok(a.hi - a.lo >= 10, `${a.lo}–${a.hi} is too tight to read`);
  });
});

describe("tenMinuteDomainEnd", () => {
  const start = Date.parse("2026-09-17T20:00:00.000Z");

  test("a fresh record still gets a ten-minute window", () => {
    assert.equal(tenMinuteDomainEnd(start, start), start + TEN_MINUTES_MS);
  });

  test("steps only on the ten, so the curve does not slide every sample", () => {
    const at = (min: number) => tenMinuteDomainEnd(start, start + min * 60_000);
    assert.equal(at(1), start + TEN_MINUTES_MS);
    assert.equal(at(9), start + TEN_MINUTES_MS);
    assert.equal(at(10), start + TEN_MINUTES_MS);
    assert.equal(at(10.5), start + 2 * TEN_MINUTES_MS);
    assert.equal(at(75), start + 8 * TEN_MINUTES_MS);
  });
});

describe("splitRuns", () => {
  const p = (min: number, v: number) => ({ t: min * 60_000, v });

  test("one run when sampling is continuous", () => {
    assert.equal(splitRuns([p(0, 1), p(0.5, 2), p(1, 3)], 180_000).length, 1);
  });

  test("breaks where the counter went quiet", () => {
    // A confident straight line through an hour nobody measured is worse than a
    // hole, which is the whole reason this exists.
    const runs = splitRuns([p(0, 1), p(0.5, 2), p(45, 3), p(45.5, 4)], 180_000);
    assert.deepEqual(runs.map((r) => r.length), [2, 2]);
  });

  test("nothing in, nothing out", () => {
    assert.deepEqual(splitRuns([], 180_000), []);
  });
});

describe("path builders", () => {
  const project = (pt: { t: number; v: number }) => ({ x: pt.t, y: pt.v });

  test("a line through two points", () => {
    assert.equal(linePathD([{ t: 0, v: 10 }, { t: 5, v: 20 }], project), "M0.0,10.0L5.0,20.0");
  });

  test("a single sample still draws, so the first point of a live service is visible", () => {
    assert.equal(linePathD([{ t: 3, v: 7 }], project), "M3.0,7.0L3.0,7.0");
  });

  test("an empty series draws nothing rather than an invalid `d`", () => {
    assert.equal(linePathD([], project), "");
  });

  test("the fill drops to the floor at the RUN's own ends", () => {
    // Not the chart's ends: a fill that spanned a sampling gap would paint the
    // hole solid, which says the room was empty rather than unmeasured.
    const d = areaPathD([{ t: 10, v: 1 }, { t: 20, v: 2 }], project, 100);
    assert.equal(d, "M10.0,100.0L10.0,1.0L20.0,2.0L20.0,100.0Z");
  });

  test("one point has no area", () => {
    assert.equal(areaPathD([{ t: 1, v: 1 }], project, 100), "");
  });
});

describe("dateTicks over a long range", () => {
  const WEEK = 7 * 24 * 60 * 60_000;
  const from = Date.parse("2020-01-05T12:00:00Z");
  const span = (weeks: number) => dateTicks(from, from + weeks * WEEK).length;

  test("the tick count stays readable however far back All reaches", () => {
    // A fixed 4-week step is a season's axis and a smear at three years: 156
    // weeks of it is 39 ticks, a mark every 49px on a 1,900px plot, which reads
    // as hatching rather than as an axis.
    // One span per line, so two branches adding different ones merge cleanly.
    const counts = [8, 16, 52, 156, 520].map((w) => [w, span(w)]);
    assert.deepEqual(
      counts.filter(([, n]) => (n as number) > 20),
      [],
      `an axis nobody can read: ${JSON.stringify(counts)}`,
    );
    // And not so few that the axis says nothing either.
    assert.deepEqual(
      counts.filter(([, n]) => (n as number) < 4),
      [],
      `an axis with almost no ticks: ${JSON.stringify(counts)}`,
    );
  });
});

describe("nearestIndex", () => {
  const pts = [{ t: 0, v: 0 }, { t: 100, v: 0 }, { t: 200, v: 0 }];
  test("picks the closest sample", () => {
    assert.equal(nearestIndex(pts, 120), 1);
    assert.equal(nearestIndex(pts, 199), 2);
  });
  test("-1 for an empty series rather than 0, which would index undefined", () => {
    assert.equal(nearestIndex([], 5), -1);
  });
});

describe("timeTicks", () => {
  const at = (hhmm: string) => Date.parse(`2026-09-17T${hhmm}:00.000Z`);
  const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

  test("a 2h38m domain is ticked every half hour", () => {
    // 20:00 -> 22:38. Six ticks, on the clock's own half-hours.
    assert.deepEqual(timeTicks(at("20:00"), at("22:38")).map(hhmm), [
      "20:00",
      "20:30",
      "21:00",
      "21:30",
      "22:00",
      "22:30",
    ]);
  });

  test("ticks are on the CLOCK, not on the domain's own start", () => {
    // A service beginning at 19:47 gets 20:00 and 20:30, not 19:47 and 20:17.
    // A chart is read against the time on the wall.
    assert.equal(hhmm(timeTicks(at("19:47"), at("22:10"))[0]), "20:00");
    // And on the fine step too — 19:50, not 19:47.
    assert.equal(hhmm(timeTicks(at("19:47"), at("21:10"))[0]), "19:50");
  });

  test("a short domain is ticked every ten minutes instead", () => {
    // Half an hour with a 30-minute step is one tick, or none, and a service
    // that has just started is exactly when the axis matters most.
    assert.deepEqual(timeTicks(at("20:02"), at("20:44")).map(hhmm), [
      "20:10",
      "20:20",
      "20:30",
      "20:40",
    ]);
  });

  test("the step changes at ninety minutes, once", () => {
    assert.equal(timeTicks(at("20:00"), at("21:29")).length, 9);
    assert.equal(timeTicks(at("20:00"), at("21:30")).length, 4);
  });

  test("a domain too short for a tick gives none rather than a crowd", () => {
    assert.deepEqual(timeTicks(at("20:01"), at("20:08")), []);
  });

  test("a backwards or unusable domain gives none rather than looping", () => {
    assert.deepEqual(timeTicks(at("21:00"), at("20:00")), []);
    assert.deepEqual(timeTicks(NaN, at("20:00")), []);
    assert.deepEqual(timeTicks(at("20:00"), NaN), []);
  });

  test("every tick is inside the domain", () => {
    for (const end of ["20:31", "21:00", "22:38", "23:59"]) {
      const a = at("19:47");
      const b = at(end);
      for (const t of timeTicks(a, b)) {
        assert.ok(t >= a && t <= b, `${new Date(t).toISOString()} is outside ${end}`);
      }
    }
  });
});
