// calendar-grid.ts — a month of Planning Center events, bucketed into squares.
//
// WHY THIS IS SERVER-SIDE. The renderer has no access to main/services/app-
// timezone.ts, deliberately: the app's wall-clock zone is an operator setting
// that lives on the server, and a browser's own zone is whatever the laptop or
// the Pi happens to be set to. Bucketing in the browser therefore buckets in the
// WRONG zone, and the error is one square wide and completely silent.
//
// It is not hypothetical. All-day events arrive from PCO as local midnight
// expressed in UTC — "05:00Z" in a UTC-5 summer, "06:00Z" in a UTC-6 winter —
// and the app's servers run UTC. A UTC bucket puts every all-day event on the
// wrong day for half the year, and every event after 19:00 local on the wrong
// day all year. The same assumption once stopped every recorder mid-service.
//
// The one thing the renderer does need is the zone itself, which the grid
// carries: an event's TIME still has to be printed, and printing it in the
// browser's zone is the same failure a formatting step later.

import type { CalendarDay, CalendarEventDTO, CalendarGrid } from "../types/calendar.js";
import {
  appTimeZone,
  startOfZonedDay,
  zonedDateKey,
  zonedParts,
  type TimeZone,
  type ZonedParts,
} from "./app-timezone.js";

/**
 * Six weeks, always.
 *
 * A grid that shrinks to five rows for February and grows back for March makes
 * every square change height between months, which on a wall display reads as
 * the page reloading. The cost is up to eleven squares of adjacent month.
 */
const DAYS_IN_GRID = 42;

/** Written out rather than formatted, so the label does not depend on the
 *  server's LOCALE. The zone comes from Intl either way, so this is about which
 *  language the month is named in, not about ICU being present at all. */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Civil date arithmetic on a YYYY-MM-DD key. No zone is involved: "the day
 *  after the 14th" is the 15th everywhere, whatever the offsets did in between. */
function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The anchor's instant, or a throw.
 *
 * A bare "2026-08-10" would parse as UTC midnight, which is the previous evening
 * in any western zone, so a grid anchored on the first of a month would silently
 * render the month before. Refusing it at the boundary is the only place that
 * mistake is visible.
 */
function anchorMs(monthAnchorIso: string): number {
  const ms = Date.parse(monthAnchorIso);
  if (Number.isNaN(ms) || !/\d{2}:\d{2}/.test(monthAnchorIso)) {
    throw new Error(`month anchor must be an ISO instant with a time, got "${monthAnchorIso}"`);
  }
  return ms;
}

/** The anchor broken into local parts — the one place either entry point turns
 *  an instant into a wall-clock month. */
function anchorParts(monthAnchorIso: string, zone: TimeZone): ZonedParts {
  return zonedParts(anchorMs(monthAnchorIso), zone);
}

/** The date the visible grid starts on: the Sunday on or before the 1st of the
 *  anchor's LOCAL month. */
function gridStartKey(p: ZonedParts): string {
  const first = `${p.year}-${pad(p.month)}-01`;
  const weekday = new Date(Date.UTC(p.year, p.month - 1, 1)).getUTCDay();
  return addDays(first, -weekday);
}

/**
 * The instants to ask PCO for, covering the WHOLE visible grid.
 *
 * Not the calendar month. The six-week grid shows up to eleven days of the
 * adjacent months, and a month-shaped window leaves those squares empty — which
 * on screen is indistinguishable from a day with nothing booked.
 *
 * Both bounds are explicit instants because the client rejects a bare date: PCO
 * reads one in the ORG's zone, which need not be the app's.
 */
export function gridWindow(monthAnchorIso: string, zone: TimeZone = appTimeZone()): { fromIso: string; toIso: string } {
  const startKey = gridStartKey(anchorParts(monthAnchorIso, zone));
  const from = startOfZonedDay(startKey, zone);
  // One second before the next day begins, so the bound is inclusive of the last
  // visible square without claiming any part of the day after it.
  const to = startOfZonedDay(addDays(startKey, DAYS_IN_GRID), zone) - 1_000;
  return { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
}

/** All-day first, then by start instant, then by id so the order is stable
 *  across renders when two events start together. */
function compareEvents(a: CalendarEventDTO, b: CalendarEventDTO): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const byStart = Date.parse(a.startsAt) - Date.parse(b.startsAt);
  return byStart !== 0 ? byStart : a.id.localeCompare(b.id);
}

/**
 * Bucket `events` into the six-week grid around `monthAnchorIso`.
 *
 * A multi-day event lands on every square it touches, clipped to the grid — an
 * event that began before the window still belongs on the days of it that are
 * visible, and dropping it is the same absence-with-no-signal the overlap query
 * in pco-calendar-service.ts exists to avoid.
 *
 * An event ending exactly at local midnight does NOT get the following square: a
 * booking from 8pm to midnight is one evening, and drawing it on two days makes
 * every evening booking look like an overnight one.
 */
export function buildGrid(
  events: readonly CalendarEventDTO[],
  monthAnchorIso: string,
  zone: TimeZone = appTimeZone(),
): CalendarGrid {
  const p = anchorParts(monthAnchorIso, zone);
  const monthPrefix = `${p.year}-${pad(p.month)}`;
  const startKey = gridStartKey(p);

  const days: CalendarDay[] = [];
  const byKey = new Map<string, CalendarEventDTO[]>();
  for (let i = 0; i < DAYS_IN_GRID; i++) {
    const date = addDays(startKey, i);
    const list: CalendarEventDTO[] = [];
    byKey.set(date, list);
    days.push({ date, inMonth: date.startsWith(monthPrefix), events: list });
  }
  const firstKey = days[0].date;
  const lastKey = days[DAYS_IN_GRID - 1].date;

  let unplaceable = 0;
  for (const ev of [...events].sort(compareEvents)) {
    const startMs = Date.parse(ev.startsAt);
    const endMs = Date.parse(ev.endsAt);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      unplaceable++;
      continue;
    }
    const fromKey = zonedDateKey(startMs, zone);
    let toKey = zonedDateKey(Math.max(endMs, startMs), zone);
    if (endMs > startMs && endMs === startOfZonedDay(toKey, zone)) toKey = addDays(toKey, -1);

    // YYYY-MM-DD sorts lexicographically, so clipping to the grid is a compare.
    // Both ends clamped before the loop, not in its condition — the upper bound
    // does not change while it runs.
    const firstVisible = fromKey < firstKey ? firstKey : fromKey;
    const lastVisible = toKey > lastKey ? lastKey : toKey;
    for (let key = firstVisible; key <= lastVisible; key = addDays(key, 1)) {
      byKey.get(key)?.push(ev);
    }
  }

  return { monthLabel: `${MONTH_NAMES[p.month - 1]} ${p.year}`, days, zone, unplaceable };
}
