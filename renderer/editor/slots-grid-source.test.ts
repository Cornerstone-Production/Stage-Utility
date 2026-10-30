// What the old layout editor shows for a slots widget, and when it lets the slot
// editor below the canvas write. A widget on a slots screen's board must never
// read as "Define here": the editor below would rewrite the screen's live wall.
//
// The helper only: the inspector and the editor read it directly. That the
// inspector's selects then show the right thing was checked in a browser (Radix
// Select renders its value through a portal jsdom does not lay out). Every id
// and name is invented.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { adoptSavedGridPointers, slotsGridSource } from "./slots-grid-source.js";
import type { LayoutObject, LayoutObjectConfig, View } from "../../main/types/stage.js";

type Grid = Extract<LayoutObjectConfig, { type: "slots-grid" }>;
const grid = (c: Partial<Grid>): Grid => ({ type: "slots-grid", ...c }) as Grid;
const SCREENS = [
  { id: "wall-1", name: "Left Display", kind: "slots", createdAt: "", boardId: "b-left" },
  // A screen from before boards shows the board its own id names.
  { id: "wall-2", name: "Right Display", kind: "slots", createdAt: "" },
] as unknown as View[];

describe("a slots widget in the old layout editor", () => {
  test("on a screen's board, embeds that screen and edits nothing below the canvas", () => {
    assert.deepEqual(slotsGridSource(grid({ boardId: "b-left" }), SCREENS), { mode: "view", embeds: SCREENS[0], awaitingCopy: false, editsBelow: false });
    assert.equal(slotsGridSource(grid({ boardId: "wall-2" }), SCREENS).embeds?.id, "wall-2");
  });

  test("on a board of its own, is Define here and edits it below the canvas", () => {
    assert.deepEqual(slotsGridSource(grid({ boardId: "b-pad" }), SCREENS), { mode: "inline", embeds: null, awaitingCopy: false, editsBelow: true });
  });

  test("switched to Define here over a screen's board, waits for the save that copies it", () => {
    assert.deepEqual(slotsGridSource(grid({ boardId: "b-left", source: "inline" }), SCREENS), { mode: "inline", embeds: null, awaitingCopy: true, editsBelow: false });
  });

  test("new, or set to embed a view, follows what was picked", () => {
    assert.equal(slotsGridSource(grid({ source: "inline", sourceViewId: null }), SCREENS).editsBelow, true);
    assert.deepEqual(slotsGridSource(grid({ source: "view", sourceViewId: "wall-2", boardId: "b-pad" }), SCREENS), { mode: "view", embeds: SCREENS[1], awaitingCopy: false, editsBelow: false });
    assert.deepEqual(slotsGridSource(grid({ boardId: null }), SCREENS), { mode: "view", embeds: null, awaitingCopy: false, editsBelow: false });
  });
});

describe("after a save, the editor's widgets", () => {
  const obj = (id: string, config: Record<string, unknown>, children?: LayoutObject[]) =>
    ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", ...config }, ...(children ? { children } : {}) }) as unknown as LayoutObject;

  test("take the pointer the server gave one sent as Define here, nested or not", () => {
    const local = [obj("g-1", { source: "inline", boardId: "b-left" }), { ...obj("box", {}), config: { type: "container" }, children: [obj("g-2", { source: "view", sourceViewId: "wall-2" })] } as unknown as LayoutObject];
    const saved = [obj("g-1", { boardId: "b-copy" }), { ...obj("box", {}), config: { type: "container" }, children: [obj("g-2", { boardId: "wall-2" })] } as unknown as LayoutObject];
    const out = adoptSavedGridPointers(local, saved);
    assert.deepEqual(out[0]!.config, { type: "slots-grid", boardId: "b-copy" });
    assert.deepEqual(out[1]!.children![0]!.config, { type: "slots-grid", boardId: "wall-2" });
    assert.equal(slotsGridSource(out[0]!.config as Grid, SCREENS).editsBelow, true);
  });

  test("are left as they are when nothing was sent in the old shape", () => {
    const local = [obj("g-1", { boardId: "b-pad" })];
    assert.equal(adoptSavedGridPointers(local, [obj("g-1", { boardId: "b-other" })]), local);
  });
});
