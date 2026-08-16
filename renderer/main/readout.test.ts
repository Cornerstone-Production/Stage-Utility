import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { VALUE_SCALE, valueSizeFor, CONTENT_SCALE } from "./readout-size.js";

// The composition is caption / value / sub, sized from the widget's own height.
// These are the proportions the comparison page was approved at, plus the one
// thing that page could not show: what happens when a widget has no caption.

const BOX = 200;
/** The caption and sub at a box tall enough that neither hits its pixel floor. */
const CAPTION = BOX * 0.105;
const SUB = BOX * 0.115;

describe("the three-line composition", () => {
  test("the value lands on VALUE_SCALE when all three lines are present", () => {
    // THE anchor. CONTENT_SCALE is derived from VALUE_SCALE so that constant
    // stays the single knob; if the derivation ever drifts, the approved
    // three-line proportion silently stops being what the constant says.
    const px = valueSizeFor(BOX, CAPTION, SUB);
    assert.ok(
      Math.abs(px - BOX * VALUE_SCALE) < 0.01,
      `three-line value is ${px}px, expected ${BOX * VALUE_SCALE}px`,
    );
  });

  test("raising VALUE_SCALE would raise the whole budget", () => {
    // The plan requires the ratio to live in ONE named constant so it can be
    // tuned on real screens in one edit. That is only true if the budget tracks
    // it — a hard-coded budget would cap the value however high the constant went.
    assert.ok(CONTENT_SCALE > VALUE_SCALE, "the budget does not contain the value");
    assert.ok(
      Math.abs(CONTENT_SCALE - (VALUE_SCALE * 1.05 + 0.105 * 1.1 + 0.115 * 1.2 + 0.06)) < 1e-9,
      "the budget is no longer derived from VALUE_SCALE",
    );
  });
});

describe("the line counts that actually occur", () => {
  // Captions ship on six types and only on NEW objects, so most readouts in the
  // layouts that exist today are a value alone. The comparison page gave every
  // widget all three lines, which is exactly why this case needs a test.

  test("a caption-less, sub-less value takes the whole budget", () => {
    const alone = valueSizeFor(BOX, 0, 0);
    assert.ok(
      alone > BOX * VALUE_SCALE * 1.7,
      `a lone value got ${alone}px — barely more than the three-line ${BOX * VALUE_SCALE}px, ` +
        "which is the small-value-in-an-empty-box bug",
    );
  });

  test("each line added shrinks the value", () => {
    const alone = valueSizeFor(BOX, 0, 0);
    const withCaption = valueSizeFor(BOX, CAPTION, 0);
    const withBoth = valueSizeFor(BOX, CAPTION, SUB);
    assert.ok(alone > withCaption, "adding a caption did not make room");
    assert.ok(withCaption > withBoth, "adding a sub-line did not make room");
  });

  test("the composition never exceeds its budget", () => {
    // The point of budgeting rather than stacking: three lines that each size
    // themselves independently overflow the box, and overflow on a wall readout
    // is a clipped number.
    for (const [cap, sub] of [[0, 0], [CAPTION, 0], [0, SUB], [CAPTION, SUB]]) {
      const used =
        valueSizeFor(BOX, cap, sub) * 1.05 +
        (cap > 0 ? cap * 1.1 + BOX * 0.03 : 0) +
        (sub > 0 ? sub * 1.2 + BOX * 0.03 : 0);
      assert.ok(used <= BOX * CONTENT_SCALE + 0.01, `caption=${cap} sub=${sub} used ${used}px`);
    }
  });
});

describe("small boxes", () => {
  test("a value survives a box the caption's pixel floor would otherwise eat", () => {
    // The floors keep the caption and sub legible in a small tile, which means
    // at some height they consume the entire budget. Without a floor under the
    // value, that box renders a caption, a sub, and nothing between them.
    const tiny = 30;
    const px = valueSizeFor(tiny, 9, 10);
    assert.ok(px > 0, "the value collapsed to nothing");
    assert.ok(px >= (tiny * 0.18) / 1.05 - 0.01, `value floor not applied: ${px}px`);
  });
});
