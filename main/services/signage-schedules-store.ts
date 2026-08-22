// signage-schedules-store.ts — the schedule list, where ORDER IS PRIORITY.
//
// The stored array's order is the whole conflict-resolution rule: when two
// schedules both match a display at the same instant, the one nearer the front
// wins. That is why reordering is its own operation rather than a field, and why
// applyScheduleOrder is careful about a stale request.

import type { SignageSchedule } from "../types/signage.js";
import { DataStore } from "./data-store.js";

export const signageSchedulesStore = new DataStore<SignageSchedule[]>(
  "signage-schedules.json",
  [],
  "config",
);

export function listSchedules(): Promise<SignageSchedule[]> {
  return signageSchedulesStore.load();
}

/**
 * Reorder `all` to match `ids`.
 *
 * PURE, so the interesting cases are testable without a disk.
 *
 * The order arrives from a page that loaded some time ago, so it is allowed to
 * be stale in both directions: an id that has since been deleted is ignored, and
 * a schedule created since — which the page never saw — is APPENDED rather than
 * dropped. Dropping it would not merely lose a row: this list is the priority
 * order, so a schedule silently missing from it stops firing altogether.
 */
export function applyScheduleOrder(
  all: SignageSchedule[],
  ids: string[],
): SignageSchedule[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const out: SignageSchedule[] = [];
  const taken = new Set<string>();
  for (const id of ids) {
    const s = byId.get(id);
    if (!s || taken.has(id)) continue; // deleted since, or listed twice
    taken.add(id);
    out.push(s);
  }
  // Anything the caller did not mention keeps its existing relative order at the
  // end, so a concurrent create lands somewhere rather than vanishing.
  for (const s of all) if (!taken.has(s.id)) out.push(s);
  return out;
}

export function reorderSchedules(ids: string[]): Promise<SignageSchedule[]> {
  return signageSchedulesStore.update((all) => applyScheduleOrder(all, ids));
}
