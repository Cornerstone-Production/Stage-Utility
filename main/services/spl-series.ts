// spl-series.ts — the raw SPL samples of one service, down-sampled for a chart.
//
// The per-item record (SplItemHistory) is one stat block per plan item, which is
// the right shape for the table and the wrong shape for a line: drawn as a step
// it says the level was constant for 25 minutes, which no sermon is. The raw
// layer has the real thing — `spl.csv` carries a row per second per metric (see
// docs/data-archive.md) — but a two-hour service is ~7,000 rows per metric, too
// many to send and far more than a 1,200px plot can draw.
//
// So the rows are bucketed. Each bucket keeps the loudest reading in it and the
// energy average across it, which is the pair that answers the two questions a
// sound chart is asked: how loud did it get, and how loud was it.

import { addLeqSample } from "./spl-leq.js";
import type { ArchiveRow } from "./archive/archive-rows.js";

/** One bucket. `t` is epoch ms at the bucket's START. */
export interface SplBucket {
  t: number;
  /** The loudest single reading in the bucket. */
  max: number;
  /**
   * The bucket's equivalent continuous level.
   *
   * ENERGY-averaged, not arithmetic, for the reason spl-leq.ts exists: decibels
   * are logarithmic and a plain mean understates a dynamic bucket by up to 15 dB.
   * Called `avg` because that is what it is to a reader of the chart; it is a
   * Leq, and combining two of these means weighting by count.
   */
  avg: number;
}

/**
 * The most buckets a series will ever return.
 *
 * A wide plot is ~1,800 CSS px and every bucket past one per pixel is data
 * nobody can see, paid for in JSON over the wire and in path length in the DOM.
 * A two-hour service at five seconds is ~1,440, so the cap only bites on a very
 * long recording or a very small requested bucket.
 */
export const MAX_BUCKETS = 2000;

/** Bucket sizes a caller may ask for, in seconds. */
export const MIN_BUCKET_SEC = 1;
export const MAX_BUCKET_SEC = 600;

/**
 * The bucket width actually used: the one asked for, widened until the window
 * fits inside the cap.
 *
 * Widened rather than truncated. Truncating would answer a two-hour service with
 * its first 100 minutes and say nothing about it — a chart that silently stops
 * before the sermon is worse than a coarser one.
 */
export function bucketSecFor(spanMs: number, requestedSec: number, maxBuckets = MAX_BUCKETS): number {
  const asked = clampBucketSec(requestedSec);
  if (!(spanMs > 0)) return asked;
  const needed = Math.ceil(spanMs / 1000 / maxBuckets);
  return Math.max(asked, needed);
}

/** A caller-supplied bucket size, held inside the range the route accepts. NaN
 *  and nonsense fall back to five seconds rather than to zero, which would be a
 *  division by zero one line later. */
export function clampBucketSec(sec: unknown): number {
  const n = typeof sec === "number" ? sec : Number(sec);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(MAX_BUCKET_SEC, Math.max(MIN_BUCKET_SEC, Math.floor(n)));
}

/**
 * Down-sample one metric's raw rows into buckets.
 *
 * Buckets are anchored to the FIRST row's timestamp, not to the wall clock, so
 * the first bucket always starts where the data does and a service beginning at
 * 19:47:13 does not open with a part-empty bucket.
 *
 * A bucket with no usable reading is ABSENT from the result rather than present
 * with a zero: the chart breaks its line across a hole, and a 0 dB sample would
 * draw a spike to the floor of the plot through a minute the meter was simply
 * unreachable.
 *
 * ACCUMULATED IN A MAP, not streamed. Rows reach here in FILE order, which is
 * time order only while nothing has been appended out of sequence — and things
 * have: `readArchiveRows` walks `spl.csv`, `spl.2.csv`, … in roll order, and a
 * merge moves one service's rolled files into another's directory (see
 * archive-rows.ts and merge-records.ts). A streaming accumulator closes its
 * bucket the moment the index changes, so rows for one bucket arriving in two
 * runs emitted that bucket TWICE, at the same `t` — two points on one x, which
 * draws a vertical spike through the plot and doubles the weight of whatever
 * was in it.
 */
export function bucketSeries(rows: readonly ArchiveRow[], metric: string, bucketSec: number): SplBucket[] {
  const width = clampBucketSec(bucketSec) * 1000;
  // The anchor is the EARLIEST usable row, not the first one seen, so an
  // interleaved file cannot move the bucket boundaries by a few seconds
  // depending on which run happened to be read first.
  let anchor = NaN;
  for (const row of rows) {
    if (!usable(row, metric)) continue;
    const at = Date.parse(row.at ?? "");
    if (!Number.isFinite(anchor) || at < anchor) anchor = at;
  }
  if (!Number.isFinite(anchor)) return [];

  const open = new Map<number, { max: number; leq: number | null; count: number }>();
  for (const row of rows) {
    if (!usable(row, metric)) continue;
    const v = Number(row[metric]);
    const index = Math.floor((Date.parse(row.at as string) - anchor) / width);
    let b = open.get(index);
    if (!b) open.set(index, (b = { max: v, leq: null, count: 0 }));
    b.max = Math.max(b.max, v);
    b.leq = addLeqSample(b.leq, b.count, v);
    b.count += 1;
  }

  const out: SplBucket[] = [];
  for (const [index, b] of open) {
    if (b.leq == null) continue;
    out.push({ t: anchor + index * width, max: round2(b.max), avg: round2(b.leq) });
  }
  // A Map iterates in insertion order, which is file order. Sorted, because an
  // unsorted series draws as a scribble rather than as a line.
  return out.sort((a, b) => a.t - b.t);
}

/** A row that carries a finite reading for `metric` at a parsable time. */
function usable(row: ArchiveRow, metric: string): boolean {
  const raw = row[metric];
  if (raw == null || raw === "") return false;
  if (!Number.isFinite(Number(raw))) return false;
  return Number.isFinite(Date.parse(row.at ?? ""));
}

/** Two decimal places. A meter reports two; carrying the float's full expansion
 *  put 14 significant figures of noise into every bucket of a 2,000-bucket
 *  response, for a line drawn at one point per pixel. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Every metric column present in a set of raw rows, sorted. The three fixed
 *  columns are not metrics — the same rule rebuildSplItems applies. */
export function metricsIn(rows: readonly ArchiveRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (k !== "at" && k !== "itemId" && k !== "item" && row[k] !== "") keys.add(k);
    }
  }
  return [...keys].sort();
}
