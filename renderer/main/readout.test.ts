import assert from "node:assert/strict";
import { test, describe } from "node:test";

// The LEADINGS and the gap, imported rather than restated. Every "used" sum
// below is the composition's own arithmetic run a second time, and with 1.05,
// 1.1, 1.2 and 0.03 typed out it was a second COPY of it: raise VALUE_LEADING
// and the real `used` grows while the test's stays put, which is a fit check
// that stops checking the fit. (:32-35 would have gone red first, so this was
// one line from being updated in isolation.)
import {
  CAPTION_LEADING,
  CONTENT_SCALE,
  GAP_SCALE,
  PAD_SCALE,
  SUB_LEADING,
  VALUE_FLOOR_SCALE,
  VALUE_LEADING,
  VALUE_SCALE,
  fitComposition,
  valueSizeFor,
} from "./readout-size.js";

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
      Math.abs(CONTENT_SCALE - (VALUE_SCALE * VALUE_LEADING + 0.105 * CAPTION_LEADING + 0.115 * SUB_LEADING + 2 * GAP_SCALE)) < 1e-9,
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
        valueSizeFor(BOX, cap, sub) * VALUE_LEADING +
        (cap > 0 ? cap * CAPTION_LEADING + BOX * GAP_SCALE : 0) +
        (sub > 0 ? sub * SUB_LEADING + BOX * GAP_SCALE : 0);
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
    const used = valueSizeFor(box, cap, sub) * VALUE_LEADING + cap * CAPTION_LEADING + box * GAP_SCALE + 2 * box * PAD_SCALE;
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
    assert.ok(px >= (tiny * VALUE_FLOOR_SCALE) / VALUE_LEADING - 0.01, `value floor not applied: ${px}px`);
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
        const gap = box * GAP_SCALE;
        const used =
          valuePx * VALUE_LEADING +
          (captionPx > 0 ? captionPx * CAPTION_LEADING + gap : 0) +
          (subPx > 0 ? subPx * SUB_LEADING + gap : 0);
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

describe("a uniform grid of tiles", () => {
  // Home is a grid of same-height tiles. Every card there carries a caption and
  // a sub-line except the clock, which has neither — so it took the whole budget
  // and rendered at 52px in a row of 35px values. Henry's note, verbatim: "clock
  // on the homepage widget needs to be smaller to match the other widget text
  // sizing."
  test("a caption-less tile gets the SAME value size as a three-line one", () => {
    const three = fitComposition(BOX, true, true, true);
    const bare = fitComposition(BOX, false, false, true);
    assert.equal(bare.valuePx, three.valuePx);
    assert.equal(bare.captionPx, 0, "it still renders no caption");
    assert.equal(bare.subPx, 0);
  });

  test("and that is SMALLER than the same tile fills its box with", () => {
    // The other half of the property: if uniform did nothing, the test above
    // would pass on a version where nothing changed.
    const filling = fitComposition(BOX, false, false, false);
    const uniform = fitComposition(BOX, false, false, true);
    assert.ok(uniform.valuePx < filling.valuePx, `${uniform.valuePx} !< ${filling.valuePx}`);
  });

  test("off by default, so a wall widget still fills the box it was placed at", () => {
    assert.deepEqual(fitComposition(BOX, false, false), fitComposition(BOX, false, false, false));
    assert.ok(fitComposition(BOX, false, false).valuePx > fitComposition(BOX, true, true).valuePx);
  });

  test("never overflows the box it is given", () => {
    // A uniform value is only ever smaller, but the drop-a-line loop measures
    // what is RENDERED — so assert the invariant directly rather than by
    // reasoning about it.
    for (const box of [8, 12, 20, 28, 40, 54, 120, 200, 480]) {
      for (const [caption, sub] of [[true, true], [true, false], [false, false]] as const) {
        const { captionPx, valuePx, subPx } = fitComposition(box, caption, sub, true);
        const used =
          valuePx * VALUE_LEADING +
          (captionPx > 0 ? captionPx * CAPTION_LEADING + box * GAP_SCALE : 0) +
          (subPx > 0 ? subPx * SUB_LEADING + box * GAP_SCALE : 0);
        assert.ok(used <= box - 2 * box * PAD_SCALE + 0.01, `${box}px box overflowed: ${used}`);
      }
    }
  });
});

