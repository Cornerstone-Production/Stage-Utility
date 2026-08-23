// signage-prefetch.ts — which assets to have in hand before they are needed.
//
// PURE: horizon in, list of URLs out. The fetching itself is the caller's job,
// which keeps the policy testable without a network.
//
// The policy balances two failures. Fetching nothing means a visible pause at
// each boundary while the next graphic loads. Fetching the whole 24-hour horizon
// is gigabytes once a video is involved, onto a Pi's SD card. So: the current
// window in full, plus the first item of the next — enough to cover the boundary
// itself — under a byte cap.

import type { SignageHorizon } from "@main/types/signage";

import { entryAt } from "./signage-cycle";

export interface PrefetchPlan {
  urls: string[];
  /** What the cap dropped. Reported rather than silently omitted: a display that
   *  fetched less than it needed still looks ready. */
  skipped: { url: string; bytes: number }[];
}

/**
 * Default ceiling on what one display holds ahead.
 *
 * Generous enough for a window of graphics and a clip, small enough not to fill
 * an SD card. Reaching it is worth a log line, not a failure.
 */
export const DEFAULT_PREFETCH_CAP_BYTES = 1024 * 1024 * 1024;

export function planPrefetch(
  horizon: SignageHorizon,
  nowMs: number,
  capBytes: number = DEFAULT_PREFETCH_CAP_BYTES,
): PrefetchPlan {
  const current = entryAt(horizon, nowMs);
  // Outside the horizon there is nothing to be confident about, and guessing
  // would spend the cap on content that may never play.
  if (!current) return { urls: [], skipped: [] };

  const index = horizon.indexOf(current);
  const next = index >= 0 ? horizon[index + 1] : undefined;

  const wanted = [
    ...(current.playlist?.items ?? []),
    // Only the FIRST item of the next window. It is what covers the boundary;
    // the rest of that window gets fetched once it becomes the current one.
    ...(next?.playlist?.items.slice(0, 1) ?? []),
  ];

  const urls: string[] = [];
  const skipped: { url: string; bytes: number }[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const item of wanted) {
    // A graphic ending one playlist and starting the next is common; counting it
    // twice would spend the cap on bytes already held.
    if (seen.has(item.url)) continue;
    seen.add(item.url);

    if (total + item.bytes > capBytes) {
      skipped.push({ url: item.url, bytes: item.bytes });
      continue;
    }
    total += item.bytes;
    urls.push(item.url);
  }

  return { urls, skipped };
}
