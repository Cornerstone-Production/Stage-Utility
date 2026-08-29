// scores-object.test.ts — which game a wall tile shows.
//
// This is the whole decision the object makes, and the two ways it can be wrong
// are both quiet: a tile that follows the wrong game looks exactly like a tile
// following the right one, and a tile that resolves nothing looks exactly like a
// broken integration. Neither announces itself from across a room.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

const { pickGame } = await import("./scores-object.js");

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
    rev: 0,
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
