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

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ServiceSplHistory, SplItemHistory } from "../../types/stage.js";
import { addLeqSample } from "../spl-leq.js";
import { serviceDirPath } from "./archive-paths.js";
import { parseRows } from "./csv.js";

/** Rows of one CSV as objects keyed by their header, across rolled files. */
async function readRecords(dir: string, base: string): Promise<Record<string, string>[] | null> {
  const out: Record<string, string>[] = [];
  let found = false;
  for (let i = 1; i <= 100; i++) {
    const name = i === 1 ? `${base}.csv` : `${base}.${i}.csv`;
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      if (i === 1) continue;
      break;
    }
    found = true;
    const rows = parseRows(text);
    if (rows.length < 2) continue;
    const header = rows[0];
    for (const r of rows.slice(1)) {
      const rec: Record<string, string> = {};
      header.forEach((h, idx) => (rec[h] = r[idx] ?? ""));
      out.push(rec);
    }
  }
  return found ? out : null;
}

/** How many SPL sample rows a service has archived, or 0 if none. */
export async function archivedSampleCount(serviceKey: string, serviceDate: string): Promise<number> {
  const rows = await readRecords(serviceDirPath(serviceKey, serviceDate), "spl");
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
  const rows = await readRecords(serviceDirPath(serviceKey, serviceDate), "spl");
  if (!rows || rows.length === 0) return null;

  const byItem = new Map<string, SplItemHistory>();
  let sequence = 0;

  for (const row of rows) {
    const itemId = row.itemId;
    if (!itemId) continue;
    let item = byItem.get(itemId);
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
      byItem.set(itemId, item);
    }
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
  return [...byItem.values()];
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
  const priorById = new Map(record.items.map((i) => [i.itemId, i]));
  for (const it of items) {
    const prior = priorById.get(it.itemId);
    if (prior) {
      it.itemType = prior.itemType;
      it.sequence = prior.sequence;
    }
    const pk = record.metricKey;
    const m = pk ? it.metrics[pk] : undefined;
    if (m) {
      it.maxSpl = m.max;
      it.leqSpl = m.leq;
      it.sampleCount = m.count;
    }
  }
  items.sort((a, b) => a.sequence - b.sequence);
  return { ...record, items };
}
