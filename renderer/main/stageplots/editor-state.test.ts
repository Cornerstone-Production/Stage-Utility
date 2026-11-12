// The editor's draft: its operations, the undo stack, and the geometry of a
// rotated item. Pure, so every rule here runs without a DOM.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PlotItem } from "@main/types/stageplots";

import { validateItems } from "@main/services/stageplots-store";

import { editorReducer, initialEditorState, isDirty, type EditorAction, type EditorState } from "./editor-state";
import { resizeInFrame, snapRotation } from "./geometry";

const H = 562.5;

function box(over: Partial<PlotItem> = {}): PlotItem {
  return { id: "b", type: "box", x: 100, y: 100, w: 80, h: 60, rotation: 0, label: "", color: null, notes: "", inputs: [], ...over };
}

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

const start = (items: PlotItem[] = [box()]) => initialEditorState(items, H);

describe("editor state", () => {
  test("a drag is one undo step", () => {
    let s = run(start(), { type: "select", id: "b" });
    // Fifty pointermoves, each further from where the drag began.
    for (let i = 1; i <= 50; i++) s = editorReducer(s, { type: "move", id: "b", dx: i, dy: i / 2 });
    s = editorReducer(s, { type: "commitGesture" });
    assert.equal(s.undo.length, 1, `one drag left ${s.undo.length} undo entries`);
    assert.deepEqual([s.items[0].x, s.items[0].y], [150, 125]);
    s = editorReducer(s, { type: "undo" });
    assert.deepEqual([s.items[0].x, s.items[0].y], [100, 100]);
    assert.equal(isDirty(s), false);
  });

  test("a press that does not move adds no undo step", () => {
    const s = run(start(), { type: "select", id: "b" }, { type: "commitGesture" }, { type: "move", id: "b", dx: 0, dy: 0 }, { type: "commitGesture" });
    assert.equal(s.undo.length, 0);
  });

  test("undo twice then redo once restores the middle state", () => {
    let s = run(start(), { type: "nudge", id: "b", dx: 4, dy: 0 }, { type: "nudge", id: "b", dx: 4, dy: 0 });
    assert.equal(s.items[0].x, 108);
    s = run(s, { type: "undo" }, { type: "undo" });
    assert.equal(s.items[0].x, 100);
    s = run(s, { type: "redo" });
    assert.equal(s.items[0].x, 104);
    assert.equal(s.redo.length, 1);
  });

  test("undo puts the selection back with the items", () => {
    let s = run(start(), { type: "select", id: "b" }, { type: "add", kind: "sym:drumkit", at: { x: 500, y: 300 }, id: "dk" });
    assert.equal(s.selectedId, "dk");
    s = run(s, { type: "undo" });
    assert.equal(s.items.length, 1);
    assert.equal(s.selectedId, "b");
  });

  test("a new edit after undo clears redo", () => {
    let s = run(start(), { type: "nudge", id: "b", dx: 4, dy: 0 }, { type: "undo" });
    assert.equal(s.redo.length, 1);
    s = run(s, { type: "patch", id: "b", fields: { label: "Riser" } });
    assert.equal(s.redo.length, 0);
  });

  test("typing in a field is one undo step, committed when it settles", () => {
    let s = start();
    for (const label of ["R", "Ri", "Ris", "Riser"]) s = editorReducer(s, { type: "patch", id: "b", fields: { label }, live: true });
    s = editorReducer(s, { type: "commitGesture" });
    assert.equal(s.undo.length, 1);
    assert.equal(run(s, { type: "undo" }).items[0].label, "");
  });

  test("discard returns to savedItems and empties both stacks", () => {
    let s = run(start(), { type: "nudge", id: "b", dx: 4, dy: 0 }, { type: "nudge", id: "b", dx: 4, dy: 0 }, { type: "undo" });
    assert.equal(isDirty(s), true);
    s = run(s, { type: "discard" });
    assert.deepEqual(s.items, s.savedItems);
    assert.deepEqual([s.undo.length, s.redo.length], [0, 0]);
    assert.equal(isDirty(s), false);
  });

  test("duplicate offsets by 16 units and selects the copy", () => {
    const s = run(start([box({ inputs: ["Kick In"] })]), { type: "duplicate", id: "b", newId: "b2" });
    const copy = s.items.find((i) => i.id === "b2")!;
    assert.deepEqual([copy.x, copy.y], [116, 116]);
    assert.equal(s.selectedId, "b2");
    assert.notEqual(copy.inputs, s.items[0].inputs, "the copy shares its inputs list");
    assert.equal(s.undo.length, 1);
  });

  test("add places the item centred where asked, at its default size, with its default label", () => {
    const s = run(start([]), { type: "add", kind: "sym:drumkit", at: { x: 500, y: 300 }, id: "dk" });
    const dk = s.items[0];
    assert.deepEqual([dk.type, dk.symbol, dk.label, dk.w, dk.h], ["symbol", "drumkit", "Drum kit", 117, 104]);
    assert.deepEqual([dk.x, dk.y], [441.5, 248]);
    const cable = run(start([]), { type: "add", kind: "cable", at: { x: 500, y: 300 }, id: "c" }).items[0];
    assert.deepEqual(cable.points, [[375, 300], [625, 300]]);
  });

  test("rotate snaps to 5 degrees and a cable point moves alone", () => {
    let s = run(start(), { type: "rotate", id: "b", angle: 93 }, { type: "commitGesture" });
    assert.equal(s.items[0].rotation, 95);
    s = run(start([box({ id: "c", type: "cable", points: [[10, 10], [200, 10]], dashed: true, x: 10, y: 10, w: 190, h: 0 })]), {
      type: "movePoint",
      id: "c",
      index: 1,
      point: { x: 200, y: 300 },
    });
    assert.deepEqual(s.items[0].points, [[10, 10], [200, 300]]);
    assert.deepEqual([s.items[0].x, s.items[0].y, s.items[0].w, s.items[0].h], [10, 10, 190, 290]);
  });

  // 562.5 is a 16:9 plot, exact to a tenth; 2000/3 is a 3:2 one, which is not.
  for (const height of [562.5, 2000 / 3]) {
    test(`whatever the gesture, the draft stays something the server accepts (plot ${height.toFixed(1)} high)`, () => {
      let s = initialEditorState([box(), box({ id: "c", type: "cable", points: [[10, 10], [200, 10]], dashed: true, x: 10, y: 10, w: 190, h: 0 })], height);
      s = run(
        s,
        { type: "move", id: "b", dx: -5000, dy: 9000 },
        { type: "commitGesture" },
        // Up to the top edge; its first point then goes to the bottom: a cable the plot's full height.
        { type: "move", id: "c", dx: 5000, dy: -5000 },
        { type: "commitGesture" },
        { type: "patch", id: "b", fields: { rotation: -180, w: 4, h: 5000 } },
        { type: "resize", id: "b", point: { x: 9000, y: 9000 } },
        { type: "commitGesture" },
        { type: "movePoint", id: "c", index: 0, point: { x: -50, y: 99999 } },
        { type: "commitGesture" },
      );
      assert.equal(validateItems(s.items, height), null, JSON.stringify(s.items));
      assert.equal(s.items[0].rotation, 180);
      // The cable runs top to bottom, its point on the bottom edge and its box no taller than the plot.
      assert.ok(s.items[1].points!.every(([, y]) => y <= height), JSON.stringify(s.items[1].points));
      assert.ok(s.items[1].h <= height, `the cable's box is ${s.items[1].h} on a plot ${height} high`);
    });
  }

  test("text kind changes take that kind's size", () => {
    const s = run(start([box({ id: "t", type: "text", textKind: "label", label: "Text", w: 158.3, h: 25 })]), {
      type: "patch",
      id: "t",
      fields: { textKind: "callout" },
    });
    assert.deepEqual([s.items[0].textKind, s.items[0].w, s.items[0].h], ["callout", 23, 23]);
  });

  test("inputs are added at the end and removed by index", () => {
    const s = run(start(), { type: "addInput", id: "b" }, { type: "patch", id: "b", fields: { inputs: ["Kick In"] } }, { type: "addInput", id: "b" }, { type: "removeInput", id: "b", index: 0 });
    assert.deepEqual(s.items[0].inputs, [""]);
  });

  test("remove deletes the item and clears the selection", () => {
    const s = run(start(), { type: "select", id: "b" }, { type: "remove", id: "b" });
    assert.deepEqual([s.items.length, s.selectedId], [0, null]);
  });

  test("only the changed item is a new object: the rest keep their identity", () => {
    const s0 = start([box(), box({ id: "b2" })]);
    const s1 = run(s0, { type: "move", id: "b", dx: 10, dy: 0 });
    assert.notEqual(s1.items[0], s0.items[0]);
    assert.equal(s1.items[1], s0.items[1]);
  });

  test("saved takes the server's items as the new base", () => {
    let s = run(start(), { type: "nudge", id: "b", dx: 4, dy: 0 });
    const sent = s.items;
    s = run(s, { type: "saved", sent, items: sent.map((i) => ({ ...i })) });
    assert.equal(isDirty(s), false);
  });
});

