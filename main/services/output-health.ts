// What the server makes of the health an output helper reports: whether a body is
// one, and whether the output is in trouble.
//
// Pure functions, with no clock and no socket. The state they work on lives in
// kiosk-presence.ts, beside the other things heard on the network and broadcast
// on the same channel; keeping the decisions here is what lets the part that is
// worth testing be tested.

import type { OutputHealthReport } from "../types/output-health.js";

/** A report older than this is no longer a reading. The helper posts every ten
 *  seconds, so this is six missed posts. */
export const HEALTH_TTL_MS = 60_000;

/** An output repeating this percent of its frames or more is late, not merely
 *  jittery: one frame in twenty is plain to the eye on a lower third. */
export const REPEATED_BAD_PERCENT = 5;

/** Reports running, bad (or good), before the verdict changes. Three is thirty
 *  seconds at the helper's cadence: long enough that one slow page is not a
 *  struggling output, short enough to be on the screen before the song ends. */
export const STREAK = 3;

const MAX_FPS = 1_000;
const MAX_DROPPED = 1_000_000_000_000;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A request body as a report, or the reason it is not one.
 *
 * Every field is checked rather than coerced: this arrives from the LAN, and a
 * report that is wrong by a factor is worse than one that is refused, because
 * nothing says it is wrong.
 */
export function parseHealthReport(body: unknown): { report: OutputHealthReport } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const o = body as Record<string, unknown>;
  if (!finite(o.fps) || o.fps < 0 || o.fps > MAX_FPS) return { error: `fps must be a number from 0 to ${MAX_FPS}` };
  if (!finite(o.repeated) || o.repeated < 0 || o.repeated > 100) return { error: "repeated must be a percent from 0 to 100" };
  if (!finite(o.dropped) || !Number.isInteger(o.dropped) || o.dropped < 0 || o.dropped > MAX_DROPPED) {
    return { error: "dropped must be a whole number of frames, 0 or more" };
  }
  if (!finite(o.at) || o.at < 0) return { error: "at must be a time in ms since the epoch" };
  return { report: { fps: o.fps, repeated: o.repeated, dropped: o.dropped, at: o.at } };
}

/** What is remembered between two reports to judge the second. */
export interface HealthTrend {
  /** The last report's dropped count; null before any. */
  dropped: number | null;
  /** Reports in a row of the kind that is the opposite of `struggling`. */
  run: number;
  struggling: boolean;
}

export const FRESH_TREND: HealthTrend = { dropped: null, run: 0, struggling: false };

/**
 * Fold one report into the trend.
 *
 * A report is bad when the card dropped frames since the last one, or when the
 * page ran late for too many frames. The dropped count is cumulative and resets
 * when the helper reopens the output, so a count that goes DOWN is a fresh
 * baseline, not a drop. Three bad reports in a row make the output struggling;
 * three good ones in a row end it. Anything between changes nothing, so one slow
 * page does not flicker a warning on and off.
 */
export function judge(trend: HealthTrend, report: OutputHealthReport): HealthTrend {
  const dropped = trend.dropped !== null && report.dropped > trend.dropped;
  const late = report.repeated >= REPEATED_BAD_PERCENT;
  const bad = dropped || late;
  // A report that agrees with the standing verdict resets the run towards the
  // opposite verdict; one that disagrees extends it.
  const against = trend.struggling ? !bad : bad;
  const run = against ? trend.run + 1 : 0;
  const flip = run >= STREAK;
  return {
    dropped: report.dropped,
    run: flip ? 0 : run,
    struggling: flip ? !trend.struggling : trend.struggling,
  };
}

/** The figures a person sees, to the precision they see them at. Two reports that
 *  round to the same thing are the same news: a healthy 59.94 that reads 59.93
 *  next time must not wake every open Screens page. */
export function displaySignature(h: { fps: number; repeated: number; dropped: number; struggling: boolean }): string {
  return JSON.stringify([Math.round(h.fps * 10) / 10, Math.round(h.repeated * 10) / 10, h.dropped, h.struggling]);
}
