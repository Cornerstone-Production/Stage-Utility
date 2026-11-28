// The geometry behind pan and zoom on a stage plot. The pointer and wheel
// handling around it needs a layout engine (jsdom measures the frame as 0 by 0)
// and is driven in a browser.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_ZOOM, fitView, panView, zoomView } from "./use-pan-zoom";

const FULL = { w: 1000, h: 600 };

describe("pan and zoom geometry", () => {
  test("zooming in keeps the point under the pointer where it was", () => {
    const at = { x: 250, y: 150 };
    const v = zoomView(fitView(FULL), FULL, 2, at);
    assert.deepEqual(v, { x: 125, y: 75, w: 500, h: 300 });
    // The point is the same fraction of the way across the view as before.
    assert.equal((at.x - v.x) / v.w, 0.25);
  });

  test("zoom stops at the whole plot and at MAX_ZOOM", () => {
    assert.deepEqual(zoomView(fitView(FULL), FULL, 0.5, { x: 500, y: 300 }), fitView(FULL));
    const deep = zoomView(fitView(FULL), FULL, 100, { x: 500, y: 300 });
    assert.equal(deep.w, FULL.w / MAX_ZOOM);
  });

  test("panning stays inside the plot", () => {
    const zoomed = zoomView(fitView(FULL), FULL, 2, { x: 500, y: 300 });
    assert.deepEqual(panView(zoomed, FULL, 10000, 10000), { x: 0, y: 0, w: 500, h: 300 });
    assert.deepEqual(panView(zoomed, FULL, -10000, -10000), { x: 500, y: 300, w: 500, h: 300 });
    assert.deepEqual(panView(fitView(FULL), FULL, 40, 40), fitView(FULL), "the whole plot does not pan");
  });
});
