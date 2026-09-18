// rebuild.ts — recompute a service's derived record from its archived samples.
//
// This is what makes the derived layer a cache rather than the only copy. Two uses:
//
//   Recovery. The recorder persists on a debounce, so a crash loses the window
//   since the last write. The raw CSV has every sample that arrived, so the record
//   can be rebuilt instead of ending short.
//
//   Recomputation. When a formula changes — as the SPL average did, from an
//   arithmetic mean of decibels to an energy average — past services can be redone
//   rather than left wrong forever. That is the whole reason the raw layer exists.
//
// Only services recorded since the archive shipped have samples. Anything older
// returns null, which is the honest answer: there is nothing to rebuild from.

import type {
  ServiceSplHistory,
  ServiceTimeline,
  ServiceTimelineItem,
  SplItemHistory,
} from "../../types/stage.js";
import { addLeqSample } from "../spl-leq.js";
import { SERVICE_GAP_MS, isStepBackTo, lastItemEntry } from "../service-recorder.js";
import { scrub } from "../scrub.js";
import { serviceDirPath } from "./archive-paths.js";
import { readArchiveRows, type ArchiveRow } from "./archive-rows.js";

/** How many SPL sample rows a service has archived, or 0 if none. */
export async function archivedSampleCount(serviceKey: string, serviceDate: string): Promise<number> {
  const rows = await readArchiveRows(serviceDirPath(serviceKey, serviceDate), "spl");
  return rows?.length ?? 0;
}

/**
 * Recompute the per-item SPL aggregates for a service from its archived samples.
 *
 * Returns the rebuilt `items` array, or null when the service has no archive. The
 * caller decides what to do with it — this deliberately does not write, so it can
 * be used to compare against a stored record as well as to replace one.
 */
export async function rebuildSplItems(
  serviceKey: string,
  serviceDate: string,
): Promise<SplItemHistory[] | null> {
  const rows = await readArchiveRows(serviceDirPath(serviceKey, serviceDate), "spl");
  if (!rows || rows.length === 0) return null;

  /** The run of each item currently being accumulated, and when it last sampled.
   *  An item can run twice in one record (a reprise, or a second service whose
   *  occurrence split was missed), and one bucket per itemId folded the second
   *  run's levels into the first — the same defect the live recorders carry
   *  lastItemEntry/isStepBackTo for. A gap of more than SERVICE_GAP_MS between
   *  consecutive samples of one item is a new run. */
  const openRun = new Map<string, { item: SplItemHistory; lastAtMs: number }>();
  const items: SplItemHistory[] = [];
  let sequence = 0;

  for (const row of rows) {
    const itemId = row.itemId;
    if (!itemId) continue;
    const atMs = row.at ? Date.parse(row.at) : NaN;
    const open = openRun.get(itemId);
    // No parsable stamp on either side means no clock to judge by — keep the run.
    const sameRun =
      open != null &&
      (!Number.isFinite(atMs) || !Number.isFinite(open.lastAtMs) || atMs - open.lastAtMs < SERVICE_GAP_MS);
    let item = sameRun ? open!.item : undefined;
    if (!item) {
      item = {
        itemId,
        title: row.item ?? "",
        itemType: null,
        sequence: sequence++,
        metrics: {},
        maxSpl: null,
        sampleCount: 0,
        startedAt: row.at || new Date(0).toISOString(),
        endedAt: null,
      };
      items.push(item);
    }
    openRun.set(itemId, { item, lastAtMs: Number.isFinite(atMs) ? atMs : (open?.lastAtMs ?? NaN) });
    if (row.at) item.endedAt = row.at;
    if (row.item && !item.title) item.title = row.item;

    // Every column that is not one of the three fixed ones is a metric.
    for (const [key, raw] of Object.entries(row)) {
      if (key === "at" || key === "itemId" || key === "item") continue;
      if (raw === "") continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      let st = item.metrics[key];
      if (!st) {
        st = { max: null, avg: null, leq: null, count: 0 };
        item.metrics[key] = st;
      }
      st.max = st.max == null ? v : Math.max(st.max, v);
      st.leq = addLeqSample(st.leq ?? null, st.count, v);
      st.count += 1;
    }
  }
  return items;
}

/**
 * Rebuild a whole record's items, keeping its identity fields.
 *
 * The identity — which plan, which service time, what it was called — is not in the
 * samples and cannot be recovered from them, so an existing record is required.
 */
