import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { INK_DARK, INK_LIGHT, contrastRatio, inkFor, inkSoft, luminance } from "./score-ink.js";

/**
 * Real team colours, straight off ESPN payloads. Half of them need dark ink and
 * half need light, which is the whole point: a fixed white is illegible on
 * roughly a third of the league.
 */
const TEAM_COLOURS = [
  "#c6011f", // Reds
  "#0e3386", // Cubs
  "#ffb612", // Packers
  "#0b162a", // Bears
  "#fdb927", // Lakers
  "#007a33", // Celtics
  "#6f263d", // Avalanche
  "#b4975a", // Golden Knights, Vegas gold
  "#003087", // Yankees
  "#bd3039", // Red Sox
  "#132448", // Yankees navy
  "#aa182c", // Diamondbacks
  "#ffffff", // observed as an NFL alternateColor
  "#000000",
];

describe("inkFor", () => {
  test("a near-white team colour gets dark ink", () => {
    assert.equal(inkFor("#ffffff"), INK_DARK);
    assert.equal(inkFor("#b4975a"), INK_DARK); // Vegas gold
  });

  test("a dark team colour gets light ink", () => {
    assert.equal(inkFor("#0e3386"), INK_LIGHT); // Cubs blue
    assert.equal(inkFor("#0b162a"), INK_LIGHT); // Bears navy
  });

  test("every ink choice clears 4.5:1", () => {
    for (const c of TEAM_COLOURS) {
      const ink = inkFor(c);
      assert.ok(
        contrastRatio(c, ink) >= 4.5,
        `${c} → ${ink} is ${contrastRatio(c, ink).toFixed(2)}:1`,
      );
    }
  });

  test("no colour is a colour, and gets light ink over the neutral surface", () => {
    assert.equal(inkFor(null), INK_LIGHT);
  });

  test("a malformed colour does not throw, and still yields a usable ink", () => {
    // ESPN is undocumented and can send anything. A colour that will not parse
    // must degrade to the neutral treatment rather than take a display down.
    for (const bad of ["", "nope", "#12345", "rgb(1,2,3)", "#gggggg"]) {
      assert.equal(inkFor(bad), INK_LIGHT, bad);
    }
  });
});

describe("contrastRatio", () => {
  test("black on white is the 21:1 maximum", () => {
    assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  });

  test("a colour against itself is 1:1", () => {
    assert.equal(contrastRatio("#0e3386", "#0e3386"), 1);
  });

  test("is symmetric — the order of the pair cannot change the answer", () => {
    assert.equal(contrastRatio("#ffb612", "#0a0a0a"), contrastRatio("#0a0a0a", "#ffb612"));
  });

  test("accepts a bare hex as well as a prefixed one", () => {
    assert.equal(luminance("0e3386"), luminance("#0e3386"));
  });
});

describe("inkSoft", () => {
  test("follows the ink it is given, so a chip never inverts against its own text", () => {
    assert.match(inkSoft(INK_LIGHT), /^rgba\(255,255,255/);
    assert.match(inkSoft(INK_DARK), /^rgba\(10,10,10/);
  });
});
