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
import { errorMessage } from "@main/services/errors";
import { invoke } from "../../../lib/api";
import { HistoryChart, useStoredKeys, type ChartMilestone } from "../history-chart";
import { toast } from "../../../components/ui";
import type { ChartSeries } from "../history-chart/geometry";
import { Sparkline } from "./sparkline";
import {
  DEFAULT_RANGE_WEEKS,
  dailyPeaks,
  RANGE_WEEKS,
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

/** Which service types are drawn, per browser — the same kind of preference the
 *  attendance and sound sections keep, and stored the same way. */
const SERIES_KEY = "history:trendSeries";

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

/**
 * "+12%" / "−12%", the spelling every percentage trend in this app uses.
 *
 * A change that rounds to nothing is "0%", not "+0%" or "−0%": a sign in front
 * of zero claims a direction the number denies, and which of the two you got
 * depended on the sign of a difference too small to print.
 */
export function pct(change: number): string {
  const whole = Math.round(change * 100);
  if (whole === 0) return "0%";
  return `${whole > 0 ? "+" : "−"}${Math.abs(whole)}%`;
}

export function TrendsCard({ recordings }: { recordings: TrendRecording[] }) {
  const [weeks, setWeeks] = useState<RangeWeeks>(storedRange);
  /**
   * The series the operator has switched OFF, by id.
   *
   * Off rather than on, so a service type that starts recording next month
   * appears by itself instead of being absent until somebody finds a control
   * they had no reason to look for. `null` for "anything the operator stored" —
   * the offering is per-history and filtering against today's would quietly
   * drop a type that had not recorded in the chosen range.
   */
  const [hidden, toggleHidden] = useStoredKeys(SERIES_KEY, null, []);
  const [stored, setStored] = useState<StoredMilestone[]>([]);
  /**
   * Set when the milestone list could not be read.
   *
   * The failure used to be swallowed: the chart drew the derived series-change
   * marks and simply lacked the operator's own, which is indistinguishable from
   * having none — somebody who had just added one would be looking at a chart
   * that silently disagreed with Settings. Said on the card AND logged, because
   * the reason is in the console and the fact is on screen.
   */
  const [milestonesFailed, setMilestonesFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<StoredMilestone[]>("history:listMilestones")
      .then((list) => !cancelled && setStored(list ?? []))
      .catch((err) => {
        if (cancelled) return;
        setMilestonesFailed(true);
        console.warn(`[history] could not read the milestone list: ${errorMessage(err)}`);
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
      // The legend IS the toggle — the same arrangement the attendance and
      // sound charts use. Without it a milestone scoped to one service type had
      // no way to be seen scoping anything: the rule that hides it with its
      // series was correct and unreachable.
      on: !hidden.includes(key || "all"),
      // A trend has no sampling interval to have a gap in: two recordings are a
      // fortnight apart because a service was a fortnight apart, not because
      // anything went unmeasured. Without this every point would be its own run.
      gapMs: Infinity,
      // The LINE runs through each day's busiest service; the DOTS are the
      // services. Three Sunday services plotted as three points drew a sawtooth
      // — 9am 1,400, 11am 700, 6pm 1,100 and back again, every week — in which a
      // real week-to-week trend was invisible.
      points: dailyPeaks(byType.get(key) ?? []).map((d) => ({ t: d.t, v: d.v })),
      dots: (byType.get(key) ?? []).map((r) => ({ t: r.t, v: r.peakOccupancy as number })),
    }));
  }, [ranged, tiles, hidden]);

  const milestones = useMemo<ChartMilestone[]>(() => {
    if (!ranged.length) return [];
    const startMs = Math.min(...ranged.map((r) => r.t));
    const endMs = Math.max(...ranged.map((r) => r.t));
    // `seriesId` is the chart's name for the same thing `serviceTypeId` names
    // here, and it is what scopes the mark: a milestone against one type draws
    // only while that type's line does, in that line's colour. The field was
    // stored and documented and then dropped on the way to the chart, so a
    // milestone somebody had scoped to the Youth service drew across the
    // Weekend line in the neutral grey of one that belonged to everything.
    return trendMilestones(stored, ranged, { startMs, endMs }).map((m) => ({
      ...m,
      seriesId: m.serviceTypeId ?? undefined,
    }));
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
        <span className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">Trends</span>
          {milestonesFailed && (
            <span data-milestones-failed className="text-caption2 text-warn-11">milestones unavailable</span>
          )}
        </span>
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
                  values={t.recent.map((d) => d.v)}
                  label={`${t.name}: the busiest service of each of the last ${t.recent.length} days it recorded`}
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
                      {/* The REAL count, never the window it would like to
                          have. A tile comparing against four days says four. */}
                      <span className="text-fg-subtle">vs prior {t.priorCount}</span>
                    </span>
                  ) : (
                    <span data-trend-change className="text-caption1 text-fg-subtle">no prior window yet</span>
                  )}
                </div>
                <span className="text-caption2 text-fg-subtle">
                  busiest service, averaged over {t.recent.length} day{t.recent.length === 1 ? "" : "s"}
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
            onToggleSeries={(id) => {
              const err = toggleHidden(id);
              if (err) toast.error(`Couldn't remember that: ${err.message}`);
            }}
            ariaLabel={`Peak attendance per recording over the last ${weeks} weeks`}
            emptyNote="No recordings in this range — try a longer one."
          />
        </>
      )}
    </section>
  );
}
