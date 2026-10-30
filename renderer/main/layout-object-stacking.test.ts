// Send to back must put the whole object behind its neighbours.
//
// Objects are layered by the order their boxes are drawn in. A box that does not
// start its own stacking context lets any z-index inside it compete with the
// boxes beside it: a mic-slots grid sent all the way back still drew each slot's
// name band (z-10) over the clock and the item readout in front of it.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { boxStyle } from "./layout-renderer.js";
import type { LayoutObject } from "@main/types/views.js";

test("every object box isolates what it draws", () => {
  // boxStyle is the box of the renderer, the layout editor's canvas and Home's
  // grid alike, so this one property covers all three.
  const grid = { id: "g", x: 0, y: 0, w: 1, h: 1, z: 0, style: {}, config: { type: "slots-grid" } } as unknown as LayoutObject;
  const styled = { ...grid, style: { background: "#111111", cornerRadius: 0.01 } } as LayoutObject;
  assert.equal(boxStyle(grid, 1080).isolation, "isolate");
  assert.equal(boxStyle(styled, 1080).isolation, "isolate");
});
