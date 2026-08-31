// A followed game that is still being played when local midnight passes.
//
// ESPN buckets an event under ITS OWN date. Verified against the live endpoint
// on 2026-08-31: `dates=20260831` answers with a game listed `2026-09-01T01:40Z`,
// because that is 21:40 on the 31st where it is being played, and the same game
// is NOT on the `dates=20260901` slate. So a poller that asks only for the app
// zone's current day loses a live game the instant the date rolls — the board
// goes to `games: []`, which a display renders as "No games today", the exact
// wrong statement the fail() path exists to avoid. Worse, the baseline is wiped
// and nothing is left to call live, so the schedule drops to the 30-minute
// dormant tier and nothing brings the game back.
//
// Driven through the REAL service against a fake ESPN that pages by `dates` the
// way the real one does, because the fact under test is which days get asked
// for. A stub that answered with the same slate whatever it was asked would stay
// green with the fix deleted.
//
// Every identifier in the fixtures is invented. This is a public repository.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import { setAppTimeZone } from "./app-timezone.js";
import { scoresService, todayStamp, yesterdayStamp } from "./scores-service.js";
import type { ScoreFavourite } from "../types/scores.js";

/** The slate for the day the late game started. */
const LATE_SLATE = JSON.parse(
  readFileSync(new URL("./fixtures/espn-late-slate.json", import.meta.url), "utf8"),
) as { events: { id: string; status: { type: { state: string; name: string; detail: string } } }[] };

/** The next day's slate. The followed team is not on it. */
const NEXT_SLATE = JSON.parse(
  readFileSync(new URL("./fixtures/espn-next-slate.json", import.meta.url), "utf8"),
);

/** Harbor Kestrels, of the late slate's second event. Invented. */
const FOLLOWED: ScoreFavourite = {
  league: "mlb",
  teamId: "9101",
  displayName: "Harbor Kestrels",
  abbreviation: "HKS",
  logo: null,
  color: null,
};

const ZONE = "America/New_York";
/** 23:50 on the 31st in New York. */
const BEFORE_MIDNIGHT = Date.parse("2026-09-01T03:50:00.000Z");
/** 00:10 on the 1st in New York — twenty minutes later, and a day later. */
const AFTER_MIDNIGHT = Date.parse("2026-09-01T04:10:00.000Z");

const realFetch = globalThis.fetch;
const realNow = Date.now;

/** The late game, gone final. Built from the fixture rather than a third file. */
function lateSlateFinal(): unknown {
  const copy = structuredClone(LATE_SLATE);
  const game = copy.events.find((e) => e.id === "700002");
  assert.ok(game, "the fixture must contain event 700002");
  game.status.type = { state: "post", name: "STATUS_FINAL", detail: "Final" };
  return copy;
}

/** Every `dates` value asked for since the last reset, in order. */
let asked: string[] = [];
/** What the late slate answers with. Flipped when the game goes final. */
let lateSlate: unknown = LATE_SLATE;

/** A fake ESPN that answers per `dates`, exactly as the real one does. */
function fakeEspn(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const dates = new URL(String(input)).searchParams.get("dates") ?? "";
    asked.push(dates);
    const body =
      dates === "20260831" ? lateSlate : dates === "20260901" ? NEXT_SLATE : { events: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Let the in-flight poll finish. connect() is fired and not awaited. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

/** One poll at `at`, reporting the `dates` values it asked ESPN for. */
async function pollAt(at: number): Promise<string[]> {
  Date.now = () => at;
  asked = [];
  scoresService.stop();
  scoresService.start();
  await settle();
  return asked;
}

afterEach(() => {
  scoresService.stop();
  globalThis.fetch = realFetch;
  Date.now = realNow;
  setAppTimeZone(null);
  lateSlate = LATE_SLATE;
});

describe("the day stamps a poll asks for", () => {
  test("yesterdayStamp is the app zone's previous day, not the host's", () => {
    setAppTimeZone(ZONE);
    Date.now = () => AFTER_MIDNIGHT;
    // The host is very likely not in New York, and on a UTC box this instant is
    // already the 1st — which is precisely the split that makes the stamp wrong
    // when it is taken off the host clock.
    assert.equal(todayStamp(), "20260901");
    assert.equal(yesterdayStamp(), "20260831");
  });

  test("crossing a DST spring-forward is still exactly one day back", () => {
    setAppTimeZone(ZONE);
    // 00:30 on 2026-03-09, the morning after New York loses an hour. `now minus
    // 86_400_000` lands at 23:30 on the 7th here, which is the wrong day.
    Date.now = () => Date.parse("2026-03-09T05:30:00.000Z");
    assert.equal(todayStamp(), "20260309");
    assert.equal(yesterdayStamp(), "20260308");
  });
});

describe("a followed game running past local midnight", () => {
  test("THE GUARD: it is still on the board after the date rolls", async () => {
    setAppTimeZone(ZONE);
    fakeEspn();
    scoresService.configure([FOLLOWED]);
    await settle();

    // Before midnight: one slate, one live game. The state this starts from.
    assert.deepEqual(await pollAt(BEFORE_MIDNIGHT), ["20260831"]);
    assert.equal(scoresService.getLatest().games.length, 1);

    // Twenty minutes later, and a day later.
    const stamps = await pollAt(AFTER_MIDNIGHT);

    const latest = scoresService.getLatest();
    assert.equal(
      latest.games.length,
      1,
      `the board held ${latest.games.length} games ten minutes after midnight with a followed game still in the 8th — a display renders that as "No games today"`,
    );
    assert.equal(latest.games[0].eventId, "700002");
    assert.equal(latest.games[0].state, "in", "the carried game is no longer reported as live");
    assert.equal(latest.connected, true);
    assert.equal(latest.error, null);

    assert.deepEqual(
      stamps,
      ["20260831", "20260901"],
      `after midnight ESPN was asked for ${JSON.stringify(stamps)}; the game in progress is on the 31st and on no other slate`,
    );
  });

  test("the carry stops once that game is over, and does not become a second request for ever", async () => {
    setAppTimeZone(ZONE);
    fakeEspn();
    scoresService.configure([FOLLOWED]);
    await settle();

    await pollAt(BEFORE_MIDNIGHT);
    await pollAt(AFTER_MIDNIGHT);

    // The game goes final. This poll still asks for both days — the carry is
    // decided by the previous poll — and the final score lands on the board.
    lateSlate = lateSlateFinal();
    assert.deepEqual(await pollAt(AFTER_MIDNIGHT), ["20260831", "20260901"]);
    assert.equal(scoresService.getLatest().games[0].state, "post");

    // And the one after it is back to a single request.
    assert.deepEqual(
      await pollAt(AFTER_MIDNIGHT),
      ["20260901"],
      "yesterday's slate is still being fetched with nothing live on it",
    );
    assert.equal(scoresService.getLatest().games.length, 0);
  });

  test("an ordinary poll asks for ONE day", async () => {
    // The other half of the guard: the extra request exists only across the
    // handover, so a normal day's polling costs exactly what it did.
    setAppTimeZone(ZONE);
    fakeEspn();
    scoresService.configure([FOLLOWED]);
    await settle();

    const stamps = await pollAt(Date.parse("2026-08-31T18:00:00.000Z"));
    assert.deepEqual(stamps, ["20260831"], `a midday poll asked ESPN for ${JSON.stringify(stamps)}`);
  });
});
