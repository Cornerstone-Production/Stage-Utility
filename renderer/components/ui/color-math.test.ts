// The colour maths behind the app's own picker.
//
// Round-tripping is the thing to pin: the picker converts to HSV to draw itself
// and back to a string to store, on every drag frame. A conversion that loses a
// little each way turns a slow drag into a drift, and the colour you let go of
// is not the colour you land on.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  formatColor,
  hsvaToRgba,
  isDark,
  parseColor,
  parseTypedColor,
  rgbaToHsva,
  type Rgba,
} from "./color-math.js";

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });

describe("reading what the app has stored", () => {
  test("the hex forms the styles are written in", () => {
    assert.deepEqual(parseColor("#ff0000"), rgba(255, 0, 0));
    assert.deepEqual(parseColor("#F00"), rgba(255, 0, 0));
    assert.deepEqual(parseColor("#141414"), rgba(20, 20, 20));
  });

  test("rgb() and rgba(), which the tints and glass grounds use", () => {
    assert.deepEqual(parseColor("rgb(45, 212, 150)"), rgba(45, 212, 150));
    assert.deepEqual(parseColor("rgba(255,255,255,0.04)"), rgba(255, 255, 255, 0.04));
    assert.deepEqual(parseColor("rgba(0, 0, 0, 0.35)"), rgba(0, 0, 0, 0.35));
  });

  test("an eight-digit hex carries its alpha", () => {
    const c = parseColor("#ff000080");
    assert.equal(c?.r, 255);
    assert.ok(Math.abs((c?.a ?? 0) - 0.502) < 0.005);
  });

  test("what it refuses to guess at", () => {
    // A token or a named colour cannot be resolved without a document, and
    // showing the operator a colour that is not the one on screen is worse than
    // showing them nothing.
    assert.equal(parseColor("var(--gray-2)"), null);
    assert.equal(parseColor("rebeccapurple"), null);
    assert.equal(parseColor(""), null);
    assert.equal(parseColor(null), null);
    assert.equal(parseColor("#12345"), null);
  });
});

describe("writing it back", () => {
  test("opaque colours stay hex, because that is what the styles are", () => {
    assert.equal(formatColor(rgba(255, 0, 0)), "#ff0000");
    assert.equal(formatColor(rgba(20, 20, 20)), "#141414");
  });

  test("anything translucent becomes rgba, not an eight-digit hex", () => {
    // Not every consumer of these strings understands #rrggbbaa.
    assert.equal(formatColor(rgba(255, 255, 255, 0.04)), "rgba(255,255,255,0.04)");
    assert.equal(formatColor(rgba(0, 0, 0, 0.5)), "rgba(0,0,0,0.5)");
  });
});

describe("round trips", () => {
  test("rgb → hsv → rgb is exact for the colours a picker lands on", () => {
    // Every 17th value covers the hex grid without testing sixteen million.
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 85) {
          const start = rgba(r, g, b);
          const back = hsvaToRgba(rgbaToHsva(start));
          assert.deepEqual(back, start, `${r},${g},${b} did not survive the round trip`);
        }
      }
    }
  });

  test("a string survives being parsed and written back", () => {
    for (const s of ["#ff0000", "#141414", "#0d1a15", "rgba(45,212,150,0.1)"]) {
      assert.equal(formatColor(parseColor(s)!), s.toLowerCase());
    }
  });

  test("grey has no hue to lose, and does not gain one", () => {
    const grey = rgbaToHsva(rgba(128, 128, 128));
    assert.equal(grey.s, 0);
    assert.deepEqual(hsvaToRgba(grey), rgba(128, 128, 128));
  });

  test("hue wraps rather than clamping", () => {
    // A hue slider dragged past the end must come round, not stick on magenta.
    assert.deepEqual(hsvaToRgba({ h: 360, s: 1, v: 1, a: 1 }), hsvaToRgba({ h: 0, s: 1, v: 1, a: 1 }));
    assert.deepEqual(hsvaToRgba({ h: -60, s: 1, v: 1, a: 1 }), hsvaToRgba({ h: 300, s: 1, v: 1, a: 1 }));
  });
});

describe("what somebody types", () => {
  test("a hex without its hash still works", () => {
    assert.deepEqual(parseTypedColor("ff0000"), rgba(255, 0, 0));
    assert.deepEqual(parseTypedColor("  #00FF00 "), rgba(0, 255, 0));
  });

  test("half a hex is not a colour yet", () => {
    // Typing six characters must not drag the field through three wrong colours.
    assert.equal(parseTypedColor("ff"), null);
    assert.equal(parseTypedColor("#ff00"), null);
    assert.equal(parseTypedColor("nonsense"), null);
  });
});

describe("legibility on a swatch", () => {
  test("dark grounds take a light mark and light grounds a dark one", () => {
    assert.equal(isDark(rgba(0, 0, 0)), true);
    assert.equal(isDark(rgba(20, 20, 20)), true);
    assert.equal(isDark(rgba(255, 255, 255)), false);
    // Green reads far lighter than blue at the same numbers, which a plain
    // average would miss.
    assert.equal(isDark(rgba(0, 200, 0)), false);
    assert.equal(isDark(rgba(0, 0, 200)), true);
  });
});
