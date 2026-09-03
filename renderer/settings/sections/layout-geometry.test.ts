import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GRID,
  HANDLES,
  MIN,
  applyResize,
  clamp,
  gridUnits,
  handleCursor,
  snapRectToGrid,
  snapTo,
} from "./layout-geometry.js";

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const near = (a: number, b: number, msg?: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, msg ?? `expected ${a} ≈ ${b}`);

// ── clamp ──────────────────────────────────────────────────────────────────

test("clamp holds a value inside its bounds", () => {
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
});

// ── The grid ───────────────────────────────────────────────────────────────

test("the grid is square in pixels, not in fractions", () => {
  // The whole point: on a 16:9 box a y-step must be 16/9 larger in fraction
  // terms to cover the same number of pixels as an x-step.
  const { xUnit, yUnit } = gridUnits(1920, 1080);
  near(xUnit, 1 / GRID);
  near(yUnit, (1920 / 1080) / GRID);
  near(yUnit / xUnit, 1920 / 1080, "the ratio is the box aspect");
});

test("a square box gives equal steps", () => {
  const { xUnit, yUnit } = gridUnits(1000, 1000);
  near(xUnit, yUnit);
});

test("a zero-height box falls back rather than dividing by zero", () => {
  // Happens on first paint, before the canvas has been measured.
  const { xUnit, yUnit } = gridUnits(1920, 0);
  assert.ok(Number.isFinite(yUnit), "must not be Infinity or NaN");
  near(yUnit, xUnit);
});

test("snapTo lands on the nearest multiple, including backwards", () => {
  near(snapTo(0.26, 0.25), 0.25);
  near(snapTo(0.24, 0.25), 0.25);
  near(snapTo(-0.24, 0.25), -0.25);
  near(snapTo(0, 0.25), 0);
});

// ── Snapping, including nested objects ─────────────────────────────────────

test("a top-level rect snaps onto the grid", () => {
  const { xUnit } = gridUnits(1000, 1000);
  const out = snapRectToGrid({ x: xUnit * 3.4, y: xUnit * 2.6, w: 0.5, h: 0.5 }, FULL, 1000, 1000, false);
  near(out.x, xUnit * 3);
  near(out.y, xUnit * 3);
  assert.equal(out.w, 0.5, "size untouched when size=false");
});

test("a nested rect snaps to the same visible lines as a top-level one", () => {
  // The reason snapping composes to absolute space first. A container at x=0.5
  // means a child's local x=0 is absolute x=0.5 — snapping locally would put it
  // on a grid the user cannot see.
  const parent = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
  const { xUnit } = gridUnits(1000, 1000);
  const out = snapRectToGrid({ x: 0.013, y: 0.013, w: 0.4, h: 0.4 }, parent, 1000, 1000, false);
  const absX = parent.x + out.x * parent.w;
  near(absX / xUnit, Math.round(absX / xUnit), "the ABSOLUTE position is on the grid");
});

test("snapping with size never collapses an object to nothing", () => {
  const out = snapRectToGrid({ x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 }, FULL, 1000, 1000, true);
  const { xUnit, yUnit } = gridUnits(1000, 1000);
  assert.ok(out.w >= xUnit - 1e-9, `width ${out.w} should be at least one cell`);
  assert.ok(out.h >= yUnit - 1e-9, `height ${out.h} should be at least one cell`);
});

// ── Resizing ───────────────────────────────────────────────────────────────

const START = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

test("dragging a corner moves only its own edges", () => {
  const out = applyResize(START, "se", 0.1, 0.1);
  near(out.x, 0.4, "left edge stays");
  near(out.y, 0.4, "top edge stays");
  near(out.w, 0.3);
  near(out.h, 0.3);
});

test("dragging a top-left corner moves the origin and the size together", () => {
  const out = applyResize(START, "nw", -0.1, -0.1);
  near(out.x, 0.3);
  near(out.y, 0.3);
  near(out.w, 0.3, "growing left makes it wider, not narrower");
  near(out.h, 0.3);
});

test("an edge handle moves one axis only", () => {
  const e = applyResize(START, "e", 0.1, 0.1);
  near(e.h, 0.2, "vertical untouched by an east drag");
  const s = applyResize(START, "s", 0.1, 0.1);
  near(s.w, 0.2, "horizontal untouched by a south drag");
});

test("nothing shrinks below the minimum", () => {
  const out = applyResize(START, "se", -1, -1);
  near(out.w, MIN);
  near(out.h, MIN);
});

test("shrinking from the top-left pins the far edge instead of sliding", () => {
  // The subtle one. Drag the NW handle past the object's own size: without the
  // pin, x keeps following the pointer and the object drifts across the canvas
  // while staying MIN wide.
  const out = applyResize(START, "nw", 1, 1);
  near(out.w, MIN);
  near(out.h, MIN);
  near(out.x, START.x + START.w - MIN, "right edge stayed put");
  near(out.y, START.y + START.h - MIN, "bottom edge stayed put");
});

