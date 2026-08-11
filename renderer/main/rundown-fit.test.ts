// The rundown's width fit, as pure arithmetic.
//
// The defect this guards is not "the table overflows" — that one is visible. It
// is the opposite: a fit that keeps shrinking a table which already fits. The
// first draft applied the undershoot unconditionally, so a table measuring
// exactly its box still asked for 0.995 of itself, every render, for ever. On
// screen that reads as "the text is a bit small", which nobody files a bug about.
//
// So the properties asserted here are convergence and monotonicity, not one
// happy-path number.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { nextFitScale } from "./rundown-table";

/** Run the fit to a fixed point the way React does — feed each result back in.
 *  `naturalW` is the content width at scale 1; width tracks the font linearly,
 *  which is the same assumption the real hook back-derives from. */
function converge(availW: number, naturalW: number, maxSteps = 50) {
  let scale = 1;
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const next = nextFitScale({ availW, scrollW: Math.max(availW, naturalW * scale), scale });
    if (next === scale) break;
    scale = next;
  }
  return { scale, steps, fits: naturalW * scale <= availW + 1 };
}

describe("nextFitScale", () => {
  it("leaves a table that already fits completely alone", () => {
    // The whole point: the standalone ScriptView page must render as it always
    // has. Any drift here is a silent restyle of a live stage display.
    assert.equal(nextFitScale({ availW: 1920, scrollW: 1920, scale: 1 }), 1);
    assert.equal(nextFitScale({ availW: 1920, scrollW: 1200, scale: 1 }), 1);
  });

  it("does not ratchet: re-applying it to a fitting table is a fixed point", () => {
    // Delete the `scrollW <= availW + 1` exit, or apply FIT_UNDERSHOOT
    // unconditionally, and this walks downward for ever instead of standing still.
    let scale = 1;
    for (let i = 0; i < 25; i++) scale = nextFitScale({ availW: 1920, scrollW: 1920, scale });
    assert.equal(scale, 1, "a fitting table must never be shrunk");
  });

  it("shrinks an overflowing table until it fits, and then stops", () => {
    // 13 columns at the old 0.03 default: ~2176px of content in a 1920px box.
    const { scale, fits, steps } = converge(1920, 2176);
    assert.ok(fits, "must converge to fitting");
    assert.ok(scale < 1, "must actually have shrunk");
    assert.ok(steps <= 6, `should settle quickly, took ${steps}`);
  });

  it("converges from the far worse settings-preview geometry", () => {
    // The narrower preview pane hid 633px where the page hid 256px.
    const { fits, scale } = converge(1460, 2093);
    assert.ok(fits);
    assert.ok(scale < 0.8, "a 30% overflow needs a real reduction");
  });

  it("never returns a scale above 1 or below the floor", () => {
    for (const [availW, naturalW] of [[1920, 2176], [1460, 2093], [900, 4000], [1280, 1300], [320, 9000]]) {
      const { scale } = converge(availW, naturalW);
      assert.ok(scale <= 1, `scale ${scale} exceeded 1`);
      assert.ok(scale >= 0.55, `scale ${scale} went below the readable floor`);
    }
  });

  it("stops at the floor rather than shrinking to nothing, leaving a scrollbar", () => {
    // Deliberate: past a point, scrolling is more honest than type nobody can
    // read. The alternative — clamping content away — hides a department's cues.
    const { scale, fits } = converge(900, 9000);
    assert.equal(scale, 0.55);
    assert.equal(fits, false, "the floor case is expected NOT to fit; that is the trade");
  });

  it("is monotonically non-increasing, whatever it is fed", () => {
    // The property that makes termination provable: it can only descend or stop,
    // so it cannot oscillate between two scales and re-render for ever.
    let scale = 1;
    for (const scrollW of [2400, 2100, 1950, 1930, 1921, 1920, 1800, 2400]) {
      const next = nextFitScale({ availW: 1920, scrollW, scale });
      assert.ok(next <= scale, `scale grew from ${scale} to ${next}`);
      scale = next;
    }
  });

  it("ignores a box that has not been laid out yet", () => {
    // A zero-width box means "no measurement", not "shrink to the floor".
    assert.equal(nextFitScale({ availW: 0, scrollW: 5000, scale: 1 }), 1);
    assert.equal(nextFitScale({ availW: 1, scrollW: 5000, scale: 0.8 }), 0.8);
  });
});
