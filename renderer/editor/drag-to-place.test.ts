import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { rectForDrop, localiseToParent, defaultDropSize } from "./drag-to-place.js";

// Placement maths, which is where "it works in the middle of the canvas" quietly
// stops being true at the edges and inside containers.

const SIZE = { w: 0.3, h: 0.16 };

describe("a dropped widget lands where you aimed", () => {
  test("centred on the drop point", () => {
    // Anchoring the top-left at the cursor puts the widget below and right of
    // where the operator looked, and every drop needs a corrective nudge.
    const r = rectForDrop({ x: 0.5, y: 0.5 }, SIZE);
    assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 1e-9, "centred on x");
    assert.ok(Math.abs(r.y + r.h / 2 - 0.5) < 1e-9, "centred on y");
  });

  test("keeps the requested size", () => {
    const r = rectForDrop({ x: 0.5, y: 0.5 }, SIZE);
    assert.equal(r.w, 0.3);
    assert.equal(r.h, 0.16);
  });
});

describe("edges", () => {
  test("a drop in the bottom-right corner is nudged fully inside", () => {
    const r = rectForDrop({ x: 0.99, y: 0.99 }, SIZE);
    assert.ok(r.x + r.w <= 1 + 1e-9, `right edge escaped: ${r.x + r.w}`);
    assert.ok(r.y + r.h <= 1 + 1e-9, `bottom edge escaped: ${r.y + r.h}`);
  });

  test("a drop in the top-left corner is nudged fully inside", () => {
    const r = rectForDrop({ x: 0.01, y: 0.01 }, SIZE);
    assert.ok(r.x >= 0 && r.y >= 0);
  });

  test("a drop outside the canvas still produces a usable rect", () => {
    // Pointer maths can overshoot by a pixel at the boundary; the result must
    // still be a rect on the canvas rather than a negative one.
    const r = rectForDrop({ x: 1.4, y: -0.3 }, SIZE);
    assert.ok(r.x >= 0 && r.x + r.w <= 1 + 1e-9);
    assert.ok(r.y >= 0 && r.y + r.h <= 1 + 1e-9);
  });

  test("a widget larger than the canvas is capped, not left negative", () => {
    const r = rectForDrop({ x: 0.5, y: 0.5 }, { w: 1.5, h: 2 });
    assert.equal(r.w, 1);
    assert.equal(r.h, 1);
    assert.equal(r.x, 0);
    assert.equal(r.y, 0);
  });
});

describe("dropping into a container", () => {
  const parent = { x: 0.4, y: 0.3, w: 0.4, h: 0.4 };

  test("the rect is expressed in the container's coordinates", () => {
    // The centre of the container is 0.5 of the way across it, whatever the
    // container's own position on the canvas.
    const abs = rectForDrop({ x: 0.6, y: 0.5 }, { w: 0.1, h: 0.1 });
    const local = localiseToParent(abs, parent);
    assert.ok(Math.abs(local.x + local.w / 2 - 0.5) < 1e-6, `expected centred, got ${local.x}`);
  });

  test("a child never escapes its container", () => {
    const abs = rectForDrop({ x: 0.79, y: 0.69 }, { w: 0.2, h: 0.2 });
    const local = localiseToParent(abs, parent);
    assert.ok(local.x >= 0 && local.x + local.w <= 1 + 1e-9, `x escaped: ${local.x + local.w}`);
    assert.ok(local.y >= 0 && local.y + local.h <= 1 + 1e-9, `y escaped: ${local.y + local.h}`);
  });

  test("a zero-sized container is survived rather than dividing by zero", () => {
    const abs = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
    const local = localiseToParent(abs, { x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual(local, abs);
  });
});

describe("default sizes match the existing add path", () => {
  test("a container starts bigger than a leaf", () => {
    // Two ways in that disagree about the result are worse than one way in.
    const c = defaultDropSize(true);
    const leaf = defaultDropSize(false);
    assert.ok(c.w > leaf.w && c.h > leaf.h);
  });

  test("the leaf default is the toolbar's default", () => {
    // layout-editor's makeObject uses 0.3 x 0.16 for a non-container.
    assert.deepEqual(defaultDropSize(false), { w: 0.3, h: 0.16 });
  });

  test("the container default is the toolbar's default", () => {
    assert.deepEqual(defaultDropSize(true), { w: 0.4, h: 0.32 });
  });
});
