// The category palette is fixed rather than configurable, so these values ARE the
// feature — a change here changes what every layout looks like.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { categoryColour, NEUTRAL_CATEGORY_COLOUR } from "./category-colour.js";

describe("categoryColour", () => {
  test("the categories that matter on a rundown each get their colour", () => {
    assert.equal(categoryColour("Lighting"), "#ffb224");
    assert.equal(categoryColour("Video"), "#46a758");
    assert.equal(categoryColour("Graphics"), "#46a758");
    assert.equal(categoryColour("Audio"), "#0091ff");
    assert.equal(categoryColour("Band"), "#12a594");
    assert.equal(categoryColour("Vocals"), "#12a594");
    assert.equal(categoryColour("Stage Manager"), "#e5484d");
  });

  test("matching is case-insensitive, substring, and tolerates padding", () => {
    assert.equal(categoryColour("  MD + Playback Tech "), "#12a594");
    assert.equal(categoryColour("FOH"), "#0091ff");
    assert.equal(categoryColour("LIGHTING"), "#ffb224");
    assert.equal(categoryColour("Aux Keys"), "#12a594");
  });

  test("an unmatched category is neutral rather than arbitrary", () => {
    assert.equal(categoryColour("Hospitality"), NEUTRAL_CATEGORY_COLOUR);
    assert.equal(categoryColour(""), NEUTRAL_CATEGORY_COLOUR);
  });

  test("the real category set produces a usable spread", () => {
    const real = ["Audio", "Band", "Vocals", "Lighting", "Video", "Graphics", "Stage Manager"];
    assert.ok(new Set(real.map(categoryColour)).size >= 4);
  });

  test("no category colour is purple", () => {
    for (const c of ["Audio", "Band", "Lighting", "Video", "Stage Manager", "Hospitality"]) {
      const hex = categoryColour(c);
      const n = parseInt(hex.slice(1), 16);
      const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d < 0.04) continue;
      let h: number;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = ((h * 60) + 360) % 360;
      assert.ok(h < 233 || h > 327, `${c} is purple (hue ${Math.round(h)})`);
    }
  });
});
