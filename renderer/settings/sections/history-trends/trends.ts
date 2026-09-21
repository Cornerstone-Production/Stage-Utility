// trends.ts — the arithmetic behind the Trends card, with no React and no DOM.
//
// Kept separate from the components for the same reason geometry.ts is: the
// parts that can be WRONG — what a day is worth, which day a tile leads with,
// what it compares that against, where a milestone lands — are tested as
// arithmetic rather than through a render jsdom cannot lay out.

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
  /**
   * The recording has ENDED.
   *
   * Nothing in this module counts a service that is still running: not the
   * tiles, not the sparkline, not the chart's line. A half-finished 9 o'clock is
   * not a smaller 9 o'clock, and a figure that climbs while you watch it cannot
   * be compared against anything. It joins the trend when it ends.
   *
   * It is also what makes a partial Sunday comparable — see `typeTrends`. With
   * one of three services done the day counts ONE, and the comparison is against
   * other days' first service rather than against their full three.
   */
  complete: boolean;
}

/** What the card is plotting. Two measures, one derivation. */
export type TrendMeasure = "attendance" | "sound";

/**
 * The reading a measure takes from a recording.
 *
 * MODULE-PRIVATE: every export here takes the measure itself, so a caller cannot
 * pair one measure's reading with another's day rule — see DAY_FIGURE.
 *
 * A TABLE, not a ternary. `measure === "sound" ? peakDb : peakOccupancy` gave a
 * third measure attendance's reading by default and compiled clean; keyed by
 * `TrendMeasure` it is a compile error until the new measure says what it reads,
 * which is the same rule DAY_FIGURE and COMPARABLE_ABOVE are under.
 */
const MEASURE_READING: Record<TrendMeasure, (r: TrendRecording) => number | null> = {
  attendance: (r) => r.peakOccupancy,
  sound: (r) => r.peakDb,
};

function measureOf(measure: TrendMeasure): (r: TrendRecording) => number | null {
  return MEASURE_READING[measure];
}

/**
 * How a measure's several recordings on ONE DAY become the one figure a tile
 * prints and a node on the line sits at.
 *
 * ATTENDANCE ADDS UP. A church running a 9, an 11 and a 6 held three services
 * that Sunday and the question a trend answers is "how many came", so the three
 * add together. Taking the busiest of them answered "how full was the fullest
 * service", which is a different question and one the service page already
 * answers per service.
 *
 * SOUND MUST NOT. Decibels are logarithmic: adding two services' peak levels is
 * not louder, it is meaningless, and three services at 100 dB would print 300 dB
 * on the card. A day's level is the loudest single recording on it.
 *
 * ONE table, read by the tiles and by the chart's line, so the two cannot come
 * to different figures for one day — and read by `TrendMeasure`, so a third
 * measure cannot be added without saying which of the two it is.
 *
 * THE HOME OVERVIEW CARD ALREADY SUMS A DAY THIS WAY — `attPoints` in
 * overview-data.ts, "value = TOTAL attendance across that day's services". Its
 * shape is different enough that it cannot call `dailyValues` (it carries a
 * per-service breakdown, a live flag and an SPL reading per day), so the sum
 * lives in two places and they have to move together. They now agree; before
 * this they did not, and one page's weekend was three times the other's.
 */
export const DAY_FIGURE: Record<TrendMeasure, "sum" | "loudest"> = {
  attendance: "sum",
  sound: "loudest",
};

/**
 * The value a comparison basis must EXCEED for the change to be worth printing.
 *
 * A separate table from DAY_FIGURE because it is a separate assumption, and it
 * was hidden in a bare `> 0` in `typeTrends`: fine for the two measures that
 * exist, and silently wrong for a signed one. Keyed by `TrendMeasure` so a third
 * measure cannot be added without deciding it, the same way DAY_FIGURE makes it
 * decide sum-or-loudest.
 *
 * Zero for both today. Nobody in the room is not a week to measure this one
 * against — it is a counter that was off, not a congregation of none — and a
 * meter reads 60 to 110 dB, so 0 dB is a broken capture rather than a quiet
 * room. A metric that can legitimately sit at or below zero (anything signed —
 * a dB difference, a delta against a target) would set its own floor here and
 * get a comparison the other two correctly refuse.
 */
export const COMPARABLE_ABOVE: Record<TrendMeasure, number> = {
  attendance: 0,
  sound: 0,
};

/** How many DAYS a tile's SPARKLINE draws. Nothing else is bounded by it — the
 *  change runs over every day on record, and the chart under the tiles is
 *  bounded by the range control instead. */
