// Matching PCO's item row colors. Two rules that are easy to get backwards: custom
// types match text CONTAINED in the title (not the whole title, not the item type),
// and #ffffff means "no color" rather than "white" — PCO ships it as the default on
// Media, so rendering it would paint a meaningless stripe on every video row.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveItemColor, washFor, stripeFor, mapPcoColor } from "./item-color.js";

const STANDARD = [
  { name: "Header", color: "#eaebeb", custom: false },
  { name: "Media", color: "#ffffff", custom: false },
  { name: "Song", color: "#e8f6df", custom: false },
];

describe("standard types match the item type", () => {
  test("a song gets the Song color", () => {
    assert.equal(resolveItemColor({ itemType: "song", title: "He Will Be" }, STANDARD), "#e8f6df");
  });

  test("a header gets the Header color", () => {
    assert.equal(resolveItemColor({ itemType: "header", title: "SERVICE START" }, STANDARD), "#eaebeb");
  });

  test("matching is case-insensitive on the type name", () => {
    const c = [{ name: "SONG", color: "#e8f6df", custom: false }];
    assert.equal(resolveItemColor({ itemType: "song", title: "x" }, c), "#e8f6df");
  });

  test("a plain item matches nothing", () => {
    assert.equal(resolveItemColor({ itemType: "item", title: "Welcome" }, STANDARD), null);
  });
});

describe("#ffffff means unset", () => {
  test("Media's default white does not color the row", () => {
    assert.equal(resolveItemColor({ itemType: "media", title: "VIDEO: Pre-roll" }, STANDARD), null);
  });

  test("but a near-white is a real choice and is kept", () => {
    const c = [{ name: "Media", color: "#fffffe", custom: false }];
    assert.equal(resolveItemColor({ itemType: "media", title: "x" }, c), "#fffffe");
  });
});

describe("custom types match text inside the title", () => {
  const CUSTOM = [...STANDARD, { name: "VIDEO", color: "#ffd9b0", custom: true }];

  test("a title containing the text matches", () => {
    assert.equal(resolveItemColor({ itemType: "item", title: "VIDEO: Need To Know" }, CUSTOM), "#ffd9b0");
  });

  test("matching is case-insensitive and substring, not exact", () => {
    assert.equal(resolveItemColor({ itemType: "item", title: "Roll the video now" }, CUSTOM), "#ffd9b0");
  });

  test("a custom match beats a standard one", () => {
    // A song whose title contains the custom text takes the custom color — the
    // operator typed that text deliberately.
    assert.equal(resolveItemColor({ itemType: "song", title: "VIDEO: Song Intro" }, CUSTOM), "#ffd9b0");
  });

  test("a custom entry set to white is still unset", () => {
    const c = [{ name: "VIDEO", color: "#ffffff", custom: true }];
    assert.equal(resolveItemColor({ itemType: "item", title: "VIDEO: x" }, c), null);
  });

  test("an empty custom name never matches everything", () => {
    // "" is contained in every string; guard against a blank entry painting the plan.
    const c = [{ name: "", color: "#ff0000", custom: true }];
    assert.equal(resolveItemColor({ itemType: "item", title: "Welcome" }, c), null);
  });
});

describe("absent config", () => {
  test("no colors configured means no color", () => {
    assert.equal(resolveItemColor({ itemType: "song", title: "x" }, undefined), null);
    assert.equal(resolveItemColor({ itemType: "song", title: "x" }, []), null);
  });
});

