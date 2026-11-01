// Which ink an icon's art is drawn in, chosen from what is behind it.
//
// Pure arithmetic over colours, so the real thing runs here: no stand-in for the
// luminance, no recorded context.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { contrastRatio, DARK_INK, iconInk, inkOn, LIGHT_INK, luminance, resolveAccent, tabColor } from "./icon-ink";

describe("luminance", () => {
  test("black is 0 and white is 1", () => {
    assert.equal(luminance("#000000"), 0);
    assert.equal(luminance("#ffffff"), 1);
  });

  test("green carries more of it than red, and red more than blue", () => {
    assert.ok(luminance("#00ff00") > luminance("#ff0000"));
    assert.ok(luminance("#ff0000") > luminance("#0000ff"));
  });
});

describe("contrastRatio", () => {
  test("black on white is 21, and a colour on itself is 1", () => {
    assert.equal(contrastRatio("#000000", "#ffffff"), 21);
    assert.equal(contrastRatio("#2e6691", "#2e6691"), 1);
  });
});

describe("inkOn", () => {
  test("a light background gets the dark ink, and a dark one the light ink", () => {
    assert.equal(inkOn("#ffffff"), DARK_INK);
    assert.equal(inkOn("#f4f0ec"), DARK_INK);
    assert.equal(inkOn("#000000"), LIGHT_INK);
    assert.equal(inkOn("#15425c"), LIGHT_INK);
  });

  test("the choice is the one with the better contrast, mid-tones included", () => {
    for (const bg of ["#2e6691", "#c2410c", "#0d9488", "#6e56cf", "#808080", "#ffcc00", "#e11d48"]) {
      const other = inkOn(bg) === DARK_INK ? LIGHT_INK : DARK_INK;
      assert.ok(contrastRatio(inkOn(bg), bg) >= contrastRatio(other, bg), bg);
    }
  });
});

describe("iconInk", () => {
  test("with Recolor on, white art on a white background turns dark", () => {
    assert.equal(iconInk("#ffffff", true), DARK_INK);
  });

  test("with Recolor on, art on black is light", () => {
    assert.equal(iconInk("#000000", true), LIGHT_INK);
  });

  test("with Recolor off there is no ink: the art is drawn as uploaded", () => {
    assert.equal(iconInk("#ffffff", false), null);
    assert.equal(iconInk("#000000", false), null);
  });
});

describe("resolveAccent", () => {
  test("the page's resolved accent wins, lowercased and trimmed", () => {
    assert.equal(resolveAccent("#c2410c", " #6AA6DF "), "#6aa6df");
  });

  test("with nothing readable from the page it is the picked accent, then the default blue", () => {
    assert.equal(resolveAccent("#C2410C", ""), "#c2410c");
    assert.equal(resolveAccent("#c2410c", "var(--x)"), "#c2410c");
    assert.equal(resolveAccent(null, ""), "#2e6691");
    assert.equal(resolveAccent("red", "rgb(1,2,3)"), "#2e6691");
  });
});

describe("tabColor", () => {
  test("a colour is a colour, lowercased; none and anything else is no background", () => {
    assert.equal(tabColor("#FFFFFF"), "#ffffff");
    assert.equal(tabColor("#2e6691"), "#2e6691");
    for (const none of ["none", "", "transparent", "#fff", "red"]) assert.equal(tabColor(none), null, none);
  });
});
