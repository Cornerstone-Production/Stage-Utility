// The arrangement model, as functions: what each drop, key and switch does to a
// set of boards. A board is written below as columns of slot ids, "|" between
// columns and "+" between a column's cards, with "~" naming a spacer:
//
//   "a | b+c | ~s | d"   four columns; b and c share one; s is a spacer.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  append,
  applyDrop,
  insertAfter,
  itemsOf,
  moveToGap,
  nudge,
  removeSlot,
  slotCount,
  slotsOf,
  stackIntoPrevious,
  stackOnto,
  stackState,
  toggleStacked,
  unstack,
  type Boards,
} from "./board-model";

function slot(id: string, over: Partial<Slot> = {}): Slot {
  return {
    id,
    channel: "",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [] },
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
    ...over,
  } as Slot;
}

/** "a | b+c | ~s" to a slot list. */
function board(spec: string): Slot[] {
  const slots: Slot[] = [];
  for (const col of spec.split("|").map((c) => c.trim()).filter(Boolean)) {
    col.split("+").forEach((raw, i) => {
      const id = raw.trim();
      const spacer = id.startsWith("~");
      slots.push(
        slot(spacer ? id.slice(1) : id, {
          order: slots.length,
          ...(spacer ? { link: { kind: "spacer" }, widthIn: 2 } : {}),
          ...(i > 0 ? { stackWithPrevious: true } : {}),
        } as Partial<Slot>),
      );
    });
  }
  return slots;
}

/** A slot list back to the spec string, so an assertion reads like the setup. */
function spec(slots: Slot[]): string {
  return itemsOf(slots)
    .map((col) => col.map((s) => (s.link.kind === "spacer" ? `~${s.id}` : s.id)).join("+"))
    .join(" | ");
}

const one = (s: string): Boards => ({ L: board(s) });
const two = (l: string, r: string): Boards => ({ L: board(l), R: board(r) });
const specs = (b: Boards) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, spec(v)]));

describe("dropping in a gap", () => {
  test("a card becomes its own column there", () => {
    const next = moveToGap(one("a | b | c"), { kind: "slot", id: "c" }, { boardId: "L", index: 1 });
    assert.equal(spec(next.L!), "a | c | b");
  });

  test("a card dragged out of a stack unstacks", () => {
    const next = moveToGap(one("a | b+c"), { kind: "slot", id: "c" }, { boardId: "L", index: 0 });
    assert.equal(spec(next.L!), "c | a | b");
    // Not just drawn apart: the saved flag is gone, or the kiosk would stack it again.
    assert.equal(next.L!.find((s) => s.id === "c")!.stackWithPrevious, undefined);
  });

  test("a gap AFTER the dragged column means where it looks, not where it was counted", () => {
    // Gap 2 is between b and c as drawn. Taking a out first would shift it by one;
    // the marker keeps it where the operator pointed.
    const next = moveToGap(one("a | b | c"), { kind: "column", id: "a" }, { boardId: "L", index: 2 });
    assert.equal(spec(next.L!), "b | a | c");
  });

  test("a whole column moves with its stack", () => {
    const next = moveToGap(one("a | b+c | d"), { kind: "column", id: "b" }, { boardId: "L", index: 3 });
    assert.equal(spec(next.L!), "a | d | b+c");
  });

  test("a spacer moves like a column", () => {
    const next = moveToGap(one("a | ~s | b"), { kind: "column", id: "s" }, { boardId: "L", index: 0 });
    assert.equal(spec(next.L!), "~s | a | b");
  });

  test("across boards: out of one, into the other", () => {
    const next = moveToGap(two("a | b", "x | y"), { kind: "slot", id: "b" }, { boardId: "R", index: 1 });
    assert.deepEqual(specs(next), { L: "a", R: "x | b | y" });
  });

  test("across boards: a whole column", () => {
    const next = moveToGap(two("a | b+c", "x"), { kind: "column", id: "b" }, { boardId: "R", index: 1 });
    assert.deepEqual(specs(next), { L: "a", R: "x | b+c" });
  });

  test("dropped back where it was, nothing changed and nothing is reported as changed", () => {
    const boards = one("a | b | c");
    assert.ok(moveToGap(boards, { kind: "column", id: "b" }, { boardId: "L", index: 1 }) === boards, "gap before itself");
    assert.ok(moveToGap(boards, { kind: "column", id: "b" }, { boardId: "L", index: 2 }) === boards, "gap after itself");
  });

  test("a board the move did not touch keeps its list", () => {
    const boards = two("a | b", "x");
    const next = moveToGap(boards, { kind: "slot", id: "b" }, { boardId: "L", index: 0 });
    assert.ok(next.R === boards.R, "R was not touched, so the page must not call it unsaved");
    assert.equal(spec(next.L!), "b | a");
  });

  test("an unknown board or card does nothing", () => {
    const boards = one("a | b");
    assert.ok(moveToGap(boards, { kind: "slot", id: "a" }, { boardId: "nope", index: 0 }) === boards);
    assert.ok(moveToGap(boards, { kind: "slot", id: "zzz" }, { boardId: "L", index: 0 }) === boards);
  });
});

