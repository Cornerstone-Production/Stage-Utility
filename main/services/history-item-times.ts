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

/** A run's identity as a map key. JSON rather than a joined string: an itemId is
 *  a Planning Center value, and any separator picked by hand is a separator two
 *  different runs could collide on. (An earlier version used a literal NUL,
 *  which worked and made grep treat this file as binary.) */
function runKey(run: { itemId: string; sequence: number }): string {
  return JSON.stringify([run.itemId, run.sequence]);
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

  // At most ONE correction per run is applied, and it is the LAST.
  //
  // setItemTimes replaces rather than appends, so a well-formed record holds one
  // — but a merge, an import or a hand-edited file can produce two, and applying
  // them in sequence read the already-corrected item as "what was recorded" for
  // the second. `editedFrom` then held the FIRST correction's values, so Reset
  // put back a time that had never happened and the tooltip named it as the
  // recording. Last wins, computed once, against the raw item.
  const byRun = new Map<string, ServiceItemTimeEdit>();
  for (const e of edits) byRun.set(runKey(e), e);

  const orphaned: ServiceItemTimeEdit[] = [];
  for (const edit of edits) {
    const i = items.findIndex((x) => x.itemId === edit.itemId && x.sequence === edit.sequence);
    if (i < 0) {
      orphaned.push(edit);
      continue;
    }
    if (byRun.get(runKey(edit)) !== edit) continue; // superseded
    const raw = items[i];
    const startedAt = edit.startedAt ?? raw.startedAt;
    // An item with no recorded end is ON AIR — the recorder either has not closed
    // it yet or stepped back and REOPENED it, which sets endedAt to null. An end
    // override left over from before the reopen would close it again behind the
    // recorder's back: the row would show a finished duration for an item still
    // running, and the pacing readout would treat the live item as done. The
    // override is kept, not deleted, so closing the item restores it.
    const endedAt = raw.endedAt == null ? null : (edit.endedAt ?? raw.endedAt);
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
  for (const e of edits) byRun.set(runKey(e), e);

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
    const edit = byRun.get(runKey({ itemId: item.itemId, sequence: before.sequence }));
    if (!edit) continue;
    carried.add(edit);
    out.push({ ...edit, itemId: item.itemId, sequence: item.sequence });
  }
  return { edits: out, orphaned: edits.filter((e) => !carried.has(e)) };
}

/**
 * Bring a record's corrections back inside its own window.
 *
 * `editServiceWindow` trims the items to the new window — dropping those that
 * start after the end, and pulling back an end that overruns it — but the
 * corrections sat outside that entirely. Trimming an 85-minute recording to 15
 * minutes left a correction saying an item ended at 21:32, so the row read
 * 85 minutes inside a 15-minute service, and the Actual tile with it. The route
 * refuses exactly this when the operator types it (`setItemTimes` validates
 * against the record's own window); a window edit could produce it by the back
 * door.
 *
 * Clamped the way the ITEMS are clamped, not dropped wholesale: an operator who
 * trims a trailing minute meant to trim the item too, and throwing their whole
 * correction away over one second would be its own kind of data loss. A
 * correction whose run is gone, or which cannot survive the clamp as a coherent
 * span, is dropped and returned so the caller can say so.
 *
 * Reads the record's window AFTER the caller has applied the new start/end.
 */
export function clampItemTimeEdits(record: ServiceTimeline): CarriedItemTimeEdits {
  const edits = record.itemTimeEdits ?? [];
  if (edits.length === 0) return { edits: [], orphaned: [] };

  const lo = Date.parse(record.startedAt);
  const hi = record.endedAt ? Date.parse(record.endedAt) : Number.POSITIVE_INFINITY;
  const clamp = (iso: string | undefined): string | undefined => {
    if (iso == null) return undefined;
    const t = Date.parse(iso);
    // An unparseable stamp is not evidence about where it belongs, and moving it
    // to a window edge would invent a time. Left for the drop test below.
    if (!Number.isFinite(t)) return iso;
    if (Number.isFinite(lo) && t < lo) return new Date(lo).toISOString();
    if (Number.isFinite(hi) && t > hi) return new Date(hi).toISOString();
    return iso;
  };

  const kept: ServiceItemTimeEdit[] = [];
  const orphaned: ServiceItemTimeEdit[] = [];
  for (const edit of edits) {
    const item = record.items.find((x) => x.itemId === edit.itemId && x.sequence === edit.sequence);
    if (!item) {
      orphaned.push(edit); // its run was trimmed away with the window
      continue;
    }
    const next: ServiceItemTimeEdit = { ...edit };
    if (next.startedAt != null) next.startedAt = clamp(next.startedAt);
    if (next.endedAt != null) next.endedAt = clamp(next.endedAt);
    const effStart = Date.parse(next.startedAt ?? item.startedAt);
    const effEnd = next.endedAt != null ? Date.parse(next.endedAt) : null;
    if (effEnd != null && !(Number.isFinite(effStart) && Number.isFinite(effEnd) && effEnd > effStart)) {
      orphaned.push(edit); // the clamp collapsed it; a zero or negative span is not a correction
      continue;
    }
    kept.push(next);
  }
  return { edits: kept, orphaned };
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
