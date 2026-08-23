// week-layout.ts — schedules as blocks on a week grid.
//
// PURE. The awkward parts of a calendar are arithmetic, not drawing: a block
// that starts before the day it appears on, a block that runs past midnight, and
// two blocks at the same time needing to sit side by side. Each is one function
// here and one test beside it, rather than conditionals inside a component that
// also has to handle a mouse.
//
// WHEN a window is open is NOT decided here — that comes from intervalsOnDay in
// signage-window, which is what the resolver uses. A calendar that worked it out
// again would eventually draw a picture of a schedule nobody is running.

import type { SignageSchedule } from "@main/types/signage";

/** Weekday names, Sunday first — the order `window.days` uses. Here rather than
 *  in either of the two components that show them, which each had their own
 *  copy. */
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** One drawn block: a schedule, on one day, at one position. */
export interface WeekBlock {
  schedule: SignageSchedule;
  /** Which of the seven columns, 0-6. */
  day: number;
  /** Fraction of the day at which it starts and ends, 0-1, clipped to the day. */
  top: number;
  bottom: number;
  /** The real instants, UNclipped — so a block can print the time it actually
   *  starts rather than the midnight its drawing was cut off at. */
  from: number;
  to: number;
  /** True when the interval began before this day — it wrapped past midnight. */
  continued: boolean;
  /** Side-by-side placement among blocks that overlap it. */
  column: number;
  columns: number;
  /**
   * A schedule ABOVE this one in the list overlaps it here, so this one does not
   * play during the overlap. Order is the priority rule, and a calendar that
   * drew both as equal would hide the one thing the operator has to be able to
   * predict.
   */
  beatenBy: string | null;
}

const DAY_MS = 86_400_000;
/** Enough to clear the longest DST shift before snapping back to midnight. */
const DST_SLACK_MS = 3 * 3600_000;

export interface DayOccurrences {
  /** Local midnight this column begins at. */
  dayStart: number;
  /** Local midnight the NEXT day begins at — 23 or 25 hours later across DST. */
  dayEnd: number;
  /** Per schedule, in list order, the intervals it is open for on this day. */
  intervals: { schedule: SignageSchedule; from: number; to: number }[];
}

/**
 * Lay one day's occurrences out as blocks.
 *
 * `columns` is assigned greedily over blocks sorted by start: the first free
 * column wins. That is what a calendar does, and it keeps a long block from
 * pushing every later one sideways.
 */
export function layOutDay(day: DayOccurrences, dayIndex: number): WeekBlock[] {
  const span = Math.max(1, day.dayEnd - day.dayStart);

  const sorted = day.intervals
    .map((o, order) => ({ ...o, order }))
    .sort((a, b) => a.from - b.from || a.order - b.order);

  // Each entry is the end of the last block placed in that column.
  const columnEnds: number[] = [];
  const placed = sorted.map((o) => {
    let column = columnEnds.findIndex((end) => end <= o.from);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(o.to);
    } else {
      columnEnds[column] = o.to;
    }
    return { ...o, column };
  });

  return placed.map((o) => ({
    schedule: o.schedule,
    day: dayIndex,
    // Clipped to the day, so a block that started yesterday draws from the top
    // rather than at a negative offset.
    top: clamp01((Math.max(o.from, day.dayStart) - day.dayStart) / span),
    bottom: clamp01((Math.min(o.to, day.dayEnd) - day.dayStart) / span),
    from: o.from,
    to: o.to,
    continued: o.from < day.dayStart,
    column: o.column,
    columns: Math.max(1, columnEnds.length),
    beatenBy: beatenBy(o, placed),
  }));
}

/**
 * The name of the schedule that wins over this one where they overlap, if any.
 *
 * "Above in the list" is `order`, which is the array position the resolver walks
 * — so this says exactly what a wall will do, not an approximation of it.
 */
function beatenBy(
  block: { schedule: SignageSchedule; from: number; to: number; order: number },
  all: { schedule: SignageSchedule; from: number; to: number; order: number }[],
): string | null {
  for (const other of all) {
    if (other.order >= block.order) continue;
    if (!other.schedule.enabled) continue;
    if (other.to <= block.from || block.to <= other.from) continue;
    return other.schedule.name;
  }
  return null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * The time a pointer at `fraction` down a day column means, snapped.
 *
 * Fifteen minutes, because that is what a schedule is ever set to and because
 * an unsnapped drag produces 09:07-13:52, which nobody wants and everybody then
 * has to correct by hand.
 */
export const SNAP_MINUTES = 15;

export function snapMinutes(fraction: number, snap = SNAP_MINUTES): number {
  const minutes = Math.round((clamp01(fraction) * 1440) / snap) * snap;
  return Math.min(1440, Math.max(0, minutes));
}

/** "HH:MM" for a minute-of-day, which is how a window stores its times. */
export function clockOf(minuteOfDay: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minuteOfDay)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * A drag from one fraction to another, as a window's start and end.
 *
 * A drag UPWARD is the same range as a drag downward — a calendar that refused
 * one direction would feel broken — and a drag that snapped to nothing becomes
 * the minimum slot rather than a zero-length window the resolver would ignore.
 */
export function dragToTimes(
  fromFraction: number,
  toFraction: number,
): { start: string; end: string } {
  const a = snapMinutes(fromFraction);
  const b = snapMinutes(toFraction);
  let [lo, hi] = a <= b ? [a, b] : [b, a];
  if (hi === lo) hi = lo + SNAP_MINUTES;
  // 24:00 is not a time. A slot dragged to the very bottom ends at midnight,
  // which as a window means "to the end of the day".
  if (hi >= 1440) {
    hi = 1440;
    lo = Math.min(lo, 1440 - SNAP_MINUTES);
  }
  return { start: clockOf(lo), end: hi >= 1440 ? "00:00" : clockOf(hi) };
}

/** Seven local midnights, starting from the Sunday on or before `anchor`. */
export function weekOf(
  anchor: number,
  /** Local midnight of the day containing `ms`. Injected so this stays pure —
   *  the app-zone version lives in signage-window. */
  dayStartOf: (ms: number) => number,
  weekdayOf: (ms: number) => number,
): number[] {
  const today = dayStartOf(anchor);
  // Walked back a day at a time rather than subtracting N×24h: a DST day is 23
  // or 25 hours long, and subtracting would land in the wrong day that week.
  // The +/-3h nudge clears the longest DST shift and is then snapped back to
  // midnight; adding a flat 24h lands in the wrong day twice a year. Named here
  // rather than repeated inline — signage-window exports the same rule as
  // nextLocalDayStart / prevLocalDayStart for callers that have a time zone.
  const back = (ms: number) => dayStartOf(ms - DST_SLACK_MS);
  const forward = (ms: number) => dayStartOf(ms + DAY_MS + DST_SLACK_MS);

  let sunday = today;
  for (let i = 0; i < 7 && weekdayOf(sunday) !== 0; i++) sunday = back(sunday);
  const days = [sunday];
  for (let i = 1; i < 7; i++) days.push(forward(days[i - 1]));
  return days;
}
