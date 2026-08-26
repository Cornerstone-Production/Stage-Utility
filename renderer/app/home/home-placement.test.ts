// The grid engine, in coordinates.
//
// Every test here is a thing an operator does to a dashboard: leave a gap, drop
// a widget onto another one, drop into empty space far below. The point of the
// feature is that a gap SURVIVES — so most of these are checking that nothing
// helpfully tidies it away.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import {
  boxesOf,
  clampCol,
  overlaps,
  placeAt,
  pushAway,
  resetPlacement,
  rowsNeeded,
  type Box,
} from "./home-placement.js";

/** A card of a given size, optionally placed by hand. */
const card = (
  id: string,
  size: "s" | "m" | "l" | "xl" | "tall",
  at?: { col: number; row: number },
): LayoutObject =>
  ({
    id,
    x: 0, y: 0, w: 0.5, h: 0.2, z: 1,
    home: { size, ...(at ?? {}) },
    config: { type: "home-spl" },
  }) as LayoutObject;

const at = (boxes: readonly Box[], id: string) => boxes.find((b) => b.id === id)!;

describe("a page nobody has arranged", () => {
  test("flows exactly as the packed grid always did", () => {
    // Three Smalls fill the first row, the fourth starts the second. If this
    // changed, every Home on disk would rearrange itself on upgrade.
    const boxes = boxesOf([card("a", "s"), card("b", "s"), card("c", "s"), card("d", "s")]);
    assert.deepEqual(
      boxes.map((b) => [b.col, b.row]),
      [[1, 1], [2, 1], [3, 1], [1, 2]],
    );
  });

  test("a Large leaves a 1-wide column that two Smalls complete", () => {
    // The tiling the sizes were chosen for, and the reason Small is 1x1.
    const boxes = boxesOf([card("big", "l"), card("a", "s"), card("b", "s")]);
    assert.deepEqual(at(boxes, "big"), { id: "big", col: 1, row: 1, w: 2, h: 2 });
    assert.deepEqual(at(boxes, "a"), { id: "a", col: 3, row: 1, w: 1, h: 1 });
    assert.deepEqual(at(boxes, "b"), { id: "b", col: 3, row: 2, w: 1, h: 1 });
  });
});

describe("a card placed by hand", () => {
  test("sits where it was put, gap and all", () => {
    // THE feature. Row 4 with nothing above it is not a mistake to correct.
    const boxes = boxesOf([card("a", "s", { col: 2, row: 4 })]);
    assert.deepEqual(at(boxes, "a"), { id: "a", col: 2, row: 4, w: 1, h: 1 });
  });

  test("flowing cards route around it rather than through it", () => {
    const boxes = boxesOf([card("flow", "m"), card("pinned", "s", { col: 1, row: 1 })]);
    assert.deepEqual(at(boxes, "pinned"), { id: "pinned", col: 1, row: 1, w: 1, h: 1 });
    // The Medium is 2 wide and cannot start at column 2 of a 3-wide row beside a
    // card at column 1... it can: columns 2 and 3. That is the first fit.
    assert.deepEqual(at(boxes, "flow"), { id: "flow", col: 2, row: 1, w: 2, h: 1 });
  });

  test("a placement wider than the grid is pulled back inside it", () => {
    // Column 3 with a 2-wide card would hang off the edge, and CSS would silently
    // add a fourth column to hold it.
    assert.equal(clampCol(3, 2), 2);
    assert.equal(clampCol(9, 1), 3);
    assert.equal(clampCol(0, 1), 1);
    const boxes = boxesOf([card("wide", "m", { col: 3, row: 1 })]);
    assert.equal(at(boxes, "wide").col, 2);
  });
});