// ── The optional rule and footer, and what they may cost ────────────────────
//
// They are OFF by default, so every widget that shipped before them must get
// exactly the composition it got before. When they are on they take their room
// from the VALUE — there is nowhere else, because CONTENT_SCALE was derived for
// the three-line composition and leaves less spare than the footer wants.
//
// TWO DEFECTS THESE EXIST FOR, one in each direction:
//
//   1. Refusing to touch the value. `used` then exceeded `avail` at every size,
//      the drop-a-line loop gave the footer up every time, and the footer
//      rendered at NO box height between 1 and 2000px — while the inspector
//      switch and the Home card toggle both wrote a setting for it.
//   2. Charging the extras to `used` AND subtracting them from the value. The
//      two cancelled exactly, `used` came out invariant to them, the loop never
//      fired, and the value silently absorbed the whole cost — falling below its
//      own sub-line, and to font-size 0 around a 60px box.
//
// Both were green under a "the footer is dropped in order" assertion, which is
// satisfied by a footer that is dropped ALWAYS. The tests below assert it is
// kept as well.

describe("the readout's optional rule and footer", () => {
  const BOTH = { meter: true, footer: true } as const;

  test("change nothing at all when they are off", () => {
    // The whole safety of the addition: fifteen widget types go through this
    // function and none of them asks for an extra.
    for (const box of [12, 28, 54, 120, 200, 480]) {
      for (const [caption, sub] of [[true, true], [true, false], [false, false]] as const) {
        for (const uniform of [false, true]) {
          const plain = fitComposition(box, caption, sub, uniform);
          const explicit = fitComposition(box, caption, sub, uniform, { meter: false, footer: false });
          assert.deepEqual(explicit, plain, `${box}px box drifted with the extras explicitly off`);
        }
      }
    }
  });

  test("ARE ACTUALLY DRAWN, at every size a widget is really placed at", () => {
    // Defect 1, as an assertion. 159 is the short side of the dashboard tile the
    // browser sweep uses; 300 and 640 are wall sizes; 112 is the Home card the
    // composition was approved at.
    for (const box of [112, 159, 200, 300, 480, 640, 1080]) {
      const f = fitComposition(box, true, true, false, BOTH);
      assert.ok(f.footerPx > 0, `${box}px box drew no footer, so "next cue" is a setting nothing renders`);
      assert.ok(f.meterPx > 0, `${box}px box drew no progress rule`);
    }
  });

  test("and the value still outranks every line under it", () => {
    // Defect 2, as an assertion. Whenever an extra is actually drawn, the value
    // is the biggest thing in the composition — that is what makes it the value.
    for (let box = 12; box <= 1200; box += 4) {
      const f = fitComposition(box, true, true, false, BOTH);
      if (f.footerPx === 0 && f.meterPx === 0) continue;
      assert.ok(f.valuePx > 0, `${box}px box rendered the value at font-size 0`);
      assert.ok(
        f.valuePx >= f.subPx,
        `${box}px box: value ${f.valuePx.toFixed(1)} is smaller than its sub-line ${f.subPx.toFixed(1)}`,
      );
      assert.ok(
        f.valuePx >= f.footerPx,
        `${box}px box: value ${f.valuePx.toFixed(1)} is smaller than the footer ${f.footerPx.toFixed(1)}`,
      );
    }
  });

  test("are given up in order: the footer, then the rule, then the sub-line", () => {
    // The footer is a QUALIFIED answer and goes first; the rule restates a
    // number that is already written out; the sub-line qualifies the value.
    let sawFooterDropped = false;
    let sawMeterDropped = false;
    for (let box = 1200; box >= 8; box -= 4) {
      const f = fitComposition(box, true, true, false, BOTH);
      if (f.footerPx === 0) sawFooterDropped = true;
      if (f.meterPx === 0) sawMeterDropped = true;
      assert.ok(!(f.footerPx > 0 && f.meterPx === 0), `${box}px kept the footer and dropped the rule`);
      assert.ok(!(f.meterPx > 0 && f.subPx === 0), `${box}px kept the rule and dropped the sub-line`);
    }
    // Otherwise the loop above is green because nothing was ever dropped — and
    // the test above is what stops it being green because nothing was ever kept.
    assert.ok(sawFooterDropped, "the footer was never dropped at any size, so the order is untested");
    assert.ok(sawMeterDropped, "the rule was never dropped at any size, so the order is untested");
  });

  test("never overflow the box, extras included", () => {
    for (const box of [8, 12, 20, 28, 40, 54, 120, 200, 480]) {
      for (const extras of [{ meter: true }, { footer: true }, BOTH]) {
        const { captionPx, valuePx, subPx, meterPx, footerPx } = fitComposition(box, true, true, false, extras);
        const gap = box * GAP_SCALE;
        const used =
          valuePx * VALUE_LEADING +
          (captionPx > 0 ? captionPx * CAPTION_LEADING + gap : 0) +
          (subPx > 0 ? subPx * SUB_LEADING + gap : 0) +
          (meterPx > 0 ? meterPx + gap : 0) +
          (footerPx > 0 ? footerPx * SUB_LEADING + gap : 0);
        assert.ok(
          used <= box - 2 * box * PAD_SCALE + 0.01,
          `${box}px box overflowed with ${JSON.stringify(extras)}: ${used}`,
        );
      }
    }
  });
});
