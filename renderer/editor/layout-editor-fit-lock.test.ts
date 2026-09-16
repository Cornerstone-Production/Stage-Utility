import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { canvasAfterPreset, ULTRITOUCH_PRESETS, CANVAS_PRESETS } from "./layout-templates.js";

describe("choosing a canvas preset", () => {
  test("an Ultritouch preset sets Letterbox fit", () => {
    const before = { width: 1920, height: 1080, background: null, fit: "responsive" as const };
    const after = canvasAfterPreset(before, ULTRITOUCH_PRESETS[0]!);
    assert.equal(after.width, 1366);
    assert.equal(after.height, 203);
    assert.equal(after.fit, "contain");
  });

  test("a screen preset leaves the fit alone", () => {
    // Nothing about a 16:9 wall says letterbox or responsive; the operator's
    // choice stands.
    const before = { width: 1366, height: 203, background: null, fit: "contain" as const };
    const after = canvasAfterPreset(before, CANVAS_PRESETS[0]!);
    assert.equal(after.fit, "contain");
    const before2 = { ...before, fit: "responsive" as const };
    assert.equal(canvasAfterPreset(before2, CANVAS_PRESETS[0]!).fit, "responsive");
  });
});
