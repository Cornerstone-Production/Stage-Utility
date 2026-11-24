// How the panel words dates. Two kinds arrive, and each is read its own way:
//
//   - A plan's sort date (and a photo's `fromDate`, which is one) is an INSTANT.
//     It is named on the app's calendar with planDateLabel, as the server's
//     zonedDateKey does: a 7pm Sunday service in Chicago is 01:00 Monday in UTC.
//   - `keptUntil` is a `YYYY-MM-DD` day key the server already worked out in the
//     app's zone, so it is formatted AS A DAY, in UTC: running it through any
//     zone would shift it a day for somebody.

import type { ThemeDTO } from "@main/types/photo-themes";

import { planDateLabel } from "../../../settings/sections/plan-date-label";

const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** `Mar 21, 2027`, from a day key. */
export function keptDay(date: string): string {
  const at = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(at) ? DAY_YEAR.format(at) : date;
}

/** The services using a theme, as a list an operator can read: dates on the app's calendar, soonest first. */
export function usedBy(theme: ThemeDTO, timeZone: string): string[] {
  return [...theme.plans]
    .sort((a, b) => (a.sortDate ?? "9999").localeCompare(b.sortDate ?? "9999"))
    .map((p) => planDateLabel(p.sortDate, timeZone) ?? "a plan with no date");
}
