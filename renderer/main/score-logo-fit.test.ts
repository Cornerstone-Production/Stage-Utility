// A team mark cannot be clipped by the disc it sits on.
//
// The disc is a circle drawn by `border-radius: 50%` with `overflow: hidden`, and
// the mark is a SQUARE image box centred in it. Those two shapes only coexist for
// one range of sizes, and the sizing used to be outside it: `width: 100%` gives
// the box the disc's bounding square, and a circle inscribed in a square cuts
// every part of that square except four tangent points. Marks that fill their own
// box — a letter mark, a two-letter wordmark — came out with their ends taken off.
//
// What this asserts is the geometry, not the picture. A square of side s fits
// inside a circle of diameter d exactly when its half-diagonal reaches no further
// than the radius:
//
//     (s/2) * sqrt(2)  <=  d/2      =>      s  <=  d / sqrt(2)  ~=  0.7071 d
//
// The pixels are a browser claim and cannot be made here: jsdom lays nothing out,
// so every `offsetWidth` in this file would read 0 and a test written on them
// would pass whatever the stylesheet said. The stylesheet's own number is the
// thing that can be checked, so that is what is checked — and the rendering was
// walked in a real browser at all three chip sizes in both themes.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CSS = join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css");

/**
 * The stylesheet with its comments removed.
 *
 * Load-bearing: the reasoning above the rule quotes the very number this file
 * reads, so matching raw text would find the prose and be satisfied by it. CSS
 * comments are `/* … *\/` and do not nest, and this sheet has no `content:`
 * string carrying those characters, so the strip is exact rather than hopeful.
 */
function stylesheet(): string {
  return readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("a team mark fits inside its disc", () => {
  test("the mark's box is the disc's inscribed square, or smaller", () => {
    const css = stylesheet();
    const matches = [...css.matchAll(/--score-logo-fit:\s*([\d.]+)%/g)];
    assert.equal(
      matches.length,
      1,
      "the mark's fit is declared in more or less than one place — one disc, one number",
    );

    const fit = Number(matches[0][1]) / 100;
    assert.ok(Number.isFinite(fit) && fit > 0, `--score-logo-fit is not a usable size: ${matches[0][1]}%`);

    // The half-diagonal of the mark's box, against the disc's radius. Both as a
    // fraction of the disc's diameter, so this holds at 32px, 22px and 18px.
    const halfDiagonal = (fit / 2) * Math.SQRT2;
    assert.ok(
      halfDiagonal <= 0.5,
      `a mark filling its own box reaches ${(halfDiagonal * 100).toFixed(2)}% of the disc's diameter from centre, ` +
        `past the 50% where the circle cuts it — the largest safe --score-logo-fit is ${(100 / Math.SQRT2).toFixed(2)}%`,
    );

    // And not so small that the disc is mostly empty. A mark at a third of the
    // disc is a bug in the other direction, and one nobody would report as
    // clipping.
    assert.ok(fit >= 0.6, `the mark is only ${(fit * 100).toFixed(1)}% of the disc — it floats rather than fits`);
  });

  test("the size is a percentage, so every chip size is covered by it", () => {
    // The disc is drawn at 32px in a card, 22px compact and 18px in the capsule,
    // and the capsule's width is not settled. A px value would be right at one of
    // those and wrong at the other two.
    const css = stylesheet();
    const rule = css.match(/\.score-logo img\s*\{([^}]*)\}/);
    assert.ok(rule, "the rule that sizes a team mark is gone");
    const body = rule[1];
    assert.match(body, /width:\s*var\(--score-logo-fit\)/, "the mark's width is not the declared fit");
    assert.match(body, /height:\s*var\(--score-logo-fit\)/, "the mark's height is not the declared fit");
    assert.doesNotMatch(body, /\d+px/, "the mark is sized in px, so it is wrong at two of its three sizes");
    // `contain` is what keeps a non-square source from being cropped INSIDE the
    // box. It was never the bug, and it must not become one.
    assert.match(body, /object-fit:\s*contain/, "the mark is no longer letterboxed, so a wide source is cropped");
  });
});
