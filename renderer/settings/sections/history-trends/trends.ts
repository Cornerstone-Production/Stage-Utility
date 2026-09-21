// trends.ts — the arithmetic behind the Trends card, with no React and no DOM.
//
// Kept separate from the components for the same reason geometry.ts is: the
// parts that can be WRONG — what a day is worth, which day a tile leads with,
// what it compares that against, where a milestone lands — are tested as
// arithmetic rather than through a render jsdom cannot lay out.

import { isCalendarDate } from "@main/services/calendar-date";
import { zonedDateKey, type TimeZone } from "@main/services/app-timezone";

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
   * A service on air is counted from its first reading whatever position it
   * holds — the day builds all morning rather than holding flat and stepping
   * each time one ends. So this does NOT decide whether a recording counts. It
   * decides two other things:
   *
   *   N, the number of services STARTED, which is what a first-N basis compares
   *   against — one finished plus one on air is a first-TWO comparison;
   *
   *   and, through `stateOf`, WHICH basis: prior days' first N while a service
   *   is still to come, prior days' whole totals once the day's last one is
   *   running and after it ends.
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

/** How many DAYS a tile's SPARKLINE draws, and the only thing this bounds. The
 *  change and the chart are both bounded by the RANGE CONTROL — see `rangeSpan`
 *  — so the sparkline is the last eight days the range contains, not the last
 *  eight on record. */
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

/**
 * Which of three things a tile is showing, across one Sunday morning.
 *
 * `earlier-services` — a service is running, or the room is between services,
 * and MORE are still to come. The figure is what has finished; the basis is
 * prior days' FIRST N, counting only days that ran N or more. A full-day basis
 * here shows a deficit that cannot close, because the services that would close
 * it have not run: every Sunday would read as the church halving until the
 * evening service ended.
 *
 * `last-service-live` — the LAST service of the day is running. The figure
 * counts it live, climbing as the room fills, and the basis switches to prior
 * completed days' FULL totals. It reads as a deficit that closes through the
 * hour — a "how are we tracking" number, red for much of it on purpose.
 *
 * `finished` — the day is over. The full total against prior completed days'
 * full totals. DELIBERATELY THE SAME BASIS as the step before it, so the number
 * does not jump when the last service ends; only the dash and the provisional
 * node go away.
 *
 * A completed two-service summer Sunday IS a two-service Sunday, which is why
 * `finished` compares whole days whatever they ran: comparing its first two
 * against other days' first two would hide exactly the seasonal change an
 * operator is looking for.
 */
export type TrendState = "earlier-services" | "last-service-live" | "finished";

/** Which comparison the state implies: whole days, or each day's first N. */
export function basisOf(state: TrendState): "whole-day" | "first-n" {
  return state === "earlier-services" ? "first-n" : "whole-day";
}

/**
 * What the card knows about NOW — the only thing in this module that is not
 * derived from the recordings.
 *
 * It is passed in rather than read, because the answer to "what day is it"
 * belongs to the APP's time zone and the browser cannot ask for that: the zone
 * is a server setting. A UTC box rolls its calendar date at 19:00 in Chicago,
 * which once stopped every recorder mid-service, so a `new Date().getDate()`
 * anywhere near this decision is the bug and not a shortcut. Build it with
 * `trendClock`.
 */
export interface TrendClock {
  /** Epoch ms. */
  now: number;
  /** Today's calendar date in the app's zone, `YYYY-MM-DD`. */
  today: string;
  /** Epoch ms of every service time Planning Center lists for TODAY, whether or
   *  not it has started. Empty when Planning Center has nothing to say. */
  serviceTimesToday: number[];
}

/**
 * The clock, built in the APP's zone rather than the host's.
 *
 * `zone` comes from the server (`state.timezone`, the operator's setting) and is
 * passed explicitly, exactly as the calendar grid does it: `appTimeZone()` in a
 * browser answers the BROWSER's zone, which is the wrong question. A kiosk
 * running UTC would otherwise decide Sunday ended at 7pm.
 *
 * Only `time_type: "service"` counts. A rehearsal at 8am is not a service still
 * to come, and treating it as one would hold the tile in its partial-day mode
 * all day.
 */
