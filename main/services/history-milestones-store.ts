// history-milestones-store.ts — the dates worth marking on the Trends chart.
//
// "Moved to two services", "new building", "Kickoff 2026". A trend line without
// them says attendance jumped 300 one week in March and offers no reason; the
// reason is the only part anybody wants.
//
// Operator config, so "config": somebody typed these, one at a time, and losing
// them to a reinstall is losing their work. Being config is also what puts them
// in every backup — the snapshot allowlist is derived from this classification.
//
// GLOBAL, not per-browser, for the same reason the saved colours are: the same
// person adds one from the booth laptop and reads the chart from the tablet by
// the desk, and a list that existed on only one of them would read as having
// lost the entry.
//
// The Trends chart draws these ALONGSIDE automatic marks it derives itself,
// where a plan's series title changes between consecutive recordings of one
// type — see renderer/settings/sections/history-trends/trends.ts. Those are not
// stored: they are a fact about the recordings, re-derived on every read, and
// writing them down would leave them behind when a recording is corrected.

import { randomUUID } from "node:crypto";

import { DataStore } from "./data-store.js";
import { isCalendarDate } from "./calendar-date.js";
import { scrub } from "./scrub.js";

/** One dated mark under the Trends chart. */
export interface HistoryMilestone {
  id: string;
  /** Local calendar date, `YYYY-MM-DD`. A milestone is a DAY, not an instant —
   *  "we moved to two services" did not happen at 14:32. */
  date: string;
  label: string;
  /** Limits the mark to one service type's series. Null = every type. */
  serviceTypeId: string | null;
}

const store = new DataStore<HistoryMilestone[]>("history-milestones.json", [], "config");

/** Re-exported so a reader of this module has the rule to hand — the Trends
 *  chart applies the SAME one to an entry that reached the file anyway. */
export { isCalendarDate };

/**
 * The entries that can be drawn, and the labels of the ones that cannot.
 *
 * Pure and exported so the rule is testable without a store or a disk. A bad
 * date is SKIPPED rather than dropped from the file: the operator's entry stays
 * where they put it, and they get a log line naming it instead of an entry that
 * silently disappeared. Nothing here deletes anybody's row.
 */
export function partitionMilestones(raw: unknown): { valid: HistoryMilestone[]; skipped: string[] } {
  const valid: HistoryMilestone[] = [];
  const skipped: string[] = [];
  if (!Array.isArray(raw)) return { valid, skipped };
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<HistoryMilestone>;
    const label = typeof r.label === "string" ? r.label : "";
    if (!isCalendarDate(r.date)) {
      skipped.push(label);
      continue;
    }
    valid.push({
      id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
      date: r.date,
      label,
      serviceTypeId: typeof r.serviceTypeId === "string" && r.serviceTypeId ? r.serviceTypeId : null,
    });
  }
  return { valid, skipped };
}

/** The one log line this subsystem has. `scrub` because the label is operator
 *  input and `/log` is one record per line — a newline in it would forge one. */
function reportSkipped(skipped: string[]): void {
  for (const label of skipped) {
    console.log(`[history] milestone "${scrub(label)}" has no valid date, skipped`);
  }
}

/** Newest first — a chart is read from the recent end, and so is this list. */
function byDateDesc(a: HistoryMilestone, b: HistoryMilestone): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

let cache: HistoryMilestone[] = [];

export const historyMilestonesStore = {
  async init(): Promise<void> {
    const { valid, skipped } = partitionMilestones(await store.load());
    reportSkipped(skipped);
    cache = valid.sort(byDateDesc);
  },

  all(): HistoryMilestone[] {
    return cache;
  },

  /**
   * Add one, or replace the one with the same id.
   *
   * THROWS on a date that is not a calendar date rather than storing it and
   * logging on the way back out — a milestone the operator cannot see is worse
   * than a form that refuses. The log line above is for a file that already
   * contains one: a hand edit, or a restored backup from a version that was
   * less careful.
   */
  async save(input: Omit<HistoryMilestone, "id"> & { id?: string }): Promise<HistoryMilestone[]> {
    if (!isCalendarDate(input.date)) {
      throw new Error(`"${input.date}" is not a date (YYYY-MM-DD)`);
    }
    const entry: HistoryMilestone = {
      id: input.id || randomUUID(),
      date: input.date,
      label: String(input.label ?? "").trim(),
      serviceTypeId: input.serviceTypeId || null,
    };
    cache = [...cache.filter((m) => m.id !== entry.id), entry].sort(byDateDesc);
    await store.save(cache);
    return cache;
  },

  /** Forget one. Awaited, like every write of the operator's own work: a save
   *  that silently failed would read as saved until the next restart. */
  async remove(id: string): Promise<HistoryMilestone[]> {
    cache = cache.filter((m) => m.id !== id);
    await store.save(cache);
    return cache;
  },
};