describe("dropping on a card's lower half", () => {
  test("stacks below it, in its column", () => {
    const next = stackOnto(one("a | b | c"), { kind: "slot", id: "c" }, "a");
    assert.equal(spec(next.L!), "a+c | b");
  });

  test("below THAT card, not at the bottom of the stack", () => {
    const next = stackOnto(one("a+b | c"), { kind: "slot", id: "c" }, "a");
    assert.equal(spec(next.L!), "a+c+b");
  });

  test("a card from inside another stack leaves it", () => {
    const next = stackOnto(one("a+b | c"), { kind: "slot", id: "b" }, "c");
    assert.equal(spec(next.L!), "a | c+b");
  });

  test("a whole column dropped on a card joins the two stacks", () => {
    const next = stackOnto(one("a+b | c+d"), { kind: "column", id: "c" }, "a");
    assert.equal(spec(next.L!), "a+c+d+b");
  });

  test("across boards", () => {
    const next = stackOnto(two("a | b", "x | y"), { kind: "slot", id: "b" }, "x");
    assert.deepEqual(specs(next), { L: "a", R: "x+b | y" });
  });

  test("a spacer never stacks", () => {
    const boards = one("a | ~s | b");
    assert.ok(stackOnto(boards, { kind: "column", id: "s" }, "a") === boards, "a spacer dropped on a card");
    assert.ok(stackOnto(boards, { kind: "slot", id: "s" }, "a") === boards, "a spacer dragged as a card");
  });

  test("nothing stacks onto a spacer", () => {
    const boards = one("a | ~s");
    assert.ok(stackOnto(boards, { kind: "slot", id: "a" }, "s") === boards);
  });

  test("a card on itself, or a column on its own card, does nothing", () => {
    const boards = one("a+b | c");
    assert.ok(stackOnto(boards, { kind: "slot", id: "a" }, "a") === boards, "a card on itself");
    assert.ok(stackOnto(boards, { kind: "column", id: "a" }, "b") === boards, "a column on its own card");
  });

  test("the stack is written back as flags the kiosk reads", () => {
    const next = stackOnto(one("a | b"), { kind: "slot", id: "b" }, "a");
    assert.deepEqual(
      next.L!.map((s) => [s.id, s.order, s.stackWithPrevious ?? false]),
      [["a", 0, false], ["b", 1, true]],
    );
  });
});

describe("stacking and unstacking", () => {
  test("unstack: a card in a stack becomes a column just after it", () => {
    assert.equal(spec(unstack(one("a+b+c | d"), "b").L!), "a+c | b | d");
  });

  test("unstack: a column's lead has nothing to leave", () => {
    const boards = one("a+b | c");
    assert.ok(unstack(boards, "a") === boards);
  });

  test("stack into previous: the lead joins the column on its left", () => {
    assert.equal(spec(stackIntoPrevious(one("a | b | c"), "b").L!), "a+b | c");
  });

  test("stack into previous skips spacers", () => {
    assert.equal(spec(stackIntoPrevious(one("a | ~s | b"), "b").L!), "a+b | ~s");
  });

  test("stack into previous: the first column has no left", () => {
    const boards = one("a | b");
    assert.ok(stackIntoPrevious(boards, "a") === boards);
    assert.equal(stackState(boards, "a").canStack, false);
  });

  test("stack into previous: a spacer never stacks", () => {
    const boards = one("a | ~s");
    assert.ok(stackIntoPrevious(boards, "s") === boards);
    assert.equal(stackState(boards, "s").canStack, false);
  });

  test("stack into previous: the card's own followers keep a column of their own", () => {
    assert.equal(spec(stackIntoPrevious(one("a | b+c"), "b").L!), "a+b | c");
  });

  test("the inspector's switch is stack when it can and unstack when it is", () => {
    assert.equal(spec(toggleStacked(one("a | b"), "b").L!), "a+b");
    assert.equal(spec(toggleStacked(one("a+b"), "b").L!), "a | b");
    assert.deepEqual(stackState(one("a+b"), "b"), { stacked: true, canStack: true });
    assert.deepEqual(stackState(one("a | b"), "b"), { stacked: false, canStack: true });
  });
});

