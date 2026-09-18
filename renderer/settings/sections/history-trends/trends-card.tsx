// trends-card.tsx — the card that leads All services.
//
// One tile per service type (a sparkline of the last eight peaks, the average,
// the change against the eight before), then one full-width chart across the
// chosen range with every type on it and milestones under the axis.
//
// EVERYTHING HERE IS COMPUTED FROM RECORDS THE PAGE ALREADY HOLDS. The list
// loads `serviceTimeline:list` and `attendance:listHistory` to draw the calendar
// and the day rows; a trend is those same records grouped differently. The one
// thing fetched is the operator's milestone list, which is not a recording and
// which nothing else on the page reads.
//
// WHAT IS NOT UNIT-TESTED HERE, AND WHY. jsdom lays nothing out and loads no
// stylesheet: the tile grid's wrap, the chart's measured width (every
// offsetWidth is 0, so the chart draws at its 640px default), whether a
// milestone label collides with its neighbour, and the accent on a hovered mark
// are all invisible to it. Those were driven in Chrome at 1280 and 600, light
// and dark, against a real three-month archive. The arithmetic is tested in
// trends.test.ts and the mark geometry in the chart module's own tests.

import { useEffect, useMemo, useState } from "react";

import { cn } from "../../../lib/cn";
import { invoke } from "../../../lib/api";
import { HistoryChart, type ChartMilestone } from "../history-chart";
import type { ChartSeries } from "../history-chart/geometry";
import { Sparkline } from "./sparkline";
import {
  DEFAULT_RANGE_WEEKS,
  RANGE_WEEKS,
  TREND_WINDOW,
  trendMilestones,
  typeTrends,
  withinRange,
  type RangeWeeks,
  type StoredMilestone,
  type TrendRecording,
} from "./trends";

/** The range choice, per browser — a view preference, like every other one in
 *  this module. A stored value that is not one of the offered ranges is
 *  ignored rather than trusted: the control could not represent it. */
const RANGE_KEY = "history:trendRangeWeeks";

function storedRange(): RangeWeeks {
  try {
    const raw = Number(localStorage.getItem(RANGE_KEY));
    return (RANGE_WEEKS as readonly number[]).includes(raw) ? (raw as RangeWeeks) : DEFAULT_RANGE_WEEKS;
  } catch {
    return DEFAULT_RANGE_WEEKS;
  }
}

/** Distinct, in order, for the series lines. Theme tokens only — the accent
 *  first because the busiest type leads, then the neutrals the rest of the app
 *  uses for secondary data. */
const SERIES_COLORS = [
  "var(--color-green-9)",
  "var(--color-accent)",
  "var(--color-fg-muted)",
  "var(--color-warn-11)",
];

/** "+12%" / "−12%", the spelling every percentage trend in this app uses. */
function pct(change: number): string {
  return `${change >= 0 ? "+" : "−"}${Math.round(Math.abs(change) * 100)}%`;
}

