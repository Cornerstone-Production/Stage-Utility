import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { CANVAS_PRESETS, ULTRITOUCH_PRESETS, isUltritouchCanvas } from "./layout-templates.js";

describe("Ultritouch canvas presets", () => {
  test("the three panels, at the User Guide's pixels", () => {
    // Ultritouch User Guide 2201DR-304, Table 1. Exact, not approximate: the
    // browser component is drawn edge to edge and a preset a few pixels off
    // letterboxes a sliver on the panel itself.
    assert.deepEqual(
      ULTRITOUCH_PRESETS.map((p) => [p.id, p.w, p.h]),
      [
        ["ultritouch-2", 1366, 203],
        ["ultritouch-2-hr", 1920, 285],
        ["ultritouch-4", 1366, 485],
      ],
    );
  });

  test("they are on the Canvas popover's list, after the screen shapes", () => {
    const tail = CANVAS_PRESETS.slice(-3).map((p) => p.id);
    assert.deepEqual(tail, ["ultritouch-2", "ultritouch-2-hr", "ultritouch-4"]);
    // Exact: a preset added by hand later must land here on purpose.
    assert.equal(CANVAS_PRESETS.length, 12);
  });

  test("a canvas is recognised by its pixels, not a flag", () => {
    // A layout imported from another install carries no marker, only numbers.
    assert.equal(isUltritouchCanvas(1366, 203), true);
    assert.equal(isUltritouchCanvas(1920, 285), true);
    assert.equal(isUltritouchCanvas(1366, 485), true);
    assert.equal(isUltritouchCanvas(1920, 1080), false);
    assert.equal(isUltritouchCanvas(1366, 204), false);
  });
});