test("an object cannot be dragged off any edge of the canvas", () => {
  for (const [h, dx, dy] of [
    ["nw", -5, -5],
    ["se", 5, 5],
    ["ne", 5, -5],
    ["sw", -5, 5],
  ] as const) {
    const out = applyResize(START, h, dx, dy);
    assert.ok(out.x >= -1e-9, `${h}: x ${out.x} < 0`);
    assert.ok(out.y >= -1e-9, `${h}: y ${out.y} < 0`);
    assert.ok(out.x + out.w <= 1 + 1e-9, `${h}: right edge ${out.x + out.w} > 1`);
    assert.ok(out.y + out.h <= 1 + 1e-9, `${h}: bottom edge ${out.y + out.h} > 1`);
  }
});

test("a zero drag changes nothing, from every handle", () => {
  // Guards against drift: a click without movement must not nudge the object.
  for (const h of HANDLES) {
    const out = applyResize(START, h, 0, 0);
    near(out.x, START.x, `${h} moved x`);
    near(out.y, START.y, `${h} moved y`);
    near(out.w, START.w, `${h} changed w`);
    near(out.h, START.h, `${h} changed h`);
  }
});

test("every handle has a cursor, and opposite corners share one", () => {
  for (const h of HANDLES) assert.match(handleCursor(h), /-resize$/, `${h} has no cursor`);
  assert.equal(handleCursor("nw"), handleCursor("se"));
  assert.equal(handleCursor("ne"), handleCursor("sw"));
  assert.equal(handleCursor("n"), "ns-resize");
  assert.equal(handleCursor("e"), "ew-resize");
});

// ── Resizing snaps the edge you are dragging, and only that edge ────────────
//
// Reported: "when resizing a widget, particularly one of the sides, it will
// automatically resize the opposite side… I can usually never get it right
// without changing the dimensions in the right side panel."
//
// The cause is that snapping treated x, y, w and h as four independent numbers.
// applyResize correctly holds the opposite edge still, and then snapping rounded
// x as well — so dragging the EAST handle moved the WEST edge, by however far the
// object happened to sit off the grid. Which is exactly the case you are in when
// you are trying to match another widget's size by eye.

test("dragging the east handle leaves the west edge exactly where it was", () => {
  const { xUnit } = gridUnits(1000, 1000);
  // Deliberately off-grid: x sits a third of a cell past a line, which is how an
  // imported or freely-placed object arrives.
  const offGrid = xUnit / 3;
  const out = snapRectToGrid({ x: offGrid, y: 0.2, w: 0.4, h: 0.3 }, FULL, 1000, 1000, "e");
  near(out.x, offGrid, "the west edge moved while dragging the east handle");
  near(out.x + out.w, snapTo(offGrid + 0.4, xUnit), "the east edge did not land on the grid");
});

test("dragging the west handle leaves the east edge exactly where it was", () => {
  const { xUnit } = gridUnits(1000, 1000);
  const start = { x: xUnit / 3, y: 0.2, w: 0.4, h: 0.3 };
  const right = start.x + start.w;
  const out = snapRectToGrid(start, FULL, 1000, 1000, "w");
  near(out.x + out.w, right, "the east edge moved while dragging the west handle");
  near(out.x, snapTo(start.x, xUnit), "the west edge did not land on the grid");
});

test("dragging the south handle leaves the top edge exactly where it was", () => {
  const { yUnit } = gridUnits(1000, 1000);
  const start = { x: 0.2, y: yUnit / 3, w: 0.3, h: 0.4 };
  const out = snapRectToGrid(start, FULL, 1000, 1000, "s");
  near(out.y, start.y, "the top edge moved while dragging the south handle");
  near(out.y + out.h, snapTo(start.y + start.h, yUnit), "the bottom edge did not land on the grid");
});

test("a corner snaps both of its own edges and neither of the others", () => {
  const { xUnit, yUnit } = gridUnits(1000, 1000);
  const start = { x: xUnit / 3, y: yUnit / 3, w: 0.4, h: 0.4 };
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  const out = snapRectToGrid(start, FULL, 1000, 1000, "nw");
  near(out.x, snapTo(start.x, xUnit), "the west edge did not snap");
  near(out.y, snapTo(start.y, yUnit), "the north edge did not snap");
  near(out.x + out.w, right, "the east edge moved while dragging a north-west corner");
  near(out.y + out.h, bottom, "the south edge moved while dragging a north-west corner");
});

test("the whole-rect snap still moves everything — that is a different action", () => {
  // "Snap all" and "Snap to grid" DO put the whole object on the grid. Only a
  // drag of one handle is required to leave the other edges alone.
  const { xUnit } = gridUnits(1000, 1000);
  const out = snapRectToGrid({ x: xUnit / 3, y: xUnit / 3, w: 0.4, h: 0.4 }, FULL, 1000, 1000, true);
  near(out.x, 0, "a whole-rect snap must still move x");
  near(out.w, snapTo(0.4, xUnit), "a whole-rect snap must still round w");
});

test("a resized edge never collapses past one cell", () => {
  const { xUnit } = gridUnits(1000, 1000);
  const out = snapRectToGrid({ x: 0.5, y: 0.5, w: 0.00001, h: 0.2 }, FULL, 1000, 1000, "e");
  assert.ok(out.w >= xUnit - 1e-9, `width collapsed to ${out.w}`);
});
