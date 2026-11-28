// retry-after.ts — a Retry-After header as milliseconds.
//
// The header is either delta-seconds ("120") or an HTTP date. Callers had each
// parsed it their own way: one by Number() (so "0x10" read as 16 seconds and a
// header of spaces as no wait at all), one by parseInt (so a date was ignored),
// one by a regex. This is the one reading; what a caller does with the answer
// (the ceiling, whether 0 counts as an instruction) stays its own policy.

/** Delta-seconds as RFC 9110 writes them: digits, and a fraction is tolerated. */
const DELTA_SECONDS = /^\d+(?:\.\d+)?$/;

/**
 * `header` as a wait in ms, or null when it is absent or not a Retry-After
 * (blank, hex, a date that will not parse). A date in the past is 0 ms. `now` is
 * the clock the date form is measured from. Clamped to `maxMs` when given, so a
 * day-long header, or a date from a box whose clock is wrong, cannot hold a
 * caller off for the rest of the service.
 */
export function retryAfterMs(header: string | null | undefined, now: number, maxMs = Infinity): number | null {
  const text = header?.trim();
  if (!text) return null;
  if (DELTA_SECONDS.test(text)) return Math.min(Number(text) * 1000, maxMs);
  // Date.parse reads "-5" as a year 2001 date; an HTTP date always has a month or day name.
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), maxMs) : null;
}
