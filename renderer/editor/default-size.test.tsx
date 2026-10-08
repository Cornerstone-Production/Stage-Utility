// The size a widget arrives at: its own, when it has one, and the editor's one
// default for every other type. Not driven through a browser here (jsdom has no
// canvas to place on); the placement the editor really makes is makeObject's, and
// the drop is defaultSizeFor, so both are read.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
const { cleanup } = await import("@testing-library/react");
const { makeObject } = await import("./layout-editor.js");
const { defaultSizeFor } = await import("./drag-to-place.js");
const { LAYOUT_OBJECTS } = await import("../main/layout-objects.js");

after(() => unmountAndTeardown(cleanup, teardown));

const place = (type: LayoutObjectType) => {
  const o = makeObject(type, 1);
  return { x: o.x, y: o.y, w: o.w, h: o.h };
};

test("the composer and the Messages widget arrive at their own sizes, centred", () => {
  for (const [type, size] of [
    ["message-composer", { w: 0.34, h: 0.9 }],
    ["messages", { w: 0.3, h: 0.8 }],
  ] as const) {
    const at = place(type);
    assert.deepEqual([at.w, at.h], [size.w, size.h], `${type} arrived at ${at.w} x ${at.h}`);
    assert.ok(Math.abs(at.x - (1 - size.w) / 2) < 1e-9 && Math.abs(at.y - (1 - size.h) / 2) < 1e-9, `${type} is not centred`);
    assert.ok(at.x >= 0 && at.y >= 0 && at.x + at.w <= 1 && at.y + at.h <= 1, `${type} falls off the canvas`);
    assert.deepEqual(defaultSizeFor(type), size, `${type} is dropped at a different size than it is added at`);
  }
});

test("every other type arrives exactly where it always did", () => {
  const own = new Set(
    Object.entries(LAYOUT_OBJECTS)
      .filter(([, spec]) => spec.defaultSize)
      .map(([t]) => t),
  );
  // The sorted list of types that chose their own size: adding to it is a decision.
  assert.deepEqual([...own].sort(), [
    "message-composer",
    "messages",
  ]);
  for (const type of Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[]) {
    if (own.has(type)) continue;
    const expected = type === "container" ? { x: 0.3, y: 0.32, w: 0.4, h: 0.32 } : { x: 0.35, y: 0.42, w: 0.3, h: 0.16 };
    const at = place(type);
    for (const k of ["x", "y", "w", "h"] as const) {
      assert.ok(Math.abs(at[k] - expected[k]) < 1e-9, `${type} moved: ${k} is ${at[k]}, was ${expected[k]}`);
    }
  }
});
