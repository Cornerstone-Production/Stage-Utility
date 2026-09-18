// A service type's colour does not move.
//
// The arithmetic only. Whether the CARD actually uses it — the tile, the
// sparkline, the line, the legend and the milestone all reading the same
// entry — is proved through a render in trends-card.test.tsx, because this
// file could be perfect while the component still coloured by sort order.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assignColorIndexes, colorForIndex, TREND_COLORS } from "./series-colors.js";

describe("assigning a colour to a service type", () => {
  test("an assigned type keeps its index however the list is reordered", () => {
    // THE BUG. Colours were `SERIES_COLORS[i]` over a busiest-first sort, so
    // The Salt Company was blue on Attendance and green on Sound — the sort
    // differs per measure — and a quiet type that had a loud week swapped with
    // its neighbour.
    const first = assignColorIndexes({}, ["salt", "weekend"]);
    const reordered = assignColorIndexes(first, ["weekend", "salt"]);
    assert.deepEqual(reordered, first, "the assignment moved when the order did");
    // And a type that stops recording, then comes back, comes back the same.
    const without = assignColorIndexes(first, ["weekend"]);
    const back = assignColorIndexes(without, ["salt", "weekend", "midweek"]);
    assert.equal(back.salt, first.salt, "a type that missed a range lost its colour");
    assert.equal(back.weekend, first.weekend);
  });

  test("a new type takes the lowest index nothing holds", () => {
    assert.deepEqual(assignColorIndexes({}, ["a", "b", "c"]), { a: 0, b: 1, c: 2 });
    // A gap left by an id that is no longer on screen is NOT reused while that
    // id is still in the store — reusing it would give two types one colour the
    // moment the old one recorded again.
    assert.deepEqual(assignColorIndexes({ a: 0, c: 2 }, ["b"]), { a: 0, c: 2, b: 1 });
  });

  test("more types than colours cycle rather than going uncoloured", () => {
    const n = TREND_COLORS.length;
    const ids = Array.from({ length: n + 3 }, (_, i) => `t${i}`);
    const got = assignColorIndexes({}, ids);
    assert.equal(Object.keys(got).length, ids.length, "a type went uncoloured");
    for (const id of ids) {
      assert.ok(Number.isInteger(got[id]), `${id} has no index`);
      assert.ok(got[id] >= 0 && got[id] < n, `${id} is outside the palette: ${got[id]}`);
    }
    // The first `n` are still one each — cycling must not disturb them.
    assert.deepEqual(ids.slice(0, n).map((id) => got[id]), [...Array(n).keys()]);
  });

  test("the empty-string id — a recording with no service type — is a type like any other", () => {
    // It is the key the card uses for the no-type bucket, and `""` is falsy in
    // every place that has ever handled it wrong.
    const got = assignColorIndexes({}, ["", "weekend"]);
    assert.equal(got[""], 0);
    assert.equal(got.weekend, 1);
  });

  test("an index outside the palette wraps rather than drawing nothing", () => {
    // A hand-edited or restored store. `TREND_COLORS[99]` is undefined, and a
    // line with stroke `undefined` draws black on black.
    assert.equal(colorForIndex(0), TREND_COLORS[0]);
    assert.equal(colorForIndex(TREND_COLORS.length), TREND_COLORS[0]);
    assert.equal(colorForIndex(-1), TREND_COLORS[TREND_COLORS.length - 1]);
    for (const n of [99, -99, 4.7]) {
      assert.ok(TREND_COLORS.includes(colorForIndex(n) as (typeof TREND_COLORS)[number]), `index ${n} drew nothing`);
    }
  });
});
