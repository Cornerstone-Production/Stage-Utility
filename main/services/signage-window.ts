// signage-window.ts — is a schedule open, and when could that change?
//
// PURE. Every calendar and clock decision goes through the APP time zone
// (app-timezone.ts), never the host clock. That is not a style preference: these
// boxes mostly run UTC, where the date rolls at 19:00 in Chicago, and a
// fixed-offset calculation drifts by an hour across a DST change. A "05:00 on
// Sunday" window computed either of those ways opens at the wrong time for half
// the year, on a wall, before anyone is there to see it.
//
// nextBoundaryAfter is what keeps the scheduler cheap: it answers "the next
// instant this could change", so the server arms ONE timeout instead of polling.

import type { PcoWindow, SignageWindow, WindowCtx } from "../types/signage.js";
import { type TimeZone, zonedParts } from "./app-timezone.js";

/** Minutes since local midnight for an "HH:MM" string, or null if unparseable. */
function minuteOfClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** "YYYY-MM-DD" for the local day containing `ms`. */
function dateKey(ms: number, tz: TimeZone): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const DAY_MS = 86_400_000;

/**
 * The epoch instant of a local wall-clock time.
 *
 * The inverse of zonedParts, which the app did not previously need. Solved by
 * iteration rather than by offset arithmetic: guess in UTC, measure how far the
 * guess lands from the target in local terms, correct, repeat. Two passes settle
 * it even across a DST change, where the offset at the guess differs from the
 * offset at the answer — which is exactly the case a one-shot offset calculation
 * gets wrong.
 */
function instantOfLocal(
  y: number,
  mo: number,
  d: number,
  minuteOfDay: number,
  tz: TimeZone,
): number {
  const target = Date.UTC(y, mo - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const landed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const drift = target - landed;
    if (drift === 0) break;
    guess += drift;
  }
  return guess;
}

/** Local midnight of the day containing `ms`. */
function startOfLocalDay(ms: number, tz: TimeZone): number {
  const p = zonedParts(ms, tz);
  return instantOfLocal(p.year, p.month, p.day, 0, tz);
}

/**
 * The concrete [from, to) interval a day-anchored window occupies, for the local
 * day that `dayStart` begins.
 *
 * Returns null when the window does not run on that weekday. `end <= start`
 * WRAPS past midnight, and the day tested is the day the window STARTED — so
 * Thursday 22:00-02:00 runs into Friday morning. Testing "today" instead shuts
 * it at midnight, which is the obvious implementation and the wrong one.
 */
function intervalOnDay(
  dayStart: number,
  days: readonly number[] | undefined,
  start: string,
  end: string,
  tz: TimeZone,
): { from: number; to: number } | null {
  const p = zonedParts(dayStart, tz);
  if (days && !days.includes(p.weekday)) return null;

  const s = minuteOfClock(start);
  const e = minuteOfClock(end);
  if (s === null || e === null) return null;

  const from = instantOfLocal(p.year, p.month, p.day, s, tz);
  // Computed from the NEXT local day rather than by adding 24h, so a wrapping
  // window is still correct on the night the clocks change (that day is 23 or 25
  // hours long).
  const nextDay = zonedParts(dayStart + DAY_MS + 3 * 3600_000, tz);
  const to =
    e > s
      ? instantOfLocal(p.year, p.month, p.day, e, tz)
      : instantOfLocal(nextDay.year, nextDay.month, nextDay.day, e, tz);
  return { from, to };
}

/** Every candidate interval that could contain `atMs`: the one starting today,
 *  and the one starting yesterday (which may still be running after midnight). */
function candidateIntervals(
  atMs: number,
  days: readonly number[] | undefined,
  start: string,
  end: string,
  tz: TimeZone,
): { from: number; to: number }[] {
  const today = startOfLocalDay(atMs, tz);
  const yesterday = startOfLocalDay(today - 3 * 3600_000, tz);
  return [intervalOnDay(yesterday, days, start, end, tz), intervalOnDay(today, days, start, end, tz)]
    .filter((i): i is { from: number; to: number } => i !== null);
}

/** The PCO window covering `atMs` for this service type, if any. */
function pcoWindowAt(windows: PcoWindow[], serviceTypeId: string, atMs: number): PcoWindow | null {
  for (const w of windows) {
    if (w.serviceTypeId !== serviceTypeId) continue;
    if (atMs >= w.from && atMs < w.to) return w;
  }
  return null;
}

/** Is `w` open at `atMs`? */
export function windowActiveAt(
  w: SignageWindow,
  atMs: number,
  tz: TimeZone,
  ctx: WindowCtx,
): boolean {
  switch (w.kind) {
    case "always":
      return true;

    case "weekly":
      // An empty day list is a half-configured schedule. Treating it as "every
      // day" would put content on every wall in the building.
      if (!w.days?.length) return false;
      return candidateIntervals(atMs, w.days, w.start, w.end, tz).some(
        (i) => atMs >= i.from && atMs < i.to,
      );

    case "dates": {
      const key = dateKey(atMs, tz);
      // Inclusive at both ends, which is what "from Dec 1 to Dec 25" means to
      // everyone who is not writing the code.
      if (key < w.from || key > w.to) return false;
      return candidateIntervals(atMs, w.days, w.start, w.end, tz).some(
        (i) => atMs >= i.from && atMs < i.to,
      );
    }

    case "once":
      if (dateKey(atMs, tz) !== w.date) return false;
      return candidateIntervals(atMs, undefined, w.start, w.end, tz).some(
        (i) => atMs >= i.from && atMs < i.to,
      );

    case "pco": {
      // A stale window is USED rather than ignored. Failing closed here means
      // dark foyer TVs on a Sunday because an API call timed out; the staleness
      // is surfaced in the UI instead.
      if (pcoWindowAt(ctx.pcoWindows, w.serviceTypeId, atMs)) return true;
      if (!w.liveExtension) return false;
      if (ctx.liveServiceTypeId !== w.serviceTypeId) return false;
      // The extension HOLDS a window open past its end; it does not create one.
      // Otherwise stepping through next week's plan in PCO Live during the week
      // lights every foyer TV in the building.
      const ended = ctx.pcoWindows.some(
        (p) => p.serviceTypeId === w.serviceTypeId && atMs >= p.to,
      );
      return ended;
    }
  }
}

