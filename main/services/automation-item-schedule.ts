// automation-item-schedule.ts — a clock for every item in a plan.
//
// PCO publishes no scheduled time on an Item. Verified against the live API: an
// Item carries title, item_type, length, sequence and service_position, and its
// item_times are empty until something actually goes live. So an item's time has
// to come from somewhere else, and there are two sources — in this order:
//
//   EXACT   — a plan_time whose name matches the item's title. plan_times DO carry
//             real starts_at values, so naming one after an item ("Doors") pins
//             that item to a real clock that survives the plan running long.
//   DERIVED — otherwise, the running sum of item lengths anchored at the SERVICE
//             START header. This is the same arithmetic the plan editor shows, and
//             the same the pre-service countdown already uses.
//
// DERIVED TIMES ARE PLANNED, NOT ACTUAL. Once a service is running they drift with
// it: an item that runs four minutes long pushes everything after it four minutes
// late, and nothing here knows that. Times for items ABOVE the service-start header
// are the dependable ones — nothing has run yet, so there is nothing to drift. Add
// a plan_time to make any item exact.

import { isServiceStartHeader } from "./pco-plan-markers.js";

/** Only what the schedule needs. Accepts a PlanItemDTO unchanged. */
export type SchedulableItem = { title: string; itemType: string; lengthSec: number };

/** A plan_time with a name — the exact-time source. */
export type NamedTime = { name: string; startsAt: string };

export type ScheduledItem = {
  title: string;
  /** ISO moment this item begins. */
  dueAt: string;
  /** True when this came from a matching plan_time rather than summed lengths.
   *  Exact times hold when the service runs long; derived ones do not. */
  exact: boolean;
};

const norm = (s: string): string => (s ?? "").trim().toLowerCase();

/**
 * Planned start time for each item.
 *
 * A plan_time whose name equals the item's title wins outright. Everything else is
 * derived by anchoring the SERVICE START header on `serviceStartIso`: items above
 * it get earlier times, items below get later ones. With no such header the top of
 * the plan is the anchor, matching the countdown's "plan-start" fallback.
 *
 * Name matching is exact (case- and whitespace-insensitive), not substring — a
 * plan_time called "Service" must not claim "Service End".
 *
 * An item with neither an exact match nor a usable anchor is omitted rather than
 * guessed at. A caller must be able to tell "not scheduled" from "scheduled at
 * midnight", and a rule armed against a guessed time fires at the wrong moment.
 */
export function scheduleItems(
  items: SchedulableItem[],
  serviceStartIso: string | null,
  namedTimes: NamedTime[] = [],
): ScheduledItem[] {
  const exactByName = new Map<string, string>();
  for (const t of namedTimes) {
    const key = norm(t.name);
    // First one wins, so a duplicate name cannot silently reassign an item.
    if (key && !exactByName.has(key) && !Number.isNaN(Date.parse(t.startsAt))) {
      exactByName.set(key, t.startsAt);
    }
  }

  const anchorMs = serviceStartIso ? Date.parse(serviceStartIso) : Number.NaN;
  const haveAnchor = !Number.isNaN(anchorMs);

  // Seconds from the top of the plan to the start of each item.
  const elapsedTo: number[] = [];
  let running = 0;
  for (const item of items) {
    elapsedTo.push(running);
    running += item.lengthSec > 0 ? item.lengthSec : 0;
  }

  const startIdx = items.findIndex((i) => i.itemType === "header" && isServiceStartHeader(i.title));
  // No marker header means the plan simply begins at the service time.
  const anchorElapsed = elapsedTo[startIdx >= 0 ? startIdx : 0] ?? 0;

  const out: ScheduledItem[] = [];
  items.forEach((item, i) => {
    const exact = exactByName.get(norm(item.title));
    if (exact) {
      out.push({ title: item.title, dueAt: new Date(Date.parse(exact)).toISOString(), exact: true });
      return;
    }
    if (!haveAnchor) return;
    out.push({
      title: item.title,
      dueAt: new Date(anchorMs + (elapsedTo[i] - anchorElapsed) * 1000).toISOString(),
      exact: false,
    });
  });
  return out;
}
