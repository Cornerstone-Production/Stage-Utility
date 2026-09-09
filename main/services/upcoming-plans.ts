// The date window and the ordering behind GET /api/plans/upcoming.
//
// Kept out of stage-controller so the two decisions that can quietly go wrong —
// which plans are in the window, and what order they come back in — can be
// driven directly, with a fixed clock and without Planning Center.
//
// The window is computed in the APP time zone, never the host's. A UTC box rolls
// its date at 19:00 in Chicago, and a window that rolls with it would drop the
// evening's own plan out of the switcher during a service.

import type { PlanDTO, ServiceTypeDTO, UpcomingPlan } from "../types/pco.js";
import { appTimeZone, startOfZonedDay, zonedDateKey, type TimeZone } from "./app-timezone.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the switcher reaches. Last Sunday is still worth editing — a
 *  correction made after the fact is how the next export gets it right. */
export const UPCOMING_LOOKBACK_DAYS = 7;

/** How long a fetched list is reused before Planning Center is asked again.
 *  The switcher is opened repeatedly while editing three types in a row, and a
 *  request per open would spend the PCO quota on a list that never changes. */
export const UPCOMING_CACHE_MS = 5 * 60 * 1000;

/** Default and maximum lookahead, in days. */
export const UPCOMING_DEFAULT_DAYS = 60;
export const UPCOMING_MAX_DAYS = 365;

export interface PlanWindow {
  /** Inclusive, at the start of the day. */
  from: number;
  /** Exclusive, at the start of the day after the last one included. */
  to: number;
}

/**
 * [start of (today − 7 days), start of (today + days + 1)) in the app zone.
 *
 * Whole days at both ends, so a plan at 09:00 this morning is still in the
 * window at 18:00 tonight — an operator fixing a board after the service must
 * not find the plan they are fixing has fallen off the list.
 */
export function planWindow(nowMs: number, days: number, tz: TimeZone = appTimeZone()): PlanWindow {
  const today = startOfZonedDay(zonedDateKey(nowMs, tz), tz);
  return { from: today - UPCOMING_LOOKBACK_DAYS * DAY_MS, to: today + (days + 1) * DAY_MS };
}

/**
 * Is this plan's date inside the window?
 *
 * An undated plan is NOT in the window — the arrows walk by date, and a plan
 * with no date cannot be placed among the others. `keepPlan` still keeps the
 * machine's own plan whatever its date, which is the case that matters.
 */
export function withinWindow(sortDate: string | null, w: PlanWindow): boolean {
  if (!sortDate) return false;
  const at = Date.parse(sortDate);
  if (!Number.isFinite(at)) return false;
  return at >= w.from && at < w.to;
}

/**
 * The plan the machine is following is never filtered out.
 *
 * Without this, an operator whose current plan is a month old — or one PCO could
 * not date — opened the switcher on a list that did not contain the board they
 * were looking at, and the first arrow press moved them somewhere unrelated.
 */
export function keepPlan(plan: PlanDTO, w: PlanWindow, currentPlanId: string | null): boolean {
  return plan.id === currentPlanId || withinWindow(plan.sortDate, w);
}

/**
 * Oldest first; undated last, then by title.
 *
 * Sorted across service types, because that is the order the "upcoming" mode's
 * arrows walk: next Wednesday's youth plan comes before next Sunday's.
 */
export function sortUpcoming(plans: UpcomingPlan[]): UpcomingPlan[] {
  return [...plans].sort((a, b) => {
    const at = a.sortDate ? Date.parse(a.sortDate) : NaN;
    const bt = b.sortDate ? Date.parse(b.sortDate) : NaN;
    const aok = Number.isFinite(at);
    const bok = Number.isFinite(bt);
    if (aok && bok && at !== bt) return at - bt;
    if (aok !== bok) return aok ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** One service type's plans, flattened into switcher rows. */
export function toUpcoming(
  type: ServiceTypeDTO,
  plans: PlanDTO[],
  w: PlanWindow,
  currentPlanId: string | null,
): UpcomingPlan[] {
  return plans
    .filter((p) => keepPlan(p, w, currentPlanId))
    .map((p) => ({
      serviceTypeId: type.id,
      serviceTypeName: type.name,
      planId: p.id,
      title: p.title,
      sortDate: p.sortDate,
      dates: p.dates,
      isCurrent: p.id === currentPlanId,
    }));
}

/**
 * Same ids, same order? The upcoming list's cache key includes the allowlist,
 * and a cache entry built under a different one answers for service types the
 * operator has since turned on or off.
 */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The service types the switcher covers. An empty allowlist means all of them,
 *  the same rule every other reader of `allowedServiceTypeIds` follows. */
export function switcherTypes(types: ServiceTypeDTO[], allowed: string[]): ServiceTypeDTO[] {
  return allowed.length === 0 ? types : types.filter((t) => allowed.includes(t.id));
}
