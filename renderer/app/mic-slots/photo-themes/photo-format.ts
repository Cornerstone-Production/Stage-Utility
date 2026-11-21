// How the panel words dates and counts. Dates arrive as `YYYY-MM-DD` day keys in
// the app's time zone (or an ISO instant for a plan's sort date), so a day key is
// formatted AS A DAY, in UTC: running one through the browser's zone would shift
// it a day for anybody west of Greenwich.

import type { ThemeDTO } from "@main/types/photo-themes";

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** `Sun, Dec 14`, from a day key or an ISO instant. Null for nothing usable. */
export function serviceDay(date: string | null | undefined): string | null {
  if (!date) return null;
  const key = /^\d{4}-\d{2}-\d{2}/.exec(date)?.[0];
  if (!key) return null;
  const at = Date.parse(`${key}T12:00:00Z`);
  return Number.isFinite(at) ? DAY.format(at) : null;
}

/** `Mar 21, 2027`, from a day key. */
export function keptDay(date: string): string {
  const at = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(at) ? DAY_YEAR.format(at) : date;
}

/** The services using a theme, as a list an operator can read: dates, soonest first. */
export function usedBy(theme: ThemeDTO): string[] {
  return [...theme.plans]
    .sort((a, b) => (a.sortDate ?? "9999").localeCompare(b.sortDate ?? "9999"))
    .map((p) => serviceDay(p.sortDate) ?? "a plan with no date");
}
