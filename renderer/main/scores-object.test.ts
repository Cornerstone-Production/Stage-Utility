// scores-object.test.ts — which game a wall tile shows.
//
// This is the whole decision the object makes, and the two ways it can be wrong
// are both quiet: a tile that follows the wrong game looks exactly like a tile
// following the right one, and a tile that resolves nothing looks exactly like a
// broken integration. Neither announces itself from across a room.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

const { pickGame, teamPin } = await import("./scores-object.js");

const TEAM = (id: string, score: number | null): ScoreTeamDTO => ({
  id,
  abbreviation: `T${id}`,
  name: `Team ${id}`,
  displayName: `Team ${id}`,
  color: null,
  logo: null,
  record: null,
  score,
});

function game(over: Partial<ScoreGameDTO> & { eventId: string }): ScoreGameDTO {
  return {
    league: "mlb",
    sport: "baseball",
    state: "in",
    delayed: false,
    detail: "Top 3rd",
    shortDetail: "Top 3rd",
    clock: "",
    startsAt: "2026-08-14T18:05:00.000Z",
    venue: null,
    away: TEAM("1", 0),
    home: TEAM("2", 0),
    situation: null,
    ...over,
  };
}

function status(games: ScoreGameDTO[], over: Partial<ScoresStatusDTO> = {}): ScoresStatusDTO {
  return {
    connected: true,
    games,
    scoreRev: 0,
    lastEvents: [],
    fetchedAt: null,
    error: null,
    ...over,
  };
}

describe("auto follows whatever is actually being played", () => {
  test("prefers the game that just scored over the one that starts first", () => {
    // THE GUARD. `games` is sorted by start time, so "the first live game" is a
    // perfectly reasonable-looking rule -- and a wall would sit on a game that
    // had not moved while another one scored.
    const a = game({ eventId: "a" });
    const b = game({ eventId: "b" });
    const s = status([a, b], { lastEvents: [{ eventId: "b", teamId: "2", from: 0, to: 1 }] });
    assert.equal(pickGame(s, "auto")?.eventId, "b");
  });

  test("with nothing live yet, shows the next one on rather than going blank", () => {
    // A wall on the afternoon of a game says "7:05 PM", not nothing. Falling
    // through to null here is the failure that looks identical to a broken
    // integration from across a room.
    const s = status([game({ eventId: "a", state: "post" }), game({ eventId: "b", state: "pre" })]);
    assert.equal(pickGame(s, "auto")?.eventId, "b");
  });

  test("with everything finished, keeps the last final up", () => {
    const s = status([game({ eventId: "a", state: "post" }), game({ eventId: "b", state: "post" })]);
    assert.equal(pickGame(s, "auto")?.eventId, "b");
  });

  test("no games at all is null, and the caller says why", () => {
    assert.equal(pickGame(status([]), "auto"), null);
    assert.equal(pickGame(null, "auto"), null);
  });
});

describe("a pinned TEAM resolves that team's game", () => {
  test("matches on either side of the game, never just the home side", () => {
    // THE GUARD. A team id is not a side. Matching only `home.id` would leave
    // every away fixture resolving to nothing -- roughly half the season, on a
    // tile the operator set up and watched work at home.
    const away = game({ eventId: "a", away: TEAM("7", 1), home: TEAM("2", 0) });
    const home = game({ eventId: "h", away: TEAM("1", 0), home: TEAM("7", 3) });
    assert.equal(pickGame(status([away]), "7")?.eventId, "a");
    assert.equal(pickGame(status([home]), "7")?.eventId, "h");
  });

  test("a team not playing today is null, not somebody else's game", () => {
    // THE GUARD. Falling back to "auto" here would put a DIFFERENT team's score
    // under a tile the operator pinned -- which reads as correct and is not.
    const other = game({ eventId: "x", away: TEAM("1", 4), home: TEAM("2", 5) });
    assert.equal(pickGame(status([other]), "7"), null);
  });

  test("a doubleheader shows the half being played, not the first listed", () => {
    // THE GUARD. Both halves are that team's game today and the earlier one is
    // first in the list, so "the first match" shows a final all evening while
    // the second game is in play.
    const first = game({ eventId: "g1", state: "post", away: TEAM("7", 2), home: TEAM("2", 5) });
    const second = game({ eventId: "g2", state: "in", away: TEAM("7", 1), home: TEAM("2", 0) });
    assert.equal(pickGame(status([first, second]), "7")?.eventId, "g2");
  });

  test("with both halves finished, the later one stays up", () => {
    const first = game({ eventId: "g1", state: "post", away: TEAM("7", 2), home: TEAM("2", 5) });
    const second = game({ eventId: "g2", state: "post", away: TEAM("7", 1), home: TEAM("2", 0) });
    assert.equal(pickGame(status([first, second]), "7")?.eventId, "g2");
  });

  test("before either half starts, the earlier one is next", () => {
    const first = game({ eventId: "g1", state: "pre", away: TEAM("7", null), home: TEAM("2", null) });
    const second = game({ eventId: "g2", state: "pre", away: TEAM("7", null), home: TEAM("2", null) });
    assert.equal(pickGame(status([first, second]), "7")?.eventId, "g1");
  });
});