export const TREND_WINDOW = 8;

/**
 * The fewest prior days a comparison may rest on.
 *
 * The prior window used to have to be FULL, which meant a church saw no change
 * figure until it had recorded sixteen Sundays, four months in. The tile was
 * right and useless for a season.
 *
 * Three, because the tile says how many days it actually compared against — "vs
 * first 3 services, 11 days" — so a thin comparison is transparent rather than
 * passed off as a solid one, and the reader can discount it themselves. Below
 * three there is nothing to discount: one or two readings are not an average,
 * and a change off them is noise wearing a direction.
 *
 * The days it counts are the ones that QUALIFY: prior days of this type that ran
 * at least as many services as the day being compared. A church with a long
 * history can still fall under this floor the first Sunday it runs a fourth
 * service, and the tile says "no prior window yet" rather than comparing four
 * services against three.
 */
export const MIN_PRIOR_DAYS = 3;

/** One day of one service type, reduced to the figure that day is worth under
 *  the current measure, and when the day's first recording started. */
export interface TrendDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Epoch ms of the day's FIRST recording — where the line's node sits.
   *
   *  Not local midnight: a node at 00:00 would sit to the left of every dot it
   *  is supposed to run through, which reads as the line leading the services
   *  rather than summarising them. */
  t: number;
  /** The day's figure: every recording ADDED UP for attendance, the LOUDEST
   *  single one for sound. See DAY_FIGURE for why the two differ. */
  v: number;
  /** How many recordings that day fed it. */
  count: number;
}

