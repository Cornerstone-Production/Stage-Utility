import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { CANVAS_PRESETS, ULTRITOUCH_PRESETS, isUltritouchCanvas, ultritouchTemplate, ultritouchCanvas } from "./layout-templates.js";

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

describe("Ultritouch strip templates", () => {
  for (const model of ["ultritouch-2", "ultritouch-2-hr", "ultritouch-4"] as const) {
    test(`${model}: eight cue buttons per row and one countdown, all on the canvas`, () => {
      const objects = ultritouchTemplate(model);
      const cueButtons = objects.filter((o) => o.config.type === "cue-button");
      assert.equal(cueButtons.length, model === "ultritouch-4" ? 16 : 8);
      assert.equal(objects.filter((o) => o.config.type === "countdown-timer").length, 1);
      assert.equal(objects.length, cueButtons.length + 1);
      for (const o of objects) {
        assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.w <= 1.0001 && o.y + o.h <= 1.0001, `${o.id} off the canvas`);
      }
      // Unbound: a template must never ship a cue name that may not exist here.
      for (const b of cueButtons) assert.equal((b.config as { cue: string }).cue, "");
      const canvas = ultritouchCanvas(model);
      assert.equal(canvas.fit, "contain");
      assert.equal(canvas.background, "#0e0e0e");
    });
  }
});
