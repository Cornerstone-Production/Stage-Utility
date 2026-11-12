// sound-metric.ts — which Smaart metric the Trends card's Sound measure plots.
//
// Pure, so the rule is testable without a card, a page or a server.
//
// ONE METRIC FOR THE WHOLE CARD, resolved once against every key the page's SPL
// summaries carry. Resolved per recording it would mix metrics on one chart: a
// recording that lacks LAeq 2 would fall through to whatever it does carry, and
// the line would plot LCeq under a heading that says LAeq.

import { METRIC_KEY } from "@main/types/trends-prefs";

/** The default when nobody has chosen, in order. The first one any recording
 *  carries wins; neither present falls through to the first metric offered. */
export const DEFAULT_SOUND_METRICS = ["LAeq 2", "LAeq 1"] as const;

/**
 * Every metric key the given summaries carry that the server would accept as a
 * choice, once each, in one stable order.
 *
 * Held to METRIC_KEY, the rule POST /api/history/trends-prefs applies: a key the
 * meter sent that the server would refuse is not offered, rather than listed and
 * then answered with a 400.
 *
 * Numeric collation under a FIXED locale, so "LAeq 2" sorts before "LAeq 10" and
 * two browsers with different system locales list the same order. A plain
 * `.sort()` puts "LAeq 10" first, which is not an order anybody reads.
 */
export function soundMetricOptions(keyLists: Iterable<readonly string[]>): string[] {
  const all = new Set<string>();
  for (const keys of keyLists) for (const k of keys) if (METRIC_KEY.test(k)) all.add(k);
  // The plain comparison breaks ties numeric collation leaves: "LAeq 2" and
  // "LAeq 02" collate EQUAL, and the sort would then keep arrival order.
  return [...all].sort((a, b) => a.localeCompare(b, "en", { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The metric the card plots: the saved choice, else the first of LAeq 2 and
 * LAeq 1 that `available` carries, else `fallback(available)` — by default the
 * first metric `available` lists.
 *
 * A saved choice that nothing carries is KEPT, not substituted: the chart then
 * says there is no reading for it, which is true, where a quiet switch to a
 * neighbour would draw a different measurement under the name the operator picked.
 * Null only when there is nothing to plot.
 */
export function effectiveSoundMetric(
  saved: string | null,
  available: readonly string[],
  fallback: (available: readonly string[]) => string | null = (a) => a[0] ?? null,
): string | null {
  if (saved) return saved;
  for (const m of DEFAULT_SOUND_METRICS) if (available.includes(m)) return m;
  return fallback(available);
}

/** One recording's peak on `metric`, or null when it carries none. Own property
 *  only: the keys are meter-supplied, and `metrics["constructor"]` is not a reading. */
export function peakOn(
  metrics: Readonly<Record<string, { max?: number | null } | undefined>>,
  metric: string | null,
): number | null {
  if (!metric || !Object.hasOwn(metrics, metric)) return null;
  return metrics[metric]?.max ?? null;
}