describe("a pin names a LEAGUE as well as a team", () => {
  // ESPN's team ids repeat across leagues: measured over the eight leagues the
  // picker offers, 267 ids name DIFFERENT clubs in different ones. Id 16 alone
  // is the Cubs, the Vikings, the Timberwolves, the Penguins and Sacramento
  // State. A church that follows two of those and pinned a tile to one was
  // getting whichever game happened to be live — the wrong sport on the wall,
  // with nothing to say it went wrong.
  const cubs = game({ eventId: "cubs", league: "mlb", away: TEAM("16", 3), home: TEAM("2", 1) });
  const vikings = game({
    eventId: "vikings",
    league: "nfl",
    sport: "football",
    away: TEAM("16", 21),
    home: TEAM("9", 17),
  });

  test("THE GUARD: a league-qualified pin resolves inside that league only", () => {
    // Drop the league half of the comparison and this returns the Cubs for an
    // NFL tile: both are live and the Cubs game is first in the list.
    assert.equal(pickGame(status([cubs, vikings]), teamPin("nfl", "16"))?.eventId, "vikings");
    assert.equal(pickGame(status([cubs, vikings]), teamPin("mlb", "16"))?.eventId, "cubs");
  });

  test("a pin into a league with no game today is null, not the other league's", () => {
    assert.equal(pickGame(status([cubs]), teamPin("nfl", "16")), null);
  });

  test("teamPin writes the key the picker reads", () => {
    assert.equal(teamPin("ncaaf", "130"), "ncaaf:130");
    assert.equal(
      pickGame(
        status([
          game({ eventId: "mich", league: "ncaaf", sport: "football", away: TEAM("130", 7) }),
        ]),
        teamPin("ncaaf", "130"),
      )?.eventId,
      "mich",
    );
  });

  test("a BARE id from a layout saved before this still resolves", () => {
    // No migration: an id on its own names up to five clubs, so guessing a
    // league for it would invent the very ambiguity the pin format removes. Old
    // configs keep exactly the behaviour they had.
    assert.equal(pickGame(status([cubs]), "16")?.eventId, "cubs");
  });
});

// ── The fit ──────────────────────────────────────────────────────────────────
//
// WHAT IS BROWSER-ONLY, AND WHY IT IS NOT GUARDED HERE.
//
// The defect these replace was three visual facts, and jsdom can see none of
// them: it does not lay out, so it has no overflow, no clipping and no scaled
// geometry. A test asserting "the home team is visible at 296px" would have
// passed on the very bug it was written for — the strip was in the DOM the whole
// time, sitting outside a box with `overflow: hidden`. So those three were
// verified by driving the production bundle in a real browser and reading
// getBoundingClientRect, and what is guarded here is the ARITHMETIC underneath
// them, which is real in JS:
//
//   • that the laid-out size times the zoom IS the box — filling is what
//     fitStrip returns, not something CSS happens to do;
//   • that no box resolves to a zero or non-finite size, i.e. to "draw
//     nothing", which on a wall is indistinguishable from a broken widget;
//   • that the strip is never laid out narrower than the width its design is
//     drawn at, which is what keeps the fix from being a redesign.

const { fitStrip } = await import("./scores-object.js");

/** The strip's measured natural height at its designed width, from the browser:
 *  86px for baseball with the detail centre. */
const NAT_H = 86;

/** Every box the object is actually given, measured off the real app at a
 *  1400px window: the five Home tiles, and the canvas tiles from the audit —
 *  including the two that used to clip and blank. */
const BOXES: [string, number, number][] = [
  ["home s", 369, 118],
  ["home m", 751, 118],
  ["home l", 751, 250],
  ["home xl", 1134, 250],
  ["home tall", 1134, 514],
  ["canvas wide", 1108, 400],
  ["canvas 300", 300, 154],
  ["canvas 166 (blanked)", 166, 89],
  ["canvas 369 (clipped)", 369, 93],
  ["canvas tall", 300, 481],
];

