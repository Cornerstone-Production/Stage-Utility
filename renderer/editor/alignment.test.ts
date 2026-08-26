import assert from "node:assert/strict";
import { MIN } from "../settings/sections/layout-geometry.js";
import { test, describe } from "node:test";

import { alignRect } from "./alignment.js";
import type { FracRect } from "../main/layout-tree";

// Snapping is the kind of code that is right in the demo and wrong in the corner
// cases: an object that creeps while it grows, a pull that is twice as strong on
// one axis, a "helpful" jump when nothing was near. Each of those is a test here.

const BOX = { w: 1920, h: 1080 };
const TOL = 8;

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("edge and centre snapping", () => {
  test("a left edge within tolerance snaps to a sibling's left edge", () => {
    const sib = rect(0.2, 0.1, 0.2, 0.2);
    const moving = rect(0.2 + 3 / BOX.w, 0.5, 0.2, 0.2);
    const { rect: r, guides } = alignRect(moving, [sib], BOX, TOL, null);
    assert.equal(r.x, 0.2);
    assert.ok(guides.some((g) => g.axis === "x" && g.kind === "edge"));
  });

  test("a right edge snaps to a sibling's right edge", () => {
    const sib = rect(0.2, 0.1, 0.2, 0.2); // right edge 0.4
    const moving = rect(0.2 + 2 / BOX.w, 0.5, 0.2, 0.2); // right edge ~0.4
    const { rect: r } = alignRect(moving, [sib], BOX, TOL, null);
    assert.ok(Math.abs(r.x + r.w - 0.4) < 1e-9);
  });

  test("centres snap to centres", () => {
    const sib = rect(0.4, 0.1, 0.2, 0.2); // centre 0.5
    const moving = rect(0.35 + 2 / BOX.w, 0.6, 0.3, 0.2); // centre ~0.5
    const { rect: r } = alignRect(moving, [sib], BOX, TOL, null);
    assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 1e-9);
  });

  test("the canvas edges and middle are snap targets with no siblings at all", () => {
    const moving = rect(2 / BOX.w, 0.4, 0.2, 0.2);
    const { rect: r } = alignRect(moving, [], BOX, TOL, null);
    assert.equal(r.x, 0, "snapped to the canvas's left edge");
  });

  test("beyond tolerance nothing moves and no guide is drawn", () => {
    // Deliberately clear of 0.5 on both axes: the canvas MIDDLE is a snap target,
    // so a fixture sitting on it reports a guide and looks like a bug in the code
    // when it is a bug in the fixture.
    const sib = rect(0.2, 0.1, 0.2, 0.2);
    const moving = rect(0.45, 0.62, 0.2, 0.2);
    const { rect: r, guides } = alignRect(moving, [sib], BOX, TOL, null);
    assert.deepEqual(r, moving, "an object far from anything must not jump");
    assert.equal(guides.length, 0);
  });

  test("an edge beats a centre when both are the same distance away", () => {
    // A left edge 3px from a sibling's left edge is also 3px from that sibling's
    // centre. Which one wins used to depend on floating-point noise.
    const sib = rect(0.2, 0.62, 0.2, 0.2);
    const moving = rect(0.2 + 3 / BOX.w, 0.2, 0.2, 0.2);
    const { rect: r, guides } = alignRect(moving, [sib], BOX, TOL, null);
    assert.equal(r.x, 0.2, "snapped to the edge, exactly");
    assert.equal(guides.find((g) => g.axis === "x")!.kind, "edge");
  });

  test("the pull is measured in pixels, so it is symmetric on both axes", () => {
    // THE bug this guards: a single fraction tolerance is ~1.8x stronger
    // vertically on a 16:9 canvas, and the object feels magnetised to one axis.
    // 6px is inside 8px on both axes; the fraction 6/1920 is not inside 8/1080.
    const sib = rect(0.5, 0.5, 0.1, 0.1);
    const nearX = rect(0.5 + 6 / BOX.w, 0.2, 0.1, 0.1);
    const nearY = rect(0.2, 0.5 + 6 / BOX.h, 0.1, 0.1);
    assert.equal(alignRect(nearX, [sib], BOX, TOL, null).rect.x, 0.5, "x snapped at 6px");
    assert.equal(alignRect(nearY, [sib], BOX, TOL, null).rect.y, 0.5, "y snapped at 6px");
  });

  test("a zero-sized box snaps nothing rather than dividing by zero", () => {
    const { rect: r, guides } = alignRect(rect(0.5, 0.5, 0.1, 0.1), [rect(0.5, 0.5, 0.1, 0.1)], { w: 0, h: 0 }, TOL, null);
    assert.deepEqual(r, rect(0.5, 0.5, 0.1, 0.1));
    assert.equal(guides.length, 0);
  });
});

