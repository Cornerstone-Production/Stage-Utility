// history-item-times.ts — an operator's correction of ONE recorded item's start
// and end, kept as an OVERLAY over the raw recording.
//
// The recorder writes what it observed, and `events.csv` keeps the same
// transitions as raw rows that `rebuildTimelineRecord` re-derives the items
// from. So a correction cannot be written INTO an item: the next rebuild would
// throw it away without saying so. It is stored beside the items as
// `itemTimeEdits` and applied HERE, on read, in one place — `overlaidTimeline`
// and `broadcastTimeline` are the only two ways a stored timeline reaches a
// client, so a new read path cannot forget the overlay by omission.
//
// Two things this deliberately does NOT do:
//
//   - Move the neighbours. Shortening an item leaves a gap before the next one,
//     and the table shows the gap. Closing it would invent timings nobody
//     observed for items the operator did not ask about.
//   - Touch the raw rows. `events.csv` and the sample archive are the evidence;
//     an edit is a statement about the summary, and Reset puts the summary back.

import type { ServiceItemTimeEdit, ServiceTimeline, ServiceTimelineItem } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { scrub } from "./scrub.js";

/** What an overlay did, including what it could not place. */
export interface ItemTimeOverlay {
  /** The record as the operator should see it: raw items with the corrections on top. */
  record: ServiceTimeline;
  /** Edits whose (itemId, sequence) names no run in this record — a rebuild or a
   *  merge moved the run out from under them. Returned rather than swallowed:
   *  the caller decides whether to tell the operator, and the edit itself is
   *  kept, so the run coming back restores the correction. */
  orphaned: ServiceItemTimeEdit[];
}

/** Seconds between two ISO stamps, or null if the end is open or either is junk. */
function durationSec(startedAt: string, endedAt: string | null): number | null {
  if (endedAt == null) return null;
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.max(0, Math.round((e - s) / 1000));
}

/**
 * The item as the recorder wrote it, undoing an overlay already applied.
 *
 * Makes `applyItemTimeEdits` total: applying it to a record that has been
 * through it once is the same as applying it once, rather than recording the
 * EDITED stamps as "what was recorded" and losing the real ones. Records do
 * reach a second read overlaid — the route answers with the overlaid record and
 * the SSE push carries it — and a caller that fed one back would otherwise
 * quietly destroy the operator's undo.
 */
function rawItem(it: ServiceTimelineItem): ServiceTimelineItem {
  if (!it.editedFrom) return it;
  const { editedFrom, ...rest } = it;
  return {
    ...rest,
    startedAt: editedFrom.startedAt,
    endedAt: editedFrom.endedAt,
    actualDurationSec: editedFrom.actualDurationSec,
  };
}

/**
 * Apply a record's `itemTimeEdits` over its items.
 *
 * Pure — no store, no disk, no broadcast — so the rebuild path and the tests can
 * use it directly. `actualDurationSec` is recomputed from the EFFECTIVE stamps,
 * which is what makes the Actual and Avg-overrun tiles follow an edit: both sum
 * `actualDurationSec` over the counted items (see `summarize` and
 * `overrunStats`), so neither needs to know this feature exists.
 */
export function applyItemTimeEdits(record: ServiceTimeline): ItemTimeOverlay {
  const items = record.items.map(rawItem);
  const edits = record.itemTimeEdits ?? [];
  if (edits.length === 0) return { record: { ...record, items }, orphaned: [] };

  const orphaned: ServiceItemTimeEdit[] = [];
  for (const edit of edits) {
    const i = items.findIndex((x) => x.itemId === edit.itemId && x.sequence === edit.sequence);
    if (i < 0) {
      orphaned.push(edit);
      continue;
    }
    const raw = items[i];
    const startedAt = edit.startedAt ?? raw.startedAt;
    const endedAt = edit.endedAt ?? raw.endedAt;
    // An override that restates the recorded value is not an edit, and marking
    // the row "edited" for it would be a lie in the UI.
    if (startedAt === raw.startedAt && endedAt === raw.endedAt) continue;
    items[i] = {
      ...raw,
      startedAt,
      endedAt,
      actualDurationSec: durationSec(startedAt, endedAt),
      editedFrom: { startedAt: raw.startedAt, endedAt: raw.endedAt, actualDurationSec: raw.actualDurationSec },
    };
  }
  return { record: { ...record, items }, orphaned };
}

/**
 * The single read gate: a stored timeline as the operator sees it.
 *
 * Every route that answers a timeline and every broadcast of one goes through
 * this or through `broadcastTimeline`.
 *
 * SILENT about orphans, deliberately. This runs on every read — every SSE push,
 * every poll of the History list, every hello burst — so a warning here printed
 * the same line hundreds of times during one service and still could not say
 * which operation had orphaned the correction. Orphaning is reported by the
 * thing that causes it: a rebuild, a merge, or a window edit, each through
 * logOrphanedItemTimeEdits. If one of those leaves an orphan behind, that is a
 * bug in the operation, not something for the reader to announce forever.
 */
export function overlaidTimeline(record: ServiceTimeline): ServiceTimeline {
  return applyItemTimeEdits(record).record;
}

/** Push a timeline to clients with the overlay already on it. The ONLY way a
 *  timeline is broadcast — `broadcast("service-timeline:history", …)` appears
 *  nowhere else, so a new push cannot ship raw stamps by forgetting a call. */
export function broadcastTimeline(record: ServiceTimeline): void {
  broadcast("service-timeline:history", overlaidTimeline(record));
}