describe("the strip fills the box it is given", () => {
  test("laid-out size times the zoom is the box, at every size", () => {
    // THE GUARD, and the whole change in one line. Before, the strip was laid
    // out at a FIXED 520 x natural and scaled: the width happened to come out
    // right whenever the fit was width-limited, but the HEIGHT never did — which
    // is the ~6:1 band floating in dead ground the operator reported. Pin the
    // natural height back into `height` and this goes red on every row.
    for (const [name, w, h] of BOXES) {
      const fit = fitStrip(w, h, NAT_H);
      assert.ok(
        Math.abs(fit.width * fit.scale - w) < 0.01,
        `${name}: ${fit.width} x ${fit.scale} = ${fit.width * fit.scale}, want width ${w}`,
      );
      assert.ok(
        Math.abs(fit.height * fit.scale - h) < 0.01,
        `${name}: ${fit.height} x ${fit.scale} = ${fit.height * fit.scale}, want height ${h}`,
      );
    }
  });

  test("still fills when the zoom hits either clamp", () => {
    // The bounds cap how large the design may be DRAWN; they must not cap how
    // much of the box it covers. A fit that stopped filling at the clamp would
    // put the dead ground back at exactly the sizes where it is most obvious.
    for (const [w, h] of [[40, 900], [4000, 60], [8, 8], [6000, 4000]]) {
      const fit = fitStrip(w, h, NAT_H);
      assert.ok(Math.abs(fit.width * fit.scale - w) < 0.01, `${w}x${h} width`);
      assert.ok(Math.abs(fit.height * fit.scale - h) < 0.01, `${w}x${h} height`);
    }
  });
});

describe("no box resolves to drawing nothing", () => {
  test("every size in a swept range is finite and positive", () => {
    // A wall widget that renders nothing is indistinguishable from one that is
    // broken — the failure this object's own Empty component exists to refuse,
    // and exactly what a 166px tile did. Swept rather than sampled, because the
    // sizes that broke were not ones anybody would have thought to pick.
    for (let w = 1; w <= 2400; w += 7) {
      for (let h = 1; h <= 1400; h += 11) {
        const fit = fitStrip(w, h, NAT_H);
        assert.ok(Number.isFinite(fit.scale) && fit.scale > 0, `${w}x${h}: scale ${fit.scale}`);
        assert.ok(Number.isFinite(fit.width) && fit.width >= 1, `${w}x${h}: width ${fit.width}`);
        assert.ok(Number.isFinite(fit.height) && fit.height >= 1, `${w}x${h}: height ${fit.height}`);
      }
    }
  });

  test("a box of zero, and an unmeasured natural height, still resolve", () => {
    // The first frame, and jsdom. Neither may produce a NaN transform, which
    // renders as nothing at all.
    for (const [w, h, nat] of [[0, 0, 0], [0, 300, NAT_H], [300, 0, NAT_H], [300, 150, 0]]) {
      const fit = fitStrip(w, h, nat);
      assert.ok(Number.isFinite(fit.scale) && fit.scale > 0, `${w}x${h}/${nat}: scale`);
      assert.ok(Number.isFinite(fit.width) && fit.width > 0, `${w}x${h}/${nat}: width`);
      assert.ok(Number.isFinite(fit.height) && fit.height > 0, `${w}x${h}/${nat}: height`);
    }
  });
});

describe("filling the box is not a redesign", () => {
  test("the strip is never laid out narrower than the width it is designed at", () => {
    // THE GUARD against the obvious wrong fix. Stretching the strip to the tile
    // — rather than laying it out at its designed width and zooming — reflows it
    // at whatever width the tile happens to be, which drops the team names
    // through .score-strip's own 460px container rule and re-proportions
    // everything against a design drawn for 520.
    for (const [name, w, h] of BOXES) {
      const fit = fitStrip(w, h, NAT_H);
      assert.ok(fit.width >= 520 - 0.01, `${name}: laid out at ${fit.width}, want >= 520`);
    }
  });

  test("the zoom is unchanged from what the fixed-size fit already produced", () => {
    // Measured off the shipped build BEFORE the change, in the browser. The
    // operator approved how this looks; the fix is that it now fills its box,
    // not that it is drawn at a different size. A change to NATURAL_W or to the
    // bounds moves these, and should be argued rather than slipped in.
    const zooms: [string, number, number, number][] = [
      ["home s", 369, 118, 0.709615],
      ["home m", 751, 118, 1.372093],
      ["home l", 751, 250, 1.444231],
      ["home xl", 1134, 250, 2.180769],
      ["home tall", 1134, 514, 2.180769],
    ];
    for (const [name, w, h, was] of zooms) {
      const got = fitStrip(w, h, NAT_H).scale;
      assert.ok(Math.abs(got - was) < 0.001, `${name}: zoom ${got}, was ${was}`);
    }
  });
});
