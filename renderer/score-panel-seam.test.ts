// The panel's shadow paints ONTO the context bar.
//
// It could not before, and no amount of room on the other edges changed that:
// `.score-clip` hides its overflow and its top edge sat exactly at the bar's
// bottom, so the shadow stopped dead at the boundary. That hard line is what
// reads as a sliced shadow — reported three times, against measurements that
// kept saying every edge had slack, because every edge did.
//
// Two earlier attempts are worth knowing about, because both made it worse:
//
//   - widen `--score-shadow-t`. It is also the panel's offset from the bar, so
//     more room pushed the panel DOWN and opened a wider strip of bare page.
//     Measured: 6px of room gave a 2px bare gap, 12px gave 5px.
//   - fill the gap with an upward shadow layer tuned to exactly the room. That
//     removed the bright line but the shadow still terminated at the bar, which
//     is the thing that was actually wrong.
//
// So the clip now starts `--score-cast` ABOVE the bar's bottom edge, and the same
// amount is added to the shell's top margin — the cards do not move, and what
// fills the band is shadow. Measured with the panel open on two live games: the
// clip starts 24px above the bar, the first card is unmoved at y=50, the shadow
// reaches y=36, and the bar's bottom 8px carry it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(HERE, "styles.css"), "utf8");

/** How far a `0 Ypx Bpx` layer reaches above its own box: blur/2 − offsetY. */
function reachUp(layer: string): number {
  // The X offset is written as a unitless `0`, so its `px` is optional here.
  const m = /(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/.exec(layer);
  assert.ok(m, `not a shadow layer: ${layer}`);
  return Number(m[3]) / 2 - Number(m[2]);
}

/** Every layer of one rule's box-shadow. */
function shadowLayers(selector: string): string[] {
  const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(rule, `no rule for ${selector}`);
  const decl = /box-shadow:\s*([^;]+);/.exec(rule[1]);
  assert.ok(decl, `${selector} sets no box-shadow`);
  return decl[1].split(/,(?![^(]*\))/).map((l) => l.trim());
}

/** How far the clip starts above the bar's bottom edge. */
const CAST = (() => {
  const m = /--score-cast:\s*(\d+(?:\.\d+)?)px/.exec(CSS);
  assert.ok(m, "--score-cast is not declared");
  return Number(m[1]);
})();

/** How far the panel floats below the bar — the gap the shadow must cross. */
const FLOAT = (() => {
  const m = /--score-shadow-t:\s*calc\((\d+(?:\.\d+)?)px\s*\+/.exec(CSS);
  assert.ok(m, "--score-shadow-t is no longer the float plus the cast");
  return Number(m[1]);
})();

/** Total room above the cards inside the clip. */
const ROOM = FLOAT + CAST;

describe("the score panel casts onto the bar", () => {
  it("the clip starts above the bar, so the shadow has somewhere to go", () => {
    assert.ok(
      CAST > 0,
      "--score-cast is 0 — the clip's top edge is the bar's bottom edge again, and the shadow will stop dead at it",
    );
    assert.match(
      CSS,
      /top:\s*calc\(-1 \* var\(--score-cast\)\)/,
      "the host does not start above the bar, so the room --score-cast reserves is never opened",
    );
  });

  it("the panel does not move when the room opens", () => {
    // The band is paid for out of the shell's top margin. If the two ever stop
    // matching, the cards slide down the page by the difference.
    assert.match(
      CSS,
      /--score-shadow-t:\s*calc\(\d+(?:\.\d+)?px\s*\+\s*var\(--score-cast\)\)/,
      "the shell's top margin no longer tracks --score-cast, so opening the band moves the cards",
    );
  });

  for (const selector of [".score-card", ".score-card.is-focused"]) {
    it(`${selector} reaches past the bar rather than stopping at it`, () => {
      const layers = shadowLayers(selector);
      assert.ok(
        layers.length >= 2,
        `${selector} has one shadow layer, offset downward — it reaches barely above the card, ` +
          `so it cannot cross the ${FLOAT}px the panel floats below the bar, let alone paint on it`,
      );
      const up = Math.max(...layers.map(reachUp));
      assert.ok(
        up > FLOAT,
        `${selector} reaches ${up}px above itself and the panel floats ${FLOAT}px below the bar — ` +
          "the shadow ends in the gap, which is the bright line all over again",
      );
      assert.ok(
        up <= ROOM,
        `${selector} reaches ${up}px into ${ROOM}px of room — the last ${up - ROOM}px is clipped, ` +
          "which is the cut this whole arrangement exists to remove",
      );
    });
  }

  it("the bar keeps room to spare, so the corners are not cut either", () => {
    // A shadow's corner is a rounded blob: it reaches further diagonally than on
    // either axis, so matching the axis exactly still cuts the corners.
    const up = Math.max(...shadowLayers(".score-card.is-focused").map(reachUp));
    assert.ok(
      ROOM - up >= 8,
      `only ${ROOM - up}px of headroom above the shadow's reach — the corners will clip before the edges do`,
    );
  });
});
