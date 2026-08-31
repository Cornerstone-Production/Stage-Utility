// scores-schedule.ts — how long to wait before asking ESPN again.
//
// The poller wakes and fetches every time; the only lever is the delay. This
// used to also return a `poll: boolean` meaning "skip the fetch on this
// wake-up", which nothing ever read — connect() fetched unconditionally, so a
// followed team whose games had all finished still hit ESPN every 30 minutes
// while eight assertions said it had stopped. The tiering is entirely in
// delayMs, and saying so here is the point of the change.
//
// Pure, and takes `now` rather than reading a clock, so every tier is testable.
//
// The argument for this file is the one service-window.ts already makes about
// the PCO live poll: a naive 25-second poll is ~3,500 requests per league per
// day for the handful of hours a followed game is actually being played. This is
// an undocumented free endpoint whose community reference warns that excessive
// requests may be blocked, by IP, with no notice — so the schedule is not
// politeness, it is the thing that keeps the feature working.

import type { ScoreGameDTO } from "../types/scores.js";

/** A followed game is live and somebody (or some rule) is consuming the channel. */
const ACTIVE_MS = 25_000;
/** Live, but nothing is reading. Slow, never stopped — automation still runs. */
const UNWATCHED_MS = 300_000;
/** A followed game starts within the hour. Cheap way to catch first pitch. */
const RAMP_MS = 120_000;
/** How long before a game we start ramping. */
const RAMP_WINDOW_MS = 3_600_000;
/** Nothing to watch today. Wake up occasionally and re-read the schedule. */
const DORMANT_MS = 1_800_000;

export interface PollDecision {
  /** How long until the next wake-up. Always finite and positive. */
  delayMs: number;
}

/**
 * The next wake-up.
 *
 * Fails OPEN in the same sense service-window.pollDelayMs does: a game whose
 * start time will not parse produces a dormant wake-up rather than NaN, and a
 * NaN delay passed to setTimeout fires immediately and forever.
 */
export function nextPoll(
  games: readonly ScoreGameDTO[],
  now: number,
  inDemand: boolean,
): PollDecision {
  if (games.some((g) => g.state === "in")) {
    return { delayMs: inDemand ? ACTIVE_MS : UNWATCHED_MS };
  }

  // A LISTED START THAT HAS ALREADY PASSED IS THE RAMP'S BEST CASE, NOT A ROW
  // TO DISCARD.
  //
  // ESPN flips a game to "in" at the opening kickoff or the first pitch, which
  // is minutes after the listed start on an ordinary day and hours after it
  // through a rain delay. Between those two moments the game is still "pre" with
  // a start in the past. Dropping those left `starts` empty and the poller
  // asleep for the DORMANT half hour, so a wall following a 1pm game sat on the
  // pre-game card until 1:31 while the first quarter was played in front of it.
  //
  // The cost of being wrong here is bounded: an unparseable start still falls
  // through to dormant below, and a game that never leaves "pre" only holds the
  // two-minute tier for the rest of the day's slate — the same tier the hour
  // before every start already runs at.
  const starts = games
    .filter((g) => g.state === "pre")
    .map((g) => Date.parse(g.startsAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const next = starts[0];
  if (next === undefined) return { delayMs: DORMANT_MS };

  // Negative when the start has passed, which is inside the window by
  // definition — that is the case above.
  const until = next - now;
  if (until <= RAMP_WINDOW_MS) return { delayMs: RAMP_MS };

  // Never sleep past the moment the ramp window opens — the same clamp
  // service-window.ts uses so a long dormant delay cannot swallow the next
  // window's start. The floor is what keeps a delay from reaching zero and
  // spinning the poll against an endpoint that blocks by IP.
  return { delayMs: Math.max(60_000, Math.min(DORMANT_MS, until - RAMP_WINDOW_MS)) };
}
