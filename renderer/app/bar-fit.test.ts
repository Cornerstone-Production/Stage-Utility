// The fit ladder's arithmetic.
//
// WHAT THIS CAN AND CANNOT PROVE. `chooseFitLevel` is the whole decision — which
// rung a strip lands on, and how many times it has to measure to get there — and
// it is pure, so all of it is tested here against a table. The MEASURING is a
// browser fact: `scrollWidth` is 0 in jsdom, there is no layout, and a test that
// asserted a pixel here would be asserting jsdom's opinion of the app's CSS.
//
// So the widths in this file are invented. What was measured in a real browser
// at 320 / 360 / 390 / 430 / 640 / 768 / 1440px, in both themes, is written down
// in docs/features/context-bar.md, and the one thing that cannot be checked
// anywhere but a browser — that the rendered strip is one row, does not scroll
// and cuts no number — is checked there by hand.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { BAR_FIT_FLOOR, chooseFitLevel } from "./bar-fit.js";

/**
 * A strip whose content is `widths[level]` wide, in a box of `box`.
 *
 * Counts its own calls, because the call count is a REQUIREMENT and not an
 * implementation detail: every measurement forces a synchronous layout, and this
 * runs on every render of a bar carrying a clock that ticks once a second.
 */
function strip(widths: readonly number[], box: number) {
  let calls = 0;
  return {
    fitsAt: (lv: number) => {
      calls++;
      return widths[Math.min(lv, widths.length - 1)]! <= box + 0.5;
    },
    get calls() {
      return calls;
    },
  };
}

/** Each rung only ever removes, so content never grows going down the ladder. */
const LADDER = [900, 714, 483, 300] as const;

describe("choosing a rung", () => {
  test("a bar with room stays at full length", () => {
    const s = strip(LADDER, 1200);
    assert.equal(chooseFitLevel(0, s.fitsAt), 0);
  });

  test("and measures exactly once to decide that", () => {
    // The common case, and the one that runs a thousand times a service. Walking
    // 0,1,2,3 unconditionally would force four layouts a second on a bar whose
    // width has not changed since it mounted.
    const s = strip(LADDER, 1200);
    chooseFitLevel(0, s.fitsAt);
    assert.equal(s.calls, 1);
  });

  test("it stops at the FIRST rung that fits, not the last", () => {
    // 714 fits in 800, so the qualifiers go and nothing else does. Falling
    // through to level 2 would take the words for no reason.
    assert.equal(chooseFitLevel(0, strip(LADDER, 800).fitsAt), 1);
    assert.equal(chooseFitLevel(0, strip(LADDER, 500).fitsAt), 2);
    assert.equal(chooseFitLevel(0, strip(LADDER, 310).fitsAt), 3);
  });

  test("a bar that got its room back climbs all the way up again", () => {
    // Sitting at the floor in a box that now fits everything. Without the climb
    // a window dragged wider would stay compact until something else forced a
    // re-fit, and the bar would look broken in the state it is in most often.
    assert.equal(chooseFitLevel(BAR_FIT_FLOOR, strip(LADDER, 1200).fitsAt), 0);
  });

  test("and climbs only as far as still fits", () => {
    assert.equal(chooseFitLevel(BAR_FIT_FLOOR, strip(LADDER, 800).fitsAt), 1);
  });

  test("THE GUARD: it bottoms out on the floor rather than running off the end", () => {
    // A bar too long for the screen even with everything given up. It must
    // return a real rung — the floor, where prose ellipsises — not a level past
    // the end of the ladder, which would write `data-fit="4"`, match no CSS rule,
    // and silently put the strip back to full length at its narrowest.
    const s = strip([900, 714, 483, 460], 300);
    assert.equal(chooseFitLevel(0, s.fitsAt), BAR_FIT_FLOOR);
  });

  test("a level from outside the ladder is clamped, not trusted", () => {
    // Nothing should hand it one. If something does — a stale ref, a hand-edited
    // attribute — it must not index past the ladder.
    assert.equal(chooseFitLevel(-5, strip(LADDER, 1200).fitsAt), 0);
    assert.equal(chooseFitLevel(99, strip(LADDER, 1200).fitsAt), 0);
  });

  test("THE GUARD: the answer does not depend on where it started", () => {
    // The monotone rungs are what rule out oscillation, and this is the property
    // that says so: an adaptive layout that answered differently on the way down
    // than on the way up would flip between two rungs at one width, forever.
    for (const box of [1200, 900, 800, 714, 500, 483, 350, 300, 299]) {
      const answers = [0, 1, 2, 3].map((from) => chooseFitLevel(from, strip(LADDER, box).fitsAt));
      assert.equal(
        new Set(answers).size,
        1,
        `at ${box}px the rung depends on the previous one: ${answers.join(",")}`,
      );
    }
  });

  test("an exactly-full strip fits, so rounding alone never costs a rung", () => {
    // scrollWidth is an integer and clientWidth is not, so a strip that fits to
    // the pixel can read a hair over. The half-pixel tolerance lives in the
    // measurer, but the boundary is asserted here: 900 in 900 is a fit.
    assert.equal(chooseFitLevel(0, strip(LADDER, 900).fitsAt), 0);
    assert.equal(chooseFitLevel(0, strip(LADDER, 899).fitsAt), 1);
  });
});
