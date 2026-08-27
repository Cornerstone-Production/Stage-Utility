// Selecting the mic-slots object made it render behind everything else.
//
// Only that object, and only while it was the selected one. Selecting anything
// else and the same layout drew correctly, which is what made it look like a
// problem with the slots object rather than with the row it sits in.
//
// It was neither. The editor's canvas row lives in a flex COLUMN capped at the
// window height. Selecting an INLINE slots-grid mounts the InlineSlotsEditor
// below that row with ~1950px of content, the column overflows, and flexbox
// answers an overflowing column by shrinking its items. The row carries
// `min-h-0` — the other branch needs it, so the side panel can scroll inside
// the row — and that removes the floor that would have stopped the shrink. So
// the row collapsed to zero height while the canvas cell inside kept the
// explicit pixel height it had been measured to, and the canvas drew full size
// out of a zero-height row, over the top of the slots editor.
//
// Measured in a real browser (1440x900, console route, inline slots-grid
// selected), because jsdom has no layout engine and every geometric assertion
// passes there whatever the CSS says:
//
//   before   row 0x0      canvas 844x475 overlapping the slots editor by 844x463
//   after    row 1176x475 canvas 844x475 slots editor at y=579, overlap none
//
// What is pinned here is the decision and the fact that the component still
// asks for it. The geometry above is what the decision is FOR, and it cannot be
// re-measured in this environment.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { canvasRowFlexClass } from "./canvas-row-fit.js";

describe("the canvas row, with an inline slots-grid selected", () => {
  test("refuses to shrink", () => {
    const cls = canvasRowFlexClass(true);
    assert.ok(
      cls.split(/\s+/).includes("shrink-0"),
      `the row must be shrink-0 while the slots editor is below it; got "${cls}"`,
    );
  });

  test("does not also claim the leftover height, which is what put the editor off-screen", () => {
    assert.ok(!canvasRowFlexClass(true).split(/\s+/).includes("flex-1"));
  });
});

describe("the canvas row otherwise", () => {
  test("takes the leftover height, so the side panel can use the full window", () => {
    assert.ok(canvasRowFlexClass(false).split(/\s+/).includes("flex-1"));
  });

  test("is never handed an empty class — an unset shrink is shrink:1, which is the bug", () => {
    for (const selected of [true, false]) {
      assert.notEqual(canvasRowFlexClass(selected).trim(), "");
    }
  });
});

describe("the editor actually asks for it", () => {
  // Without this, deleting the call and hard-coding `flex-1` back into the JSX
  // leaves every test above green — the exact way guards in this repo have
  // passed on the defect they were added for.
  test("layout-editor builds the canvas row's class from this function", () => {
    const src = readFileSync(new URL("./layout-editor.tsx", import.meta.url), "utf8");
    // A call, in a className, on the row that carries min-h-0 — none of which
    // prose or an import line can satisfy.
    const row = src.match(/className=\{`flex gap-3 [^`]*min-h-0 \$\{([^}]*)\}`\}/);
    assert.ok(row, "could not find the canvas row's className in layout-editor.tsx");
    assert.match(row[1], /canvasRowFlexClass\(/);
  });
});
