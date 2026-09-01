// espn-client.ts — HTTP against ESPN's public, undocumented scoreboard API.
//
// No authentication, no rate-limit headers, and no contract. The community
// reference is explicit that "excessive requests may be blocked", and a block
// would be by source IP — which on a church LAN is the whole building, with no
// warning and no support channel. Nothing is gained by polling fast and a silent
// unappealable block is what there is to lose. Cadence lives in
// scores-schedule.ts; this file only knows how to ask once.
//
// Every response is returned as parsed JSON and NOT interpreted here: the fold
// lives in scores-parse.ts so it can be tested against a fixture with no network.

const BASE = "https://site.api.espn.com/apis/site/v2/sports";

/** ESPN's own cache-control on the scoreboard is max-age=10; six seconds is a
 *  network timeout, not a cadence. */
const REQUEST_TIMEOUT_MS = 6000;

/** A league path, e.g. "baseball/mlb". */
export type LeaguePath = string;

async function getJson(url: string): Promise<unknown> {
  // AbortSignal.timeout rather than a hand-rolled controller-plus-clearTimeout:
  // the timer cannot be leaked because there is no timer to forget. This is the
  // codebase-wide convention (see reaper-service.ts).
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ESPN returned HTTP ${res.status} for ${url}`);
  return await res.json();
}

/**
 * One league's scoreboard.
 *
 * `dates` is YYYYMMDD in the LEAGUE's own reckoning, which is why the caller
 * computes it through app-timezone rather than this file reaching for a clock.
 */
export function fetchScoreboard(league: LeaguePath, dates?: string): Promise<unknown> {
  const q = dates ? `?dates=${encodeURIComponent(dates)}` : "";
  return getJson(`${BASE}/${league}/scoreboard${q}`);
}

/**
 * How many teams to ask for.
 *
 * `/teams` PAGES AT 50 and says nothing about it: college football answers with
 * 50 of its 760 and the envelope looks exactly like a complete one, so the
 * default silently returns a seventh of the league and reads as working. 1000
 * clears the largest league by a wide margin — measured on 2026-08-30:
 * college football 760, college baseball 437, each college basketball 362, and
 * every professional league under 33.
 */
const TEAMS_PAGE_LIMIT = 1000;

/** One league's teams — for the picker, and to re-resolve cached display fields. */
export function fetchTeams(league: LeaguePath): Promise<unknown> {
  return getJson(`${BASE}/${league}/teams?limit=${TEAMS_PAGE_LIMIT}`);
}
