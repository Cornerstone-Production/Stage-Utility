import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { VALUE_SCALE, valueSizeFor, CONTENT_SCALE, PAD_SCALE, fitComposition } from "./readout-size.js";

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

describe("the composition fits the box it paints", () => {
  test("the budget plus the idiom's own padding stays inside the box", () => {
    // THE clipping guard. The readout draws over the object's stored padding and
    // supplies its own, because the stored one is a fraction of the CANVAS: a
    // 54px status pill carried 14.7px a side, leaving 23px of content for a 31px
    // composition, and clipped its own value on a real display.
    //
    // So the budget and the padding have to be checked against each other. They
    // are separate constants, and nothing else notices when their sum passes 1.
    assert.ok(
      CONTENT_SCALE + 2 * PAD_SCALE <= 1,
      `composition ${CONTENT_SCALE} + padding ${2 * PAD_SCALE} overflows the box`,
    );
  });

  test("a short box still fits", () => {
    // The pixel floors under the caption and sub do not scale down forever, so
    // the small end is where the sum actually breaks. 54px is the real status
    // pill that clipped.
    const box = 54;
    const cap = Math.max(9, box * 0.105);
    const sub = 0;
    const used = valueSizeFor(box, cap, sub) * 1.05 + cap * 1.1 + box * 0.03 + 2 * box * PAD_SCALE;
    assert.ok(used <= box + 0.01, `a ${box}px widget renders ${used.toFixed(1)}px of content`);
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

describe("a widget that has been made small", () => {
  // The report: integration widgets clip in the editor once they are shrunk —
  // "OFFLINE" cut in half under its caption. Two things did it. The composition
  // was sized from the OBJECT's height while it paints inside the object's
  // padding, and at the small end the caption's pixel floor is taller than
  // everything available and was drawn anyway.
  const LINES = [
    { caption: true, sub: true },
    { caption: true, sub: false },
    { caption: false, sub: false },
  ];

  test("nothing is ever painted outside the box, at any height", () => {
    for (let box = 6; box <= 400; box += 2) {
      for (const { caption, sub } of LINES) {
        const { captionPx, valuePx, subPx } = fitComposition(box, caption, sub);
        const gap = box * 0.03;
        const used =
          valuePx * 1.05 +
          (captionPx > 0 ? captionPx * 1.1 + gap : 0) +
          (subPx > 0 ? subPx * 1.2 + gap : 0);
        const avail = box - 2 * box * PAD_SCALE;
        assert.ok(
          used <= avail + 0.01,
          `${box}px box, caption=${caption} sub=${sub}: ${used.toFixed(1)}px of content in ${avail.toFixed(1)}px`,
        );
      }
    }
  });

  test("lines are given up in order, and the value is the last to go", () => {
    // A short box drops the sub-line before the caption, and the caption before
    // the value — the value is the line the widget exists for.
    const roomy = fitComposition(200, true, true);
    assert.ok(roomy.captionPx > 0 && roomy.subPx > 0, "a 200px box should hold all three");

    const tight = fitComposition(28, true, true);
    assert.equal(tight.subPx, 0, "the sub-line should be the first to go");
    assert.ok(tight.valuePx > 0, "the value must survive");

    const tiny = fitComposition(12, true, true);
    assert.equal(tiny.captionPx, 0, "the caption should go before the value");
    assert.ok(tiny.valuePx > 0, "the value must survive");
  });

  test("a roomy box is unchanged — this only bites at the small end", () => {
    // The proportions above are the approved composition, and a fix for small
    // widgets that quietly resized every big one would be a worse bug.
    const box = 200;
    const { captionPx, valuePx, subPx } = fitComposition(box, true, true);
    assert.ok(Math.abs(valuePx - box * VALUE_SCALE) < 0.01, `value is ${valuePx}, expected ${box * VALUE_SCALE}`);
    assert.ok(Math.abs(captionPx - box * 0.105) < 0.01);
    assert.ok(Math.abs(subPx - box * 0.115) < 0.01);
  });
});
