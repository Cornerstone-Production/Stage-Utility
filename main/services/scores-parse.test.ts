// scores-parse.test.ts — the fold and the diff, against real ESPN payloads.
//
// Both fixtures are real, unmodified-in-substance responses captured on
// 2026-08-29 and trimmed to the fields the parser reads (see the header of each).
// That matters: the two bugs this file exists to catch — a team-keyed diff
// smearing a doubleheader, and a missing score read as nil-nil — are only
// visible against a payload nobody invented.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { baselineOf, diffScores, parseScoreboard, scoresChanged, sortGames } from "./scores-parse.js";
import { SCORES_OFFLINE, type ScoreGameDTO, type ScoresStatusDTO } from "../types/scores.js";

const MLB = JSON.parse(
  readFileSync(new URL("./fixtures/espn-mlb-doubleheader.json", import.meta.url), "utf8"),
);
const NFL = JSON.parse(
  readFileSync(new URL("./fixtures/espn-nfl-scoreboard.json", import.meta.url), "utf8"),
);
// A football slate captured WHILE a game was in play, so it carries a real
// `situation.possession`. It is college football, not the NFL, only because no
// NFL game was in play on the capture date — both are `football/` on the same
// endpoint and the situation object is the same shape. The parser is told "nfl"
// because the league id selects the SPORT arm, and that arm is what is under test.
const FOOTBALL_LIVE = JSON.parse(
  readFileSync(new URL("./fixtures/espn-football-in-play.json", import.meta.url), "utf8"),
);

/** New York Yankees. Present twice in the MLB fixture — it is the doubleheader. */
const NYY = "10";

/** Every competitor id in a fixture, so parseScoreboard returns the whole slate. */
function allTeamIds(payload: {
  events: { competitions: { competitors: { id: string }[] }[] }[];
}): Set<string> {
  return new Set(
    payload.events.flatMap((e) => e.competitions[0].competitors.map((c) => c.id)),
  );
}

