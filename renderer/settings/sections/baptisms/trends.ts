// trends.ts — the arithmetic behind the Baptisms tab's Trends card, with no
// React and no DOM — the same split as history-trends/trends.ts, for the same
// reason: what a window averages and what it is compared against are tested as
// arithmetic, not through a render jsdom cannot lay out.
//
// A baptism trend needs none of history-trends' day-grouping machinery. A
// baptism SESSION already IS one service's occurrence — an operator starts and
// finishes exactly one per service — so there is no day that can hold several
// of them to add up or take the loudest of, and no "day still running" state.
// TREND_WINDOW and MIN_PRIOR_DAYS carry over UNCHANGED: the last eight sessions
// against the eight before, and fewer than three prior sessions means no
// change figure rather than a misleading one.
//
// COMPARABLE_ABOVE does NOT carry over. It is typed Record<TrendMeasure,
// number>, and TrendMeasure is "attendance" | "sound" — neither is a baptism.
// Widening that union for one more caller would make a future attendance/sound
// change think about baptisms too. It also does not fit here: three of these
// four tiles compare an ABSOLUTE clock delta ("+4s"), which never divides and
// so has no zero-basis floor to set; only the count tile divides, and
// pctChange (reused from trends-card.tsx) already refuses to divide by a basis
// at or below zero on its own.

import { MIN_PRIOR_DAYS, TREND_WINDOW, mean } from "../history-trends/trends";

export { MIN_PRIOR_DAYS, TREND_WINDOW };

/** One finished baptism session, reduced to what a trend tile is drawn from —
 *  the same idea as TrendRecording in history-trends/trends.ts: a recording
 *  stripped to only the numbers a trend needs. */
export interface BaptismTrendPoint {
  /** Epoch ms the session started. Used only to sort oldest-first; the
   *  session's own card (Past sessions) is what names it on screen. */
  t: number;
  /** People actually baptized this session. Never people.length — see
   *  baptismStats' own doc comment for why a grouped session's mid-testimony
   *  entries must not count here. */
  baptized: number;
  avgTestimonySec: number;
  avgBaptismSec: number;
  /** finishedAt - startedAt, wall clock. Distinct from the summed
   *  testimony+baptism total the People and Past sessions cards show: this is
   *  what a planner budgets, including the walk to the water and every gap. */
  wholeSegmentSec: number;
}

/** One tile's derived numbers: a sparkline's points, an average to lead with,
 *  and what it is measured against. */
export interface BaptismTrendTile {
  /** Up to TREND_WINDOW values, oldest first — the sparkline's points. */
  recent: number[];
  /** The mean of `recent`. Null when there are no sessions at all. */
  latest: number | null;
  /** The mean of the up-to-TREND_WINDOW sessions immediately before `recent`.
   *  Null below MIN_PRIOR_DAYS of them — a thin comparison is not shown rather
   *  than passed off as a solid one. */
  prior: number | null;
  /** How many prior sessions actually fed `prior`. Zero when `prior` is null. */
  priorCount: number;
}

function tile(values: number[], window: number): BaptismTrendTile {
  const recent = values.slice(-window);
  const before = values.slice(0, Math.max(0, values.length - window)).slice(-window);
  const comparable = before.length >= MIN_PRIOR_DAYS;
  return {
    recent,
    latest: recent.length ? mean(recent) : null,
    prior: comparable ? mean(before) : null,
    priorCount: comparable ? before.length : 0,
  };
}

export interface BaptismTrends {
  baptized: BaptismTrendTile;
  avgTestimonySec: BaptismTrendTile;
  avgBaptismSec: BaptismTrendTile;
  wholeSegmentSec: BaptismTrendTile;
}

/**
 * The four tiles: the last `window` sessions against the `window` before.
 *
 * `points` may arrive in any order — sorted oldest-first here, once, rather
 * than trusted from the caller. baptismStore.listSessions() returns
 * newest-first, and a caller that forgot to reverse it would silently compare
 * the wrong two halves against each other.
 */
export function baptismTrends(points: readonly BaptismTrendPoint[], window: number = TREND_WINDOW): BaptismTrends {
  const sorted = points.slice().sort((a, b) => a.t - b.t);
  return {
    baptized: tile(sorted.map((p) => p.baptized), window),
    avgTestimonySec: tile(sorted.map((p) => p.avgTestimonySec), window),
    avgBaptismSec: tile(sorted.map((p) => p.avgBaptismSec), window),
    wholeSegmentSec: tile(sorted.map((p) => p.wholeSegmentSec), window),
  };
}
