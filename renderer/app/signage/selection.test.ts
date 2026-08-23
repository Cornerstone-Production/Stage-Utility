// Click, cmd-click, shift-click — the behaviour an operator already knows.
//
// Written against the cases that make range selection go wrong in practice: an
// anchor that has been deleted, a range dragged upward, a shift-click with
// nothing to extend from, and a list that reordered under a live selection.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  EMPTY,
  clickSelect,
  contextTarget,
  modsOf,
  pruneSelection,
  selectAll,
  type Selection,
} from "./selection";

const ORDER = ["a", "b", "c", "d", "e"];
const PLAIN = { meta: false, shift: false };
const META = { meta: true, shift: false };
const SHIFT = { meta: false, shift: true };

const sel = (ids: string[], anchor: string | null = ids[ids.length - 1] ?? null): Selection => ({
  ids,
  anchor,
});

describe("a plain click", () => {
  test("selects one thing and drops everything else", () => {
    assert.deepEqual(clickSelect(sel(["a", "b", "c"]), ORDER, "e", PLAIN), sel(["e"]));
  });

  test("and sets the anchor a later shift-click extends from", () => {
    const after = clickSelect(EMPTY, ORDER, "b", PLAIN);
    assert.equal(after.anchor, "b");
    assert.deepEqual(clickSelect(after, ORDER, "d", SHIFT).ids, ["b", "c", "d"]);
  });
});

describe("cmd-click", () => {
  test("adds one without disturbing the rest", () => {
    assert.deepEqual(clickSelect(sel(["a"]), ORDER, "c", META).ids, ["a", "c"]);
  });

  test("and clicking a selected one takes it out again", () => {
    assert.deepEqual(clickSelect(sel(["a", "c"]), ORDER, "a", META).ids, ["c"]);
  });

  test("moves the anchor, so shift extends from what was just clicked", () => {
    // What every file manager does, and what the hand expects.
    const after = clickSelect(sel(["a"]), ORDER, "c", META);
    assert.deepEqual(clickSelect(after, ORDER, "e", SHIFT).ids, ["c", "d", "e"]);
  });

  test("taking the last one out leaves an empty selection, not a crash", () => {
    assert.deepEqual(clickSelect(sel(["a"]), ORDER, "a", META).ids, []);
  });
});

describe("shift-click", () => {
  test("selects the range between the anchor and the click", () => {
    assert.deepEqual(clickSelect(sel(["b"]), ORDER, "d", SHIFT).ids, ["b", "c", "d"]);
  });

  test("works upward too", () => {
    // The range dragged backwards. slice(lo, hi) with the arguments the wrong
    // way round returns nothing, and the selection silently empties.
    assert.deepEqual(clickSelect(sel(["d"]), ORDER, "b", SHIFT).ids, ["b", "c", "d"]);
  });

  test("keeps the anchor, so extending again redraws rather than crawls", () => {
    // Shift to d, then shift to c: the answer is b-c, not c-d.
    const first = clickSelect(sel(["b"]), ORDER, "d", SHIFT);
    assert.deepEqual(clickSelect(first, ORDER, "c", SHIFT).ids, ["b", "c"]);
  });

  test("with no anchor at all behaves like a plain click", () => {
    // Shift-clicking as the very first action in a fresh list.
    assert.deepEqual(clickSelect(EMPTY, ORDER, "c", SHIFT), sel(["c"]));
  });

  test("with an anchor that has been deleted behaves like a plain click", () => {
    // The anchor names a row that is no longer there — delete one, then shift.
    // Left unhandled this is indexOf === -1, and slice(-1, n) selects the tail.
    assert.deepEqual(clickSelect(sel(["x"], "x"), ORDER, "c", SHIFT), sel(["c"]));
  });

  test("extends over the list AS SHOWN, not some underlying order", () => {
    // Sorted by name, the operator shift-clicks between two things they can see.
    const shown = ["e", "d", "c", "b", "a"];
    assert.deepEqual(clickSelect(sel(["e"]), shown, "c", SHIFT).ids, ["e", "d", "c"]);
  });
});

describe("keeping a selection honest", () => {
  test("pruning drops ids that no longer exist", () => {
    // Without this a "Delete 3" acts on two, and says three.
    assert.deepEqual(pruneSelection(sel(["a", "gone", "c"]), ORDER).ids, ["a", "c"]);
  });

  test("and clears an anchor that went with them", () => {
    assert.equal(pruneSelection(sel(["a"], "gone"), ORDER).anchor, null);
  });

  test("returns the SAME object when nothing changed", () => {
    // So it can be called on every render without causing one.
    const s = sel(["a", "b"]);
    assert.equal(pruneSelection(s, ORDER), s);
  });

  test("select-all takes the list as shown", () => {
    assert.deepEqual(selectAll(["c", "a"]).ids, ["c", "a"]);
  });
});

describe("what a right-click acts on", () => {
  test("inside a selection, the whole selection", () => {
    const s = sel(["a", "b", "c"]);
    assert.equal(contextTarget(s, "b"), s);
  });

  test("outside it, just that one — and it becomes the selection", () => {
    // The alternative is a menu that silently drops a ten-item selection because
    // the pointer was somewhere else, which is how an operator deletes one file
    // believing they deleted ten.
    assert.deepEqual(contextTarget(sel(["a", "b"]), "e"), sel(["e"]));
  });
});

describe("reading the modifiers", () => {
  test("cmd on a Mac and ctrl everywhere else both toggle", () => {
    assert.deepEqual(modsOf({ metaKey: true, ctrlKey: false, shiftKey: false }), { meta: true, shift: false });
    assert.deepEqual(modsOf({ metaKey: false, ctrlKey: true, shiftKey: false }), { meta: true, shift: false });
  });

  test("shift is read on its own", () => {
    assert.deepEqual(modsOf({ metaKey: false, ctrlKey: false, shiftKey: true }), { meta: false, shift: true });
  });
});