export async function rebuildSplRecord(record: ServiceSplHistory): Promise<ServiceSplHistory | null> {
  const items = await rebuildSplItems(record.serviceKey, record.serviceDate);
  if (!items) return null;

  // Carry the item type and the primary-metric fields, which the raw rows do not
  // hold: itemType comes from the plan, and maxSpl/leqSpl mirror the chosen metric.
  //
  // Paired by RUN, not by id: an item that ran twice has two rebuilt entries and
  // (at most) two prior ones, and pairing on the id alone would hand the second
  // run whatever the first run's plan row said.
  const priorRuns = new Map<string, SplItemHistory[]>();
  for (const i of record.items) {
    const list = priorRuns.get(i.itemId);
    if (list) list.push(i);
    else priorRuns.set(i.itemId, [i]);
  }
  const runIndex = new Map<string, number>();
  for (const it of items) {
    const n = runIndex.get(it.itemId) ?? 0;
    runIndex.set(it.itemId, n + 1);
    const prior = priorRuns.get(it.itemId)?.[n];
    if (prior) it.itemType = prior.itemType;
    const pk = record.metricKey;
    const m = pk ? it.metrics[pk] : undefined;
    if (m) {
      it.maxSpl = m.max;
      it.leqSpl = m.leq;
      it.sampleCount = m.count;
    }
  }
  // `sequence` is the run's place in the service, and rebuildSplItems already
  // produced the runs in the order their first sample arrived — so it is the
  // index, full stop.
  //
  // The prior record's numbers are deliberately NOT carried. Doing that needed a
  // uniquing pass behind it (a carried number colliding with a generated one
  // collapses two rows in a UI that keys on itemId + sequence), and the two
  // masked each other: reverting either alone left the whole suite green. It
  // also put a re-run at the BOTTOM of the table rather than where it happened,
  // because its fresh number was above every carried one. Numbering by time is
  // one rule, unique by construction, and orders the table the way the service
  // ran.
  items.forEach((it, i) => (it.sequence = i));
  return { ...record, items };
}

// ── Timeline ────────────────────────────────────────────────────────────────
//
// The SPL record has rebuilt from its raw rows since the archive shipped, and
// attendance re-derives from its samples. The timing record was the one that
// only ever moved forward: on 18 Sep 2026 a recorder bug merged two services
// into one summary while `events.csv` held every transition of the evening
// intact, and the repair had to be done by hand. Every summary must be
// derivable from the raw rows by the app.

/** One row of `events.csv`, as readArchiveRows hands it back. */
export type EventRow = ArchiveRow;

/**
 * An id for a title no row named and no stored entry matches.
 *
 * Stable across rebuilds by construction: the entry it creates carries this
 * title, so the next rebuild matches it by title and reuses the same id rather
 * than minting a second one.
 */
function titleSlug(title: string, run = 0): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  // The ordinal only appears past the first run, so the common case is
  // unchanged and a second rebuild re-derives the same ids.
  return run === 0 ? slug : `${slug}-${run + 1}`;
}

/** Chronological, leaving an unparseable stamp beside its neighbours (the sort
 *  is stable, so returning 0 does not herd damaged rows to one end). */
function byTime(rows: EventRow[]): EventRow[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.at ?? "");
    const tb = Date.parse(b.at ?? "");
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
}

function closeEntry(entry: ServiceTimelineItem, endedAt: string): void {
  entry.endedAt = endedAt;
  const startMs = Date.parse(entry.startedAt);
  const endMs = Date.parse(endedAt);
  entry.actualDurationSec =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
}

/**
 * Recompute a service's item timings from its `events.csv` rows.
 *
 * Pure: it neither reads the disk nor writes the store, so it can be used to
 * compare a stored record against the raw rows as well as to replace one.
 *
 * The rules are the LIVE recorder's, not a second opinion about what happened —
 * `isStepBackTo` and `lastItemEntry` are imported from service-recorder.ts for
 * exactly that reason. An item going live again within SERVICE_GAP_MS of its
 * last entry closing is the operator stepping back, and reopens that entry;
 * anything later is a genuine re-run and gets its own. The one difference is
 * the clock a step back is judged by: the live recorder uses PCO's
 * `live_start_at`, which no raw row carries, so the row's own `at` stands in.
 * They agree to within one poll interval, and the gap they are compared against
 * is ten minutes.
 *
 * Each entry ends when the next row fires. The last one ends at the record's own
 * `endedAt`, and stays open when the record is still open.
 *
 * What is NOT in the rows is carried from `prior`: the record's identity, its
 * window, `pacingResetAt`, and any per-item `counted` override the operator set
 * — which is a statement about the PLAN item, so it lands on every entry for
 * that id.
 */
