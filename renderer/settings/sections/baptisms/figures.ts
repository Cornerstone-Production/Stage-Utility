// figures.ts — the Baptisms tab's stat strip: what each figure means and how it
// is derived from the live (or just-finished) session.
//
// One pure function over BaptismState + "now", so the header can recompute it on
// every render without special-casing a running session, and so it is testable
// without a DOM or a timer — see figures.test.ts.
//
// `count` and the two averages come straight off summarizeBaptism rather than
// being re-derived here: it already counts a person as baptized only once their
// baptizeMs is real (a grouped session's `people` fills during the testimony
// pass, before anyone is in the water), and a second derivation is the second
// place that rule would have to stay right.

import { segmentElapsedMs } from "@main/services/baptism-elapsed";

import { summarizeBaptism, fmtClock } from "../../../main/use-baptism-state";
import type { StatFigure } from "../history-chart";

/** Every figure the strip can show, in the mockup's order — Customize's
 *  offering. Labels match the mockup exactly. */
export const BAPTISM_FIGURES = [
  { key: "count", label: "Baptized" },
  { key: "timed", label: "Timed" },
  { key: "wall", label: "Wall clock" },
  { key: "gap", label: "Not counted" },
  { key: "avgTestimony", label: "Avg testimony" },
  { key: "avgBaptism", label: "Avg baptism" },
] as const;

export const BAPTISM_FIGURE_KEYS = BAPTISM_FIGURES.map((f) => f.key);

/**
 * Per-browser view preference, like every figure list in the History module —
 * see prefs.ts. All six show by default: unlike the sound strip's five, there
 * is no one figure here that is obviously secondary.
 */
export const BAPTISM_FIGURES_STORAGE_KEY = "baptism:visibleFigures";
export const DEFAULT_BAPTISM_FIGURES: string[] = [...BAPTISM_FIGURE_KEYS];

/**
 * The six figures above the Timer card, for the CURRENT (or just-finished)
 * session.
 *
 * `now` is the caller's own clock (the server's, ticking only while a session
 * is live) — never read in here, so this stays pure. It is only consulted for
 * a session that has started and not yet finished.
 *
 * WALL CLOCK is real time, start to finish (or to now, while it runs). TIMED is
 * what actually got measured: every banked testimony/baptism split
 * (summarizeBaptism's totalMs), the just-closed testimony still waiting to be
 * paired with a baptism (pendingTestimonyMs — per-person mode only, between
 * baptized() and next()), and the segment running right now. NOT COUNTED is
 * the gap between the two — vows, prayer, the walk to the water, an explicit
 * pause, or the armed wait for the first person to step in (see
 * BaptismState.armed: nothing banked, nothing running, but wall keeps moving).
 * A person's own time is press to press, never claims to be time submerged —
 * this is that same idea, over the whole session.
 */
export function baptismFigures(state: BaptismState, now: number): StatFigure[] {
  const sum = summarizeBaptism(state);
  const live = state.phase !== "idle";
  const liveMs = live ? segmentElapsedMs(state, now) : 0;
  const pendingMs = state.pendingTestimonyMs ?? 0;
  const timedMs = sum.totalMs + pendingMs + liveMs;

  const startMs = state.sessionStartedAt ? Date.parse(state.sessionStartedAt) : NaN;
  // An unparseable finishedAt falls back to `now` rather than propagating NaN
  // into every figure below it as "NaN:NaN" — the same defensiveness fmtDate
  // already applies to a bad timestamp.
  const parsedFinish = state.finishedAt ? Date.parse(state.finishedAt) : NaN;
  const endMs = Number.isFinite(parsedFinish) ? parsedFinish : now;
  const wallMs = Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : null;
  const gapMs = wallMs != null ? Math.max(0, wallMs - timedMs) : null;

  const testified = state.people.length;

  return [
    { key: "count", label: "Baptized", value: String(sum.count) },
    { key: "timed", label: "Timed", value: wallMs != null ? fmtClock(timedMs) : "—", sub: "testimony + baptism" },
    { key: "wall", label: "Wall clock", value: wallMs != null ? fmtClock(wallMs) : "—", sub: "start to finish" },
    { key: "gap", label: "Not counted", value: gapMs != null ? fmtClock(gapMs) : "—", sub: "gap between phases" },
    {
      key: "avgTestimony",
      label: "Avg testimony",
      value: testified ? fmtClock(sum.avgTestimonyMs) : "—",
      color: "var(--color-accent)",
    },
    {
      key: "avgBaptism",
      label: "Avg baptism",
      value: sum.count ? fmtClock(sum.avgBaptizeMs) : "—",
      color: "var(--color-live-11)",
    },
  ];
}
