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
const { defaultSizeFor, nestedGeometry } = await import("./drag-to-place.js");
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

test("inside a container, the composer and Messages arrive at their size, held inside it; every other type is placed as before", () => {
  const parent = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const messages = nestedGeometry("messages", parent);
  // 0.3 of the canvas across a container 0.8 wide is 0.375 of the container, 0.8 of it tall; centred.
  assert.ok(Math.abs(messages.w - 0.3 / 0.8) < 1e-9 && Math.abs(messages.h - 0.8 / 0.8) < 1e-9, JSON.stringify(messages));
  const composer = nestedGeometry("message-composer", parent);
  assert.ok(Math.abs(composer.w - 0.34 / 0.8) < 1e-9, `the composer was not given its width: ${composer.w}`);
  assert.equal(composer.h, 1, "taller than the container is held to it");
  for (const g of [messages, composer]) {
    assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.w <= 1 + 1e-9 && g.y + g.h <= 1 + 1e-9, `${JSON.stringify(g)} falls out of the container`);
    assert.ok(Math.abs(g.x + g.w / 2 - 0.5) < 1e-9, "not centred across the container");
  }
  for (const type of Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[]) {
    if (LAYOUT_OBJECTS[type].defaultSize) continue;
    const expected = type === "container" ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : { x: 0.1, y: 0.3, w: 0.8, h: 0.4 };
    assert.deepEqual(nestedGeometry(type, parent), expected, `${type} moved inside a container`);
    assert.deepEqual(nestedGeometry(type, { x: 0, y: 0, w: 0.2, h: 0.2 }), expected, `${type} depends on the container's size`);
  }
});