/**
 * Every interval this window is open for, on the local day beginning at
 * `dayStart`.
 *
 * For drawing a calendar. Exported from HERE rather than worked out again in the
 * renderer, because "when is this window open" is the one rule the whole feature
 * turns on — and a calendar that disagreed with the resolver would be a picture
 * of a schedule nobody is running.
 *
 * Returns intervals that may START on an earlier day: a window that wraps past
 * midnight belongs to the day it started, and a calendar has to draw the part
 * that lands on this one.
 */
export function intervalsOnDay(
  w: SignageWindow,
  dayStart: number,
  tz: TimeZone,
  ctx: WindowCtx,
): { from: number; to: number }[] {
  const dayEnd = startOfLocalDay(dayStart + DAY_MS + 3 * 3600_000, tz);

  if (w.kind === "always") return [{ from: dayStart, to: dayEnd }];

  if (w.kind === "pco") {
    return ctx.pcoWindows
      .filter((p) => p.serviceTypeId === w.serviceTypeId && p.from < dayEnd && dayStart < p.to)
      .map((p) => ({ from: p.from, to: p.to }));
  }

  // Yesterday as well as today, so a window that wrapped past midnight draws its
  // tail on this day — the same rule windowActiveAt follows.
  const yesterday = startOfLocalDay(dayStart - 3 * 3600_000, tz);
  const days = w.kind === "weekly" ? w.days : w.kind === "dates" ? w.days : undefined;

  const out: { from: number; to: number }[] = [];
  for (const start of [yesterday, dayStart]) {
    const key = dateKey(start, tz);
    const inRange =
      w.kind === "once" ? key === w.date : w.kind === "dates" ? key >= w.from && key <= w.to : true;
    if (!inRange) continue;
    const interval = intervalOnDay(start, days, w.start, w.end, tz);
    // Only the ones that actually touch this day.
    if (interval && interval.from < dayEnd && dayStart < interval.to) out.push(interval);
  }
  return out;
}

/** Local midnight of the day containing `ms`. Exported for a calendar's grid. */
export function localDayStart(ms: number, tz: TimeZone): number {
  return startOfLocalDay(ms, tz);
}

/** How many local days the boundary search visits. The walk starts YESTERDAY (a
 *  wrapping window's closing edge belongs to the day it started), so 8 covers
 *  yesterday, today and seven days ahead — a weekly window's next edge is at
 *  most seven days out. */
const SEARCH_DAYS = 8;

/**
 * The next instant strictly after `afterMs` at which this window's answer could
 * change, or null when it never will inside the search horizon.
 *
 * Strictly after, always: a boundary at or before `afterMs` would make the
 * scheduler re-arm a zero-delay timer and spin.
 */
export function nextBoundaryAfter(
  w: SignageWindow,
  afterMs: number,
  tz: TimeZone,
  ctx: WindowCtx,
): number | null {
  if (w.kind === "always") return null;

  if (w.kind === "pco") {
    // The SCHEDULED edges only. A live extension is not a predictable instant,
    // so the scheduler recomputes when the live state changes rather than trying
    // to time it.
    let best: number | null = null;
    for (const p of ctx.pcoWindows) {
      if (p.serviceTypeId !== w.serviceTypeId) continue;
      for (const edge of [p.from, p.to]) {
        if (edge > afterMs && (best === null || edge < best)) best = edge;
      }
    }
    return best;
  }

  const days = w.kind === "weekly" ? w.days : w.kind === "dates" ? w.days : undefined;
  let best: number | null = null;

  // Walk local days rather than adding 24h, so a day that is 23 or 25 hours long
  // is still visited exactly once.
  //
  // Starting YESTERDAY, not today. A window that wraps past midnight belongs to
  // the day it STARTED — the same rule intervalOnDay and candidateIntervals
  // follow — so at Friday 01:00, inside a Thursday 22:00-02:00 window, its
  // closing edge lives on Thursday. Beginning at Friday's midnight skipped it
  // and answered with next Thursday's OPENING instead, which put a single
  // week-long entry in the horizon and left the Thursday-night playlist on the
  // wall until the following Thursday.
  //
  // Costs nothing for a window that does not wrap: yesterday's edges are all at
  // or before today's midnight, and every edge is filtered on `> afterMs`.
  let day = startOfLocalDay(startOfLocalDay(afterMs, tz) - 3 * 3600_000, tz);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const key = dateKey(day, tz);
    const inRange =
      w.kind === "once" ? key === w.date : w.kind === "dates" ? key >= w.from && key <= w.to : true;

    if (inRange) {
      const interval = intervalOnDay(day, days, w.start, w.end, tz);
      if (interval) {
        for (const edge of [interval.from, interval.to]) {
          if (edge > afterMs && (best === null || edge < best)) best = edge;
        }
      }
    }
    // +3h then snap, so the step cannot land back on the same local day.
    day = startOfLocalDay(day + DAY_MS + 3 * 3600_000, tz);
  }

  return best;
}
