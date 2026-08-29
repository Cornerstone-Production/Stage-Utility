// app-timezone.ts — the one wall-clock zone this app reasons in.
//
// Anything asking "what day is it?" or "is it 3am yet?" must ask HERE, never the
// host clock. The two are not the same thing, and assuming they were cost a
// service: most Linux images (and every container) run UTC, so on a UTC host the
// calendar date rolls at 19:00 in Chicago. Every "is this today?" comparison in
// the app flipped mid-evening, and a live service stopped recording at 7pm on the
// dot — see docs/integrations/service-history.md.
//
// Resolution order: the operator's configured zone, else the host's. An invalid
// zone falls back to the host instead of throwing: a typo in settings must not
// take the server down, and a slightly wrong clock beats no server at all.

/** An IANA zone name (e.g. "America/Chicago"). */
export type TimeZone = string;

export function hostTimeZone(): TimeZone {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let configured: TimeZone | null = null;

/** Set from settings. Anything invalid (or empty) means "follow the host". */
export function setAppTimeZone(tz: string | null | undefined): void {
  configured = tz && isValidTimeZone(tz) ? tz : null;
}

/** The zone every local-time decision in the app is made in. */
export function appTimeZone(): TimeZone {
  return configured ?? hostTimeZone();
}

/** True when the app is following the host clock rather than an explicit setting. */
export function isFollowingHostTimeZone(): boolean {
  return configured === null;
}

export interface ZonedParts {
  year: number;
  /** 1-12, not the 0-based month `Date` uses. */
  month: number;
  day: number;
  /** 0 = Sunday, matching `Date.prototype.getDay`. */
  weekday: number;
  /** 0-23. */
  hour: number;
  minute: number;
}

// Intl.DateTimeFormat construction is not cheap and these run on every live tick.
const formatters = new Map<TimeZone, Intl.DateTimeFormat>();

function formatter(tz: TimeZone): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      // h23 so midnight is hour 0. The default hour12 cycle renders it as 24,
      // which silently breaks any `hour === 0` comparison.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Break an instant into wall-clock parts in `tz`. */
export function zonedParts(ms: number, tz: TimeZone = appTimeZone()): ZonedParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter(tz).formatToParts(new Date(ms));
  } catch {
    parts = formatter(hostTimeZone()).formatToParts(new Date(ms));
  }
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // Derive the weekday from the zoned Y/M/D rather than parsing a localized
  // weekday name — no locale or abbreviation to get wrong.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday, hour: get("hour"), minute: get("minute") };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The calendar date at `ms` in `tz`, as "YYYY-MM-DD". */
export function zonedDateKey(ms: number, tz: TimeZone = appTimeZone()): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since midnight at `ms` in `tz`. */
export function zonedMinuteOfDay(ms: number, tz: TimeZone = appTimeZone()): number {
  const p = zonedParts(ms, tz);
  return p.hour * 60 + p.minute;
}

/** The zone's offset from UTC at `ms`, in milliseconds (east of UTC is positive). */
function zoneOffsetMs(ms: number, tz: TimeZone): number {
  const p = zonedParts(ms, tz);
  // zonedParts resolves to the minute, so compare against a minute-truncated
  // instant or every offset comes out seconds wrong.
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant local midnight begins on `dateKey` ("YYYY-MM-DD") in `tz`.
 *
 * The inverse of {@link zonedDateKey}, and the reason it lives here rather than
 * beside its caller: turning a wall-clock date back into a point in time needs
 * the zone's offset AT THAT DATE, and a second private implementation of that is
 * exactly the kind of copy this repository has watched drift.
 *
 * The offset is read twice because the first read happens at the wrong instant
 * whenever the guess lands on the far side of a DST change. Both candidates are
 * then checked against the zone, because a handful of zones (Santiago, Beirut)
 * SKIP midnight on the spring-forward date — there is no 00:00 that day, and the
 * day begins at the instant the clocks jumped.
 *
 * @throws if `dateKey` is not a bare YYYY-MM-DD. An instant would silently work
 *   under the regexless version of this and place the day an offset away.
 */
export function startOfZonedDay(dateKey: string, tz: TimeZone = appTimeZone()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new Error(`startOfZonedDay expects a YYYY-MM-DD date, got "${dateKey}"`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // Exactly two candidates, because there are exactly two offsets in play: the
  // one in force at the naive guess, and the one in force where that guess
  // lands. They are equal on all but two days a year.
  const naive = wall - zoneOffsetMs(wall, tz);
  const corrected = wall - zoneOffsetMs(naive, tz);
  const earlier = Math.min(naive, corrected);
  const later = Math.max(naive, corrected);

  // The EARLIEST instant that reads as this date locally — on a fall-back date
  // that is the first of the two 00:00s, not the second.
  if (zonedDateKey(earlier, tz) === dateKey) return earlier;
  if (zonedDateKey(later, tz) === dateKey) return later;
  // Neither reads as this date, which happens only where the zone SKIPS midnight
  // (Santiago, Beirut): the day has no 00:00 and begins when the clocks jumped,
  // so the later candidate is the first instant on it.
  return later;
}