/**
 * Bind each record's edits to the ITEM OBJECTS they describe, before anything
 * renumbers them.
 *
 * `mergeServiceRecords` re-sorts the combined items by start time and assigns
 * `sequence = i`, so an edit keyed by (itemId, sequence) points at a different
 * row afterwards — the operator's correction would still be in the record and
 * silently land on the wrong item. `mergeItemRuns` returns the same object
 * references it was given, so object identity is the one handle that survives
 * the renumber.
 */
export function bindItemTimeEdits(
  ...records: ServiceTimeline[]
): Map<ServiceTimelineItem, ServiceItemTimeEdit> {
  const bound = new Map<ServiceTimelineItem, ServiceItemTimeEdit>();
  for (const rec of records) {
    for (const edit of rec.itemTimeEdits ?? []) {
      const item = rec.items.find((x) => x.itemId === edit.itemId && x.sequence === edit.sequence);
      if (item) bound.set(item, edit);
    }
  }
  return bound;
}

/** Re-key bound edits onto the items' CURRENT sequence numbers. Items that did
 *  not survive the merge drop their edit with them, which is what "the local run
 *  wins" already means for the timings themselves. */
export function rekeyItemTimeEdits(
  bound: Map<ServiceTimelineItem, ServiceItemTimeEdit>,
  items: ServiceTimelineItem[],
): ServiceItemTimeEdit[] {
  const out: ServiceItemTimeEdit[] = [];
  for (const item of items) {
    const edit = bound.get(item);
    if (edit) out.push({ ...edit, itemId: item.itemId, sequence: item.sequence });
  }
  return out;
}

/** The result of carrying edits onto a freshly derived item list. */
export interface CarriedItemTimeEdits {
  /** Edits re-keyed onto the runs they belong to, in the new numbering. */
  edits: ServiceItemTimeEdit[];
  /** Edits whose run has no counterpart in the new list. The caller logs these
   *  and decides whether to keep them; nothing here throws them away. */
  orphaned: ServiceItemTimeEdit[];
}

/**
 * Carry edits from `prior` onto items derived fresh, pairing by RUN.
 *
 * Object identity is no help here: a rebuild from `events.csv` constructs new
 * item objects, so `bindItemTimeEdits` has nothing to bind to. The pairing is
 * the Nth run of an itemId to the Nth run of that itemId — exactly the rule
 * `rebuildTimelineRecord` already uses to carry the recorder's own `counted`
 * observation, and `rebuildSplRecord` to carry `itemType`.
 *
 * Carrying the edits UNCHANGED, as this used to, is silently wrong the moment
 * the rebuilt run list differs from the stored one. A record whose second run
 * of a song was corrected, rebuilt after an earlier item was added, moved that
 * correction onto whichever run inherited sequence 4 — the row read `edited`,
 * the operator's real correction was gone, and nothing was reported because the
 * sequence still matched something.
 *
 * `items` must already carry their FINAL sequence numbers.
 */
export function carryItemTimeEdits(
  prior: ServiceTimeline,
  items: ServiceTimelineItem[],
): CarriedItemTimeEdits {
  const edits = prior.itemTimeEdits ?? [];
  if (edits.length === 0) return { edits: [], orphaned: [] };

  // Keyed on the PRIOR numbering. Last wins, matching applyItemTimeEdits, so a
  // record that somehow holds two edits for one run carries the same one that
  // was being applied rather than a different one.
  const byRun = new Map<string, ServiceItemTimeEdit>();
  for (const e of edits) byRun.set(`${e.itemId} ${e.sequence}`, e);

  const priorRuns = new Map<string, ServiceTimelineItem[]>();
  for (const i of prior.items) {
    const list = priorRuns.get(i.itemId);
    if (list) list.push(i);
    else priorRuns.set(i.itemId, [i]);
  }

  const out: ServiceItemTimeEdit[] = [];
  const carried = new Set<ServiceItemTimeEdit>();
  const runIndex = new Map<string, number>();
  for (const item of items) {
    const n = runIndex.get(item.itemId) ?? 0;
    runIndex.set(item.itemId, n + 1);
    const before = priorRuns.get(item.itemId)?.[n];
    if (!before) continue; // a run the prior record did not have — nothing to carry
    const edit = byRun.get(`${item.itemId} ${before.sequence}`);
    if (!edit) continue;
    carried.add(edit);
    out.push({ ...edit, itemId: item.itemId, sequence: item.sequence });
  }
  return { edits: out, orphaned: edits.filter((e) => !carried.has(e)) };
}

/**
 * The one place an orphaned correction is reported.
 *
 * Logged where the orphaning HAPPENS — a rebuild, a merge, a window edit — and
 * not on the read path: reads run on every SSE push and every poll, so warning
 * there printed the same line hundreds of times a service while saying nothing
 * about which operation caused it.
 */
export function logOrphanedItemTimeEdits(
  serviceKey: string,
  cause: string,
  orphaned: readonly ServiceItemTimeEdit[],
): void {
  if (orphaned.length === 0) return;
  // Joined and scrubbed INSIDE the interpolation: log-injection.test.ts reads
  // the source, and a value pre-scrubbed into a local reads to it as raw.
  const runs = orphaned.map((e) => e.itemId + "#" + String(e.sequence));
  console.warn(
    `[history] ${scrub(serviceKey)}: ${scrub(cause)} left ${scrub(orphaned.length)} item time ` +
      `correction(s) with no run to apply to (${scrub(runs.join(", "))}) — dropped.`,
  );
}
