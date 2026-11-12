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

import { useMemo, useSyncExternalStore } from "react";

import { effectiveSoundMetric } from "./history-trends/sound-metric";
import { notifyStoredKeys, readStoredKeys, subscribeStoredKeys, writeStoredKeys } from "./history-chart/prefs";

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

/** The two inputs to the plot rule that live outside a record. Passed AROUND as
 *  one value, never read from storage inside a derivation: a memo that reads
 *  localStorage behind its own back has no dependency for the React Compiler (or
 *  anyone) to see, and keeps its answer after the choice changes. */
export interface PlotPrefs {
  /** The Trends metric as the page resolved it across EVERY recording it loaded,
   *  or null while those are unread (or none carries a metric). */
  trends: string | null;
  /** This browser's own choice, or null when it has none. */
  chosen: string | null;
}

/**
 * The metric to plot: this browser's own choice if the record carries it, else
 * the Trends metric if it does, else the first recorded metric. Null only when
 * the record carries no metric at all.
 *
 * `prefs.trends` is resolved across every recording, not per record: resolved per
 * record, a service carrying only LAeq 1 would plot it under the Trends tag while
 * the Trends card plots LAeq 2 from the others; here it says LAeq 2 is missing.
 * It is resolved again here only for the case the page has none to give (its
 * summaries unread or failed), where the record's own LAeq 2 / LAeq 1 default
 * applies; a value from the page comes back unchanged. Whatever it is, a metric
 * this record lacks is replaced, and the card says so.
 */
export function plottedMetric(available: readonly string[], prefs: PlotPrefs): Plotted | null {
  if (!available.length) return null;
  const trends = effectiveSoundMetric(prefs.trends, available);
  const want = prefs.chosen ?? trends;
  if (want && available.includes(want)) return { metric: want, wanted: null, trends };
  const metric = trends && available.includes(trends) ? trends : available[0]!;
  return { metric, wanted: want, trends };
}

/**
 * A choice the browser refused to store, held for the rest of this page's life
 * so the plot still changes (the caller says it could not be remembered).
 * Wrapped, so a held "forget it" (null) is told apart from nothing held while
 * storage still has an older choice. Cleared by the next write that lands and by
 * a change from another tab, either of which is newer than it.
 */
let unsaved: { metric: string | null } | null = null;

/** This browser's plot choice, or null when it has none. Stored as a one-key
 *  list, the shape every other per-browser Customize preference uses. */
export function readPlotChoice(): string | null {
  if (unsaved) return unsaved.metric;
  return readStoredKeys(PLOT_STORAGE_KEY, null, [])[0] || null;
}

/** Remember a plot choice, or forget it with null. Returns the failure, like
 *  the other per-browser preferences: a browser in private mode cannot keep it,
 *  and the choice then holds only until the page is closed. */
export function writePlotChoice(metric: string | null): Error | null {
  // Before the write: it announces a write that lands, and every reader it
  // wakes must read the new value rather than an older one held here.
  unsaved = null;
  const failure = writeStoredKeys(PLOT_STORAGE_KEY, metric ? [metric] : []);
  if (failure) {
    unsaved = { metric };
    notifyStoredKeys(PLOT_STORAGE_KEY);
  }
  return failure;
}

/** Writes from this tab (announced by `writePlotChoice`) and from other tabs
 *  (the browser's `storage` event, which never fires in the tab that wrote). */
function subscribePlotChoice(onChange: () => void): () => void {
  const off = subscribeStoredKeys(PLOT_STORAGE_KEY, onChange);
  const onStorage = (e: StorageEvent) => {
    // null: the other tab cleared all of storage.
    if (e.key !== PLOT_STORAGE_KEY && e.key !== null) return;
    unsaved = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    off();
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The plot preferences for a page: the Trends metric it resolved, and this
 * browser's choice, live. A write from anywhere re-renders the caller.
 *
 * An external-store subscription, so the choice itself is the value the memo
 * depends on. A counter beside an unseen storage read kept its first answer in
 * the built app, where the React Compiler drops the unused read and its
 * dependency. Called ONCE, by the page, and passed down: the card, its title,
 * the header and the rows then cannot hold two different choices.
 */
export function usePlotPrefs(trends: string | null): PlotPrefs {
  const chosen = useSyncExternalStore(subscribePlotChoice, readPlotChoice, () => null);
  return useMemo(() => ({ trends, chosen }), [trends, chosen]);
}

/** A peak's name: "<metric> peak" (`suffix`, the chart's line) or "Peak <metric>"
 *  (`prefix`, the header and row figure), except for a metric that already says
 *  it ("FS Peak"), which would otherwise read "FS Peak peak" or "Peak FS Peak". */
export function peakLabel(metric: string, where: "suffix" | "prefix"): string {
  if (/peak$/i.test(metric)) return metric;
  return where === "suffix" ? `${metric} peak` : `Peak ${metric}`;
}
