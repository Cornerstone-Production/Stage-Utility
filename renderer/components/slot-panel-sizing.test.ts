// A mic slot always shows a face.
//
// The name card is sized in container units. It was sized to the card's WIDTH
// (cqi), which is right for a tall column and wrong for a short one: a slots
// object dropped into a custom layout is wide and short, so 14cqi produced large
// text, the two-line reservation doubled it, and between them the name and
// position covered the photo completely. The visible strip was hair and forehead.
//
// Three changes, all asserted here:
//   1. cqmin, not cqi — the SMALLER of width and height governs, so a short card
//      gets smaller text. That is what "make it fit" means when the constraint is
//      vertical, and it is a no-op on a tall card where width is already smaller.
//   2. the two-line reservation shrinks with it, via min() against cqb.
//   3. a hard ceiling on the band, so the photo keeps the majority whatever the
//      text does.
//
// VERIFIED IN A REAL BROWSER, because container queries do not resolve in jsdom
// and a DOM test here would assert nothing. Driving the running app at
// 127.0.0.1:8799 and measuring getBoundingClientRect:
//
//   card 140x367 (tall, a normal display): name 19.31px, band 22.9% — IDENTICAL
//     to before the change, which is the important non-regression
//   card 140x97  (short, the reported case): name 19.31px -> 13.28px,
//     reservation 48.3px -> 15.17px, photo share ~15% -> 53.9%
//
// This file guards the mechanism those numbers came from. It matches on the style
// VALUES rather than on prose, so a comment mentioning cqmin cannot satisfy it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("./slot-panel.tsx", import.meta.url), "utf8");

describe("slot card sizing", () => {
  it("scales the name to the smaller dimension, not the width", () => {
    assert.match(
      SRC,
      /fontSize:\s*"clamp\([^"]*cqmin[^"]*\)"/,
      "the name must be sized in cqmin — cqi is what covered the faces",
    );
    assert.doesNotMatch(
      SRC,
      /fontSize:\s*"clamp\(1rem,\s*14cqi/,
      "the width-only sizing is what this fixes",
    );
  });

  it("shrinks the two-line reservation on a short card", () => {
    // Reserving two lines keeps photo bottoms aligned across a row, which is worth
    // having — but not at the cost of the photo itself.
    assert.match(
      SRC,
      /minHeight:\s*overlay\s*\?\s*undefined\s*:\s*"min\(2\.5em,\s*\d+cqb\)"/,
      "the reservation must give way on a short card",
    );
  });

  it("caps the name card so the photo always keeps most of the slot", () => {
    assert.match(
      SRC,
      /maxHeight:\s*"\d+cqb"/,
      "without a ceiling, enough text still buries the photo",
    );
  });

  it("needs a size container for any of that to resolve", () => {
    // cqb and cqmin are only defined inside container-type: size. With
    // inline-size they silently fall back and every assertion above is decorative.
    assert.match(
      SRC,
      /\[container-type:size\]/,
      "the card must be a size container, or cqb/cqmin do not resolve",
    );
  });

  it("lets the box shape choose the fit", () => {
    // Cover crops on whichever axis has to give. In a short WIDE slot that is the
    // top and bottom, and with the name card below it the visible band was
    // forehead-to-mouth -- chins cut off. That is geometry: a 440x432 photo
    // covering a 260x175 box leaves ~66% of it visible however it is positioned,
    // and a face needs about 60% starting near the top. Only changing the fit
    // helps, so a landscape box switches to contain.
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    assert.match(css, /\.slot-photo\s*\{[^}]*container-type:\s*size/, "the photo box must be a size container");
    assert.match(
      css,
      /@container\s*\(min-aspect-ratio:\s*1\/1\)\s*\{[^}]*object-fit:\s*contain/s,
      "a landscape photo box must use contain, or a face cannot fit in it",
    );
    assert.match(css, /\.slot-photo img\s*\{[^}]*object-fit:\s*cover/s, "a tall box keeps cover");
    assert.match(css, /object-position:\s*center 28%/, "the cover crop starts below the very top");
    // And the component has to opt in, or none of the above applies.
    assert.match(SRC, /className="slot-photo /, "the photo wrapper must carry the class");
  });
});
