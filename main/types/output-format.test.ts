import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_VIDEO_MODE, isRotation, isVideoMode, ROTATIONS, VIDEO_MODES } from "./output-format.js";

describe("the accepted video modes", () => {
  // Exactly this list, one name per line and sorted, so two branches adding a
  // mode touch different lines and neither a count nor a floor can hide an add
  // paired with a remove.
  it("are exactly these", () => {
    assert.deepEqual([...VIDEO_MODES], [
      "1080i50",
      "1080i59.94",
      "1080i60",
      "1080p23.98",
      "1080p24",
      "1080p25",
      "1080p29.97",
      "1080p30",
      "1080p50",
      "1080p59.94",
      "1080p60",
      "720p50",
      "720p59.94",
      "720p60",
    ]);
  });

  it("are sorted", () => {
    assert.deepEqual([...VIDEO_MODES], [...VIDEO_MODES].sort());
  });

  it("include the house default", () => {
    assert.equal(isVideoMode(DEFAULT_VIDEO_MODE), true);
  });

  it("refuse a near miss, a non-string and nothing", () => {
    for (const bad of ["1080p61", "1080P59.94", " 1080p59.94", "", 59.94, null, undefined, ["1080p60"]]) {
      assert.equal(isVideoMode(bad), false, JSON.stringify(bad));
    }
  });
});

describe("the accepted rotations", () => {
  it("are exactly the four quarter turns", () => {
    assert.deepEqual([...ROTATIONS], [0, 90, 180, 270]);
  });

  it("refuse a number between them, a string and nothing", () => {
    for (const bad of [45, 360, -90, 90.5, "90", null, undefined, NaN]) {
      assert.equal(isRotation(bad), false, String(bad));
    }
  });
});
