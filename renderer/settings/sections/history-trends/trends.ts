// trends.ts — the arithmetic behind the Trends card, with no React and no DOM.
//
// Kept separate from the components for the same reason geometry.ts is: the
// parts that can be WRONG — which recordings a tile averages, what it compares
// them against, where a milestone lands — are tested as arithmetic rather than
// through a render jsdom cannot lay out.

import { isCalendarDate } from "@main/services/calendar-date";

/** One recording, reduced to what a trend is drawn from. Built from the same
 *  `rows` the day list and the calendar are built from; nothing here is fetched
 *  that the All services page was not already holding. */
export interface TrendRecording {
  serviceKey: string;
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  /** Local date the recording started, `YYYY-MM-DD`. */
  serviceDate: string;
  /** Epoch ms of the service's start — the x position of its point. */
  t: number;
  seriesTitle: string | null;
  /** Peak people in the room. Null when no attendance record exists, and those
   *  recordings are not plotted: a service with no counter is not a service of
   *  zero people. */
  peakOccupancy: number | null;
}

/** How many recordings a tile averages, and how many it compares them against. */
export const TREND_WINDOW = 8;

export interface TypeTrend {
  serviceTypeId: string | null;
  name: string;
  /** The last `TREND_WINDOW` recordings that have a peak, oldest first — the
   *  sparkline's points and the figures below it. */
  recent: TrendRecording[];
  /** Mean peak across `recent`, rounded. Null when `recent` is empty. */
  average: number | null;
  /**
   * Fractional change of `average` against the mean of the `TREND_WINDOW`
   * recordings BEFORE it. Null when there is no prior window at all.
   *
   * Null, not zero, and not a number computed from an empty window. Dividing by
   * a prior mean of nothing is how a tile comes to read "+Infinity%" on the
   * first Sunday a church records — the failure this returning null prevents.
   * A type with fewer than two recordings can never have a prior window, so it
   * shows no change as a consequence of the rule rather than as a special case.
   */
  change: number | null;
  /** How many recordings the change is measured against — the tile says so, or
   *  "vs the prior 8" would be a lie in a church three months old. */
  priorCount: number;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Oldest first. Every derivation here walks time forwards; `rows` arrives
 *  newest-first, and sorting once here is cheaper than remembering not to. */
function byTime(a: TrendRecording, b: TrendRecording): number {
  return a.t - b.t;
}

/**
 * One tile per service type, newest activity first.
 *
 * A type with no plotted recording at all is dropped: a tile reading "—" for
 * every figure is a row of nothing taking up the width of a real one.
 */
export function typeTrends(recordings: TrendRecording[], window = TREND_WINDOW): TypeTrend[] {
  const byType = new Map<string, TrendRecording[]>();
  const names = new Map<string, string>();
  for (const r of recordings) {
    const key = r.serviceTypeId ?? "";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(r);
    if (!names.has(key) && r.serviceTypeName) names.set(key, r.serviceTypeName);
  }
  const out: TypeTrend[] = [];
  for (const [key, all] of byType) {
    const plotted = all.filter((r) => r.peakOccupancy != null).sort(byTime);
    if (!plotted.length) continue;
    const recent = plotted.slice(-window);
    const prior = plotted.slice(Math.max(0, plotted.length - window * 2), plotted.length - recent.length);
    const average = mean(recent.map((r) => r.peakOccupancy as number));
    const priorMean = mean(prior.map((r) => r.peakOccupancy as number));
    out.push({
      serviceTypeId: key || null,
      name: names.get(key) ?? "Services",
      recent,
      average: average == null ? null : Math.round(average),
      change: average != null && priorMean != null && priorMean > 0 ? (average - priorMean) / priorMean : null,
      priorCount: prior.length,
    });
  }
  // Busiest first: the weekend service leads, and a once-a-year type does not
  // take the left-hand tile because its name sorts early.
  return out.sort((a, b) => (b.average ?? 0) - (a.average ?? 0));
}

/** A mark under the Trends chart. `kind` decides nothing about how it draws —
 *  a milestone is a milestone — but it is what the hover label says it is. */
export interface TrendMilestone {
  id: string;
  /** Epoch ms of the day it falls on. */
  t: number;
  label: string;
  kind: "operator" | "series";
  /** The type it belongs to, or null for every type. */
  serviceTypeId: string | null;
}

/**
 * Local midnight of a `YYYY-MM-DD`, as epoch ms, or NaN for anything that is not
 * a real day.
 *
 * Local, because a milestone is a calendar day where the church is and a UTC
 * midnight lands on the previous evening in Chicago. `isCalendarDate` rather
 * than a bare parse, and it is the SERVER'S rule imported rather than a second
 * copy: "2026-02-31" parses and lands on the 2nd of March, which would draw a
 * mark under a date nothing happened on.
 */
export function dayStartMs(date: string): number {
  if (!isCalendarDate(date)) return NaN;
  return new Date(`${date}T00:00:00`).getTime();
}

/**
 * A mark wherever a plan's series title changes between consecutive recordings
 * of one type.
 *
 * The FIRST series a type ever records is not a change — there is nothing it
 * changed from — and a recording with no series title is an absence rather than
 * a change, so it is stepped over and the next titled recording is compared
 * against the last titled one. Without that, a single plan that happened not to
 * carry a series would produce two marks: one leaving the series and one
 * arriving back at it.
 */
export function seriesChangeMilestones(recordings: TrendRecording[]): TrendMilestone[] {
  const byType = new Map<string, TrendRecording[]>();
  for (const r of recordings) {
    const key = r.serviceTypeId ?? "";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(r);
  }
  const out: TrendMilestone[] = [];
  for (const [key, all] of byType) {
    let previous: string | null = null;
    for (const r of all.slice().sort(byTime)) {
      const title = r.seriesTitle?.trim() || null;
      if (!title) continue;
      if (previous != null && title !== previous) {
        out.push({
          id: `series:${key}:${r.serviceKey}`,
          t: r.t,
          label: title,
          kind: "series",
          serviceTypeId: key || null,
        });
      }
      previous = title;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** An operator's stored entry, as the server hands it over. */
export interface StoredMilestone {
  id: string;
  date: string;
  label: string;
  serviceTypeId: string | null;
}

/**
 * The operator's list and the derived series changes, merged and clipped to the
 * drawn domain.
 *
 * A stored entry whose date will not parse is DROPPED here as well as logged
 * server-side: the server refuses to write one, so the only way to hold one is
 * a hand-edited file or a restored backup, and drawing a mark at NaN puts it at
 * the left edge of the plot where it means something it does not.
 */
export function trendMilestones(
  stored: StoredMilestone[],
  recordings: TrendRecording[],
  domain: { startMs: number; endMs: number },
): TrendMilestone[] {
  const fromStore: TrendMilestone[] = [];
  for (const m of stored) {
    const t = dayStartMs(m.date);
    if (!Number.isFinite(t)) continue;
    fromStore.push({ id: m.id, t, label: m.label, kind: "operator", serviceTypeId: m.serviceTypeId });
  }
  return [...fromStore, ...seriesChangeMilestones(recordings)]
    .filter((m) => m.t >= domain.startMs && m.t <= domain.endMs)
    .sort((a, b) => a.t - b.t);
}

/** The range control's options, in weeks. 16 is the default: a season. */
export const RANGE_WEEKS = [8, 16, 52] as const;
export type RangeWeeks = (typeof RANGE_WEEKS)[number];
export const DEFAULT_RANGE_WEEKS: RangeWeeks = 16;

/** Recordings inside the chosen range, measured back from the newest one rather
 *  than from the clock: a history that stops in June should still draw when it
 *  is opened in September, not show an empty chart. */
export function withinRange(recordings: TrendRecording[], weeks: number): TrendRecording[] {
  const plotted = recordings.filter((r) => r.peakOccupancy != null && Number.isFinite(r.t));
  if (!plotted.length) return [];
  const newest = Math.max(...plotted.map((r) => r.t));
  const from = newest - weeks * 7 * 24 * 60 * 60_000;
  return plotted.filter((r) => r.t >= from).sort(byTime);
}
