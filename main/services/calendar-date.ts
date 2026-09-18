// calendar-date.ts — is this string a real day?
//
// Its own module, with no dependencies, because BOTH halves of the app need the
// same answer and neither can import the other's: the milestone store refuses a
// date it cannot draw, and the Trends chart drops one that reached the file
// anyway (a hand edit, or a backup restored from a version that was less
// careful). Two copies of this rule would be two rules the day one of them was
// tightened.

/**
 * A real `YYYY-MM-DD`.
 *
 * The round trip is the point. `new Date("2026-02-31")` parses happily and
 * lands on the 2nd or 3rd of March, so a parse alone accepts the 31st of
 * February and silently moves it — which on a chart means a mark under a date
 * nothing happened on.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
