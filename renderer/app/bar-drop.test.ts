import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dropPoint, droppedOnBar, insertionGap, type Box } from "./bar-drop.js";
import { arrayMove } from "@dnd-kit/sortable";

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
  const KEYS = ["a", "b", "c", "d"];

  test("from the palette, the item lands BEFORE the row you are over", () => {
    assert.equal(insertionGap(KEYS, "palette:clock", "c"), 2);
  });

  test("dropped on the strip itself, it goes on the end", () => {
    assert.equal(insertionGap(KEYS, "palette:clock", "bar"), KEYS.length);
  });

  test("over nothing means nothing is inserted", () => {
    assert.equal(insertionGap(KEYS, "a", null), null);
  });

  test("an unknown row inserts nothing rather than guessing", () => {
    assert.equal(insertionGap(KEYS, "a", "gone"), null);
  });

  // The asymmetry, and the reason this is not just `indexOf(over)`.
  test("moving a row RIGHT lands after the row you are over", () => {
    assert.equal(insertionGap(KEYS, "a", "c"), 3);
  });

  test("moving a row LEFT lands before it", () => {
    assert.equal(insertionGap(KEYS, "d", "b"), 1);
  });

  // THE invariant. The caret is drawn from insertionGap; the drop is arrayMove.
  // They are different code, so a test that only checked insertionGap against
  // hand-written numbers would let them drift and the caret would quietly lie.
  test("the caret marks where arrayMove actually puts the row, every pair", () => {
    for (let from = 0; from < KEYS.length; from++) {
      for (let to = 0; to < KEYS.length; to++) {
        if (from === to) continue;
        const gap = insertionGap(KEYS, KEYS[from], KEYS[to]);
        assert.notEqual(gap, null, `no gap for ${from} -> ${to}`);
        // The caret sits in a gap of the CURRENT list; removing the dragged row
        // shifts every gap after it left by one.
        const landsAt = gap! > from ? gap! - 1 : gap!;
        const moved = arrayMove([...KEYS], from, to);
        assert.equal(
          moved[landsAt],
          KEYS[from],
          `caret at gap ${gap} for ${KEYS[from]} (${from} -> ${to}) but arrayMove put it at ${moved.indexOf(KEYS[from])}`,
        );
      }
    }
  });
});