/**
 * Which zone a browser should answer "what day is it" in.
 *
 * In the server's own order: the operator's SETTING first, then the SERVER's
 * host clock, which is what `appTimeZone()` resolves to when nothing is set.
 *
 * The last fallback is this browser's own zone, and it is only reached when
 * stage state has not arrived yet. Reaching for it sooner is the bug: a UTC
 * server viewed from a laptop in Chicago would have the page deciding the day
 * ended five hours before the server did, and the two would disagree about
 * which Sunday a 7pm service belongs to.
 */
export function appZoneOf(
  state: { timezone?: string | null; hostTimezone?: string | null } | null | undefined,
  browserZone: TimeZone,
): TimeZone {
  return state?.timezone ?? state?.hostTimezone ?? browserZone;
}

export function trendClock(
  now: number,
  zone: TimeZone,
  planTimes: readonly { timeType: string; startsAt: string }[] = [],
): TrendClock {
  const today = zonedDateKey(now, zone);
  const serviceTimesToday = planTimes
    .filter((p) => p.timeType === "service")
    .map((p) => Date.parse(p.startsAt))
    .filter((t) => Number.isFinite(t) && zonedDateKey(t, zone) === today);
  return { now, today, serviceTimesToday };
}

/**
 * Is this day over?
 *
 * THE RULE, in the order it is applied, because an operator will ask why today
 * is or is not being compared:
 *
 *   1. Anything still RECORDING means no. A running service is the one piece of
 *      evidence that needs no clock at all.
 *   2. With no clock, yes. The arithmetic tests pass none, and the data is then
 *      all there is to go on.
 *   3. Any date that is not today in the app's zone, yes. Yesterday is over.
 *   4. Today: yes only once no service time Planning Center lists for today is
 *      still to start.
 *
 * Step 4 is the fallback as well as the rule: when Planning Center has nothing
 * to say — the integration is off, or no plan is selected — the list is empty,
 * nothing is "still to start", and today is judged finished the moment its last
 * recording ends. That is the honest answer from the evidence available, and it
 * is what the docs say.
 */
function dayIsOver(date: string, clock: TrendClock | null): boolean {
  if (!clock) return true;
  if (date !== clock.today) return true;
  return !clock.serviceTimesToday.some((t) => t > clock.now);
}

/**
 * Which of the three states a day is in.
 *
 * NOTHING RUNNING is the easy half: the day is either over or waiting for a
 * service that has not started, and `dayIsOver` decides which.
 *
 * SOMETHING RUNNING turns on whether it is the day's LAST service, because that
 * is what makes its figure worth counting live — nothing else is coming to close
 * the gap. Planning Center's service times for the day answer it; where they are
 * unavailable, or the day is not today and so those times are about some other
 * day, a running service IS the last one. With three services and no Planning
 * Center, that means the first one running is treated as the last: the figure
 * counts live and the basis is whole days, which reads as a deficit until the
 * day catches up. Said plainly in the docs, because it is what an operator with
 * the integration off will see.
 */
function stateOf(day: DayServices, clock: TrendClock | null): TrendState {
  const running = day.running;
  if (!running.length) return dayIsOver(day.date, clock) ? "finished" : "earlier-services";
  const last = running[running.length - 1];
  const moreToCome = clock != null
    && day.date === clock.today
    && clock.serviceTimesToday.some((t) => t > last.t);
  return moreToCome ? "earlier-services" : "last-service-live";
}

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
  /**
   * `v` includes a service that is still recording and will keep moving.
   *
   * Only ever the newest day, and only while that day's LAST service is running
   * — see TrendState. The chart draws the segment into it dashed and its node
   * marked, so a glance reads "not done yet" rather than "collapsed".
   */
  provisional: boolean;
}