describe("washFor", () => {
  test("keeps the hue of a pale PCO color instead of washing it to gray", () => {
    // The bug this exists for: #e8f6df mixed into near-black at 10% measured
    // rgb(33,34,32) on screen — neutral gray. A row has to look GREEN, not lighter.
    const wash = washFor("#46a758");
    assert.match(wash, /^hsl\(\d+ \d+% \d+%\)$/);
    const hue = Number(wash.match(/\d+/)![0]);
    assert.ok(hue > 70 && hue < 160, `expected a green hue, got ${hue}`);
  });

  test("a blue PCO color stays blue", () => {
    const hue = Number(washFor("#4a86c8").match(/\d+/)![0]);
    assert.ok(hue > 160 && hue < 240, `expected a cyan/blue hue, got ${hue}`);
  });

  test("a near-gray has no hue to keep, so it stays neutral", () => {
    // PCO's Header is #eaebeb — forcing a hue onto it would invent a color.
    assert.equal(washFor("#eaebeb"), "rgba(255, 255, 255, 0.05)");
  });

  test("garbage does not produce a broken color value", () => {
    assert.equal(washFor("not-a-color"), "rgba(255, 255, 255, 0.05)");
  });
});

describe("stripeFor", () => {
  test("a pale PCO color becomes a saturated stripe, not near-white", () => {
    // #e0f7ff is 88% lightness — at full strength on a dark panel it reads WHITE.
    const s = stripeFor("#4a86c8");
    assert.match(s, /^hsl\(\d+ \d+% \d+%\)$/);
    const [hue, sat, light] = s.match(/\d+/g)!.map(Number);
    assert.ok(hue > 160 && hue < 240, `expected a blue hue, got ${hue}`);
    assert.ok(sat >= 60, `stripe must stay saturated, got ${sat}%`);
    assert.ok(light < 75, `stripe must not be near-white, got ${light}%`);
  });

  test("it is brighter than the wash of the same color", () => {
    // The stripe carries the color at a distance; the wash sits behind text.
    const sl = Number(stripeFor("#46a758").match(/\d+/g)![2]);
    const wl = Number(washFor("#46a758").match(/\d+/g)![2]);
    assert.ok(sl > wl, `stripe (${sl}%) must be lighter than wash (${wl}%)`);
  });

  test("both keep the same hue", () => {
    assert.equal(stripeFor("#46a758").match(/\d+/)![0], washFor("#46a758").match(/\d+/)![0]);
  });

  test("a near-gray stays a neutral rule rather than inventing a hue", () => {
    assert.equal(stripeFor("#eaebeb"), "rgba(255, 255, 255, 0.45)");
  });
});

describe("mapPcoColor", () => {
  /** Hue of a hex, for asserting on what a mapping produced. */
  function hueOfHex(hex: string): number | null {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.04) return null;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  }
  /** A pale pastel at a given hue, standing in for a PCO swatch. */
  function pastel(hue: number): string {
    const l = 0.9, s = 0.4;
    const k = (n: number) => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
    return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
  }

  test("PCO green maps to the curated green", () => {
    assert.equal(mapPcoColor("#e8f6df"), "#46a758");
  });

  test("PCO blue maps to the deeper blue", () => {
    // Blue and lavender bands are crossed on purpose — see PALETTE.
    assert.equal(mapPcoColor("#e0f7ff"), "#4a86c8");
  });

  test("PCO lavender maps to the brighter blue, never purple", () => {
    assert.equal(mapPcoColor(pastel(265)), "#58c1e4");
  });

  test("white is PCO's way of saying no color", () => {
    assert.equal(mapPcoColor("#ffffff"), null);
    assert.equal(mapPcoColor("#FFFFFF"), null);
  });

  test("a near-gray has no hue to map", () => {
    assert.equal(mapPcoColor("#eaebeb"), null);
  });

  test("warm hues wrap through zero to amber", () => {
    assert.equal(mapPcoColor(pastel(30)), "#ffb224");
    assert.equal(mapPcoColor(pastel(355)), "#ffb224");
  });

  test("NOTHING maps into the purple band, at any input hue", () => {
    for (let h = 0; h < 360; h += 3) {
      const out = mapPcoColor(pastel(h));
      if (!out) continue;
      const hue = hueOfHex(out);
      assert.ok(hue == null || hue < 233 || hue > 327, `input hue ${h} mapped to purple (${out})`);
    }
  });

  test("every band boundary lands in exactly one band", () => {
    for (const h of [75, 160, 250, 290, 345]) {
      assert.ok(mapPcoColor(pastel(h)), `hue ${h} produced no color`);
    }
  });
});