describe("parseScoreboard", () => {
  test("keeps only games a followed team is in", () => {
    const games = parseScoreboard("mlb", MLB, new Set([NYY]));
    assert.ok(games.length > 0, "the fixture must contain a game for team 10");
    for (const g of games) {
      assert.ok(g.away.id === NYY || g.home.id === NYY, `${g.eventId} has no followed team`);
    }
  });

  test("score is a NUMBER, never the string ESPN sends", () => {
    const games = parseScoreboard("mlb", MLB, new Set([NYY]));
    for (const g of games) {
      for (const t of [g.away, g.home]) {
        assert.ok(
          t.score === null || typeof t.score === "number",
          `${t.abbreviation} score is ${typeof t.score}`,
        );
      }
    }
  });

  test("an absent score is null, not 0", () => {
    // Strip the scores off one competitor and confirm the fold says "no reading"
    // rather than inventing a nil-nil game.
    const doctored = structuredClone(MLB);
    delete doctored.events[0].competitions[0].competitors[0].score;
    const id = doctored.events[0].competitions[0].competitors[0].id;
    const g = parseScoreboard("mlb", doctored, new Set([id]))[0];
    const side = g.away.id === id ? g.away : g.home;
    assert.equal(side.score, null);
  });

  test("colours arrive prefixed with #", () => {
    // The assertion used to sit inside `if (t.color !== null)`, which meant it
    // skipped itself the moment the parser stopped producing a colour at all:
    // returning `color: null` from parseTeam left the whole file green. So the
    // exact hex is named, and the count is exact — every competitor in the
    // fixture carries a colour, so anything less than all of them is the bug.
    const games = parseScoreboard("mlb", MLB, new Set([NYY]));
    assert.equal(games[0].home.color, "#132448", "the home team's colour is not the fixture's");
    assert.equal(games[0].away.color, "#0d2b56", "the away team's colour is not the fixture's");

    const slate = parseScoreboard("mlb", MLB, allTeamIds(MLB));
    const colours = slate.flatMap((g) => [g.away.color, g.home.color]);
    assert.equal(colours.length, 34, "the fixture must carry 17 games' worth of competitors");
    assert.equal(
      colours.filter((c) => c !== null).length,
      34,
      "a competitor lost its colour: every one in this fixture has one",
    );
    for (const c of colours) assert.match(c!, /^#[0-9a-f]{6}$/, `${c} is not a css hex colour`);
  });

  test("ESPN's bare six-digit hex is the only thing read as a colour", () => {
    // The `#` prefix is added here, so a parser that passed the raw value
    // through would hand CSS a string it silently ignores. Anything that is not
    // six hex digits is not a colour and must be null rather than "#undefined".
    const doctored = structuredClone(MLB);
    const comps = doctored.events[0].competitions[0].competitors;
    comps[0].team.color = "not-a-colour";
    delete comps[1].team.color;
    const g = parseScoreboard("mlb", doctored, new Set([NYY]))[0];
    assert.equal(g.home.color, null);
    assert.equal(g.away.color, null);
  });

  test("a football payload with no baseball fields still folds", () => {
    // The situation object is sport-shaped. This is the degradation guard: a
    // sport whose situation lacks everything the renderer might want must yield
    // a game with a null or football situation, never throw.
    const games = parseScoreboard("nfl", NFL, allTeamIds(NFL));
    assert.ok(games.length > 0);
    for (const g of games) {
      assert.ok(g.situation === null || g.situation.kind === "football");
      assert.equal(g.sport, "football");
    }
  });

  test("TIMEOUT: no down and no possession, and neither throws", () => {
    // The exact situation shape observed on a live NFL game sitting in an
    // official timeout. ESPN OMITS `possession` entirely there — absent, not
    // null — so this is the guard that the parser reads a missing key as "we
    // cannot see who has the ball" rather than throwing or inventing a side.
    const doctored = structuredClone(NFL);
    doctored.events[0].competitions[0].situation = {
      down: -1,
      yardLine: 35,
      distance: 0,
      isRedZone: true,
      homeTimeouts: 3,
      awayTimeouts: 3,
    };
    const id = doctored.events[0].competitions[0].competitors[0].id;
    const g = parseScoreboard("nfl", doctored, new Set([id]))[0];
    assert.deepEqual(g.situation, {
      kind: "football",
      down: null,
      distance: 0,
      redZone: true,
      possession: null,
      downDistance: null,
    });
  });

  test("IN PLAY: possession is one of the two teams actually in the game", () => {
    // possession is a bare team id. The trap it guards is possessionText, which
    // despite the name is the ball's FIELD POSITION ("SJSU 28") and matches
    // neither competitor id — so asserting membership, not just non-null, is
    // what makes this fail on the wrong field.
    const games = parseScoreboard("nfl", FOOTBALL_LIVE, allTeamIds(FOOTBALL_LIVE));
    const withBall = games.filter(
      (g) => g.situation?.kind === "football" && g.situation.possession !== null,
    );
    assert.ok(
      withBall.length > 0,
      "the fixture must contain a game in play with possession — see Task 1 Step 2",
    );
    for (const g of withBall) {
      assert.equal(g.situation?.kind, "football");
      const possession = g.situation.kind === "football" ? g.situation.possession : null;
      assert.ok(
        possession === g.away.id || possession === g.home.id,
        `${g.eventId}: possession ${JSON.stringify(possession)} is neither ${g.away.id} nor ${g.home.id}`,
      );
    }
  });

  test("FIRST SNAP OF A DRIVE: a down and distance with no possession survives", () => {
    // Observed between a kickoff and the receiving team's first snap:
    // shortDownDistanceText is present ("1st & 10") while possession is absent.
    // The two are INDEPENDENT. A parser that read them as a pair — bailing out
    // of the football arm when possession is missing — would silently drop the
    // down and distance for the opening play of every single drive.
    const doctored = structuredClone(FOOTBALL_LIVE);
    const ev = doctored.events.find(
      (e: { competitions: { situation?: { possession?: string } }[] }) =>
        e.competitions[0].situation?.possession,
    );
    assert.ok(ev, "the fixture must contain a game in play with possession");
    delete ev.competitions[0].situation.possession;
    ev.competitions[0].situation.shortDownDistanceText = "1st & 10";

    const id = ev.competitions[0].competitors[0].id;
    const g = parseScoreboard("nfl", doctored, new Set([id]))[0];
    assert.equal(g.situation?.kind, "football");
    assert.equal(g.situation.kind === "football" ? g.situation.possession : "unset", null);
    assert.equal(g.situation.kind === "football" ? g.situation.downDistance : null, "1st & 10");
  });

  test("IN PLAY: down and distance come from ESPN's SHORT form", () => {
    // The long downDistanceText is "3rd & 9 at SJSU 28" — it repeats the field
    // position the centre has no room for. The short form is "3rd & 9".
    const games = parseScoreboard("nfl", FOOTBALL_LIVE, allTeamIds(FOOTBALL_LIVE));
    const shown = games
      .map((g) => (g.situation?.kind === "football" ? g.situation.downDistance : null))
      .filter((d): d is string => d !== null);
    assert.ok(shown.length > 0, "the fixture must contain a game in play with a down and distance");
    for (const d of shown) {
      assert.doesNotMatch(d, / at /, `${d} is the long form, which carries field position`);
    }
  });

  test("a payload missing competitions entirely is skipped, not thrown on", () => {
    const doctored = { events: [{ id: "x", date: "2026-08-29T17:05Z", status: {}, competitions: [] }] };
    assert.deepEqual(parseScoreboard("mlb", doctored, new Set([NYY])), []);
  });

  test("hands the slate back SORTED, whatever order ESPN sent it in", () => {
    // `return sortGames(out)` was free: the fixture already arrives ascending,
    // so `return out` passed the whole file. ESPN promises no order between
    // polls, and a stack of cards that reshuffles is unreadable.
    const forwards = parseScoreboard("mlb", MLB, allTeamIds(MLB)).map((g) => g.eventId);
    const reversed = structuredClone(MLB);
    reversed.events.reverse();
    assert.deepEqual(
      parseScoreboard("mlb", reversed, allTeamIds(MLB)).map((g) => g.eventId),
      forwards,
      "a reversed payload came back in a different order",
    );
  });

  test("an EMPTY favourites set follows nothing, not everything", () => {
    // "Follow everything" is not a state this feature has. Adding
    // `followed.size > 0 &&` to the guard — a very natural-looking fix —
    // silently turns an empty list into every game in the league, and the
    // poller then renders fifteen games nobody asked for.
    assert.deepEqual(parseScoreboard("mlb", MLB, new Set()), []);
  });

  test("a scheduled game is 'pre', and so is one whose status makes no sense", () => {
    // parseState's default was unpinned: `v === "post" ? "post" : "in"` left the
    // file green, which renders every scheduled game as LIVE.
    const scheduled = parseScoreboard("mlb", MLB, allTeamIds(MLB)).filter((g) => g.state === "pre");
    assert.equal(scheduled.length, 5, "the fixture must contain scheduled games");

    const doctored = structuredClone(MLB);
    const ev = doctored.events[0];
    const id = ev.competitions[0].competitors[0].id;
    for (const state of ["pre", "nonsense", undefined]) {
      if (state === undefined) delete ev.status.type.state;
      else ev.status.type = { ...ev.status.type, state };
      const g = parseScoreboard("mlb", doctored, new Set([id]))[0];
      assert.equal(g.state, "pre", `state ${JSON.stringify(state)} did not read as "pre"`);
    }
    // And the two states that ARE real still come through.
    ev.status.type = { ...ev.status.type, state: "in" };
    assert.equal(parseScoreboard("mlb", doctored, new Set([id]))[0].state, "in");
    ev.status.type = { ...ev.status.type, state: "post" };
    assert.equal(parseScoreboard("mlb", doctored, new Set([id]))[0].state, "post");
  });

  test("a delayed game reports delayed, even though its state is in", () => {
    const doctored = structuredClone(MLB);
    const ev = doctored.events[0];
    ev.status.type = { ...ev.status.type, state: "in", name: "STATUS_DELAYED" };
    const id = ev.competitions[0].competitors[0].id;
    const g = parseScoreboard("mlb", doctored, new Set([id]))[0];
    assert.equal(g.state, "in");
    assert.equal(g.delayed, true);
  });
});

describe("diffScores", () => {
  test("THE DOUBLEHEADER: two games between the same two teams do not smear", () => {
    // This is the guard the whole file exists for. BOS @ NYY is played twice on
    // this date. A diff keyed on the TEAM sees one game's score against the
    // other's and reports a change that never happened — in both directions,
    // every poll, forever.
    const games = parseScoreboard("mlb", MLB, allTeamIds(MLB));
    const pairs = new Map<string, ScoreGameDTO[]>();
    for (const g of games) {
      const key = [g.away.id, g.home.id].sort().join("~");
      pairs.set(key, [...(pairs.get(key) ?? []), g]);
    }
    const doubled = [...pairs.values()].find((gs) => gs.length > 1);
    assert.ok(doubled, "the fixture must contain a doubleheader — see Task 1 Step 2");
    assert.notEqual(doubled[0].eventId, doubled[1].eventId);
    // The two games must differ on at least one side's score, or a team-keyed
    // diff would produce no event and this guard could pass on the bug.
    assert.notDeepEqual(
      [doubled[0].away.score, doubled[0].home.score],
      [doubled[1].away.score, doubled[1].home.score],
    );

    // Same list, twice. Nothing changed, so nothing is reported.
    const base = baselineOf(games);
    assert.deepEqual(diffScores(base, games), []);
  });

  test("a real score reports exactly one event, with from and to", () => {
    const games = parseScoreboard("mlb", MLB, new Set([NYY]));
    const g = games.find((x) => x.away.score !== null && x.home.score !== null);
    assert.ok(g, "the fixture must contain a game with both scores present");
    const base = baselineOf(games);
    const after = structuredClone(games);
    const target = after.find((x) => x.eventId === g.eventId)!;
    const before = target.home.score!;
    target.home.score = before + 1;

    const events = diffScores(base, after);
    assert.deepEqual(events, [
      { eventId: g.eventId, teamId: g.home.id, from: before, to: before + 1 },
    ]);
  });

  test("null to a number is NOT a score", () => {
    const games = parseScoreboard("mlb", MLB, new Set([NYY]));
    const after = structuredClone(games);
    after[0].home.score = 0;
    const base = new Map(baselineOf(games));
    base.set(`${after[0].eventId}:${after[0].home.id}`, null);
    assert.deepEqual(diffScores(base, after), []);
  });

  test("an unseen game does not report every team as having scored", () => {
    // The first successful poll seeds the baseline and emits nothing. Without
    // this, every followed team "scores" the moment the server starts.
    const games = parseScoreboard("mlb", MLB, new Set([NYY]));
    assert.deepEqual(diffScores(new Map(), games), []);
  });

  test("a score going DOWN is reported, so a reversal is not silently swallowed", () => {
    // Whichever side happens to be non-zero in the fixture — which side that is
    // depends on the day's results, and the rule under test does not.
    const games = parseScoreboard("mlb", MLB, allTeamIds(MLB));
    const found = games.flatMap((g) =>
      (["away", "home"] as const)
        .filter((s) => (g[s].score ?? 0) > 0)
        .map((s) => ({ eventId: g.eventId, side: s })),
    )[0];
    assert.ok(found, "the fixture must contain a game with a non-zero score");
    const base = baselineOf(games);
    const after = structuredClone(games);
    const target = after.find((x) => x.eventId === found.eventId)!;
    target[found.side].score = target[found.side].score! - 1;
    assert.equal(diffScores(base, after).length, 1);
  });
});

describe("sortGames", () => {
  test("is ASCENDING by start time, not merely deterministic", () => {
    // This used to sort a reversed copy and compare it to a sorted original,
    // which proves the comparator is a function of its inputs and nothing else:
    // sorting DESCENDING, or ignoring startsAt entirely, both passed it. What a
    // person expects is the next game first, so that is what is asserted.
    const games = parseScoreboard("mlb", MLB, allTeamIds(MLB));
    const starts = sortGames([...games].reverse()).map((g) => g.startsAt);
    assert.deepEqual(starts, [...starts].sort(), "the stack is not in start-time order");
    // A sorted list of one, or of identical values, would satisfy that alone.
    assert.ok(starts.length > 1 && starts[0] !== starts[starts.length - 1], "the fixture spans one instant");
  });

  test("eventId breaks a tie, so a doubleheader never reshuffles", () => {
    // Four fixture games share 2026-08-29T20:10Z. Without the tiebreak their
    // relative order is whatever the input order happened to be, and a stack of
    // cards that reshuffles under the operator between polls is unreadable.
    const games = parseScoreboard("mlb", MLB, allTeamIds(MLB));
    const tied = "2026-08-29T20:10Z";
    const idsAt = (list: readonly ScoreGameDTO[]) =>
      sortGames(list).filter((g) => g.startsAt === tied).map((g) => g.eventId);
    const expected = ["401816718", "401816719", "401816720", "401816723"];
    assert.deepEqual(idsAt(games), expected);
    // Fed in the opposite order, the answer is the same one.
    assert.deepEqual(idsAt([...games].reverse()), expected);
  });
});

describe("scoresChanged", () => {
  const games = parseScoreboard("mlb", MLB, new Set([NYY]));

  function snapshot(over: Partial<ScoresStatusDTO> = {}): ScoresStatusDTO {
    return {
      ...SCORES_OFFLINE,
      connected: true,
      games: structuredClone(games),
      fetchedAt: "2026-08-29T17:00:00.000Z",
      ...over,
    };
  }

  test("a poll that changed NOTHING but the wall clock is not a broadcast", () => {
    // THE guard. `games` is a fresh array every poll and `fetchedAt` is a new
    // timestamp by definition, so StatusIntegration's shallow key compare says
    // "changed" every single time — turning a 25-second poll into a 25-second
    // SSE frame to every display, which is exactly what the house
    // broadcast-on-change rule forbids.
    const before = snapshot();
    const after = snapshot({ fetchedAt: "2026-08-29T17:00:25.000Z" });
    assert.equal(scoresChanged(before, after), false);
  });

  test("a score moving IS a broadcast", () => {
    const after = snapshot();
    after.games[0].home.score = (after.games[0].home.score ?? 0) + 1;
    assert.equal(scoresChanged(snapshot(), after), true);
  });

  test("a game's own status moving IS a broadcast", () => {
    // The clock and the period are what a live card is showing. Comparing only
    // the scores would freeze a card mid-inning.
    const after = snapshot();
    after.games[0].shortDetail = "Top 9th";
    assert.equal(scoresChanged(snapshot(), after), true);
  });

  test("losing the connection, and the error arriving, are both broadcasts", () => {
    assert.equal(scoresChanged(snapshot(), snapshot({ connected: false })), true);
    assert.equal(scoresChanged(snapshot(), snapshot({ error: "ESPN unreachable" })), true);
  });

  test("a scoring event bumping scoreRev IS a broadcast", () => {
    assert.equal(scoresChanged(snapshot(), snapshot({ scoreRev: 1 })), true);
  });
});
