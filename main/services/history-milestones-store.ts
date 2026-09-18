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

/**
 * `unknown[]`, not `HistoryMilestone[]`: what goes to disk is every milestone
 * this module understands PLUS every row it does not, carried verbatim. The
 * reading side (`partitionMilestones`) is what narrows it, and it is the only
 * thing that may.
 */
const store = new DataStore<unknown[]>("history-milestones.json", [], "config");

/** Re-exported so a reader of this module has the rule to hand — the Trends
 *  chart applies the SAME one to an entry that reached the file anyway. */
export { isCalendarDate };

/**
 * How long a label may be.
 *
 * It is drawn under a chart axis, where the room between two marks is tens of
 * pixels — `fitLabel` truncates anything longer and the full text lives in the
 * hover and the aria-label. Sixty characters is already far more than fits; past
 * that the entry is a paragraph somebody will only ever read in Settings, and
 * the field is the wrong place for it.
 */
export const MAX_LABEL_LENGTH = 60;

/**
 * The entries that can be drawn, and the labels of the ones that cannot.
 *
 * Pure and exported so the rule is testable without a store or a disk. A bad
 * date is SKIPPED rather than dropped from the file: the operator's entry stays
 * where they put it, and they get a log line naming it instead of an entry that
 * silently disappeared. Nothing here deletes anybody's row.
 */
export function partitionMilestones(raw: unknown): {
  valid: HistoryMilestone[];
  /** The labels of the rows that cannot be drawn — for the log line. */
  skipped: string[];
  /** Those rows, VERBATIM. Carried back onto every write, so a row the operator
   *  put in the file is still there after an unrelated save. */
  skippedRows: unknown[];
} {
  const valid: HistoryMilestone[] = [];
  const skipped: string[] = [];
  const skippedRows: unknown[] = [];
  if (!Array.isArray(raw)) return { valid, skipped, skippedRows };
  for (const row of raw) {
    if (!row || typeof row !== "object") {
      // Named, not merely kept. A row that is a string or a null is skipped for
      // the same reason a bad date is, and an operator looking for a mark that
      // never appeared needs a line about it just as much — it was kept in the
      // file and mentioned nowhere.
      skipped.push(typeof row === "string" ? row : String(row));
      skippedRows.push(row);
      continue;
    }
    const r = row as Partial<HistoryMilestone>;
    const label = typeof r.label === "string" ? r.label : "";
    if (!isCalendarDate(r.date)) {
      skipped.push(label);
      skippedRows.push(row);
      continue;
    }
    valid.push({
      id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
      date: r.date,
      label,
      serviceTypeId: typeof r.serviceTypeId === "string" && r.serviceTypeId ? r.serviceTypeId : null,
    });
  }
  return { valid, skipped, skippedRows };
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
/**
 * The rows on disk this module could not read, kept verbatim and written back
 * out beside the ones it could.
 *
 * The comment on `partitionMilestones` says a bad row is "SKIPPED rather than
 * dropped from the file", and it was not: the next write persisted `cache`,
 * which never held it, so adding one good milestone silently deleted the
 * operator's unreadable one and the log line naming it stopped appearing.
 * Deleting an operator's data to tidy something up is not a thing this repo
 * does — the row stays where they put it, and a hand edit or a restore can
 * still fix it. It is still skipped on the way back IN, so it never draws.
 */
let unreadable: unknown[] = [];

/** What goes to disk: everything this module understands, plus everything it
 *  does not, untouched. */
function persistable(): unknown[] {
  return [...cache, ...unreadable];
}

export const historyMilestonesStore = {
  async init(): Promise<void> {
    const { valid, skipped, skippedRows } = partitionMilestones(await store.load());
    reportSkipped(skipped);
    cache = valid.sort(byDateDesc);
    unreadable = skippedRows;
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
  async save(
    input: Omit<HistoryMilestone, "id"> & { id?: string },
    /** Every service type the history knows, or null to accept any. A mark
     *  scoped to a type that does not exist draws on nothing and is silently
     *  invisible, which is the failure the caller is refused for. */
    knownTypeIds: readonly string[] | null = null,
  ): Promise<HistoryMilestone[]> {
    if (!isCalendarDate(input.date)) {
      throw new Error(`"${input.date}" is not a date (YYYY-MM-DD)`);
    }
    const label = String(input.label ?? "").trim();
    if (!label) throw new Error("a milestone needs a label");
    if (label.length > MAX_LABEL_LENGTH) {
      throw new Error(`a milestone label is at most ${MAX_LABEL_LENGTH} characters (this one is ${label.length})`);
    }
    const serviceTypeId = input.serviceTypeId || null;
    if (serviceTypeId && knownTypeIds && !knownTypeIds.includes(serviceTypeId)) {
      throw new Error(`no service type "${serviceTypeId}" has a recorded service to mark`);
    }
    const entry: HistoryMilestone = {
      id: input.id || randomUUID(),
      date: input.date,
      label,
      serviceTypeId,
    };
    cache = [...cache.filter((m) => m.id !== entry.id), entry].sort(byDateDesc);
    await store.save(persistable());
    return cache;
  },

  /**
   * Forget one, or `null` when there was no such id. Awaited, like every write
   * of the operator's own work: a save that silently failed would read as saved
   * until the next restart.
   *
   * The null is what lets the route answer 404 rather than 200 for a deletion
   * that did not happen.
   */
  async remove(id: string): Promise<HistoryMilestone[] | null> {
    const before = cache.length;
    cache = cache.filter((m) => m.id !== id);
    if (cache.length === before) return null;
    await store.save(persistable());
    return cache;
  },
};
