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
  /** The loudest reading of this recording on the operator's PRIMARY Smaart
   *  metric. Null when nothing was recorded, or when this browser surfaces no
   *  metric the recording carries — the same rule the day-list rows apply. */
  peakDb: number | null;
}

/** What the card is plotting. Two measures, one derivation. */
export type TrendMeasure = "attendance" | "sound";

/** The reading a measure takes from a recording. */
export function measureOf(measure: TrendMeasure): (r: TrendRecording) => number | null {
  return measure === "sound" ? (r) => r.peakDb : (r) => r.peakOccupancy;
}

/** How many DAYS a tile averages, and the most it compares them against. */
export const TREND_WINDOW = 8;

/**
 * The fewest prior days a comparison may rest on.
 *
 * The prior window used to have to be FULL — eight days — which meant a church
 * saw no change figure until it had recorded sixteen Sundays, four months in.
 * The tile was right and useless for a season.
 *
 * Three, because the tile says how many days it actually compared against —
 * "vs prior 3" — so a thin comparison is transparent rather than passed off as
 * eight, and the reader can discount it themselves. Below three there is
 * nothing to discount: one or two readings are not an average, and a percentage
 * off them is noise wearing a direction.
 *
 * Four was the first attempt and left the three-month archive this was built
 * against showing no change on any tile — its busiest service type has eleven
 * recorded days, which is eight recent and three prior. A floor nothing real
 * clears is a figure nobody ever sees.
 */
export const MIN_PRIOR_DAYS = 3;

/** One day of one service type: the busiest that day, and when the day's first
 *  recording started. */
export interface DayPeak {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Epoch ms of the day's FIRST recording — where the line's node sits.
   *
   *  Not local midnight: a node at 00:00 would sit to the left of every dot it
   *  is supposed to run through, which reads as the line leading the services
   *  rather than summarising them. */
  t: number;
  /** The busiest recording that day. */
  v: number;
  /** How many recordings that day fed it. */
  count: number;
}

export interface TypeTrend {
  serviceTypeId: string | null;
  name: string;
  /** The last `TREND_WINDOW` DAYS that recorded a peak, oldest first — the
   *  sparkline's points and the figures below it. */
  recent: DayPeak[];
  /** Mean of `recent`, rounded. Null when `recent` is empty. */
  average: number | null;
  /**
   * Mean of the up-to-`TREND_WINDOW` days before `recent`, rounded. Null when
   * there are fewer than `MIN_PRIOR_DAYS` of them.
   *
   * Below that floor the "average" is one or two readings and a change off it
   * is noise wearing a direction; above it the tile compares against whatever
   * it HAS, up to eight, and says how many — a thin comparison is labelled, not
   * hidden and not dressed up as a full one.
   */
  priorAverage: number | null;
  /**
   * The same two means, UNROUNDED.
   *
   * The tile rounds them to the precision it prints — whole people, tenths of a
   * decibel — and takes the change as the difference of those two rounded
   * numbers, so what it shows is always exactly the difference between the two
   * figures it is derived from. A change taken from unrounded means prints "+1"
   * beside two numbers that are equal on screen, which is the bug the old
   * percentage had.
   *
   * Null on exactly the same condition as their rounded pair.
   */
  averageRaw: number | null;
  priorAverageRaw: number | null;
  /** How many days the change is measured against. Zero when there is none. */
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
 * One entry per DAY a type recorded, carrying that day's busiest service.
 *
 * The trend LINE runs through these, not through every recording. A church with
 * three Sunday services plots three points a week within a couple of hours of
 * each other, and joining them drew a sawtooth — 9am 1,400, 11am 700, 6pm 1,100
 * and back again — in which a real week-to-week trend was invisible. The
 * individual recordings are still drawn, as dots; the line is the week.
 *
 * The MAXIMUM rather than the sum or the mean, because attendance is people in
 * the room: summing double-counts the family who came to one of the three, and
 * a mean answers "how full was a service" when the question a trend asks is
 * "how many came".
 */
export function dailyPeaks(
  recordings: TrendRecording[],
  /** Which reading to take. The MAXIMUM is right for both: the busiest service
   *  of the day, and the loudest. */
  pick: (r: TrendRecording) => number | null = (r) => r.peakOccupancy,
): DayPeak[] {
  const byDay = new Map<string, DayPeak>();
  for (const r of recordings) {
    const v = pick(r);
    if (v == null || !Number.isFinite(r.t)) continue;
    const hit = byDay.get(r.serviceDate);
    if (!hit) {
      byDay.set(r.serviceDate, { date: r.serviceDate, t: r.t, v, count: 1 });
      continue;
    }
    hit.v = Math.max(hit.v, v);
    hit.t = Math.min(hit.t, r.t);
    hit.count += 1;
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

/**
 * One tile per service type, busiest first.
 *
 * A type with no plotted recording at all is dropped: a tile reading "—" for
 * every figure is a row of nothing taking up the width of a real one.
 */
export function typeTrends(
  recordings: TrendRecording[],
  opts: { window?: number; pick?: (r: TrendRecording) => number | null } = {},
): TypeTrend[] {
  const window = opts.window ?? TREND_WINDOW;
  const pick = opts.pick ?? ((r: TrendRecording) => r.peakOccupancy);
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
    // The SAME derivation the chart's line uses, so the tile's average and a
    // point on the line are the same kind of number. They were not: the average
    // was over every recording and the line was too, and once the line became
    // per-day the tile would have been quoting a different statistic under it.
    const days = dailyPeaks(all.slice().sort(byTime), pick);
    // A type with NO reading under this measure keeps its tile, with a null
    // average — the card says "no sound recorded" rather than dropping the
    // whole type the moment you switch measure, which reads as the service type
    // having disappeared. A type with no recordings at all is still no tile.
    const recent = days.slice(-window);
    const prior = days.slice(Math.max(0, days.length - window * 2), days.length - recent.length);
    const average = mean(recent.map((d) => d.v));
    const priorMean = prior.length >= MIN_PRIOR_DAYS ? mean(prior.map((d) => d.v)) : null;
    const rounded = average == null ? null : Math.round(average);
    const priorRounded = priorMean == null ? null : Math.round(priorMean);
    /** Both windows have a number, and the prior one is something to compare
     *  against. Narrows for the type checker as well as reading once. */
    const comparable = rounded != null && priorRounded != null && priorRounded > 0;
    out.push({
      serviceTypeId: key || null,
      name: names.get(key) ?? "Services",
      recent,
      average: rounded,
      priorAverage: priorRounded,
      // A prior average of ZERO is not something to claim a comparison
      // against. One condition, read by all three, so a tile cannot read "no
      // prior window yet" beside a count of 8 — a label for a comparison that
      // was not made.
      averageRaw: comparable ? average : null,
      priorAverageRaw: comparable ? priorMean : null,
      priorCount: comparable ? prior.length : 0,
    });
  }
  // Busiest first: the weekend service leads, and a once-a-year type does not
  // take the left-hand tile because its name sorts early. A type with nothing
  // to show under this measure sorts last, not into the middle.
  return out.sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity));
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
export function withinRange(
  recordings: TrendRecording[],
  weeks: number,
  pick: (r: TrendRecording) => number | null = (r) => r.peakOccupancy,
): TrendRecording[] {
  const plotted = recordings.filter((r) => pick(r) != null && Number.isFinite(r.t));
  if (!plotted.length) return [];
  const newest = Math.max(...plotted.map((r) => r.t));
  const from = newest - weeks * 7 * 24 * 60 * 60_000;
  return plotted.filter((r) => r.t >= from).sort(byTime);
}
