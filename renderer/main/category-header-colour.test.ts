// The one thing header colours must do: let you tell a layout's columns apart at a
// glance. That means every note column in a layout gets a DISTINCT colour — the reason
// this spreads evenly rather than hashing the name, which collided on a real
// fourteen-column layout.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { headerColoursFor, isStructuralColumn } from "./category-header-colour.js";

const REAL_14 = ["clock", "len", "title", "note:Band", "note:Vocals", "note:MD + Playback Tech",
  "note:AG", "note:Aux Keys", "note:Drums & Bass", "note:EG", "note:Keys", "note:Strings",
  "note:Audio", "note:Stage Manager", "note:Graphics", "note:Lighting", "note:Video"];

/** Reconstruct the hue from a rendered hex, to assert on what is actually shown. */
function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  let h: number;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  return ((h * 60) + 360) % 360;
}

describe("structural columns", () => {
  test("the app's own columns take no colour", () => {
    for (const k of ["clock", "time", "item", "title", "len", "TITLE"]) {
      assert.equal(isStructuralColumn(k), true, `${k} must be structural`);
    }
    const colours = headerColoursFor(REAL_14);
    for (const k of ["clock", "len", "title"]) {
      assert.equal(colours[k], undefined, `${k} must not be tinted`);
    }
  });

  test("a layout with no note columns produces nothing", () => {
    assert.deepEqual(headerColoursFor(["clock", "len", "title"]), {});
  });
});

describe("distinctness", () => {
  test("a real fourteen-column layout gets fourteen distinct colours", () => {
    const colours = headerColoursFor(REAL_14);
    const values = Object.values(colours);
    assert.equal(values.length, 14);
    assert.equal(new Set(values).size, 14, "two columns share a colour");
  });

  test("a three-column layout gets widely separated hues", () => {
    const hues = Object.values(headerColoursFor(["clock", "note:Audio", "note:Band", "note:Vocals"]))
      .map(hueOf).sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i++) {
      assert.ok(hues[i] - hues[i - 1] > 50, `hues too close: ${hues.join(", ")}`);
    }
  });

  test("the same layout always produces the same colours", () => {
    assert.deepEqual(headerColoursFor(REAL_14), headerColoursFor(REAL_14));
  });
});

describe("the purple rule", () => {
  test("no header lands in the purple band, at any column count", () => {
    for (let n = 1; n <= 30; n++) {
      const keys = Array.from({ length: n }, (_, i) => `note:c${i}`);
      for (const [key, hex] of Object.entries(headerColoursFor(keys))) {
        const hue = hueOf(hex);
        // Indigo (249) and violet (320) both read purple, so the band checked here is
        // wider than "purple" strictly is.
        assert.ok(hue < 233 || hue > 327, `${key} of ${n} is purple (hue ${Math.round(hue)})`);
      }
    }
  });

  test("every colour is a six-digit hex", () => {
    for (const hex of Object.values(headerColoursFor(REAL_14))) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
    }
  });
});
