// live-service-gate.ts — may the recorders record this live tick?
//
// One rule above all others: IF PCO SAYS A SERVICE IS LIVE, NOTHING STOPS THE
// RECORDING. Not a clock, not a calendar, not a timezone, not a date comparison.
// This is not a preference — it is the lesson from an outage. The old gate asked
// "does the service's date equal the server's date"; on a UTC host that went false
// at 19:00 local, mid-item, and silently closed all three recorders for the rest
// of a live service. A recording in progress is now un-stoppable by any of that.
//
// Two rules, in order:
//
//   1. LATCH — an open record plus a live plan item keeps recording, full stop.
//      No time-based test is even consulted. The latch releases only when the
//      record is closed, and only PCO leaving item mode can close it.
//
//   2. START WINDOW — with nothing open, start only on a service near now. This is
//      the one thing the old date test was genuinely for: stepping through NEXT
//      Sunday's plan in PCO Live during the week must not create a record dated
//      today. A ±12h window says that without a midnight cliff, because it is
//      anchored to the SERVICE's own time — so unlike a calendar comparison, its
//      value cannot change while a service is running.
//
// `serviceEnded` is deliberately NOT handled here. It is the plan's own SERVICE END
// header — an explicit operator signal, position-based, and therefore incapable of
// misfiring on a clock. Callers apply it themselves.

import type { PcoLiveDTO } from "../types/stage.js";
import { zonedDateKey } from "./app-timezone.js";

/**
 * How far from "now" a service may start and still open a NEW record.
 *
 * Generous on purpose. It only has to separate today's service from one days
 * away; it must never be tight enough to second-guess a service that is actually
 * happening, however long it runs or however far its start slipped.
 */
export const SERVICE_START_WINDOW_MS = 12 * 60 * 60_000;

/** The instant a live tick's service is anchored to, or null when unknowable. */
function serviceAnchorMs(live: PcoLiveDTO): number | null {
  const ref = live.serviceTimeStartsAt ?? live.liveStartAt;
  if (!ref) return null;
  const t = Date.parse(ref);
  return Number.isFinite(t) ? t : null;
}

/**
 * Is this service close enough to now to START recording?
 *
 * Fails OPEN: with no usable time signal we record. A missing plan time is a PCO
 * cache miss, not evidence that nothing is happening, and refusing to record a
 * real service is far worse than keeping one stray record.
 */
export function isServiceNearNow(live: PcoLiveDTO, nowMs: number = Date.now()): boolean {
  const anchor = serviceAnchorMs(live);
  if (anchor === null) return true;
  return Math.abs(nowMs - anchor) <= SERVICE_START_WINDOW_MS;
}

/**
 * The gate every recorder asks.
 *
 * @param hasOpenRecord true when this recorder holds a record that is not yet
 *   closed. That is the latch: while it holds, the answer for a live item is
 *   unconditionally yes.
 */
export function shouldRecordLive(
  live: PcoLiveDTO,
  hasOpenRecord: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (live.mode !== "item" || !live.currentItemId) return false;
  if (hasOpenRecord) return true; // rule 1 — nothing time-based may end a live recording
  return isServiceNearNow(live, nowMs); // rule 2
}

/**
 * The calendar date to file a record under, in the APP's zone.
 *
 * Derived from the service's own start time, not from "now": an evening service
 * recorded either side of midnight-UTC used to be stamped with two different days
 * depending on which side of 19:00 local the record happened to open.
 */
export function serviceDateKey(live: PcoLiveDTO, nowMs: number = Date.now()): string {
  return zonedDateKey(serviceAnchorMs(live) ?? nowMs);
}
