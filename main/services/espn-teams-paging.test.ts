import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";

import { fetchTeams } from "./espn-client.js";
import { scoresService } from "./scores-service.js";
import { LEAGUES, leagueById } from "../types/scores.js";

// ESPN's /teams endpoint PAGES AT 50 and never says so: the envelope for 50 of
// college football's 760 is shaped exactly like the envelope for all of them, so
// asking without a limit returns a seventh of the league and looks like it
// worked. That is the bug this file exists for, and it is why the fake ESPN
// below PAGES THE SAME WAY the real one does rather than answering with
// everything regardless — a stub that ignores the parameter would stay green
// with the parameter deleted, which is the definition of a vacuous guard.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Real league sizes, measured against ESPN on 2026-08-30. */
const REAL_SIZE: Record<string, number> = {
  mlb: 30,
  nfl: 32,
  nba: 30,
  nhl: 32,
  ncaaf: 760,
  ncaam: 362,
  ncaaw: 362,
  ncaabb: 437,
};

/** ESPN's default when no limit is given. The whole trap. */
const ESPN_DEFAULT_PAGE = 50;

let lastUrl = "";

/** A fake ESPN that pages exactly as the real one does. */
function fakeEspn(total: number): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    lastUrl = String(input);
    const limit = Number(new URL(lastUrl).searchParams.get("limit") ?? ESPN_DEFAULT_PAGE);
    const n = Math.min(total, Number.isFinite(limit) && limit > 0 ? limit : ESPN_DEFAULT_PAGE);
    const teams = Array.from({ length: n }, (_, i) => ({
      team: {
        id: String(i + 1),
        abbreviation: `T${i + 1}`,
        displayName: `Team ${String(i + 1).padStart(4, "0")}`,
        color: "112233",
        logos: [{ href: `https://a.espncdn.com/i/teamlogos/x/${i + 1}.png` }],
      },
    }));
    return new Response(JSON.stringify({ sports: [{ leagues: [{ teams }] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("the /teams request", () => {
  test("THE GUARD: it asks for more teams than the largest league has", async () => {
    // Delete `?limit=` from fetchTeams and this reads 50 — ESPN's default —
    // which is smaller than college football and the assertion fails by name.
    fakeEspn(REAL_SIZE.ncaaf);
    await fetchTeams("football/college-football");
    const limit = Number(new URL(lastUrl).searchParams.get("limit"));
    assert.ok(
      Number.isFinite(limit) && limit >= REAL_SIZE.ncaaf,
      `/teams was asked for ${lastUrl.includes("limit") ? limit : "no limit at all"}, ` +
        `which cannot return college football's ${REAL_SIZE.ncaaf} teams`,
    );
  });

  test("the scoreboard is left alone — only /teams pages", async () => {
    // The cadence work lives in the poll, and a limit on the scoreboard would
    // silently truncate a day's slate. Only the team list needed this.
    const { fetchScoreboard } = await import("./espn-client.js");
    fakeEspn(0);
    await fetchScoreboard("baseball/mlb", "20260830");
    assert.equal(new URL(lastUrl).searchParams.get("limit"), null);
  });
});

describe("listTeams over a paging ESPN", () => {
  test("THE GUARD: a college league folds far more than one page of teams", async () => {
    // The real defect, through the real code path: without the limit the fake
    // ESPN answers with 50 and this is 50, not 760.
    fakeEspn(REAL_SIZE.ncaaf);
    const teams = await scoresService.listTeams("ncaaf");
    assert.equal(
      teams.length,
      REAL_SIZE.ncaaf,
      `college football folded ${teams.length} teams; ${ESPN_DEFAULT_PAGE} means the page limit was not asked for`,
    );
    assert.ok(teams.length > ESPN_DEFAULT_PAGE * 2, "a single page of teams came back");
  });

  test("a professional league is unaffected", async () => {
    // The other half: the pro leagues fit inside one page and must not change.
    fakeEspn(REAL_SIZE.nfl);
    const teams = await scoresService.listTeams("nfl");
    assert.equal(teams.length, REAL_SIZE.nfl);
  });
});

describe("the league catalogue", () => {
  test("every league has a distinct id and a real ESPN path", () => {
    // An EXACT count, not a floor: the picker, the docs and the poll all read
    // this list, and a league added without a path here is a dropdown row that
    // fetches nothing.
    assert.equal(LEAGUES.length, 8);
    assert.equal(new Set(LEAGUES.map((l) => l.id)).size, 8);
    assert.equal(new Set(LEAGUES.map((l) => l.path)).size, 8);
    for (const l of LEAGUES) {
      assert.ok(/^[a-z-]+\/[a-z-]+$/.test(l.path), `${l.id} has an implausible path ${l.path}`);
      assert.equal(leagueById(l.id)?.path, l.path);
    }
  });

  test("the college leagues reuse the sports the parser already draws", () => {
    // A new `kind` would be a new arm in parseSituation AND in the per-sport
    // centre. These four deliberately need neither.
    const pro = new Set(LEAGUES.filter((l) => !l.id.startsWith("ncaa")).map((l) => l.kind));
    for (const l of LEAGUES.filter((l) => l.id.startsWith("ncaa"))) {
      assert.ok(pro.has(l.kind), `${l.id} introduces a sport kind nothing renders: ${l.kind}`);
    }
  });
});