export function rebuildTimelineRecord(prior: ServiceTimeline, rows: EventRow[]): ServiceTimeline {
  const items: ServiceTimelineItem[] = [];
  /** Titles already warned about, so a title that ran six times says so once. */
  const warned = new Set<string>();
  let open: ServiceTimelineItem | null = null;

  /** Stored entries per title, in sequence order — the table a title-only row
   *  is matched against. */
  const priorByTitle = new Map<string, ServiceTimelineItem[]>();
  for (const i of prior.items) {
    const list = priorByTitle.get(i.title);
    if (list) list.push(i);
    else priorByTitle.set(i.title, [i]);
  }
  /** Entries CREATED per title so far — "the Nth run of this title". */
  const runsByTitle = new Map<string, ServiceTimelineItem[]>();
  const warnOnce = (title: string, line: string) => {
    if (warned.has(title)) return;
    warned.add(title);
    console.warn(line);
  };

  for (const row of byTime(rows)) {
    if (row.kind !== "item") continue;
    const at = row.at ?? "";
    const atMs = Date.parse(at);
    let title = row.detail ?? "";

    // Close the entry that was on air BEFORE deciding what this row does, in the
    // order the live recorder does it (finalizePrevItem, then openItem): the step
    // back test reads endedAt, so an entry still open is "the same run" by
    // definition and a reopen must see the stamp this row just wrote.
    if (open) closeEntry(open, at);

    // Old rows predate the itemId column, so a title is the only handle left.
    //
    // Matched by RUN rather than by first hit: a plan with two items called
    // HOSTING gave every HOSTING row the first one's id, and the step-back rule
    // then folded the second item's run into the first's entry — one entry
    // spanning the items between them. The Nth run of a title is matched to the
    // Nth stored item carrying it, which is right whenever the counts agree and
    // degrades to a numbered id when they do not.
    //
    // An EMPTY title carries no identity at all, so it is never matched to
    // another empty row: two such rows collapsed into one `untitled` entry that
    // swallowed everything between them. It is recovered by POSITION against
    // the stored record — the Nth entry is the Nth stored item — and numbered
    // only when there is no stored item to recover from.
    let itemId = row.itemId ?? "";
    let forceNew = false;
    if (!itemId) {
      const runs = runsByTitle.get(title) ?? [];
      const openRun = runs[runs.length - 1];
      const sameTitle = priorByTitle.get(title) ?? [];
      if (!title) {
        const byPosition = prior.items[items.length];
        if (byPosition) {
          title = byPosition.title;
          itemId = byPosition.itemId;
          warnOnce("", `[service-timeline] rebuild: a row has no title, matched by position`);
        } else {
          itemId = titleSlug("", items.length);
          forceNew = true; // nothing to prove two blank rows are the same item
          warnOnce("", `[service-timeline] rebuild: a row has no title and no stored item to match it to`);
        }
      } else if (openRun && isStepBackTo(openRun, atMs)) {
        itemId = openRun.itemId; // same run — whatever that run was given
      } else if (sameTitle.length > 1) {
        itemId = sameTitle[runs.length]?.itemId ?? titleSlug(title, runs.length);
        warnOnce(
          title,
          `[service-timeline] rebuild: "${scrub(title)}" is not unique in this record, matched by position`,
        );
      } else {
        itemId = sameTitle[0]?.itemId ?? titleSlug(title);
        warnOnce(title, `[service-timeline] rebuild: no item id for "${scrub(title)}", matched by title`);
      }
    }

    const priorEntry = lastItemEntry(prior.items, itemId);
    const plannedCol = row.plannedLengthSec ? Number(row.plannedLengthSec) : NaN;
    const planned = Number.isFinite(plannedCol) ? plannedCol : (priorEntry?.plannedLengthSec ?? null);
    const preService =
      row.preService === "true" ? true
      : row.preService === "false" ? false
      : (priorEntry?.preService ?? false);

    const last = forceNew ? undefined : lastItemEntry(items, itemId);
    if (last && isStepBackTo(last, atMs)) {
      if (title) last.title = title;
      if (planned != null) last.plannedLengthSec = planned;
      last.endedAt = null;
      last.actualDurationSec = null;
      open = last;
      continue;
    }
    const entry: ServiceTimelineItem = {
      itemId,
      title,
      sequence: items.length,
      plannedLengthSec: planned,
      startedAt: at,
      endedAt: null,
      actualDurationSec: null,
      preService,
    };
    items.push(entry);
    // Tracked under the title the ROW carried, which is what the next
    // title-only row will look itself up by.
    const runs = runsByTitle.get(row.detail ?? "");
    if (runs) runs.push(entry);
    else runsByTitle.set(row.detail ?? "", [entry]);
    open = entry;
  }

  // A closed record ends its last item; an open one leaves it running, which is
  // what the live recorder's own finalizeRecord would have done.
  if (open && prior.endedAt) closeEntry(open, prior.endedAt);

  // `counted` is the operator's override of the auto pre-service default, set
  // per plan item and applied to every run of it — see setItemCounted. It exists
  // nowhere in the raw rows, so losing it here would silently undo their edit.
  const overrides = new Map<string, boolean>();
  for (const i of prior.items) if (i.counted != null) overrides.set(i.itemId, i.counted);
  for (const it of items) {
    const c = overrides.get(it.itemId);
    if (c != null) it.counted = c;
  }

  items.forEach((it, i) => (it.sequence = i));
  return { ...prior, items };
}
