// A nested object is drawn where its container is, not twice as far along.
//
// resolveLayout returns VIEWPORT-ABSOLUTE pixels. responsive-layout.test.ts
// asserts exactly that: a child of a container starting at x=0.5 on a 1920
// canvas comes back with left === 960. That is the right answer for a layout
// engine reasoning about anchors and stacking across a whole canvas.
//
// But RenderObject draws children INSIDE the parent's own position:absolute div.
// Applying an absolute 960 there put the child 960px past a box that already
// began at 960 — and because boxStyle sets overflow:hidden, the child did not
// merely shift, it vanished.
//
// fitFor returns "responsive" by DEFAULT for every console surface, so this hit
// every console page, every panel and the editor preview in this release: any
// layout with a container in it.
//
// This drives the REAL resolveLayout and the REAL geometry function the renderer
// applies, so it fails on the actual composition rather than on a restatement of
// it. Asserting only that resolveLayout returns 960 would pass on the bug — the
// existing test does, and did.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { resolveLayout } from "./responsive-layout.js";
import { placedGeometry } from "./layout-renderer.js";

const CANVAS = { width: 1920, height: 1080 };
const VIEWPORT = { w: 1920, h: 1080 };

const obj = (over: Partial<LayoutObject>): LayoutObject =>
  ({
    id: "o", x: 0, y: 0, w: 1, h: 1, z: 0,
    config: { type: "clock" }, style: {},
    ...over,
  }) as LayoutObject;

describe("a nested object's drawn position", () => {
  test("is relative to the container it is drawn inside", () => {
    const parent = obj({
      id: "p", x: 0.5, y: 0.25, w: 0.5, h: 0.5, config: { type: "container" },
      children: [obj({ id: "c", x: 0, y: 0, w: 1, h: 0.5 })],
    });
    const placed = resolveLayout([parent], CANVAS, VIEWPORT);
    const p = placed.find((x) => x.id === "p")!;
    const c = placed.find((x) => x.id === "c")!;

    // The engine's answer is absolute — this is the contract the other test pins.
    assert.equal(c.left, 960, "resolveLayout is viewport-absolute");
    assert.equal(c.top, 270);

    // What the renderer actually writes into the child's style, inside the parent.
    const css = placedGeometry(c, p);
    assert.equal(css.left, "0px", "a child flush with its container's left edge draws at 0");
    assert.equal(css.top, "0px", "and at 0 from its top");
  });

  test("a top-level object still draws at its absolute position", () => {
    // The other half: subtracting an origin must not break the un-nested case,
    // which is every layout without a container.
    const solo = obj({ id: "s", x: 0.25, y: 0.5, w: 0.25, h: 0.25 });
    const [p] = resolveLayout([solo], CANVAS, VIEWPORT);
    const css = placedGeometry(p, null);
    assert.equal(css.left, "480px");
    assert.equal(css.top, "540px");
  });

  test("an offset child keeps its offset WITHIN the container", () => {
    // Not merely "0 works" — a child a quarter into its parent must land a
    // quarter into it, not a quarter into the viewport.
    const parent = obj({
      id: "p", x: 0.5, y: 0, w: 0.5, h: 1, config: { type: "container" },
      children: [obj({ id: "c", x: 0.5, y: 0, w: 0.5, h: 1 })],
    });
    const placed = resolveLayout([parent], CANVAS, VIEWPORT);
    const p = placed.find((x) => x.id === "p")!;
    const c = placed.find((x) => x.id === "c")!;

    assert.equal(c.left, 1440, "absolute: half way into a container that starts at 960");
    assert.equal(placedGeometry(c, p).left, "480px", "drawn: half way into a 960-wide container");
  });

  test("the renderer actually hands each child its container's rect", () => {
    // THE WIRING. Without this the suite passed with origin never passed down:
    // placedGeometry is correct in isolation and every assertion above still
    // held, while every nested object on screen was still double-offset. A guard
    // that passes on the defect it was written for is the failure mode this
    // repo has hit four times.
    //
    // Matches the recursive call's prop, which prose in a comment cannot satisfy.
    const src = readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8");
    assert.match(
      src,
      /<RenderObject[^>]*\borigin=\{placed \?\? origin\}/,
      "RenderObject must pass its own placed rect to its children as their origin, " +
        "or their absolute pixels are applied inside an already-offset box",
    );
  });

  test("size is never adjusted by the origin", () => {
    const parent = obj({
      id: "p", x: 0.5, y: 0, w: 0.5, h: 1, config: { type: "container" },
      children: [obj({ id: "c", x: 0, y: 0, w: 1, h: 1 })],
    });
    const placed = resolveLayout([parent], CANVAS, VIEWPORT);
    const p = placed.find((x) => x.id === "p")!;
    const c = placed.find((x) => x.id === "c")!;
    const css = placedGeometry(c, p);
    assert.equal(css.width, `${c.width}px`);
    assert.equal(css.height, `${c.height}px`);
  });
});
