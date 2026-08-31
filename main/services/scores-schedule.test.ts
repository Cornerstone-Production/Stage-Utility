import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { nextPoll } from "./scores-schedule.js";
import type { ScoreGameDTO } from "../types/scores.js";

function game(over: Partial<ScoreGameDTO>): ScoreGameDTO {
  return {
    eventId: "e1",
    league: "mlb",
    sport: "baseball",
    state: "pre",
    delayed: false,
    detail: "",
    shortDetail: "",
    clock: "",
    startsAt: "2026-08-29T18:00:00.000Z",
    venue: null,
    situation: null,
    away: {
      id: "1", abbreviation: "AAA", name: "A", displayName: "A",
      color: null, logo: null, record: null, score: null,
    },
    home: {
      id: "2", abbreviation: "BBB", name: "B", displayName: "B",
      color: null, logo: null, record: null, score: null,
    },
    ...over,
  };
}

const NOON = Date.parse("2026-08-29T17:00:00.000Z");

describe("nextPoll", () => {
  test("a live game with something watching polls at the active cadence", () => {
    const d = nextPoll([game({ state: "in" })], NOON, true);
    assert.equal(d.delayMs, 25_000);
  });

  test("a live game with NOTHING watching still polls, just slowly", () => {
    // Not zero. integration-base.ts records a real bug where gating on browser
    // subscribers alone silently disabled every automation rule reading the
    // channel — an unattended appliance is exactly where "nobody is watching"
    // is permanent.
    const d = nextPoll([game({ state: "in" })], NOON, false);
    assert.equal(d.delayMs, 300_000);
  });

  test("a game starting within the hour polls every two minutes", () => {
    const soon = new Date(NOON + 30 * 60_000).toISOString();
    const d = nextPoll([game({ state: "pre", startsAt: soon })], NOON, true);
    assert.equal(d.delayMs, 120_000);
  });

  test("every followed game finished: drop to the dormant cadence", () => {
    // Not "stop". The poller fetches on every wake-up — the schedule's only
    // lever is how long it waits — and these titles used to say STOP on the
    // strength of a `poll: false` nothing read.
    const d = nextPoll([game({ state: "post" })], NOON, true);
    assert.equal(d.delayMs, 30 * 60_000);
  });

  test("no games at all: dormant, not a spin", () => {
    const d = nextPoll([], NOON, true);
    assert.equal(d.delayMs, 30 * 60_000);
  });

  test("a game far in the future does not hold the fast cadence open", () => {
    const later = new Date(NOON + 6 * 3_600_000).toISOString();
    const d = nextPoll([game({ state: "pre", startsAt: later })], NOON, true);
    // It must wake in time to catch the pre-game ramp, never sleep past it.
    assert.ok(NOON + d.delayMs <= Date.parse(later) - 60 * 60_000 + 1000);
  });

  test("live beats finished: one live game keeps the fast cadence", () => {
    const d = nextPoll([game({ state: "post" }), game({ eventId: "e2", state: "in" })], NOON, true);
    assert.equal(d.delayMs, 25_000);
  });

  test("an unparseable start time never yields NaN", () => {
    const d = nextPoll([game({ state: "pre", startsAt: "" })], NOON, true);
    assert.ok(Number.isFinite(d.delayMs), `delayMs was ${d.delayMs}`);
    assert.equal(d.delayMs, 30 * 60_000, "a start time that will not parse falls back to dormant");
  });

  test("a delay is never zero or negative, whatever the input", () => {
    // A zero delay passed to setTimeout is a spin: it would re-poll immediately,
    // forever, against an endpoint whose community reference warns that
    // excessive requests get the source IP blocked.
    const cases: ScoreGameDTO[][] = [
      [],
      [game({ state: "post" })],
      [game({ state: "pre", startsAt: new Date(NOON + 3_600_000 + 1).toISOString() })],
      [game({ state: "pre", startsAt: "not a date" })],
    ];
    for (const games of cases) {
      for (const inDemand of [true, false]) {
        const d = nextPoll(games, NOON, inDemand);
        assert.ok(d.delayMs > 0, `delayMs was ${d.delayMs}`);
        assert.ok(Number.isFinite(d.delayMs), `delayMs was ${d.delayMs}`);
      }
    }
  });
});
