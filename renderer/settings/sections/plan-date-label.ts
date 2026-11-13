// plan-date-label.ts — a Planning Center plan's date as stage plots names it,
// "Sun 15 Nov" (day before month, the mockup's order), on the app's calendar.
//
// Beside planLabel (slots-target-pill.tsx), which words the same date in the
// browser's own order for the slot editor. Stage plots uses this one: its
// badge, its This week card, its delete confirm and its printed date.

import type { UpcomingPlan } from "@main/types/pco";

/** "Sun 15 Nov", or with `year` "Thu 12 Nov 2026", for the instant `ms` on the calendar of `timeZone`. */
export function zonedDayLabel(ms: number, timeZone: string, { year = false }: { year?: boolean } = {}): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" as const } : {}),
    timeZone,
  }).formatToParts(ms);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return [get("weekday"), get("day"), get("month"), ...(year ? [get("year")] : [])].join(" ");
}

/** "9:00" for the instant `ms` in `timeZone`, on a 24-hour clock. */
function zonedTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hourCycle: "h23", timeZone }).format(ms);
}

/**
 * A plan's date from its ISO sort date, else Planning Center's own words
 * (`dates`), else null. `withTime` adds the time of day, for telling apart two
 * plans on one day.
 */
export function planDateLabel(sortDate: string | null | undefined, timeZone: string, { dates = null, withTime = false }: { dates?: string | null; withTime?: boolean } = {}): string | null {
  const at = sortDate ? Date.parse(sortDate) : NaN;
  if (!Number.isFinite(at)) return dates;
  return withTime ? `${zonedDayLabel(at, timeZone)} ${zonedTime(at, timeZone)}` : zonedDayLabel(at, timeZone);
}

/**
 * Names for plans: each by its date, from the date an override stored, else
 * the upcoming list's, with the time added only where two plans the list (or
 * the overrides) know of fall on one day. A plan with no date at all is "A plan
 * with no date".
 */
export function planNamer(
  plans: readonly UpcomingPlan[],
  timeZone: string,
  stored: readonly { planId: string; planDate: string | null }[] = [],
): (p: { planId: string; planDate?: string | null }) => string {
  const dateOf = new Map<string, string>();
  for (const p of plans) if (p.sortDate) dateOf.set(p.planId, p.sortDate);
  for (const o of stored) if (o.planDate && !dateOf.has(o.planId)) dateOf.set(o.planId, o.planDate);
  const onDay = new Map<string, Set<string>>();
  for (const [planId, date] of dateOf) {
    const day = planDateLabel(date, timeZone);
    if (day) onDay.set(day, (onDay.get(day) ?? new Set()).add(planId));
  }
  return ({ planId, planDate }) => {
    const date = planDate ?? dateOf.get(planId) ?? null;
    const day = planDateLabel(date, timeZone);
    const shared = day !== null && (onDay.get(day)?.size ?? 0) > 1;
    return planDateLabel(date, timeZone, { dates: plans.find((p) => p.planId === planId)?.dates ?? null, withTime: shared }) ?? "A plan with no date";
  };
}
