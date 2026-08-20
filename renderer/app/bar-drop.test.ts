import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dropPoint, droppedOnBar, gapFromMidpoints, type Box } from "./bar-drop.js";

// The bar as it actually is: full width, and only 44px tall.
const BAR: Box = { left: 240, right: 1400, top: 516, bottom: 560 };

/** A mouse drag that began at (x, y) and moved by (dx, dy). */
const mouse = (x: number, y: number, dx: number, dy: number) => ({
  activatorEvent: { clientX: x, clientY: y } as unknown as Event,
  delta: { x: dx, y: dy },
});

describe("where a drag ended", () => {
  test("the pointer is the activator plus the delta", () => {
    assert.deepEqual(dropPoint(mouse(1000, 538, -220, -290)), { x: 780, y: 248 });
  });

  test("a touch drag reads the touch, not clientX", () => {
    // A TouchEvent has no clientX of its own. Reading it gives undefined, and
    // undefined + delta is NaN — which compares false against every bound and
    // deletes whatever was dragged.
    const e = {
      activatorEvent: { touches: [{ clientX: 800, clientY: 530 }] } as unknown as Event,
      delta: { x: 10, y: 4 },
    };
    assert.deepEqual(dropPoint(e), { x: 810, y: 534 });
    assert.equal(droppedOnBar(e, BAR), true);
  });

  test("a touch that has already ended reads changedTouches", () => {
    const e = {
      activatorEvent: { touches: [], changedTouches: [{ clientX: 800, clientY: 530 }] } as unknown as Event,
      delta: { x: 0, y: 0 },
    };
    assert.deepEqual(dropPoint(e), { x: 800, y: 530 });
  });

  test("an event carrying no pointer at all gives nothing", () => {
    assert.equal(dropPoint({ activatorEvent: {} as Event, delta: { x: 5, y: 5 } }), null);
  });
});

describe("whether that counts as on the bar", () => {
  test("released on the bar keeps the item", () => {
    assert.equal(droppedOnBar(mouse(800, 538, 40, 0), BAR), true);
  });

  test("released up in the palette removes it", () => {
    // THE case. Both earlier implementations answered true here: `over` is never
    // null under closestCenter, and the dragged node's own rect never moves
    // while a DragOverlay is up. Dragging an item out did nothing at all, twice.
    assert.equal(droppedOnBar(mouse(1000, 538, -220, -290), BAR), false);
  });

  test("released below the bar removes it too", () => {
    assert.equal(droppedOnBar(mouse(800, 538, 0, 200), BAR), false);
  });

  test("released past either end removes it", () => {
    assert.equal(droppedOnBar(mouse(800, 538, -600, 0), BAR), false);
    assert.equal(droppedOnBar(mouse(800, 538, 700, 0), BAR), false);
  });

  test("a wobble just off the edge still keeps it", () => {
    // The bar is 44px tall. Without the tolerance, aiming at it and landing a
    // few pixels high deletes what you were trying to place.
    assert.equal(droppedOnBar(mouse(800, 538, 0, -30), BAR), true);
    assert.equal(droppedOnBar(mouse(800, 538, 0, 30), BAR), true);
  });

  test("no pointer, or no bar, keeps the item", () => {
    // Nothing to go on. Keeping is recoverable; deleting on a guess is not.
    assert.equal(droppedOnBar({ activatorEvent: {} as Event, delta: { x: 0, y: -400 } }, BAR), true);
    assert.equal(droppedOnBar(mouse(800, 538, 0, -400), null), true);
  });
});

describe("where the caret goes", () => {
  // Four rows, each 100 wide, laid out from x=200: midpoints 250/350/450/550.
  const MIDS = [250, 350, 450, 550];

  test("left of everything is the first gap", () => {
    assert.equal(gapFromMidpoints(MIDS, 205), 0);
  });

  test("right of everything is the last gap", () => {
    assert.equal(gapFromMidpoints(MIDS, 900), MIDS.length);
  });

  test("the LEFT half of a row means before it", () => {
    assert.equal(gapFromMidpoints(MIDS, 320), 1);
  });

  test("the RIGHT half of the same row means after it", () => {
    // THE bug this replaced. An over-based rule saw one row either side of the
    // midpoint and inserted before it both times, so every drop drifted left
    // and a wide item could not be dropped after at all.
    assert.equal(gapFromMidpoints(MIDS, 380), 2);
  });

  test("dead on a midpoint goes before, not after", () => {
    // Arbitrary, but it has to be one of them and it has to be stable — a
    // caret that flickers between two gaps on a pixel is worse than either.
    assert.equal(gapFromMidpoints(MIDS, 350), 1);
  });

  test("an empty bar has exactly one gap", () => {
    assert.equal(gapFromMidpoints([], 400), 0);
  });

  test("every pointer position lands in a gap that exists", () => {
    for (let x = 150; x < 700; x += 7) {
      const g = gapFromMidpoints(MIDS, x);
      assert.ok(g >= 0 && g <= MIDS.length, `x=${x} gave gap ${g}`);
    }
  });

  test("the gap only ever grows as the pointer moves right", () => {
    // Monotonic, so dragging one way never walks the caret backwards.
    let prev = -1;
    for (let x = 150; x < 700; x += 3) {
      const g = gapFromMidpoints(MIDS, x);
      assert.ok(g >= prev, `gap went backwards at x=${x}`);
      prev = g;
    }
  });
});
