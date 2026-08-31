import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { DISC, INK_DARK, INK_LIGHT, contrastOf, discInk, inkFor, luminance } from "./score-ink.js";

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
        contrastOf(c, ink) >= 4.5,
        `${c} → ${ink} is ${contrastOf(c, ink).toFixed(2)}:1`,
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

describe("contrastOf", () => {
  test("black on white is the 21:1 maximum", () => {
    assert.equal(Math.round(contrastOf("#000000", "#ffffff")), 21);
  });

  test("a colour against itself is 1:1", () => {
    assert.equal(contrastOf("#0e3386", "#0e3386"), 1);
  });

  test("is symmetric — the order of the pair cannot change the answer", () => {
    assert.equal(contrastOf("#ffb612", "#0a0a0a"), contrastOf("#0a0a0a", "#ffb612"));
  });

  test("accepts a bare hex as well as a prefixed one", () => {
    assert.equal(luminance("0e3386"), luminance("#0e3386"));
  });
});

describe("the disc behind every team mark", () => {
  test("THE GUARD: it is LIGHT, so a navy or black logo has something to sit on", () => {
    // The operator's report: ESPN ships `logos[0]` drawn for a light ground, and
    // on this app's near-black cards the Yankees and the Packers were marks you
    // could not see. Darken DISC and this fails.
    assert.ok(
      contrastOf(DISC, "#161616") > 10,
      `the disc ${DISC} does not stand off the near-black card it sits on`,
    );
    assert.ok(luminance(DISC) > 0.7, `the disc ${DISC} is not light`);
  });

  test("THE GUARD: it is the SAME disc for every team", () => {
    // It used to be the inverse of the team's own ink, which put two clubs in
    // one strip on opposite discs. DISC is a constant, not a function — this is
    // the assertion that a per-team version cannot come back without failing.
    assert.equal(typeof DISC, "string");
    assert.match(DISC, /^#[0-9a-f]{6}$/i);
  });

  test("a dark brand colour keeps its own colour for the no-logo abbreviation", () => {
    // 83 college football teams have no logo at all, and any church network that
    // blocks the CDN puts every team here. The brand colour survives where it
    // can be read.
    assert.equal(discInk("#0e3386"), "#0e3386"); // Cubs navy
    assert.equal(discInk("#204e32"), "#204e32"); // Packers green
  });

  test("THE GUARD: a LIGHT brand colour falls back to dark ink on the light disc", () => {
    // Roughly one club in ten. Its own colour on a light disc is unreadable, and
    // an identifier you cannot read is worse than one that is not on-brand.
    assert.equal(discInk("#ffb612"), INK_DARK); // Packers gold
    assert.equal(discInk("#fdb927"), INK_DARK); // Lakers gold
    assert.equal(discInk("#ffffff"), INK_DARK); // observed on a college team
    for (const c of [discInk("#ffb612"), discInk("#fdb927")]) {
      assert.ok(contrastOf(c, DISC) >= 4.5, `${c} is unreadable on the disc`);
    }
  });

  test("no colour at all still reads", () => {
    assert.equal(discInk(null), INK_DARK);
    assert.notEqual(discInk(null), INK_LIGHT);
  });

  test("THE GUARD: a colour it cannot read never comes back OUT of it", () => {
    // The bug: the hand-rolled luminance returned 0 for junk, so junk measured
    // as black — 18.76:1 against the disc — and discInk handed the string
    // straight back. `--score-disc-ink: nope` is invalid at computed-value time,
    // so .score-logo fell through to the inherited white ink and a dark-brand
    // team's abbreviation was invisible on the light disc. Exactly what discInk
    // is for, produced by discInk.
    //
    // inkFor's own contract already said "ESPN can send anything"; discInk sits
    // behind the same boundary and had the opposite behaviour.
    for (const bad of ["", "nope", "#12345", "rgb(1,2,3)", "#gggggg", "red"]) {
      assert.equal(discInk(bad), INK_DARK, bad);
    }
  });

  test("the SIX-DIGIT gate is unchanged by sharing the parse", () => {
    // parseColor also accepts #rgb, #rrggbbaa and rgba(); the hand-rolled parse
    // this replaced did not, and widening what a boundary accepts is a behaviour
    // change however harmless it looks. "#0e3" would now resolve to a light
    // #00ee33 and take dark ink, where before it fell through to the neutral
    // treatment. chipText holds the same line for the same reason.
    for (const wider of ["#0e3", "#0e3386ff", "rgba(14, 51, 134, 1)"]) {
      assert.equal(discInk(wider), INK_DARK, wider);
      assert.equal(inkFor(wider), INK_LIGHT, wider);
    }
  });

  test("takes ESPN's bare hex as readily as a prefixed one", () => {
    // ESPN sends "0e3386", not "#0e3386". scores-parse normalises on the way in
    // and this module normalises again, because its stated contract is that the
    // payload can be anything.
    assert.equal(discInk("0e3386"), discInk("#0e3386"));
    assert.equal(inkFor("0b162a"), inkFor("#0b162a"));
    assert.equal(luminance("0e3386"), luminance("#0e3386"));
  });

  test("every colour it returns is legible on the disc", () => {
    // The property, over the real team colours above: whatever comes back,
    // reading it against the disc is never below AA for small text.
    for (const c of TEAM_COLOURS) {
      assert.ok(
        contrastOf(discInk(c), DISC) >= 4.5,
        `${c} yielded ${discInk(c)}, which is unreadable on the disc`,
      );
    }
  });
});
