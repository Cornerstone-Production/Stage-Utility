import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

import { PREVIEW_SHAPES } from "./preview-shape.js";
import { shouldStack } from "../main/responsive-layout.js";

// The claim this file defends is NOT "the preview looks right". It is that the
// preview and the display are the same code, so they cannot drift apart.
//
// A value-comparison test would not defend it: it would pass on the day someone
// reimplements placement inside the preview and gets the same answer for the two
// viewports the test happens to check. So the assertion is structural — the
// preview mounts LayoutRenderer and nothing else — plus the behavioural checks
// that a preview must satisfy whatever it renders.

const SRC = readFileSync(new URL("./preview-shape.tsx", import.meta.url), "utf8");

describe("the preview is the kiosk's renderer, not a copy of it", () => {
  test("it mounts LayoutRenderer", () => {
    assert.match(SRC, /<LayoutRenderer\b/, "the preview must render the real component");
  });

  test("it does not place objects itself", () => {
    // resolveLayout belongs to LayoutRenderer. If it appears here, someone has
    // started computing placements in the preview, and the two can now disagree.
    assert.ok(
      !/\bresolveLayout\s*\(/.test(SRC),
      "the preview must not compute placements: that is LayoutRenderer's job",
    );
  });

  test("the preview is never interactive", () => {
    // A live control in a preview means looking at the editor can fire an action.
    assert.match(SRC, /interactive=\{false\}/, "interactive must be hard-coded false");
    assert.ok(
      !/interactive=\{(?!false\})/.test(SRC),
      "interactive must not be passed through from a prop",
    );
  });

  test("the viewport is given in real CSS pixels, and scaled by transform only", () => {
    // LayoutRenderer measures itself with clientWidth/clientHeight, which a CSS
    // transform does not affect. Sizing the box by the SCALED numbers instead
    // would hand it a viewport of 130x281 and stack a phone preview for the
    // wrong reason.
    assert.match(SRC, /width:\s*vp\.w,\s*\n\s*height:\s*vp\.h,/, "inner box is the true viewport");
    assert.match(SRC, /transform:\s*`scale\(\$\{scale\}\)`/, "scaled visually, not by resizing");
  });
});

describe("the caption describes the LAYOUT, not just the viewport", () => {
  // The bug this guards shipped as far as a browser: the caption read
  // "stacked into one column" over a preview that was plainly letterboxed,
  // because it asked shouldStack (a fact about the viewport) instead of asking
  // whether this layout reflows at all. A wall screen keeps its shape everywhere.
  test("stacking is gated on the layout being responsive", () => {
    assert.match(
      SRC,
      /const\s+stacks\s*=\s*responsive\s*&&\s*shouldStack\(/,
      "stacks must require responsive, not shouldStack alone",
    );
  });

  test("the responsive decision comes from fitFor, the one place that decides it", () => {
    assert.match(SRC, /fitFor\(\{\s*surface\s*\}\s*,\s*layout\.canvas\.fit\s*\)/);
  });

  test("a letterboxed layout gets its own wording", () => {
    assert.match(SRC, /letterboxed:/, "say what it actually does, rather than nothing");
  });
});

describe("the shapes offered", () => {
  test("Design is first and is the only editable one", () => {
    assert.equal(PREVIEW_SHAPES[0].id, "design");
    assert.equal(PREVIEW_SHAPES[0].vp, null);
    assert.equal(
      PREVIEW_SHAPES.filter((s) => s.vp === null).length,
      1,
      "exactly one editable shape",
    );
  });

  test("every preview shape has a real viewport", () => {
    for (const s of PREVIEW_SHAPES.slice(1)) {
      assert.ok(s.vp && s.vp.w > 0 && s.vp.h > 0, `${s.id} needs a viewport`);
    }
  });

  test("the set spans both sides of the design's shape", () => {
    // A switcher where everything stacks, or nothing does, teaches the operator
    // nothing. Phone must stack against a 16:9 design and Panel must not.
    const design = { width: 1920, height: 1080 };
    const byId = Object.fromEntries(PREVIEW_SHAPES.filter((s) => s.vp).map((s) => [s.id, s.vp!]));
    assert.equal(shouldStack(design, byId.phone), true, "phone stacks");
    assert.equal(shouldStack(design, byId.panel), false, "panel keeps the arrangement");
  });
});
