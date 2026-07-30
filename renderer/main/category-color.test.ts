// The category palette is fixed rather than configurable, so these values ARE the
// feature — a change here changes what every layout looks like.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { categoryColor, NEUTRAL_CATEGORY_COLOUR } from "./category-color.js";

describe("categoryColor", () => {
  test("the categories that matter on a rundown each get their color", () => {
    assert.equal(categoryColor("Lighting"), "#ffb224");
    assert.equal(categoryColor("Video"), "#46a758");
    assert.equal(categoryColor("Graphics"), "#46a758");
    assert.equal(categoryColor("Audio"), "#0091ff");
    assert.equal(categoryColor("Band"), "#12a594");
    assert.equal(categoryColor("Vocals"), "#12a594");
    assert.equal(categoryColor("Stage Manager"), "#e5484d");
  });

  test("matching is case-insensitive, substring, and tolerates padding", () => {
    assert.equal(categoryColor("  MD + Playback Tech "), "#12a594");
    assert.equal(categoryColor("FOH"), "#0091ff");
    assert.equal(categoryColor("LIGHTING"), "#ffb224");
    assert.equal(categoryColor("Aux Keys"), "#12a594");
  });

  test("an unmatched category is neutral rather than arbitrary", () => {
    assert.equal(categoryColor("Hospitality"), NEUTRAL_CATEGORY_COLOUR);
    assert.equal(categoryColor(""), NEUTRAL_CATEGORY_COLOUR);
  });

  test("the real category set produces a usable spread", () => {
    const real = ["Audio", "Band", "Vocals", "Lighting", "Video", "Graphics", "Stage Manager"];
    assert.ok(new Set(real.map(categoryColor)).size >= 4);
  });

  test("no category color is purple", () => {
    for (const c of ["Audio", "Band", "Lighting", "Video", "Stage Manager", "Hospitality"]) {
      const hex = categoryColor(c);
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