describe("removing, duplicating and adding", () => {
  test("remove: a card, and an emptied column goes with it", () => {
    assert.equal(spec(removeSlot(one("a | b+c"), "c").L!), "a | b");
    assert.equal(spec(removeSlot(one("a | b | c"), "b").L!), "a | c");
  });

  test("remove: a spacer", () => {
    assert.equal(spec(removeSlot(one("a | ~s | b"), "s").L!), "a | b");
  });

  test("remove: orders are renumbered", () => {
    assert.deepEqual(removeSlot(one("a | b | c"), "a").L!.map((s) => s.order), [0, 1]);
  });

  test("duplicate: the copy is a column of its own after the original's column", () => {
    assert.equal(spec(insertAfter(one("a+b | c"), "a", slot("a2")).L!), "a+b | a2 | c");
  });

  test("append: a new column at the end", () => {
    assert.equal(spec(append(one("a"), "L", slot("z")).L!), "a | z");
  });

  test("the slot count leaves spacers out", () => {
    assert.equal(slotCount(board("a | ~s | b+c")), 3);
  });
});

describe("arrow keys", () => {
  test("left and right move a column past its neighbour", () => {
    assert.equal(spec(nudge(one("a | b | c"), "b", "right").L!), "a | c | b");
    assert.equal(spec(nudge(one("a | b | c"), "b", "left").L!), "b | a | c");
  });

  test("left and right move a column past a spacer too", () => {
    assert.equal(spec(nudge(one("a | ~s | b"), "a", "right").L!), "~s | a | b");
  });

  test("the first and last column stay put", () => {
    const boards = one("a | b");
    assert.ok(nudge(boards, "a", "left") === boards);
    assert.ok(nudge(boards, "b", "right") === boards);
  });

  test("a card inside a stack leaves it, to the side the arrow points", () => {
    assert.equal(spec(nudge(one("a+b | c"), "b", "right").L!), "a | b | c");
    assert.equal(spec(nudge(one("a+b | c"), "b", "left").L!), "b | a | c");
    assert.equal(spec(nudge(one("a+b+c"), "b", "right").L!), "a+c | b");
  });

  test("up and down reorder inside a stack, and a column of one stays put", () => {
    assert.equal(spec(nudge(one("a+b+c"), "b", "up").L!), "b+a+c");
    assert.equal(spec(nudge(one("a+b+c"), "b", "down").L!), "a+c+b");
    const alone = one("a | b");
    assert.ok(nudge(alone, "a", "down") === alone);
    const stack = one("a+b");
    assert.ok(nudge(stack, "a", "up") === stack, "the top card cannot go up");
  });
});

describe("applyDrop", () => {
  test("routes a gap to a move and a card to a stack", () => {
    assert.equal(spec(applyDrop(one("a | b | c"), { kind: "slot", id: "c" }, { kind: "gap", boardId: "L", index: 0 }).L!), "c | a | b");
    assert.equal(spec(applyDrop(one("a | b | c"), { kind: "slot", id: "c" }, { kind: "stack", targetId: "a" }).L!), "a+c | b");
  });

  test("slotsOf round-trips a layout", () => {
    const b = board("a | b+c | ~s | d");
    assert.deepEqual(slotsOf(itemsOf(b)).map((s) => [s.id, s.stackWithPrevious ?? false]), b.map((s) => [s.id, s.stackWithPrevious ?? false]));
  });
});