describe("resizing", () => {
  test("resizing east snaps the right edge and never moves the left one", () => {
    // THE bug this guards: snapping the whole rect during a resize drags the
    // anchored edge along, so the object creeps sideways instead of growing.
    const sib = rect(0.6, 0.1, 0.2, 0.2);
    const moving = rect(0.2, 0.1, 0.4 + 3 / BOX.w, 0.2); // right edge ~0.6
    const { rect: r } = alignRect(moving, [sib], BOX, TOL, "e");
    assert.equal(r.x, 0.2, "the anchored left edge must not move");
    assert.ok(Math.abs(r.x + r.w - 0.6) < 1e-9, "the dragged right edge snapped");
  });

  test("resizing west snaps the left edge and never moves the right one", () => {
    const sib = rect(0.2, 0.1, 0.2, 0.2); // left edge 0.2
    const moving = rect(0.2 + 3 / BOX.w, 0.1, 0.4, 0.2); // right edge ~0.6
    const right = moving.x + moving.w;
    const { rect: r } = alignRect(moving, [sib], BOX, TOL, "w");
    assert.equal(r.x, 0.2, "the dragged left edge snapped");
    assert.ok(Math.abs(r.x + r.w - right) < 1e-9, "the anchored right edge must not move");
  });

  test("resizing east does not snap the vertical axis at all", () => {
    // "e" moves no horizontal edge of the y axis. Snapping y here would move an
    // object the operator is only widening.
    const sib = rect(0.6, 0.5, 0.2, 0.2);
    const moving = rect(0.2, 0.5 + 3 / BOX.h, 0.4, 0.2);
    const { rect: r } = alignRect(moving, [sib], BOX, TOL, "e");
    assert.equal(r.y, 0.5 + 3 / BOX.h, "y untouched while resizing east");
  });

  test("a corner handle snaps both of its own edges", () => {
    const sib = rect(0.6, 0.6, 0.2, 0.2);
    const moving = rect(0.2, 0.2, 0.4 + 2 / BOX.w, 0.4 + 2 / BOX.h);
    const { rect: r } = alignRect(moving, [sib], BOX, TOL, "se");
    assert.ok(Math.abs(r.x + r.w - 0.6) < 1e-9);
    assert.ok(Math.abs(r.y + r.h - 0.6) < 1e-9);
    assert.equal(r.x, 0.2);
    assert.equal(r.y, 0.2);
  });

  test("no equal-gap snapping while resizing", () => {
    const a = rect(0.1, 0.1, 0.1, 0.1);
    const b = rect(0.3, 0.1, 0.1, 0.1);
    const moving = rect(0.5 + 2 / BOX.w, 0.1, 0.1, 0.1);
    const { guides } = alignRect(moving, [a, b], BOX, TOL, "s");
    assert.ok(!guides.some((g) => g.kind === "gap"), "gap snapping is a move gesture");
  });
});

