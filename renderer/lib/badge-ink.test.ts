import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { boxRectToImageRect, inkForLuminance, relativeLuminance } from "./badge-ink.js";

describe("inkForLuminance", () => {
  test("white and light grey photos get dark ink", () => {
    assert.equal(inkForLuminance(relativeLuminance(255, 255, 255)), "dark");
    assert.equal(inkForLuminance(relativeLuminance(200, 200, 200)), "dark");
  });
  test("black and dark grey photos get light ink", () => {
    assert.equal(inkForLuminance(relativeLuminance(0, 0, 0)), "light");
    assert.equal(inkForLuminance(relativeLuminance(40, 40, 40)), "light");
  });
  test("the switch is where black and white ink contrast equally", () => {
    // sRGB 119 is the crossover grey: either side flips the ink.
    assert.equal(inkForLuminance(relativeLuminance(110, 110, 110)), "light");
    assert.equal(inkForLuminance(relativeLuminance(130, 130, 130)), "dark");
  });
});

describe("boxRectToImageRect", () => {
  const patch = { left: 80, top: 0, width: 20, height: 20 };
  test("a cover crop of a wide image maps the right edge of the box inside the image", () => {
    // 200x100 image in a 100x100 box: scale 1, 50px cropped each side at x 0.5.
    const r = boxRectToImageRect(patch, { width: 100, height: 100 }, { width: 200, height: 100 }, { x: 0.5, y: 0.28 });
    assert.deepEqual(r, { left: 130, top: 0, width: 20, height: 20 });
  });
  test("zero-sized box or image is null, never NaN", () => {
    assert.equal(boxRectToImageRect(patch, { width: 0, height: 100 }, { width: 200, height: 100 }, { x: 0.5, y: 0.5 }), null);
    assert.equal(boxRectToImageRect(patch, { width: 100, height: 100 }, { width: 0, height: 0 }, { x: 0.5, y: 0.5 }), null);
  });
});
