import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { rectFrom, MIN_DRAW } from "./draw-to-create.js";

describe("the drawn rect", () => {
  test("a straightforward drag becomes that rectangle", () => {
    // Compared with a tolerance: these are floats, and asserting an exact
    // 0.4000000000000001 pins a rounding artefact rather than the behaviour.
    const r = rectFrom({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 });
    for (const [k, want] of [["x", 0.2], ["y", 0.3], ["w", 0.4], ["h", 0.4]] as const) {
      assert.ok(Math.abs(r[k] - want) < 1e-9, `${k}: expected ~${want}, got ${r[k]}`);
    }
  });

  test("dragging up-and-left is the same rectangle", () => {
    // Starting at the bottom right is not a different gesture, and a negative
    // width is never what anyone meant.
    const down = rectFrom({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 });
    const up = rectFrom({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 });
    assert.ok(Math.abs(down.x - up.x) < 1e-9 && Math.abs(down.y - up.y) < 1e-9);
    assert.ok(Math.abs(down.w - up.w) < 1e-9 && Math.abs(down.h - up.h) < 1e-9);
  });

  test("a flick becomes a default-sized widget, not a sliver", () => {
    const r = rectFrom({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.501 });
    assert.ok(r.w >= MIN_DRAW && r.h >= MIN_DRAW, `got ${r.w} x ${r.h}`);
    // Centred on where they clicked.
    assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 1e-9);
  });

  test("a drag that is wide but not tall still counts as a flick", () => {
    // Both axes must clear the minimum; a 1px-tall band is not a widget.
    const r = rectFrom({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.505 });
    assert.ok(r.h >= MIN_DRAW);
  });

  test("it never escapes the canvas", () => {
    const r = rectFrom({ x: 0.9, y: 0.9 }, { x: 1.4, y: 1.6 });
    assert.ok(r.x >= 0 && r.x + r.w <= 1 + 1e-9);
    assert.ok(r.y >= 0 && r.y + r.h <= 1 + 1e-9);
  });

  test("a flick in the corner is nudged fully inside", () => {
    const r = rectFrom({ x: 0.99, y: 0.99 }, { x: 0.991, y: 0.991 });
    assert.ok(r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
  });

  test("a drag larger than the canvas is capped", () => {
    const r = rectFrom({ x: -0.5, y: -0.5 }, { x: 1.8, y: 1.9 });
    assert.equal(r.w, 1);
    assert.equal(r.h, 1);
    assert.equal(r.x, 0);
    assert.equal(r.y, 0);
  });
});
