// trends.test.ts — the Trends card's arithmetic: the last TREND_WINDOW
// sessions against the TREND_WINDOW before, and the MIN_PRIOR_DAYS floor below
// which no change figure is shown. Every guard here was watched red before the
// fix that makes it pass — see the report for the exact failing output.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { MIN_PRIOR_DAYS, TREND_WINDOW, baptismTrends, type BaptismTrendPoint } from "./trends.js";

const DAY = 24 * 60 * 60 * 1000;

/** `n` points, oldest first, `t` spaced a day apart starting at epoch 0, every
 *  numeric field set to `value` unless overridden per point by `pick`. */
function points(n: number, value: number, pick?: (i: number) => Partial<BaptismTrendPoint>): BaptismTrendPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * DAY,
    baptized: value,
    avgTestimonySec: value,
    avgBaptismSec: value,
    wholeSegmentSec: value,
    ...pick?.(i),
  }));
}

describe("baptismTrends — reuses TREND_WINDOW and MIN_PRIOR_DAYS from history-trends", () => {
  test("TREND_WINDOW is history's own 8, not a re-declared literal", () => {
    assert.equal(TREND_WINDOW, 8);
  });

  test("MIN_PRIOR_DAYS is history's own 3", () => {
    assert.equal(MIN_PRIOR_DAYS, 3);
  });
});

describe("baptismTrends — the last window against the window before", () => {
  test("with 16 sessions, the newest 8 average against the 8 before them", () => {
    // Oldest 8 baptize 1 each (mean 1), newest 8 baptize 3 each (mean 3).
    const all = [...points(8, 1), ...points(8, 3, (i) => ({ t: (8 + i) * DAY }))];
    const trends = baptismTrends(all);
    assert.equal(trends.baptized.latest, 3, "the headline is the mean of the newest window");
    assert.equal(trends.baptized.prior, 1, "the comparison is the mean of the window before it");
    assert.equal(trends.baptized.priorCount, 8);
    assert.deepEqual(trends.baptized.recent, [3, 3, 3, 3, 3, 3, 3, 3]);
  });

  test("order-independent: newest-first input (baptismStore's own order) gives the identical split", () => {
    const oldestFirst = [...points(8, 1), ...points(8, 3, (i) => ({ t: (8 + i) * DAY }))];
    const newestFirst = oldestFirst.slice().reverse();
    const trends = baptismTrends(newestFirst);
    assert.equal(trends.baptized.latest, 3, "a caller handing over newest-first must not silently compare the wrong halves");
    assert.equal(trends.baptized.prior, 1);
  });

  test("a 9th prior session is dropped from the comparison, not blended in", () => {
    // 9 prior sessions at 1, then 8 recent at 3: only the NEAREST 8 priors
    // count, so a 9th-oldest session at a different value must not move it.
    const all = [
      ...points(9, 1),
      ...points(8, 3, (i) => ({ t: (9 + i) * DAY })),
    ];
    const trends = baptismTrends(all);
    assert.equal(trends.baptized.priorCount, 8);
    assert.equal(trends.baptized.prior, 1);
  });
});

describe("baptismTrends — MIN_PRIOR_DAYS guard: below it, no change figure", () => {
  test("exactly MIN_PRIOR_DAYS prior sessions compare", () => {
    const all = [...points(MIN_PRIOR_DAYS, 2), ...points(8, 5, (i) => ({ t: (MIN_PRIOR_DAYS + i) * DAY }))];
    const trends = baptismTrends(all);
    assert.equal(trends.baptized.prior, 2, "MIN_PRIOR_DAYS itself must still be enough to compare");
    assert.equal(trends.baptized.priorCount, MIN_PRIOR_DAYS);
  });

  test("one short of MIN_PRIOR_DAYS shows the headline but no comparison", () => {
    const short = MIN_PRIOR_DAYS - 1;
    const all = [...points(short, 2), ...points(8, 5, (i) => ({ t: (short + i) * DAY }))];
    const trends = baptismTrends(all);
    assert.equal(trends.baptized.latest, 5, "the headline itself is unaffected by a thin comparison");
    assert.equal(trends.baptized.prior, null, "a comparison resting on fewer than MIN_PRIOR_DAYS sessions must not be shown");
    assert.equal(trends.baptized.priorCount, 0);
  });

  test("no sessions at all: every tile is empty, not zero", () => {
    const trends = baptismTrends([]);
    assert.equal(trends.baptized.latest, null);
    assert.equal(trends.baptized.prior, null);
    assert.deepEqual(trends.baptized.recent, []);
  });
});

describe("baptismTrends — all four measures derive independently", () => {
  test("baptized, avgTestimonySec, avgBaptismSec and wholeSegmentSec each carry their own value", () => {
    const all: BaptismTrendPoint[] = [
      { t: 0, baptized: 1, avgTestimonySec: 100, avgBaptismSec: 40, wholeSegmentSec: 900 },
      { t: DAY, baptized: 2, avgTestimonySec: 110, avgBaptismSec: 42, wholeSegmentSec: 950 },
      { t: 2 * DAY, baptized: 3, avgTestimonySec: 120, avgBaptismSec: 44, wholeSegmentSec: 1000 },
    ];
    const trends = baptismTrends(all, 3);
    assert.deepEqual(trends.baptized.recent, [1, 2, 3]);
    assert.deepEqual(trends.avgTestimonySec.recent, [100, 110, 120]);
    assert.deepEqual(trends.avgBaptismSec.recent, [40, 42, 44]);
    assert.deepEqual(trends.wholeSegmentSec.recent, [900, 950, 1000]);
  });
});
