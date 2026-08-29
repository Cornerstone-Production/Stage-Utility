// calendar.ts — Planning Center Calendar, flattened.
//
// The shapes the /calendar/v2 client hands to everything above it. Deliberately
// slim: an event instance as PCO returns it carries a dozen fields a month grid
// has no use for, and the ones kept here are the ones something on screen reads.
//
// Times are ISO instants, always. A bare calendar date would have to be
// interpreted in SOME zone, and the app's zone (main/services/app-timezone.ts)
// is not necessarily the org's — the error that produces is a silent one-day
// shift, which is the kind nobody reports because the event is simply on the
// wrong square.

/**
 * A tag as it hangs off one event.
 *
 * `color` is a REAL hex string (`#rrggbb`), which is why tags are the colour
 * source rather than the Calendar's own `color` — that one is an enum of names
 * ("blue", "green") with no value behind it.
 */
export interface CalendarTagRefDTO {
  id: string;
  name: string;
  /** `#rrggbb`, lowercased. Null when PCO has no usable colour for the tag. */
  color: string | null;
}

/**
 * One occurrence of a Planning Center Calendar event.
 *
 * Note `startsAt` is not guaranteed to fall inside the window that selected it.
 * The window filters on PCO's `starts_at`/`ends_at`, which include an event's
 * setup and teardown, while these are the PUBLISHED times where PCO has them.
 * Published times normally sit inside the actual ones, so the error direction is
 * an extra event just outside the grid, never a needed one missing — but a
 * consumer that assumes containment will eventually be wrong.
 */
export interface CalendarEventDTO {
  id: string;
  name: string;
  /** published_starts_at where PCO has one, else starts_at — the published
   *  fields are real instants but are sometimes null on real events. */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  churchCenterUrl: string | null;
  tags: CalendarTagRefDTO[];
}

/**
 * A window of time to read, and the filters to read it under.
 *
 * Both bounds are ISO INSTANTS, and the client rejects a bare date: PCO reads a
 * bare `2026-03-01` in the org's zone, which need not be the app's, and the
 * resulting one-day shift of the whole grid raises no error anywhere.
 *
 * An empty `calendarIds` or `tagIds` means NO filter, not an empty one. PCO
 * composes several tag ids as OR within a tag group and AND across groups, so a
 * picker that presents tags as a flat list should group them.
 */
export interface CalendarWindow {
  /** ISO instant. Inclusive lower bound of the grid. */
  fromIso: string;
  /** ISO instant. Inclusive upper bound of the grid. */
  toIso: string;
  calendarIds: readonly string[];
  tagIds: readonly string[];
}

/**
 * One square of a month grid.
 *
 * A DAY, not a range of instants. Which day an instant falls on is a question
 * only the app time zone can answer, so the bucketing happens on the server —
 * see main/services/calendar-grid.ts.
 */
export interface CalendarDay {
  /** YYYY-MM-DD, in the app time zone. */
  date: string;
  /**
   * False for the leading and trailing squares that belong to the adjacent
   * months. They carry real events and are not filler — the renderer dims them,
   * it does not skip them.
   */
  inMonth: boolean;
  /** All-day events first, then timed ones in start order. An event spanning
   *  several days appears in each day it touches, not only the first. */
  events: CalendarEventDTO[];
}

/** A month as six weeks of squares, ready to draw. */
export interface CalendarGrid {
  /** e.g. "August 2026". */
  monthLabel: string;
  /** Exactly 42, in order, starting on a Sunday. Six weeks always, so the grid
   *  does not change height between months. */
  days: CalendarDay[];
  /**
   * The zone every date above was computed in.
   *
   * Sent so the renderer can print event times, and decide which square is
   * today, in the SAME zone the squares were built in. Without it a browser set
   * to another zone draws a correct grid with the wrong times on it.
   */
  zone: string;
  /**
   * Events that carried an unparseable time and landed on no square.
   *
   * Normally zero — the client's mapper guarantees an ISO start — so a non-zero
   * count is a contract breach rather than a routine case. It travels to the
   * renderer, which SAYS so in the header, instead of becoming a server log line
   * nobody reads: an event that quietly failed to draw is exactly the silent
   * absence this whole feature is written against.
   */
  unplaceable: number;
}

/**
 * One calendar or tag an operator has chosen, as stored on a View.
 *
 * The ID is what filters — names are not stable and PCO does not accept one.
 * The NAME is a cached label, and only ever a label: it is what the picker shows
 * for a choice Planning Center no longer offers, so a deleted or renamed tag
 * appears struck through instead of vanishing and silently widening the filter.
 * Nothing reads it to decide what to fetch.
 */
export interface CalendarSelection {
  id: string;
  /** The name as it read when it was chosen. A label, never a filter. */
  name: string;
}

/** One of the org's calendars, for the picker. */
export interface CalendarSourceDTO {
  id: string;
  name: string;
}

/** One tag the org has defined, for the picker. */
export interface CalendarTagDTO {
  id: string;
  name: string;
  color: string | null;
  /** The tag group's name, or "Individual Tags" for an ungrouped tag — PCO's own
   *  name for that bucket in its UI. Never empty, so a picker can group on it. */
  groupName: string;
}
