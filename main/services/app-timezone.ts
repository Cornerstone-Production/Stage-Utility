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
