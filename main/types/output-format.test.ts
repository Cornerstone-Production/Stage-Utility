import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_VIDEO_MODE, isRotation, isVideoMode, modeChoices, ROTATIONS, VIDEO_MODES } from "./output-format.js";

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

describe("the modes to offer for a port", () => {
  it("are the ones it reported that are accepted, the house default first", () => {
    assert.deepEqual(modeChoices(["720p50", "1080p50", "1080p59.94", "2160p30"], undefined), ["1080p59.94", "1080p50", "720p50"]);
  });

  it("are the whole accepted list for a port that reported nothing", () => {
    assert.deepEqual(modeChoices(undefined, undefined).sort(), [...VIDEO_MODES]);
    assert.deepEqual(modeChoices([], undefined).sort(), [...VIDEO_MODES]);
  });

  it("are the whole accepted list when nothing it reported is accepted", () => {
    assert.deepEqual(modeChoices(["2160p30"], undefined).sort(), [...VIDEO_MODES]);
  });

  it("keep the mode the screen has, first, even when the port did not report it", () => {
    assert.deepEqual(modeChoices(["1080p60"], "720p50"), ["720p50", "1080p60"]);
  });

  it("do not list the current mode twice", () => {
    assert.deepEqual(modeChoices(["1080p60", "720p50"], "720p50"), ["1080p60", "720p50"]);
  });
});
