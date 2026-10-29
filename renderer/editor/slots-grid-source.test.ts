// After a layout save, a slots widget sent in the shape before boards takes the
// board pointer the server gave it. Every id and name is invented.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { adoptSavedGridPointers } from "./slots-grid-source.js";
import type { LayoutObject } from "../../main/types/stage.js";

describe("after a save, the editor's widgets", () => {
  const obj = (id: string, config: Record<string, unknown>, children?: LayoutObject[]) =>
    ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", ...config }, ...(children ? { children } : {}) }) as unknown as LayoutObject;

  test("take the pointer the server gave one sent as Define here, nested or not", () => {
    const local = [obj("g-1", { source: "inline", boardId: "b-left" }), { ...obj("box", {}), config: { type: "container" }, children: [obj("g-2", { source: "view", sourceViewId: "wall-2" })] } as unknown as LayoutObject];
    const saved = [obj("g-1", { boardId: "b-copy" }), { ...obj("box", {}), config: { type: "container" }, children: [obj("g-2", { boardId: "wall-2" })] } as unknown as LayoutObject];
    const out = adoptSavedGridPointers(local, saved);
    assert.deepEqual(out[0]!.config, { type: "slots-grid", boardId: "b-copy" });
    assert.deepEqual(out[1]!.children![0]!.config, { type: "slots-grid", boardId: "wall-2" });
  });

  test("are left as they are when nothing was sent in the old shape", () => {
    const local = [obj("g-1", { boardId: "b-pad" })];
    assert.equal(adoptSavedGridPointers(local, [obj("g-1", { boardId: "b-other" })]), local);
  });
});
