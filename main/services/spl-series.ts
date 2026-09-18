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
 */
export function bucketSeries(rows: readonly ArchiveRow[], metric: string, bucketSec: number): SplBucket[] {
  const width = clampBucketSec(bucketSec) * 1000;
  let anchor = NaN;
  const out: SplBucket[] = [];
  let open: { index: number; max: number; leq: number | null; count: number } | null = null;

  const flush = () => {
    if (open && open.leq != null) out.push({ t: anchor + open.index * width, max: open.max, avg: open.leq });
    open = null;
  };

  for (const row of rows) {
    const raw = row[metric];
    if (raw == null || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const at = Date.parse(row.at ?? "");
    if (!Number.isFinite(at)) continue;
    if (!Number.isFinite(anchor)) anchor = at;
    const index = Math.floor((at - anchor) / width);
    if (!open || open.index !== index) {
      flush();
      open = { index, max: v, leq: null, count: 0 };
    }
    open.max = Math.max(open.max, v);
    open.leq = addLeqSample(open.leq, open.count, v);
    open.count += 1;
  }
  flush();
  // Rows are appended in time order, but a rolled file can land out of order
  // after a merge (see archive-rows.ts), and an unsorted series draws as a
  // scribble rather than as a line.
  return out.sort((a, b) => a.t - b.t);
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
