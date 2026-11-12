// The size arithmetic of pdf-raster.ts. The rendering itself is not unit-tested:
// jsdom has no canvas, and pdf.js loads its worker through Vite's ?url import,
// which only a browser build resolves. The page picker on /stageplots/edit is
// driven in a real browser instead (docs/features/stageplots.md).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { pageIn, sizeForLongEdge } from "./pdf-raster";

describe("sizeForLongEdge", () => {
  test("a landscape Letter page comes out 2400 on its long edge", () => {
    assert.deepEqual(sizeForLongEdge({ width: 792, height: 612 }, 2400), { scale: 2400 / 792, width: 2400, height: 1855 });
  });

  test("a portrait A4 page comes out 2400 tall", () => {
    const s = sizeForLongEdge({ width: 595.28, height: 841.89 }, 2400);
    assert.equal(s.height, 2400);
    assert.equal(s.width, 1697);
  });

  test("a thumbnail size works the same way and never rounds to zero", () => {
    assert.deepEqual(sizeForLongEdge({ width: 1000, height: 1 }, 120), { scale: 0.12, width: 120, height: 1 });
  });
});

describe("pageIn", () => {
  test("clamps into the document, 1-based", () => {
    assert.equal(pageIn(0, 3), 1);
    assert.equal(pageIn(2, 3), 2);
    assert.equal(pageIn(9, 3), 3);
    assert.equal(pageIn(Number.NaN, 3), 1);
  });
});
