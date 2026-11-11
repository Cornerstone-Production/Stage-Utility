// The History Trends card's organisation-wide settings, shared by the server's
// store and the card.

/** What `trends:prefs` carries and GET /api/history/trends-prefs answers. */
export interface TrendsPrefsState {
  /** Bumped on every change; a new process starts at 0. */
  rev: number;
  /** The Smaart metric the Sound measure plots, or null when nobody has chosen
   *  and the card falls back to its default (LAeq 2, else LAeq 1, else the
   *  browser's own primary metric). */
  soundMetric: string | null;
}

/** The SSE channel that carries a {@link TrendsPrefsState}. */
export const TRENDS_PREFS_CHANNEL = "trends:prefs";

/**
 * The shape of a Smaart metric key: what the meter names its readings
 * ("LAeq 2", "SPL A Slow", "LCeq 10"). A shape, not a list, because which
 * metrics exist depends on what the meter was configured to send; this only
 * keeps text that is not a metric name out of the file.
 */
export const METRIC_KEY = /^[A-Za-z0-9][A-Za-z0-9 ._+()/-]{0,47}$/;
