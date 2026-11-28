// zoned-time-input.ts — an <input type="time"> that edits an instant, in a zone.
//
// The field holds a bare "HH:MM" or "HH:MM:SS"; the record holds an instant. Both
// directions go through the zone the caller names, which for anything recorded is
// the APP's zone (`appZoneOf`), never this browser's. A browser in UTC showing an
// evening service in Chicago read its times a day out, and the stamps it sent back
// moved the whole service a day and trimmed away every item and sample it had.

import { pad2 } from "@main/services/duration-format";
import { zonedParts, zonedTimeNear, type TimeZone } from "@main/services/app-timezone";

/** An instant as the field shows it in `tz`, or "" for a missing or unreadable stamp. */
export function toZonedTimeInput(
  iso: string | null | undefined,
  tz: TimeZone,
  opts: { seconds?: boolean } = {},
): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const p = zonedParts(ms, tz);
  const hhmm = `${pad2(p.hour)}:${pad2(p.minute)}`;
  // Seconds are the instant's own: every zone in use is offset by whole minutes.
  return opts.seconds ? `${hhmm}:${pad2(Math.floor(ms / 1000) % 60)}` : hhmm;
}

/**
 * What a typed "HH:MM[:SS]" means, as an ISO instant: that time in `tz`, on
 * whichever day puts it nearest `nearMs`. Undefined for a blank or unreadable
 * field, or an anchor that is not a time.
 *
 * The anchor is the caller's statement of where the answer should land. For a
 * correction it is the stamp being corrected; for the end of a window it is half
 * a day after the start, so the end is the first reading after the start and a
 * service that runs past midnight ends on the next day.
 */
export function fromZonedTimeInput(value: string, nearMs: number, tz: TimeZone): string | undefined {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m || !Number.isFinite(nearMs)) return undefined;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return undefined;
  return new Date(zonedTimeNear(nearMs, h, min, s, tz)).toISOString();
}