export interface TypeTrend {
  serviceTypeId: string | null;
  name: string;
  /** The last `TREND_WINDOW` DAYS this type has a figure for, oldest first — the
   *  sparkline's points. The CHANGE is not taken inside this window: it runs
   *  over the operator's chosen range. See `priorAverage`. */
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
   * A service still running IS in it, from any position in the day, so the
   * figure climbs through the morning. It falls back to the last day that had a
   * figure only when today has none at all — a counter that has not reported
   * yet, rather than a service that has not finished.
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
   * How many services `latest` counts. Zero when there is nothing to show.
   *
   * Includes the one still recording while `state` is `last-service-live`.
   *
   * Taken from the data, never a literal: a church running five services works
   * with no change, and one that adds a fourth gets it counted the first Sunday
   * it finishes.
   *
   * The tile prints it while `state` is `earlier-services`, because "+40"
   * against a Sunday with more services still to come means something different
   * from "+40" against a whole one, and the reader cannot tell which without it.
   */
  serviceCount: number;
  /**
   * Which of the three things the tile is showing. See TrendState.
   *
   * Read twice by the card: for the LABEL, which must never leave a reader
   * guessing whether the figure beside it compares slices or whole days; and for
   * the CHART, which draws the segment into a `last-service-live` day dashed
   * with its node marked provisional.
   */
  state: TrendState;
  /**
   * What `latest` is measured against: the mean over the prior days of this type
   * that are INSIDE THE CHOSEN RANGE, rounded. Null below `MIN_PRIOR_DAYS` of
   * them.
   *
   * THE RANGE IS THE OPERATOR'S — 8, 16 or 52 weeks, or All. The card's own
   * control, the same one that bounds the chart below the tiles, so a tile is
   * compared against exactly the days drawn under it. One control, and the
   * relationship is visible rather than documented.
   *
   * WHAT each prior day contributes follows `state`:
   *
   *   whole days, while the last service runs and after it ends. A completed
   *   two-service summer Sunday belongs in the same average as a three-service
   *   one — that IS the seasonal change, and hiding it was the point of asking.
   *
   *   each day's first `serviceCount`, and only days that ran that many, while
   *   earlier services are still to come. A Sunday with one of three done is
   *   compared against other Sundays' FIRST service, or every Sunday reads as a
   *   collapse until the evening ends; and a day that only ever ran two is left
   *   out of a three-service comparison rather than dragging the average down
   *   for a reason that is nothing to do with attendance.
   *
   * Below the floor the "average" is one or two readings and a change off it is
   * noise wearing a direction; above it the tile compares against whatever it
   * HAS and says how many — a thin comparison is labelled, not hidden and not
   * dressed up as a solid one. That matters more now the range can be narrowed
   * to eight weeks.
   */
  priorAverage: number | null;
  /**
   * The same two figures, UNROUNDED.
   *
   * The tile rounds them to the precision it prints — whole people, tenths of a
   * decibel — and takes the change as a PERCENTAGE of those two rounded
   * numbers, so a change taken from two figures that read identically on
   * screen is always exactly 0%. A percentage taken from the raw values instead
   * prints a residual off two numbers a reader cannot tell apart, which is the
   * bug the card's percentage had before this figure was added and the card
   * printed an absolute difference instead for a while.
   *
   * Null on exactly the same condition as their rounded pair.
   */
  latestRaw: number | null;
  priorAverageRaw: number | null;
  /**
   * How many prior SERVICES actually fed `priorAverage` — never days.
   *
   * A whole-day basis and a first-N basis can both rest on the SAME prior
   * days and still be worth a different number: eleven prior days is 11×N
   * services under a first-N basis, and whatever those eleven days actually
   * ran under a whole-day one — a completed two-service summer Sunday beside
   * three-service ones does not contribute the same count as either
   * neighbour. Counting services rather than days carries that distinction on
   * its own, so the label needs no separate word for which basis produced it
   * — see `basisLabel` in trends-card.tsx.
   *
   * Never days times N: taken by summing what each basis day actually
   * contributed to `priorMean`, the same slice `combineFirst` itself took, so
   * the count cannot drift from the average it is claiming to describe.
   *
   * Zero when there is no comparison — see `priorAverage`.
   */
  priorServiceCount: number;
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
export function dailyValues(
  recordings: TrendRecording[],
  measure: TrendMeasure = "attendance",
  clock: TrendClock | null = null,
): TrendDay[] {
  const days = dayServices(recordings, measure);
  // ONE derivation with the tile's, so the last node on the line and the number
  // on the tile above it are the same figure in every one of the three states,
  // including while a service is on air and the figure is climbing.
  return days
    .map((d) => {
      const counted = countedFor(d, stateOf(d, clock));
      return {
        date: d.date,
        t: d.t,
        v: combineFirst(counted.values, counted.values.length, measure),
        count: counted.values.length,
        provisional: counted.provisional,
      };
    })
    // A day with no reading at all — a counter that has not reported, not a
    // service that has not finished. It is not a day of zero people; it is a
    // day the line has not reached.
    .filter((d) => d.count > 0);
}

/** One day of one service type, with what each COMPLETED recording on it was
 *  worth under this measure, in start order. */
interface DayServices {
  date: string;
  /** Epoch ms of the day's first recording, finished or not. */
  t: number;
  /** COMPLETED services, oldest first, so `values[0]` is the day's first. */
  values: number[];
  /** Services still recording, oldest first. Carried rather than dropped so the
   *  day's LAST one can be counted live — see TrendState. */
  running: { t: number; v: number }[];
}

/**
 * What a day is worth in the state it is in, and whether that figure is still
 * moving.
 *
 * ONE function, read by the tile and by the chart's line, so a state cannot mean
 * one thing on the tile and another on the node under it.
 */
function countedFor(day: DayServices, state: TrendState): { values: number[]; provisional: boolean } {
  const live = day.running[day.running.length - 1];
  // PROVISIONAL is "this figure is not final", which is true of ANY day that is
  // not over — the one climbing right now, and equally the one that will step
  // when its next service ends. Only the first of those counts a live value;
  // both need the line into them drawn dashed, because a solid line into a
  // Sunday with one of three services done draws a cliff the tile beside it
  // spends its whole label denying.
  const provisional = state !== "finished";
  // FROM ANY POSITION. The running service is counted whether it is the day's
  // first or its last, so the figure climbs all morning instead of sitting flat
  // at the completed sum and stepping when a service ends — a staircase, not a
  // day building.
  return live != null
    ? { values: [...day.values, live.v], provisional }
    : { values: day.values, provisional };
}

/**
 * A day's completed recordings, per day, oldest first — the shape every
 * derivation here is built on.
 *
 * ORDER MATTERS, which is why this exists beside `dailyValues` rather than under
 * it: comparing a partial Sunday like for like means taking each prior day's
 * FIRST N services, and a day reduced to one number has thrown that away.
 *
 * A recording with nothing under this measure is skipped: a service nobody
 * counted is not a service of nobody, and a day where two of three services had
 * a counter running is worth those two. A recording that is still RUNNING is
 * kept aside in `running` rather than dropped — whether it counts depends on
 * whether it is the day's last, which is `stateOf`'s question, not this one's.
 */
function dayServices(recordings: TrendRecording[], measure: TrendMeasure): DayServices[] {
  const pick = measureOf(measure);
  type Bucket = { date: string; t: number; done: { t: number; v: number }[]; live: { t: number; v: number }[] };
  const byDay = new Map<string, Bucket>();
  for (const r of recordings) {
    const v = pick(r);
    if (v == null || !Number.isFinite(r.t)) continue;
    let hit = byDay.get(r.serviceDate);
    if (!hit) {
      hit = { date: r.serviceDate, t: r.t, done: [], live: [] };
      byDay.set(r.serviceDate, hit);
    }
    (r.complete ? hit.done : hit.live).push({ t: r.t, v });
    hit.t = Math.min(hit.t, r.t);
  }
  const byStart = (a: { t: number }, b: { t: number }) => a.t - b.t;
  return [...byDay.values()]
    .sort(byStart)
    .map((d) => ({
      date: d.date,
      t: d.t,
      values: d.done.slice().sort(byStart).map((e) => e.v),
      running: d.live.slice().sort(byStart),
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
  opts: { window?: number; measure?: TrendMeasure; weeks?: number; clock?: TrendClock } = {},
): TypeTrend[] {
  const window = opts.window ?? TREND_WINDOW;
  const measure = opts.measure ?? "attendance";
  const clock = opts.clock ?? null;
  /**
   * The left edge of the COMPARISON, from the operator's own range control.
   *
   * Measured back from the newest recording rather than from the clock — the
   * same rule `withinRange` draws the chart by, so a tile's basis and the
   * picture under it cover one span and the relationship needs no explaining.
   * A history that stops in June must still compare when it is opened in
   * September.
   *
   * Omitted, or `Infinity` for All, means no bound at all. The arithmetic tests
   * pass none; the card always passes the operator's choice.
   */
  const cutoff = opts.weeks == null || !Number.isFinite(opts.weeks)
    ? -Infinity
    : Math.max(-Infinity, ...recordings.filter((r) => Number.isFinite(r.t)).map((r) => r.t))
      - opts.weeks * 7 * 24 * 60 * 60_000;
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
    // ONE derivation, shared by `everyDay` (the headline and its comparison
    // basis, below) and `days` (the sparkline and the chart's line), so the
    // tile's headline and the last node on the line are the same number. They
    // were not: the headline was a mean over every recording and the line was
    // too, and once the line became per-day the tile would have been quoting a
    // different statistic under it.
    const sorted = all.slice().sort(byTime);
    const everyDay = dayServices(sorted, measure);
    const days = dailyValues(sorted, measure, clock);
    // A type with NO reading under this measure keeps its tile, with a null
    // headline — the card says "no sound recorded" rather than dropping the
    // whole type the moment you switch measure, which reads as the service type
    // having disappeared. A type with no recordings at all is still no tile.
    const recent = days.slice(-window);

    // ── Which day the tile is about, and in which of the three states ──
    //
    // The newest day that has SOMETHING to show: services that have finished, or
    // a last service running whose figure is worth counting live. A Sunday on
    // its first of three with nothing finished has neither, so the tile falls
    // back to last Sunday and dates itself to it rather than reading zero all
    // morning.
    let latestDay: DayServices | null = null;
    let state: TrendState = "finished";
    let counted: { values: number[]; provisional: boolean } = { values: [], provisional: false };
    for (let i = everyDay.length - 1; i >= 0; i--) {
      const day = everyDay[i];
      const dayState = stateOf(day, clock);
      const c = countedFor(day, dayState);
      if (!c.values.length) continue;
      latestDay = day;
      state = dayState;
      counted = c;
      break;
    }
    const serviceCount = counted.values.length;
    const latest = latestDay ? combineFirst(counted.values, serviceCount, measure) : null;

    // ── What it is measured against ──
    //
    // WHOLE DAYS once the last service is running and after it ends, so the
    // number does not jump when it ends. FIRST N while earlier services are
    // still to come, because a whole-day basis then shows a deficit that cannot
    // close — the services that would close it have not run.
    //
    // A prior day only counts toward a first-N basis if it ran N or more: a day
    // that only ever held two has no third service to offer and would drag the
    // average down for a reason that is nothing to do with attendance. Against
    // WHOLE days that bar is deliberately absent, because a completed
    // two-service summer Sunday belongs in the average exactly as it is.
    //
    // N is the data's, never a literal: a church running five works with no
    // change here, and one that adds a fourth gets it the first Sunday it
    // finishes.
    const before = latestDay == null ? [] : everyDay.slice(0, everyDay.indexOf(latestDay));
    const inRange = before.filter((d) => d.t >= cutoff && d.values.length > 0);
    const basisDays = basisOf(state) === "whole-day"
      ? inRange
      : inRange.filter((d) => d.values.length >= serviceCount);
    /** How many of ONE basis day's services feed the comparison: every one of
     *  them for a whole-day basis, or the first `serviceCount` for a first-N
     *  basis. Capped at what the day actually ran — which the filter above
     *  already guarantees is at least `serviceCount` for a first-N basis, but
     *  the cap keeps this correct even if that ever changes, and it is
     *  exactly the slice `combineFirst` itself takes. */
    const basisSlice = (d: DayServices): number =>
      basisOf(state) === "whole-day" ? d.values.length : Math.min(d.values.length, serviceCount);
    const priorMean = basisDays.length >= MIN_PRIOR_DAYS
      ? mean(basisDays.map((d) => combineFirst(d.values, basisSlice(d), measure)))
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
      state,
      priorAverage: priorRounded,
      // A prior average of ZERO is not something to claim a comparison
      // against. One condition, read by all three, so a tile cannot read "no
      // prior window yet" beside a count of 11 — a label for a comparison that
      // was not made.
      latestRaw: comparable ? latest : null,
      priorAverageRaw: comparable ? priorMean : null,
      // SUMMED, not days times N: a whole-day basis's prior days do not all
      // run the same count, so only adding up each day's own contribution to
      // `priorMean` — never a multiplication — stays correct when the mix is
      // uneven, e.g. a two-service summer Sunday beside three-service ones.
      priorServiceCount: comparable ? basisDays.reduce((sum, d) => sum + basisSlice(d), 0) : 0,
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

/**
 * The range control's options. 16 weeks is the default: a season.
 *
 * `"all"` rather than a very large number of weeks, so the intent survives a
 * round trip through localStorage and the label can say "All" without a special
 * case at the button. `weeksOf` turns a choice into the number every derivation
 * here wants.
 */
export const RANGE_WEEKS = [8, 16, 52, "all"] as const;
export type RangeWeeks = (typeof RANGE_WEEKS)[number];
export const DEFAULT_RANGE_WEEKS: RangeWeeks = 16;

/** A range choice as a number of weeks. All is `Infinity`, which every cutoff
 *  here already reads as "no bound". */
export function weeksOf(range: RangeWeeks): number {
  return range === "all" ? Infinity : range;
}

/** What a range choice reads as on its button. */
export function rangeLabel(range: RangeWeeks): string {
  return range === "all" ? "All" : `${range}w`;
}

/**
 * What a range choice reads as in a SENTENCE — the card's subtitle.
 *
 * "8w" is a button and "last 8 weeks" is prose, and All needs a different shape
 * of phrase entirely: "last all weeks" is not a thing, and "last 0 weeks" is
 * worse. The subtitle used to name a fixed eight-day window, which was true when
 * the tile averaged one and is now three numbers on one card that disagree.
 */
export function rangeSpan(range: RangeWeeks): string {
  return range === "all" ? "every recorded day" : `last ${range} weeks`;
}

/** Recordings inside the chosen range, measured back from the newest one rather
 *  than from the clock: a history that stops in June should still draw when it
 *  is opened in September, not show an empty chart. */
export function withinRange(
  recordings: TrendRecording[],
  weeks: number,
  measure: TrendMeasure = "attendance",
): TrendRecording[] {
  const pick = measureOf(measure);
  const plotted = recordings.filter((r) => pick(r) != null && Number.isFinite(r.t));
  if (!plotted.length) return [];
  // THE EDGE IS THE NEWEST FINISHED RECORDING, but a running one still comes
  // back. Measuring the edge from a service that started this morning and then
  // contributes no node can push a real week off the left of an 8-week range;
  // dropping the running recording ALTOGETHER is worse, because the day's last
  // service is exactly what `dailyValues` counts live to draw the provisional
  // node. Two different questions, and they had one answer.
  const finished = plotted.filter((r) => r.complete);
  const newest = Math.max(...(finished.length ? finished : plotted).map((r) => r.t));
  const from = newest - weeks * 7 * 24 * 60 * 60_000;
  return plotted.filter((r) => r.t >= from).sort(byTime);
}