describe("geometry", () => {
  test("resizeInFrame on a 90°-rotated box grows its height when the pointer moves right", () => {
    const it = box({ x: 100, y: 100, w: 80, h: 60, rotation: 90 });
    // Centre (140, 130). Rotated 90°, the box's own height runs across the screen.
    const next = resizeInFrame(it, { x: 140 + 50, y: 130 + 40 });
    assert.equal(next.h, 100);
    assert.equal(next.w, 80);
    assert.deepEqual([next.x + next.w / 2, next.y + next.h / 2], [140, 130], "the centre moved");
  });

  test("resizeInFrame at 45° turns the pointer into the item's own frame, the right way round", () => {
    // Centre (140, 130), pointer 100 right: in a frame turned +45° that is 70.7 along
    // and -70.7 across, so w and h differ only through the turn's sign.
    const next = resizeInFrame(box({ rotation: 45 }), { x: 240, y: 130 });
    assert.deepEqual([next.w, next.h], [141.4, 141.4]);
    const offAxis = resizeInFrame(box({ rotation: 45 }), { x: 240, y: 180 });
    assert.deepEqual([offAxis.w, offAxis.h], [212.1, 70.7]);
  });

  test("resizeInFrame keeps a dimension line's height and the 8-unit minimum", () => {
    const dim = box({ type: "text", textKind: "dimension", w: 200, h: 18.3 });
    assert.equal(resizeInFrame(dim, { x: 400, y: 600 }).h, 18.3);
    const tiny = resizeInFrame(box(), { x: 140, y: 130 });
    assert.deepEqual([tiny.w, tiny.h], [8, 8]);
  });

  test("snapRotation rounds to 5° within (-180, 180]", () => {
    assert.equal(snapRotation(93), 95);
    assert.equal(snapRotation(181), 180);
    assert.equal(snapRotation(183), -175);
    assert.equal(snapRotation(-180), 180);
    assert.equal(snapRotation(-178), 180);
    assert.equal(snapRotation(-177), -175);
  });
});
