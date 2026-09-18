// geometry.test.ts — the chart's arithmetic.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  TEN_MINUTES_MS,
  areaPathD,
  linePathD,
  nearestIndex,
  niceAxis,
  splitRuns,
  tenMinuteDomainEnd,
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
