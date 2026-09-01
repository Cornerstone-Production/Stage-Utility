// The capsule's feather padding and its gradient stops move TOGETHER.
//
// `.score-side`'s colour is a percentage mask: opaque for the first N% of the
// side, then feathered to transparent. The panel's strip is wide, so 42% of it
// clears the logo and the score comfortably. The capsule is a sixth of that
// width, and the only thing keeping its number off the fade is padding — 22px of
// it, a quarter of the whole capsule, which is what made it 180px wide and 27%
// of the bar for one reading.
//
// Narrowing the padding ALONE drags the number into the feather. Measured in a
// browser with "SD 0 · Bot 3rd · 0 CIN": the shipped capsule backs its number at
// 0.74 opacity; padding cut to 16px with the panel's stops gives 0.578, and a
// tighter pass gives 0.499. With the stops shifted to match, 16px gives 0.834 —
// better than shipped, on a capsule 24px narrower.
//
// So this asserts the coupling, not the numbers: if the capsule narrows its
// feather it must carry stops of its own, and those stops must stay opaque for
// longer than the panel's. A capsule that drops the override and keeps the
// narrow padding is the regression this exists for.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, "styles.css"), "utf8");

/** The `#000 N%` stop — where the mask stops being fully opaque. */
function opaqueUntil(gradient: string): number {
  const stops = [...gradient.matchAll(/#000\s+(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  assert.ok(stops.length >= 2, `no #000 stops in: ${gradient}`);
  return Math.max(...stops);
}

/** Every declaration of `--score-feather-r`, in source order. */
function feathers(): string[] {
  return [...CSS.matchAll(/--score-feather-r:\s*([^;]+);/g)].map((m) => m[1]);
}

describe("the score capsule is narrow without putting its number in the fade", () => {
  const all = feathers();

  // EXACT. Two: the panel's, and the capsule's override. A third would mean a
  // surface nobody checked here, and zero would mean this scan reads nothing.
  it("there are exactly two feather gradients", () => {
    assert.equal(
      all.length,
      2,
      `expected the panel's gradient and the capsule's override, found ${all.length}`,
    );
  });

  const [panel, capsule] = all;

  it("the capsule stays opaque for longer than the panel", () => {
    assert.ok(
      opaqueUntil(capsule) > opaqueUntil(panel),
      `the capsule fades from ${opaqueUntil(capsule)}% and the panel from ${opaqueUntil(panel)}% — ` +
        "the capsule is a sixth of the panel's width, so the same stop puts its score under the feather",
    );
  });

  it("the panel's own gradient is untouched", () => {
    // The override is scoped to the capsule; the strip in the panel, the stack
    // card and the wall tile all still read the original.
    assert.equal(opaqueUntil(panel), 42, "the panel's feather moved — the capsule's override leaked");
  });

  it("the capsule's feather padding is narrower than the panel's", () => {
    const pad = CSS.match(/\.score-capsule \.score-side-away\s*\{[^}]*padding-right:\s*(\d+)px/);
    assert.ok(pad, "the capsule declares no feather padding");
    assert.ok(
      Number(pad[1]) <= 16,
      `the capsule pays ${pad[1]}px a side for its feather; 22px was a quarter of its whole width`,
    );
  });
});