describe("dropping onto something", () => {
  test("what was there is pushed down, not covered", () => {
    const cards = [card("a", "s", { col: 1, row: 1 }), card("b", "s", { col: 1, row: 2 })];
    const boxes = pushAway(boxesOf(cards), { id: "a", col: 1, row: 2, w: 1, h: 1 });
    assert.deepEqual(at(boxes, "a"), { id: "a", col: 1, row: 2, w: 1, h: 1 });
    assert.deepEqual(at(boxes, "b"), { id: "b", col: 1, row: 3, w: 1, h: 1 });
  });

  test("the push cascades through whatever it lands on", () => {
    const cards = [
      card("a", "s", { col: 1, row: 1 }),
      card("b", "s", { col: 1, row: 2 }),
      card("c", "s", { col: 1, row: 3 }),
    ];
    const boxes = pushAway(boxesOf(cards), { id: "a", col: 1, row: 2, w: 1, h: 1 });
    assert.equal(at(boxes, "b").row, 3);
    assert.equal(at(boxes, "c").row, 4, "the third card must move too, or b lands on it");
  });

  test("a card in another column is left alone", () => {
    // A push that moved the whole page would make every drop feel like a shuffle.
    const cards = [card("a", "s", { col: 1, row: 1 }), card("side", "s", { col: 3, row: 2 })];
    const boxes = pushAway(boxesOf(cards), { id: "a", col: 1, row: 2, w: 1, h: 1 });
    assert.deepEqual(at(boxes, "side"), { id: "side", col: 3, row: 2, w: 1, h: 1 });
  });

  test("nothing ends up overlapping anything", () => {
    // The invariant the cascade exists for, asserted directly.
    const cards = [
      card("xl", "xl", { col: 1, row: 1 }),
      card("a", "s", { col: 1, row: 3 }),
      card("b", "m", { col: 2, row: 3 }),
      card("c", "l", { col: 1, row: 4 }),
    ];
    const boxes = pushAway(boxesOf(cards), { id: "a", col: 1, row: 1, w: 1, h: 1 });
    for (const x of boxes) {
      for (const y of boxes) {
        if (x.id === y.id) continue;
        assert.ok(!overlaps(x, y), `${x.id} and ${y.id} overlap after a push`);
      }
    }
  });
});

describe("committing a drop", () => {
  test("every card is written, so the page cannot rearrange behind the drop", () => {
    // With the others left flowing, a card could rise into the gap just vacated
    // and the whole page would move for a drag the operator thought was local.
    const cards = [card("a", "s"), card("b", "s"), card("c", "s")];
    const next = placeAt(cards, "c", 1, 3);
    for (const o of next) {
      assert.equal(typeof o.home?.col, "number", `${o.id} was left flowing`);
      assert.equal(typeof o.home?.row, "number", `${o.id} was left flowing`);
    }
    assert.deepEqual([next[2].home?.col, next[2].home?.row], [1, 3]);
  });

  test("a gap below the last card is a legal home", () => {
    // Dropping into empty space is the whole request: "put space between widgets
    // if I want to".
    const cards = [card("a", "s"), card("b", "s")];
    const next = placeAt(cards, "b", 2, 5);
    assert.deepEqual([next[1].home?.col, next[1].home?.row], [2, 5]);
    // And the other card did not chase it down there.
    assert.deepEqual([next[0].home?.col, next[0].home?.row], [1, 1]);
  });

  test("size and visibility survive a move", () => {
    const cards = [{ ...card("a", "l"), home: { size: "l" as const, when: "live" as const } }];
    const next = placeAt(cards, "a", 2, 2);
    assert.equal(next[0].home?.size, "l");
    assert.equal(next[0].home?.when, "live");
  });

  test("dropping a card that is not on the page changes nothing", () => {
    const cards = [card("a", "s")];
    assert.deepEqual(placeAt(cards, "ghost", 1, 1), cards);
  });
});

describe("going back to a packed page", () => {
  test("reset drops the coordinates and keeps everything else", () => {
    const cards = [{ ...card("a", "m", { col: 3, row: 7 }), home: { size: "m" as const, when: "idle" as const, col: 3, row: 7 } }];
    const next = resetPlacement(cards);
    assert.equal(next[0].home?.col, undefined);
    assert.equal(next[0].home?.row, undefined);
    assert.equal(next[0].home?.size, "m");
    assert.equal(next[0].home?.when, "idle");
    // And it flows again.
    assert.deepEqual(at(boxesOf(next), "a"), { id: "a", col: 1, row: 1, w: 2, h: 1 });
  });
});

describe("the drop area", () => {
  test("reaches past the last card, or there is nowhere to drop a gap into", () => {
    const boxes = boxesOf([card("a", "s", { col: 1, row: 1 }), card("b", "l", { col: 2, row: 3 })]);
    // b ends on row 4, so the page must draw at least a couple of rows beyond it.
    assert.ok(rowsNeeded(boxes) >= 6, `${rowsNeeded(boxes)} rows is not past the last card`);
  });
});
