import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveLayout, shouldStack } from "./responsive-layout.js";

// The model that replaces `fill`. Every mechanism is optional and off by
// default, so the FIRST test is the one that matters most: with nothing set,
// this must be exactly proportional — otherwise every existing layout moves on
// upgrade, which is a regression whatever it does at other sizes.

const CANVAS = { width: 1920, height: 1080 };
const DESIGN: { w: number; h: number } = { w: 1920, h: 1080 };

const obj = (over: Record<string, unknown> = {}): LayoutObject =>
  ({ id: "o", x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 0, config: { type: "text" }, ...over }) as unknown as LayoutObject;

describe("the default is a no-op", () => {
  test("with no anchors it is exactly proportional", () => {
    const [p] = resolveLayout([obj()], CANVAS, DESIGN);
    assert.deepEqual(
      [p.left, p.top, p.width, p.height],
      [192, 108, 384, 216],
      "an object with no responsive settings must land exactly where fractions put it",
    );
  });

  test("and stays proportional at a different size", () => {
    const [p] = resolveLayout([obj()], CANVAS, { w: 960, h: 540 });
    assert.deepEqual([p.left, p.top, p.width, p.height], [96, 54, 192, 108]);
  });
});

describe("anchors", () => {
  test("pinned right keeps its distance from the right edge", () => {
    // Designed with its right edge 0.1 of the way in: 192px at design width.
    const o = obj({ x: 0.7, w: 0.2, anchor: { x: "right" } });
    const [p] = resolveLayout([o], CANVAS, { w: 1200, h: 1080 });
    assert.equal(Math.round(1200 - (p.left + p.width)), 192);
  });

  test("pinned bottom keeps its distance from the bottom edge", () => {
    const o = obj({ y: 0.7, h: 0.2, anchor: { y: "bottom" } });
    const [p] = resolveLayout([o], CANVAS, { w: 1920, h: 700 });
    assert.equal(Math.round(700 - (p.top + p.height)), 108);
  });

  test("centred stays centred", () => {
    const o = obj({ x: 0.4, w: 0.2, anchor: { x: "center" } });
    const [p] = resolveLayout([o], CANVAS, { w: 3000, h: 1080 });
    assert.equal(Math.round(p.left + p.width / 2), 1500);
  });
});

describe("keepAspect", () => {
  test("a square stays square on a very wide window", () => {
    // 0.2 x 0.356 of a 16:9 canvas is square in real terms.
    // 2400x1080 is wide but within the stacking threshold — this test is about
    // aspect preservation, not stacking, and 3840x1080 would stack.
    const o = obj({ w: 0.2, h: 0.3556, keepAspect: true });
    const [p] = resolveLayout([o], CANVAS, { w: 2400, h: 1080 });
    assert.ok(Math.abs(p.width - p.height) < 2, `expected square, got ${p.width} x ${p.height}`);
  });

  test("without it, the same object stretches", () => {
    // The contrast is the point: this is what fill did to everything.
    const o = obj({ w: 0.2, h: 0.3556 });
    const [p] = resolveLayout([o], CANVAS, { w: 2400, h: 1080 });
    assert.ok(p.width > p.height * 1.2, `expected a stretched box, got ${p.width} x ${p.height}`);
  });
});

describe("size clamps", () => {
  test("a minimum stops a control shrinking below tappable", () => {
    const o = obj({ w: 0.1, minPx: { w: 44 } });
    const [p] = resolveLayout([o], CANVAS, { w: 320, h: 800 });
    assert.ok(p.width >= 44, `expected at least 44px, got ${p.width}`);
  });

  test("a maximum stops it ballooning on a wall", () => {
    const o = obj({ w: 0.3, maxPx: { w: 400 } });
    const [p] = resolveLayout([o], CANVAS, { w: 3840, h: 2160 });
    assert.ok(p.width <= 400);
  });
});

describe("stacking", () => {
  const a = obj({ id: "a", x: 0.05, y: 0.1, w: 0.4, h: 0.3 });
  const b = obj({ id: "b", x: 0.55, y: 0.1, w: 0.4, h: 0.3 });

  test("a phone-shaped window stacks into a column", () => {
    const placed = resolveLayout([a, b], CANVAS, { w: 390, h: 844 });
    assert.equal(placed[0].left, placed[1].left, "stacked objects share a left edge");
    assert.ok(placed[1].top >= placed[0].top + placed[0].height, "and do not overlap");
  });

  test("an ultra-wide window stacks too", () => {
    // Deviation is symmetric: far wider is as different as far taller.
    assert.equal(shouldStack(CANVAS, { w: 3840, h: 600 }), true);
  });

  test("a near-design viewport does NOT stack", () => {
    // Triggering on a slightly narrow laptop would rearrange a layout the
    // operator just built, which is worse than a little squashing.
    const placed = resolveLayout([a, b], CANVAS, { w: 1600, h: 1000 });
    assert.notEqual(placed[0].left, placed[1].left);
  });

  test("stacking order is READING order, not z order", () => {
    // z is paint order. A background panel with a high z must not jump to the
    // top of the column just because it is drawn last.
    const top = obj({ id: "top", x: 0.5, y: 0.05, z: 9 });
    const bottom = obj({ id: "bottom", x: 0.0, y: 0.6, z: 1 });
    const placed = resolveLayout([bottom, top], CANVAS, { w: 390, h: 844 });
    assert.deepEqual(placed.map((p) => p.id), ["top", "bottom"]);
  });

  test("a stacked container still holds its children", () => {
    const parent = obj({
      id: "p", x: 0, y: 0, w: 1, h: 0.5, config: { type: "container" },
      children: [obj({ id: "c", x: 0, y: 0, w: 0.5, h: 1 })],
    });
    const placed = resolveLayout([parent], CANVAS, { w: 390, h: 844 });
    const p = placed.find((x) => x.id === "p")!;
    const c = placed.find((x) => x.id === "c")!;
    assert.ok(c.left >= p.left && c.top >= p.top, "a child must stay inside its parent when stacked");
  });
});

describe("nesting", () => {
  test("a child is placed within its container, not the viewport", () => {
    const parent = obj({
      id: "p", x: 0.5, y: 0, w: 0.5, h: 1, config: { type: "container" },
      children: [obj({ id: "c", x: 0, y: 0, w: 1, h: 0.5 })],
    });
    const placed = resolveLayout([parent], CANVAS, DESIGN);
    const c = placed.find((x) => x.id === "c")!;
    assert.equal(c.left, 960, "the child starts at its container's left edge");
    assert.equal(c.width, 960, "and is a fraction of the container, not the window");
  });

  test("anchors apply within the container too", () => {
    const parent = obj({
      id: "p", x: 0, y: 0, w: 0.5, h: 1, config: { type: "container" },
      children: [obj({ id: "c", x: 0.7, y: 0, w: 0.2, h: 0.5, anchor: { x: "right" } })],
    });
    const placed = resolveLayout([parent], CANVAS, DESIGN);
    const p = placed.find((x) => x.id === "p")!;
    const c = placed.find((x) => x.id === "c")!;
    // 0.1 of the container's width from its right edge.
    assert.equal(Math.round(p.left + p.width - (c.left + c.width)), Math.round(0.1 * p.width));
  });
});
