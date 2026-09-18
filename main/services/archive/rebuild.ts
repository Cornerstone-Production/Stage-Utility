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

import type { ServiceSplHistory, SplItemHistory } from "../../types/stage.js";
import { addLeqSample } from "../spl-leq.js";
import { SERVICE_GAP_MS } from "../service-recorder.js";
import { serviceDirPath } from "./archive-paths.js";
import { readArchiveRows } from "./archive-rows.js";

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
