// Pins the OUTPUT of every colour helper that used to parse hex by hand, so
// sharing parseColor between them cannot move a single pixel.
//
// The share is of the PARSE ONLY. Each helper keeps its own coefficients and its
// own threshold, deliberately: chipText asks "light or dark text on this chip"
// with YIQ weights at 0.6, hueOf asks "what hue is this, if any" with a 0.04
// neutral cutoff, and color-math's isDark asks a third question with a third
// answer. Folding those together would silently flip text colours on a live
// stage display, which is not something this change is entitled to do.
//
// So these assert LITERAL current values, recorded before the refactor and
// unchanged by it. Every case below was produced by the pre-refactor code.
//
// Every colour here is INVENTED or is a documented app constant.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installDom } from "../test-dom.js";

// stage-display-view is a .tsx that pulls the UI tree in with it, so a document
// has to exist before it is imported even though only a pure function is called.
const teardown = installDom();
const { chipText } = await import("./stage-display-view.js");
const { washFor, stripeFor, mapPcoColor } = await import("./item-color.js");
teardown();

describe("chipText picks the text colour for a chip", () => {
  // The threshold is 0.6 of a YIQ-weighted luminance. These bracket it.
  const cases: [string, string][] = [
    ["#ffffff", "#111111"],
    ["#000000", "#fff"],
    ["#e0e0e0", "#111111"],
    ["#0b0b0b", "#fff"],
    // Pure green sits just UNDER the 0.6 threshold on these weights (0.587),
    // which is the sort of thing only a recorded value gets right.
    ["#00ff00", "#fff"],
    ["#0000ff", "#fff"],
    ["#ff0000", "#fff"],
    ["#f9d266", "#111111"],
    ["#1d9a8c", "#fff"],
    ["#b4a7e6", "#111111"],
    ["#808080", "#fff"],
    ["#999999", "#fff"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} takes ${expected}`, () => {
      assert.equal(chipText(input), expected);
    });
  }

  it("accepts a bare six-digit hex with no leading hash", () => {
    // The regex is `#?` — the hash is OPTIONAL here and required by parseColor,
    // so this is the case a careless share would break.
    assert.equal(chipText("ffffff"), "#111111");
    assert.equal(chipText("000000"), "#fff");
  });

  it("falls back to white text for anything it cannot read", () => {
    for (const bad of ["", "not a colour", "#abc", "#12345", "#1234567", "rgb(0,0,0)", "red"]) {
      assert.equal(chipText(bad), "#fff", bad);
    }
  });
});

describe("hueOf, through the three helpers that use it", () => {
  const cases: [string, string, string][] = [
    // input, washFor, stripeFor
    ["#ff0000", "hsl(0 42% 15%)", "hsl(0 72% 62%)"],
    ["#00ff00", "hsl(120 42% 15%)", "hsl(120 72% 62%)"],
    ["#0000ff", "hsl(240 42% 15%)", "hsl(240 72% 62%)"],
    ["#f9d266", "hsl(44 42% 15%)", "hsl(44 72% 62%)"],
    ["#1d9a8c", "hsl(173 42% 15%)", "hsl(173 72% 62%)"],
    ["#b4a7e6", "hsl(252 42% 15%)", "hsl(252 72% 62%)"],
  ];
  for (const [input, wash, stripe] of cases) {
    it(`${input} washes and stripes the same hue`, () => {
      assert.equal(washFor(input), wash);
      assert.equal(stripeFor(input), stripe);
    });
  }

  it("treats a near-grey as having no hue worth keeping", () => {
    // PCO's own Header colour. The 0.04 cutoff is the whole point of this branch.
    for (const grey of ["#eaebeb", "#ffffff", "#000000", "#808080"]) {
      assert.equal(washFor(grey), "rgba(255, 255, 255, 0.05)", grey);
      assert.equal(stripeFor(grey), "rgba(255, 255, 255, 0.45)", grey);
      assert.equal(mapPcoColor(grey), null, grey);
    }
  });

  it("REQUIRES a leading hash and exactly six digits", () => {
    // Unlike chipText. parseColor accepts #rgb and rgba(); this must not start
    // to, or a three-digit colour that used to read as neutral would gain a hue.
    for (const bad of ["ff0000", "#abc", "#12345", "#1234567", "rgb(255,0,0)", ""]) {
      assert.equal(washFor(bad), "rgba(255, 255, 255, 0.05)", bad);
      assert.equal(stripeFor(bad), "rgba(255, 255, 255, 0.45)", bad);
    }
  });

  it("maps a hue onto the curated palette exactly as it did", () => {
    assert.equal(mapPcoColor("#ff0000"), "#ffb224");
    assert.equal(mapPcoColor("#00ff00"), "#46a758");
    assert.equal(mapPcoColor("#0000ff"), "#4a86c8");
    assert.equal(mapPcoColor("#f9d266"), "#ffb224");
    assert.equal(mapPcoColor("#b4a7e6"), "#58c1e4");
  });
});
