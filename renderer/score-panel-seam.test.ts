// The panel's shadow reaches the context bar exactly — no bright line, no cut.
//
// The panel floats `--score-shadow-t` below the bar. A card's shadow is offset
// DOWNWARD, so with a single `0 6px 20px` layer it reached only 4px above the
// card and the top 2px of that gap was bare page: a bright hairline running the
// full width of the panel, directly under the bar, which reads as the shadow
// having been sliced off by the bar.
//
// NOTHING WAS BEING CLIPPED. Measured on the reporter's own machine with the
// panel open — 24px of room on the left, 24 right, 6 top, 46 bottom, against
// reaches of 22, 22, 4 and 16. Slack on every edge. The gap needed FILLING.
//
// Two ways to get it wrong, and both were tried:
//
//   - widen the room, so the shadow has space to reach up. The room is also the
//     panel's offset from the bar, so this pushes the panel DOWN and opens a
//     wider strip of bare page. Measured: 6px of room gave a 2px bare gap, 12px
//     of room gave 5px.
//   - reach further up than the room allows, and the layer that exists to soften
//     the seam is itself clipped at the bar's edge.
//
// So the two numbers are one number: the upward reach must EQUAL the room. This
// asserts that, from the CSS, rather than asserting either value on its own.

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

const ROOM = (() => {
  const m = /--score-shadow-t:\s*(\d+(?:\.\d+)?)px/.exec(CSS);
  assert.ok(m, "--score-shadow-t is not declared");
  return Number(m[1]);
})();

describe("the score panel meets the bar without a seam", () => {
  it("the room above the panel is declared", () => {
    assert.ok(ROOM > 0, `--score-shadow-t is ${ROOM}px — the panel would sit against the bar`);
  });

  for (const selector of [".score-card", ".score-card.is-focused"]) {
    it(`${selector} reaches the bar exactly`, () => {
      const layers = shadowLayers(selector);
      assert.ok(
        layers.length >= 2,
        `${selector} has one shadow layer, offset downward — it cannot reach the ${ROOM}px above it, ` +
          "so the top of that gap renders as a bright line under the bar",
      );
      const up = Math.max(...layers.map(reachUp));
      assert.equal(
        up,
        ROOM,
        `${selector} reaches ${up}px above itself into ${ROOM}px of room — ` +
          (up < ROOM
            ? `${ROOM - up}px of bare page is left under the bar, which is the bright line`
            : `${up - ROOM}px of the shadow is clipped by the bar's edge`),
      );
    });
  }
});
