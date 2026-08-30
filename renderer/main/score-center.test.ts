// What this file does NOT guard, deliberately.
//
// jsdom loads no stylesheet, so getComputedStyle returns Tailwind defaults and
// offsetHeight is always 0. A test asserting the colour feather or the bases
// geometry would therefore PASS ON THE BUG, which is worse than no test. Both
// were verified in a real browser instead, and the measurements are recorded
// here so the next person does not have to rediscover them:
//
//  - The mask is on the background layer, never the element:
//    getComputedStyle(side).maskImage === "none" while
//    getComputedStyle(side, "::before").maskImage is the feather gradient, with
//    the ::before at z-index 0 and the content above it at full opacity. Masking
//    the element fades its own text, which is what made scores near the seam
//    hard to read.
//  - The diamond is a real diamond. Measuring the four cells' centres against
//    their common centre: DOM order second/first/third/home lands TOP / RIGHT /
//    LEFT / BOTTOM, so third base is on the LEFT and home is the hidden one.
//
// The pure rules below - which string is the period, and which side has the
// ball - are the parts a unit test can actually see.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { possessionSide, splitDetail } from "./score-center.js";

function team(over: Partial<ScoreTeamDTO> = {}): ScoreTeamDTO {
  return {
    id: "23",
    abbreviation: "SJSU",
    name: "Spartans",
    displayName: "San Jose State Spartans",
    color: "#0055a2",
    logo: null,
    record: null,
    score: 7,
    ...over,
  };
}

function game(over: Partial<ScoreGameDTO> = {}): ScoreGameDTO {
  return {
    eventId: "401864494",
    league: "nfl",
    sport: "football",
    state: "in",
    delayed: false,
    detail: "",
    shortDetail: "4:47 - 3rd",
    clock: "4:47",
    startsAt: "2026-08-29T20:00:00.000Z",
    venue: null,
    away: team(),
    home: team({ id: "30", abbreviation: "USC", name: "Trojans", displayName: "USC Trojans" }),
    situation: {
      kind: "football",
      down: 3,
      distance: 9,
      redZone: false,
      possession: "23",
      downDistance: "3rd & 9",
    },
    ...over,
  };
}

describe("splitDetail", () => {
  test("a clock sport's detail splits into clock and period", () => {
    assert.deepEqual(splitDetail("4:47 - 3rd", "4:47"), { period: "3rd", clock: "4:47" });
  });

  test("a detail that does not start with the clock is kept WHOLE", () => {
    // Guessing harder at ESPN's formatting risks a period label with a chunk
    // missing, which is worse than one that is merely long.
    assert.deepEqual(splitDetail("Top 3rd", ""), { period: "Top 3rd", clock: null });
    assert.deepEqual(splitDetail("End of 2nd", "0:00"), { period: "End of 2nd", clock: "0:00" });
  });

  test("a detail that is ONLY the clock keeps the clock as the period", () => {
    // Otherwise the centre would render an empty period line under the clock.
    assert.deepEqual(splitDetail("11:04", "11:04"), { period: "11:04", clock: "11:04" });
  });

  test("an empty clock is null, never an empty string to render", () => {
    assert.equal(splitDetail("Final", "").clock, null);
  });

  test("separators other than a hyphen still split", () => {
    assert.equal(splitDetail("3:22  2nd Quarter", "3:22").period, "2nd Quarter");
  });
});

describe("possessionSide", () => {
  test("maps the possession team id onto THIS game's away side", () => {
    assert.equal(possessionSide(game()), "away");
  });

  test("maps it onto the home side", () => {
    assert.equal(
      possessionSide(
        game({
          situation: {
            kind: "football",
            down: 1,
            distance: 10,
            redZone: false,
            possession: "30",
            downDistance: "1st & 10",
          },
        }),
      ),
      "home",
    );
  });

  test("THE GUARD: an id belonging to NEITHER team points at nobody", () => {
    // possessionText is "SJSU 28" — the ball's field position, not a team. If it
    // ever reaches this field, the only safe answer is no arrow at all. Picking
    // a default side would put an arrow on the wrong team and leave it there.
    assert.equal(
      possessionSide(
        game({
          situation: {
            kind: "football",
            down: 3,
            distance: 9,
            redZone: false,
            possession: "SJSU 28",
            downDistance: "3rd & 9",
          },
        }),
      ),
      null,
    );
  });

  test("no possession is no arrow", () => {
    assert.equal(
      possessionSide(
        game({
          situation: {
            kind: "football",
            down: null,
            distance: 0,
            redZone: false,
            possession: null,
            downDistance: null,
          },
        }),
      ),
      null,
    );
  });

  test("a sport with no possession concept is no arrow", () => {
    assert.equal(possessionSide(game({ situation: { kind: "hockey" } })), null);
    assert.equal(possessionSide(game({ situation: null })), null);
  });
});