describe("equal gaps", () => {
  test("a third object lands on the rhythm the first two set", () => {
    // The row is offset from the canvas centre on purpose: at x 0.5 the canvas's
    // own middle line snaps first and there is no gap left to detect.
    const a = rect(0.08, 0.1, 0.1, 0.1);
    const b = rect(0.28, 0.1, 0.1, 0.1); // gap 0.1
    const moving = rect(0.48 + 2 / BOX.w, 0.1, 0.1, 0.1);
    const { rect: r, guides } = alignRect(moving, [a, b], BOX, TOL, null);
    assert.ok(Math.abs(r.x - 0.48) < 1e-6, `expected 0.48, got ${r.x}`);
    assert.ok(guides.some((g) => g.kind === "gap"));
  });

  test("a row with no consistent rhythm offers nothing", () => {
    // 0.1 then 0.3: there is no gap to extend, and guessing one would move the
    // object somewhere the operator did not ask for.
    const a = rect(0.0, 0.1, 0.1, 0.1);
    const b = rect(0.2, 0.1, 0.1, 0.1);
    const c = rect(0.6, 0.1, 0.1, 0.1);
    const moving = rect(0.82, 0.1, 0.1, 0.1);
    const { guides } = alignRect(moving, [a, b, c], BOX, TOL, null);
    assert.ok(!guides.some((g) => g.kind === "gap"));
  });

  test("objects in a different row do not set the rhythm", () => {
    // Arithmetically these are evenly spaced; on screen they are nowhere near
    // the object being dragged.
    //
    // Offset from 0.5 deliberately. The first version of this test put the third
    // position exactly on the canvas's middle line, so the centre snap claimed
    // the axis before the gap check ran — and the test passed with the row filter
    // deleted. It was green for a reason that had nothing to do with what it
    // claimed to prove.
    const a = rect(0.08, 0.8, 0.1, 0.1);
    const b = rect(0.28, 0.8, 0.1, 0.1);
    const moving = rect(0.48 + 2 / BOX.w, 0.1, 0.1, 0.1);
    const { guides } = alignRect(moving, [a, b], BOX, TOL, null);
    assert.ok(!guides.some((g) => g.kind === "gap"));
  });

  test("gaps can be turned off without turning off edge snapping", () => {
    const a = rect(0.1, 0.1, 0.1, 0.1);
    const b = rect(0.3, 0.1, 0.1, 0.1);
    const moving = rect(0.5 + 2 / BOX.w, 0.1, 0.1, 0.1);
    const { rect: r, guides } = alignRect(moving, [a, b], BOX, TOL, null, { gaps: false });
    assert.ok(!guides.some((g) => g.kind === "gap"));
    assert.ok(Math.abs(r.y - 0.1) < 1e-9, "the y edge snap still applies");
  });

  test("an edge snap wins over an equal gap on the same axis", () => {
    // Both are available; the edge is the more specific intent.
    const a = rect(0.1, 0.1, 0.1, 0.1);
    const b = rect(0.3, 0.1, 0.1, 0.1);
    const moving = rect(0.3 + 1 / BOX.w, 0.4, 0.1, 0.1);
    const { rect: r, guides } = alignRect(moving, [a, b], BOX, TOL, null);
    assert.equal(r.x, 0.3);
    assert.ok(guides.some((g) => g.axis === "x" && g.kind === "edge"));
    assert.ok(!guides.some((g) => g.axis === "x" && g.kind === "gap"));
  });
});

describe("guides", () => {
  test("a guide spans the objects it relates, not the whole canvas", () => {
    const sib = rect(0.2, 0.1, 0.2, 0.2); // y 0.1..0.3
    const moving = rect(0.2 + 2 / BOX.w, 0.6, 0.2, 0.2); // y 0.6..0.8
    const { guides } = alignRect(moving, [sib], BOX, TOL, null);
    const g = guides.find((x) => x.axis === "x")!;
    assert.ok(g, "expected an x guide");
    assert.ok(Math.abs(g.span.from - 0.1) < 1e-6, `span starts at the sibling's top, got ${g.span.from}`);
    assert.ok(Math.abs(g.span.to - 0.8) < 1e-6, `span ends at the moving object's bottom, got ${g.span.to}`);
  });
});

describe("a snap can never collapse the object", () => {
  // applyResize clamps to MIN and snapRectToGrid to one grid unit, but alignRect
  // runs AFTER both and rebuilds the rect from the anchored edge with raw
  // arithmetic. Running the shipped function produced w = 0 and w = -0.0015625.
  //
  // Reachable whenever the rendered width is under the 8px tolerance: a
  // grid-minimum leaf inside a container about a third of a ~700px canvas is
  // 7.3px, and the editor draws exactly that. `width: -0.15%` is invalid, the box
  // collapses with no grab area left to undo it with, and the bad geometry is
  // saved into the view.

  const box = { w: 700, h: 400 };

  test("dragging the leading edge past the trailing one stops at MIN", () => {
    // A sibling edge sitting beyond this object's far edge is the snap target
    // that inverted it.
    const moving: FracRect = { x: 0.5, y: 0.1, w: 0.02, h: 0.2 };
    const siblings: FracRect[] = [{ x: 0.9, y: 0.1, w: 0.05, h: 0.2 }];
    const { rect } = alignRect(moving, siblings, box, 64, "w");
    assert.ok(rect.w >= MIN - 1e-9, `width collapsed to ${rect.w}`);
    assert.ok(rect.w > 0, "width must never be zero or negative");
  });

  test("dragging the trailing edge back past the leading one stops at MIN", () => {
    const moving: FracRect = { x: 0.5, y: 0.1, w: 0.02, h: 0.2 };
    const siblings: FracRect[] = [{ x: 0.1, y: 0.1, w: 0.05, h: 0.2 }];
    const { rect } = alignRect(moving, siblings, box, 64, "e");
    assert.ok(rect.w >= MIN - 1e-9, `width collapsed to ${rect.w}`);
    assert.ok(rect.w > 0, "width must never be zero or negative");
  });

  // That the clamp has not blunted snapping is covered by the nineteen tests
  // above, which assert exact snap positions and all still pass. A fourth
  // hand-made fixture here would only restate them.
});
