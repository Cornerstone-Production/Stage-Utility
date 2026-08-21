// The chart's one piece of geometry that is not the data: how wide it lets
// itself be drawn.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { plotWidth } from "./attendance-trend-chart.js";

describe("a trend never gets flatter than 8:1", () => {
  test("Home's XL tile is capped, not filled", () => {
    // The reported bug: about 1700 wide and 130 tall drew a fifteen-to-one wire
    // in which every weekend looked identical.
    assert.equal(plotWidth(1722, 130), 1040);
    assert.ok(1722 / 130 > 8, "the fixture has to be flatter than the cap to test it");
  });

  test("a chart with room to be square is left alone", () => {
    // History's 640-wide chart is 4.9:1 and must draw exactly as it always has.
    assert.equal(plotWidth(640, 130), 640);
    assert.equal(plotWidth(400, 300), 400);
  });

  test("more height buys more width", () => {
    // A Tall tile gets the whole width back, because at that height it is no
    // longer a wire.
    assert.equal(plotWidth(1722, 400), 1722);
  });
});
