// sound-plot.ts — which Smaart metric the Sound card plots for one record.
//
// ONE rule, read by every surface that quotes a sound level for a service: the
// chart's raw-series read, its peak line and triangles, the figure strip, the
// service header's peak figure and the All services row. Two copies of it would
// be two rules the day one was tightened, and the symptom would be a chart
// plotting LCeq under a heading that says LAeq.
//
// The choice is per BROWSER (this file's localStorage key). The default it
// overrides is the organisation's Trends metric, kept on the server. The table's
// columns (`spl:visibleMetrics`) are a separate preference and play no part here.

import { removeStored, readStored, storeFailure } from "../../lib/safe-storage";
import { effectiveSoundMetric } from "./history-trends/sound-metric";
import { notifyStoredKeys, useStoredKeysVersion } from "./history-chart/prefs";

export const PLOT_STORAGE_KEY = "spl:plotMetric";

export interface Plotted {
  /** The metric to draw. Always one the record carries. */
  metric: string;
  /** What was wanted but this record does not carry, or null when the want was
   *  met. The card says so in one line rather than quietly plotting another. */
  wanted: string | null;
  /** The metric Trends plots, resolved against this record. What the Plot
   *  group tags, and what picking it clears the override for. */
  trends: string | null;
}

/**
 * The metric to plot: this browser's own choice if the record carries it, else
 * the Trends metric if it does, else the first recorded metric. Null only when
 * the record carries no metric at all.
 *
 * `trendsSaved` is the Trends metric as the page resolved it across EVERY
 * recording it loaded (null before they load). Resolved per record instead, a
 * service carrying only LAeq 1 would plot it under the Trends tag while the
 * Trends card plots LAeq 2 from the others; here it says LAeq 2 is missing.
 * Whatever it is, a metric this record lacks is replaced, and the card says so.
 */
export function plottedMetric(
  available: readonly string[],
  chosen: string | null,
  trendsSaved: string | null,
): Plotted | null {
  if (!available.length) return null;
  const trends = effectiveSoundMetric(trendsSaved, available);
  const want = chosen ?? trends;
  if (want && available.includes(want)) return { metric: want, wanted: null, trends };
  const metric = trends && available.includes(trends) ? trends : available[0]!;
  return { metric, wanted: want, trends };
}

/** This browser's own plot choice, or null when it has none. */
export function readPlotChoice(): string | null {
  return readStored<string | null>(
    PLOT_STORAGE_KEY,
    (raw) => {
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      return typeof v === "string" && v ? v : null;
    },
    null,
  );
}

/** Remember a plot choice, or forget it with null. Returns the failure, like
 *  the other per-browser preferences: a browser in private mode cannot keep it. */
export function writePlotChoice(metric: string | null): Error | null {
  let failure: Error | null = null;
  if (metric === null) {
    if (!removeStored(PLOT_STORAGE_KEY)) failure = new Error("browser storage is unavailable");
  } else {
    failure = storeFailure(PLOT_STORAGE_KEY, JSON.stringify(metric));
  }
  if (!failure) notifyStoredKeys(PLOT_STORAGE_KEY);
  return failure;
}

/** The plot rule against this browser's choice, for a caller that is not a
 *  component. A component subscribes with `usePlotChoiceVersion` so it recomputes
 *  when the choice is written from elsewhere in the tab. */
export function plottedFor(available: readonly string[], trendsSaved: string | null): Plotted | null {
  return plottedMetric(available, readPlotChoice(), trendsSaved);
}

/** A counter that moves whenever the plot choice is written, to put in a
 *  dependency list beside a call to `plottedFor`. */
export function usePlotChoiceVersion(): number {
  return useStoredKeysVersion(PLOT_STORAGE_KEY);
}

/** The peak line's name: "<metric> peak", except for a metric that already says
 *  it ("FS Peak"), which would otherwise read "FS Peak peak". */
export function peakSeriesLabel(metric: string): string {
  return /peak$/i.test(metric) ? metric : `${metric} peak`;
}

/** The peak figure's name: "Peak <metric>", except for a metric that already
 *  says it ("FS Peak"), which would otherwise read "Peak FS Peak". */
export function peakFigureLabel(metric: string): string {
  return /peak$/i.test(metric) ? metric : `Peak ${metric}`;
}