export interface TypeTrend {
  serviceTypeId: string | null;
  name: string;
  /** The last `TREND_WINDOW` DAYS this type completed a recording on, oldest
   *  first — the sparkline's points. The CHANGE is not taken inside this window;
   *  it runs over every day on record. See `priorAverage`. */
  recent: TrendDay[];
  /**
   * The latest day that has COMPLETED a recording, reduced by this measure.
   * Null when the type has completed none.
   *
   * The headline used to be the mean of the whole window, which answered "what
   * is a normal Sunday here" — a question that does not change week to week and
   * a number that therefore never moved. What an operator opens this tab for is
   * the Sunday that just happened.
   *
   * A service still running is not in it. The figure holds still through a
   * service and steps when it ends, and a morning that has finished nothing
   * falls back to the last day that did rather than reading zero.
   */
  latest: number | null;
  /**
   * The `YYYY-MM-DD` that `latest` belongs to. Null when the type has completed
   * no recording.
   *
   * On the tile beside the figure, because "latest day" is a relative phrase: a
   * type that has not recorded for three weeks shows a three-week-old number and
   * nothing on screen says so. It is also the honest answer when a Sunday
   * morning has finished nothing yet and the tile has fallen back to last week.
   */
  latestDate: string | null;
  /**
   * How many services `latest` is the sum of — N, the size of the slice the
   * comparison is like-for-like on.
   *
   * Taken from the data, never a literal: a church running five services works
   * with no change, and one that adds a fourth gets it counted the first Sunday
   * it finishes. Zero when nothing has completed.
   *
   * The tile prints it, because "+40" against a partial Sunday means something
   * different from "+40" against a whole one and the reader cannot tell which
   * without it.
   */
  serviceCount: number;
  /**
   * What `latest` is measured against: the mean, over EVERY prior day this type
   * recorded, of that day's first `serviceCount` services — counting only days
   * that ran at least that many. Rounded. Null below `MIN_PRIOR_DAYS` of them.
   *
   * All time, not a window. "How does this morning compare" is a question about
   * the whole record, and the eight-day window the sparkline draws was never
   * more than what fits on a tile.
   *
   * LIKE FOR LIKE. A Sunday with one of three services done is compared against
   * other Sundays' FIRST service, not against their full three — otherwise every
   * Sunday reads as a collapse until the evening service ends. And a day that
   * only ever ran two is left out of a three-service comparison rather than
   * dragging the average down for a reason that is not about attendance.
   *
   * Below the floor the "average" is one or two readings and a change off it is
   * noise wearing a direction; above it the tile compares against whatever it
   * HAS and says how many — a thin comparison is labelled, not hidden and not
   * dressed up as a solid one.
   */
  priorAverage: number | null;
  /**
   * The same two figures, UNROUNDED.
   *
   * The tile rounds them to the precision it prints — whole people, tenths of a
   * decibel — and takes the change as the difference of those two rounded
   * numbers, so what it shows is always exactly the difference between the two
   * figures it is derived from. A change taken from unrounded values prints "+1"
   * beside two numbers that are equal on screen, which is the bug the old
   * percentage had.
   *
   * Null on exactly the same condition as their rounded pair.
   */
  latestRaw: number | null;
  priorAverageRaw: number | null;
  /** How many prior days met the `serviceCount`-or-more bar and fed
   *  `priorAverage`. Zero when there is no comparison. */
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
 * One entry per DAY a type recorded, carrying what that day is worth under this
 * measure — see DAY_FIGURE: the day's recordings added up for attendance, the
 * loudest of them for sound.
 *
 * The trend LINE runs through these, not through every recording. A church with
 * three Sunday services plots three points a week within a couple of hours of
 * each other, and joining them drew a sawtooth — 9am 1,400, 11am 700, 6pm 1,100
 * and back again — in which a real week-to-week trend was invisible.
 *
 * A recording with NOTHING under this measure is skipped rather than counted as
 * zero: a service nobody counted is not a service of nobody, and a day where two
 * of three services had a counter running is the sum of those two.
 *
 * `measure` rather than a picker function, so the reading taken and the way the
 * day's readings combine come from ONE argument and cannot be mismatched — a
 * caller cannot ask for decibels and get them summed.
 */
export function dailyValues(recordings: TrendRecording[], measure: TrendMeasure = "attendance"): TrendDay[] {
  return dayServices(recordings, measure).map((d) => ({
    date: d.date,
    t: d.t,
    v: combineFirst(d.values, d.values.length, measure),
    count: d.values.length,
  }));
}

/** One day of one service type, with what each COMPLETED recording on it was
 *  worth under this measure, in start order. */
interface DayServices {
  date: string;
  /** Epoch ms of the day's first counted recording. */
  t: number;
  /** Oldest first, so `values[0]` is the day's first service. */
  values: number[];
}

/**
 * A day's completed recordings, per day, oldest first — the shape every
 * derivation here is built on.
 *
 * ORDER MATTERS, which is why this exists beside `dailyValues` rather than under
 * it: comparing a partial Sunday like for like means taking each prior day's
 * FIRST N services, and a day reduced to one number has thrown that away.
 *
 * A recording is skipped when it is still running, or when it has nothing under
 * this measure. A service nobody counted is not a service of nobody, and a day
 * where two of three services had a counter running is worth those two.
 */
function dayServices(recordings: TrendRecording[], measure: TrendMeasure): DayServices[] {
  const pick = measureOf(measure);
  const byDay = new Map<string, { date: string; t: number; entries: { t: number; v: number }[] }>();
  for (const r of recordings) {
    const v = pick(r);
    if (v == null || !r.complete || !Number.isFinite(r.t)) continue;
    const hit = byDay.get(r.serviceDate);
    if (!hit) {
      byDay.set(r.serviceDate, { date: r.serviceDate, t: r.t, entries: [{ t: r.t, v }] });
      continue;
    }
    hit.entries.push({ t: r.t, v });
    hit.t = Math.min(hit.t, r.t);
  }
  return [...byDay.values()]
    .sort((a, b) => a.t - b.t)
    .map((d) => ({
      date: d.date,
      t: d.t,
      values: d.entries.slice().sort((a, b) => a.t - b.t).map((e) => e.v),
    }));
}

/**
 * The first `n` of a day's services, brought together the way this measure
 * allows — see DAY_FIGURE.
 *
 * ONE function for the tile's headline and for every day in its comparison
 * basis, so a partial Sunday and the days it is measured against are reduced
 * identically. Sound takes the loudest of the first n; it never adds them.
 */
function combineFirst(values: number[], n: number, measure: TrendMeasure): number {
  const take = values.slice(0, n);
  return DAY_FIGURE[measure] === "sum"
    ? take.reduce((a, b) => a + b, 0)
    : Math.max(...take);
}

/**
 * One tile per service type, ordered by the figure the tile SHOWS — the latest
 * recorded day, highest first.
 *
 * A type with no plotted recording at all is dropped: a tile reading "—" for
 * every figure is a row of nothing taking up the width of a real one.
 */
export function typeTrends(
  recordings: TrendRecording[],
  opts: { window?: number; measure?: TrendMeasure } = {},
): TypeTrend[] {
  const window = opts.window ?? TREND_WINDOW;
  const measure = opts.measure ?? "attendance";
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
    // The SAME derivation the chart's line uses, so the tile's headline and the
    // last node on the line are the same number. They were not: the headline was
    // a mean over every recording and the line was too, and once the line became
    // per-day the tile would have been quoting a different statistic under it.
    const sorted = all.slice().sort(byTime);
    // ALL TIME, not the window and not the range control. The comparison basis
    // is every day this type ever recorded; the window below is only what the
    // sparkline draws, and the range buttons only govern the chart under it.
    const everyDay = dayServices(sorted, measure);
    // The SAME derivation the chart's line uses, so the tile's headline and the
    // last node on the line are the same number. They were not: the headline was
    // a mean over every recording and the line was too, and once the line became
    // per-day the tile would have been quoting a different statistic under it.
    const days = dailyValues(sorted, measure);
    // A type with NO reading under this measure keeps its tile, with a null
    // headline — the card says "no sound recorded" rather than dropping the
    // whole type the moment you switch measure, which reads as the service type
    // having disappeared. A type with no recordings at all is still no tile.
    const recent = days.slice(-window);

    // ── The partial-day comparison ──
    //
    // THE HEADLINE IS THE LATEST DAY THAT HAS FINISHED SOMETHING, and N is how
    // many services it has finished. A Sunday with one of three done counts one;
    // a Sunday still on its first counts nothing and the tile falls back to the
    // last day that did finish a service, rather than reading zero all morning.
    //
    // THE BASIS IS LIKE FOR LIKE. Comparing a one-service morning against other
    // days' full three says every Sunday has collapsed, every Sunday, until the
    // evening service ends. So the basis is the first N services of each PRIOR
    // day — and only of days that ran N or more, because a day that only ever
    // held two has no third service to offer and would drag the average down for
    // a reason that is not about attendance at all.
    //
    // N is the data's, never a literal: a church running five works with no
    // change here, and a church that adds a fourth next year gets the fourth
    // counted the first Sunday it finishes.
    const latestDay = everyDay.length ? everyDay[everyDay.length - 1] : null;
    const serviceCount = latestDay ? latestDay.values.length : 0;
    const latest = latestDay ? combineFirst(latestDay.values, serviceCount, measure) : null;
    const basisDays = everyDay.slice(0, -1).filter((d) => d.values.length >= serviceCount);
    const priorMean = basisDays.length >= MIN_PRIOR_DAYS
      ? mean(basisDays.map((d) => combineFirst(d.values, serviceCount, measure)))
      : null;

    const rounded = latest == null ? null : Math.round(latest);
    const priorRounded = priorMean == null ? null : Math.round(priorMean);
    /** Both figures are there, and the prior one is something to compare
     *  against. Narrows for the type checker as well as reading once. */
    const comparable = rounded != null && priorRounded != null && priorRounded > COMPARABLE_ABOVE[measure];
    out.push({
      serviceTypeId: key || null,
      name: names.get(key) ?? "Services",
      recent,
      latest: rounded,
      latestDate: latestDay?.date ?? null,
      serviceCount,
      priorAverage: priorRounded,
      // A prior average of ZERO is not something to claim a comparison
      // against. One condition, read by all three, so a tile cannot read "no
      // prior window yet" beside a count of 11 — a label for a comparison that
      // was not made.
      latestRaw: comparable ? latest : null,
      priorAverageRaw: comparable ? priorMean : null,
      priorCount: comparable ? basisDays.length : 0,
    });
  }
  // BY THE NUMBER ON THE TILE, so the order a reader sees is the order of the
  // figures they are reading. Sorting by anything else — an average across the
  // window, say — puts a tile showing 380 above one showing 3,541 and gives no
  // account of why. The weekend service still leads, and a once-a-year type
  // still does not take the left-hand tile because its name sorts early.
  //
  // This order also seeds the COLOUR assignment, once, on a browser that has
  // never drawn this card — see assignColorIndexes. After that it is frozen, so
  // two types crossing over on one day re-orders the tiles and leaves every
  // colour where it was.
  //
  // A type with nothing to show under this measure sorts last, not into the
  // middle.
  return out.sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity));
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
  measure: TrendMeasure = "attendance",
): TrendRecording[] {
  const pick = measureOf(measure);
  // `complete` here as well as in `dayServices`, so the range is measured back
  // from the newest FINISHED recording. Without it a service that started this
  // morning sets the window's right-hand edge and then contributes no node,
  // which on the 8-week range can push a real week off the left.
  const plotted = recordings.filter((r) => pick(r) != null && r.complete && Number.isFinite(r.t));
  if (!plotted.length) return [];
  const newest = Math.max(...plotted.map((r) => r.t));
  const from = newest - weeks * 7 * 24 * 60 * 60_000;
  return plotted.filter((r) => r.t >= from).sort(byTime);
}