export function TrendsCard({ recordings }: { recordings: TrendRecording[] }) {
  const [weeks, setWeeks] = useState<RangeWeeks>(storedRange);
  const [stored, setStored] = useState<StoredMilestone[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<StoredMilestone[]>("history:listMilestones")
      .then((list) => !cancelled && setStored(list ?? []))
      .catch(() => {
        // The chart draws without the operator's marks; the derived
        // series-change marks are unaffected, and Settings → Advanced is where
        // the list is managed and where a failure to read it would show.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function pickRange(next: RangeWeeks) {
    setWeeks(next);
    try {
      localStorage.setItem(RANGE_KEY, String(next));
    } catch {
      // Private mode or a full quota: the range holds for this visit and
      // reverts to the default on the next one. Nothing is lost.
    }
  }

  const tiles = useMemo(() => typeTrends(recordings), [recordings]);
  const ranged = useMemo(() => withinRange(recordings, weeks), [recordings, weeks]);

  const series = useMemo<ChartSeries[]>(() => {
    const byType = new Map<string, TrendRecording[]>();
    for (const r of ranged) {
      const key = r.serviceTypeId ?? "";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(r);
    }
    // The tiles are already sorted busiest-first; the lines follow the same
    // order so a colour means the same thing in both halves of the card.
    const order = tiles.map((t) => t.serviceTypeId ?? "").filter((k) => byType.has(k));
    for (const k of byType.keys()) if (!order.includes(k)) order.push(k);
    return order.map((key, i) => ({
      id: key || "all",
      label: tiles.find((t) => (t.serviceTypeId ?? "") === key)?.name ?? "Services",
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      role: i === 0 ? "primary" : "secondary",
      // A trend has no sampling interval to have a gap in: two recordings are a
      // fortnight apart because a service was a fortnight apart, not because
      // anything went unmeasured. Without this every point would be its own run.
      gapMs: Infinity,
      points: (byType.get(key) ?? []).map((r) => ({ t: r.t, v: r.peakOccupancy as number })),
    }));
  }, [ranged, tiles]);

  const milestones = useMemo<ChartMilestone[]>(() => {
    if (!ranged.length) return [];
    const startMs = Math.min(...ranged.map((r) => r.t));
    const endMs = Math.max(...ranged.map((r) => r.t));
    return trendMilestones(stored, ranged, { startMs, endMs });
  }, [stored, ranged]);

  const figures = useMemo(() => {
    const peaks = ranged.map((r) => r.peakOccupancy as number);
    const avg = peaks.length ? Math.round(peaks.reduce((a, b) => a + b, 0) / peaks.length) : null;
    return [
      { key: "services", label: "Services", value: ranged.length.toLocaleString() },
      { key: "average", label: "Average peak", value: avg == null ? "—" : avg.toLocaleString() },
      {
        key: "busiest",
        label: "Busiest",
        value: peaks.length ? Math.max(...peaks).toLocaleString() : "—",
      },
    ];
  }, [ranged]);

  return (
    <section data-testid="history-trends" className="su-card flex flex-col gap-4 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">Trends</span>
        {/* The range control. A segmented set of three rather than a Select:
            three options that are always the same three read faster as buttons
            than behind a menu that has to be opened to see them. */}
        <div role="group" aria-label="Trend range" className="flex items-center gap-1 rounded-lg border border-line p-0.5">
          {RANGE_WEEKS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={weeks === w}
              onClick={() => pickRange(w)}
              className={cn(
                "touch-target rounded-md px-2 py-0.5 font-mono text-caption2 tabular-nums transition-colors",
                weeks === w ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill hover:text-fg",
              )}
            >
              {w}w
            </button>
          ))}
        </div>
      </div>

      {tiles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-caption1 text-fg-muted">
          No attendance recorded yet — a trend needs at least one service with a people counter running.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map((t) => (
              <div
                key={t.serviceTypeId ?? "all"}
                data-trend-tile={t.serviceTypeId ?? "all"}
                className="flex flex-col gap-1.5 rounded-lg border border-line bg-fill/40 px-3 py-2.5"
              >
                <span className="truncate text-caption2 uppercase tracking-wider text-fg-subtle">{t.name}</span>
                <Sparkline
                  values={t.recent.map((r) => r.peakOccupancy as number)}
                  label={`${t.name}: peak attendance over the last ${t.recent.length} recordings`}
                />
                <div className="flex items-baseline gap-2">
                  <span data-trend-average className="font-mono text-[20px] font-medium leading-[24px] tabular-nums text-fg">
                    {t.average == null ? "—" : t.average.toLocaleString()}
                  </span>
                  {/* No change until there is something to compare against. A
                      tile with one window of recordings says so rather than
                      printing a figure derived from nothing. */}
                  {t.change != null ? (
                    <span
                      data-trend-change
                      className={cn("text-caption1", t.change >= 0 ? "text-ok-11" : "text-warn-11")}
                    >
                      {pct(t.change)}{" "}
                      <span className="text-fg-subtle">
                        vs prior {t.priorCount}
                      </span>
                    </span>
                  ) : (
                    <span data-trend-change className="text-caption1 text-fg-subtle">no prior window yet</span>
                  )}
                </div>
                <span className="text-caption2 text-fg-subtle">
                  average peak, last {Math.min(t.recent.length, TREND_WINDOW)}
                </span>
              </div>
            ))}
          </div>

          <HistoryChart
            series={series}
            items={[]}
            // A trend has no service window, so nothing is hatched: every point
            // on it is a whole service, and there is no "before the service".
            window={{ startedAt: null, endedAt: null }}
            yScale={{ kind: "count" }}
            xAxis="date"
            milestones={milestones}
            figures={figures}
            ariaLabel={`Peak attendance per recording over the last ${weeks} weeks`}
            emptyNote="No recordings in this range — try a longer one."
          />
        </>
      )}
    </section>
  );
}
