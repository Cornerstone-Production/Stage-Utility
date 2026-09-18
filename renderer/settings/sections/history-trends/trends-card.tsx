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
import { logToServer } from "../../../lib/client-log";
import { HistoryChart, useStoredKeys, type ChartMilestone } from "../history-chart";
import { toast } from "../../../components/ui";
import type { ChartSeries } from "../history-chart/geometry";
import { Sparkline } from "./sparkline";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/context-menu";
import {
  assignColorIndexes,
  colorForIndex,
  readColorAssignment,
  writeColorAssignment,
} from "./series-colors";
import {
  DEFAULT_RANGE_WEEKS,
  dailyPeaks,
  measureOf,
  RANGE_WEEKS,
  TREND_WINDOW,
  trendMilestones,
  typeTrends,
  withinRange,
  type RangeWeeks,
  type StoredMilestone,
  type TrendMeasure,
  type TrendRecording,
} from "./trends";

/** The range choice, per browser — a view preference, like every other one in
 *  this module. A stored value that is not one of the offered ranges is
 *  ignored rather than trusted: the control could not represent it. */
const RANGE_KEY = "history:trendRangeWeeks";

/** Which service types are drawn, per browser — the same kind of preference the
 *  attendance and sound sections keep, and stored the same way. */
const SERIES_KEY = "history:trendSeries";

/** Which reading the card plots, per browser. */
const MEASURE_KEY = "history:trendMeasure";

const MEASURES = [
  { key: "attendance" as const, label: "Attendance" },
  { key: "sound" as const, label: "Sound" },
];

function storedMeasure(): TrendMeasure {
  try {
    return localStorage.getItem(MEASURE_KEY) === "sound" ? "sound" : "attendance";
  } catch {
    return "attendance";
  }
}

/** Keep a view preference, or carry on without it. Private mode and a full
 *  quota both throw; the choice then holds for this visit and reverts next
 *  time, which is the state the operator was already in. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* nothing is lost */
  }
}

function storedRange(): RangeWeeks {
  try {
    const raw = Number(localStorage.getItem(RANGE_KEY));
    return (RANGE_WEEKS as readonly number[]).includes(raw) ? (raw as RangeWeeks) : DEFAULT_RANGE_WEEKS;
  } catch {
    return DEFAULT_RANGE_WEEKS;
  }
}

/** Every drawn line on this chart is a PEER — one service type against
 *  another, none of them the subject — so they share a weight. 1.8/1.2 by role
 *  said the busiest type was the measurement and the rest were reference lines
 *  against it. */
const TREND_LINE_WIDTH = 2;

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

export function TrendsCard({
  recordings,
  /** The page's SPL summary load failed, so `peakDb` is null everywhere for a
   *  reason that has nothing to do with what was recorded. Without this the
   *  sound measure reads "No sound recorded yet" at a church that records it
   *  every week. */
  soundUnavailable = false,
}: {
  recordings: TrendRecording[];
  soundUnavailable?: boolean;
}) {
  const [weeks, setWeeks] = useState<RangeWeeks>(storedRange);
  /** Attendance or sound. Attendance by default: it is the question the tab is
   *  opened to answer, and sound is the one asked afterwards. */
  const [measure, setMeasure] = useState<TrendMeasure>(storedMeasure);
  /**
   * The series the operator has switched OFF, by id.
   *
   * Off rather than on, so a service type that starts recording next month
   * appears by itself instead of being absent until somebody finds a control
   * they had no reason to look for. `null` for "anything the operator stored" —
   * the offering is per-history and filtering against today's would quietly
   * drop a type that had not recorded in the chosen range.
   */
  const [hidden, toggleHidden, , replaceHidden] = useStoredKeys(SERIES_KEY, null, []);
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
        logToServer("history", `could not read the milestone list: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function pickRange(next: RangeWeeks) {
    setWeeks(next);
    remember(RANGE_KEY, String(next));
  }

  function pickMeasure(next: TrendMeasure) {
    setMeasure(next);
    remember(MEASURE_KEY, next);
  }

  const sound = measure === "sound";
  const pick = useMemo(() => measureOf(measure), [measure]);
  /** Counts read with separators; levels read as whole decibels, the same way
   *  every other level in the app does. */
  const fmtValue = (v: number) => (sound ? `${Math.round(v)} dB` : Math.round(v).toLocaleString());

  const tiles = useMemo(() => typeTrends(recordings, { pick }), [recordings, pick]);
  const ranged = useMemo(() => withinRange(recordings, weeks, pick), [recordings, weeks, pick]);

  /**
   * One colour per service type, stable across measure, range and sort.
   *
   * The ORDER a type is first seen in decides its colour, and that order is the
   * tiles' — busiest first — so the weekend service leads in the palette's lead
   * colour and a once-a-year type does not take the green because its id sorts
   * early. Sorting by id gave a church its midweek service in green and its
   * weekend in the third colour.
   *
   * Only the FIRST sighting uses this order; after that the assignment is
   * frozen and persisted, so re-sorting on a measure switch, a quiet type
   * having a loud week, or a type missing a range all leave it alone. Types
   * with no tile under the current measure are appended, so a type that has
   * only ever recorded sound still gets a colour.
   *
   * The derivation is pure and tested in series-colors.test.ts.
   */
  const typeIds = useMemo(() => {
    const ordered = tiles.map((t) => t.serviceTypeId ?? "");
    const seen = new Set(ordered);
    for (const r of recordings) {
      const key = r.serviceTypeId ?? "";
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
    return ordered;
  }, [tiles, recordings]);
  const colorIndexes = useMemo(() => assignColorIndexes(readColorAssignment(), typeIds), [typeIds]);
  const colorOf = (key: string) => colorForIndex(colorIndexes[key] ?? 0);

  // Persist it, so the assignment survives a reload and next week's chart is
  // the same picture. A browser that refuses to write says so on a [history]
  // line rather than silently re-deriving a different assignment every visit.
  useEffect(() => {
    const err = writeColorAssignment(colorIndexes);
    if (err) logToServer("history", `could not remember the trend colours: ${err.message}`);
  }, [colorIndexes]);

  const series = useMemo<ChartSeries[]>(() => {
    const byType = new Map<string, TrendRecording[]>();
    for (const r of ranged) {
      const key = r.serviceTypeId ?? "";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(r);
    }
    // Order decides only which line draws on top; the COLOUR no longer follows
    // it — see colorIndexes. It used to, and that is how The Salt Company was
    // blue on Attendance and green on Sound.
    const order = tiles.map((t) => t.serviceTypeId ?? "").filter((k) => byType.has(k));
    for (const k of byType.keys()) if (!order.includes(k)) order.push(k);
    return order.map((key, i) => ({
      id: key || "all",
      label: tiles.find((t) => (t.serviceTypeId ?? "") === key)?.name ?? "Services",
      color: colorOf(key),
      // Every line the same weight — see TREND_LINE_WIDTH. `role` still picks
      // which one the gradient and the live edge would belong to; this chart
      // has neither.
      width: TREND_LINE_WIDTH,
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
      // The line runs through each day's BUSIEST service. Three Sunday services
      // plotted as three points drew a sawtooth — 9am 1,400, 11am 700, 6pm
      // 1,100 and back again, every week — in which a real week-to-week trend
      // was invisible. The individual recordings were also drawn, as scatter
      // dots; they read as noise nobody could name and are gone.
      points: dailyPeaks(byType.get(key) ?? [], pick).map((d) => ({ t: d.t, v: d.v })),
      format: fmtValue,
    }));
    // `fmtValue` is a fresh closure every render; what it depends on is the
    // measure, which `pick` already carries. `colorOf` reads `colorIndexes`,
    // which IS a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranged, tiles, hidden, pick, colorIndexes]);

  /** The tiles that are DRAWN. `hidden` keys a type by its series id, which is
   *  the type id or "all" for the no-type bucket — the same key the series and
   *  the stat strip filter on, so the three cannot disagree. */
  const shownTiles = useMemo(
    () => tiles.filter((t) => !hidden.includes(t.serviceTypeId ?? "all")),
    [tiles, hidden],
  );

  /** Where a right-click landed, and which series it was on (null = the plot). */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  function openMenu(id: string | null, e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, id });
  }
  function setHidden(id: string, hide: boolean) {
    if (hidden.includes(id) === hide) return;
    const err = toggleHidden(id);
    if (err) toast.error(`Couldn't remember that: ${err.message}`);
  }
  function showAll() {
    // One write, not a loop of toggles — see `replaceHidden`.
    const err = replaceHidden([]);
    if (err) toast.error(`Couldn't remember that: ${err.message}`);
  }

  /**
   * The menu: hide the one that was clicked, then a tick per service type, then
   * Show all.
   *
   * The whole list is offered whichever surface was right-clicked, because a
   * 2px line is not something a pointer lands on reliably — so the plot's menu
   * has to be able to reach every type rather than guessing which was aimed at.
   */
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    const items: ContextMenuItem[] = [];
    const clicked = menu.id == null ? null : tiles.find((t) => (t.serviceTypeId ?? "all") === menu.id);
    if (clicked && !hidden.includes(menu.id as string)) {
      items.push({ label: `Hide ${clicked.name}`, onSelect: () => setHidden(menu.id as string, true) });
      items.push({ separator: true });
    }
    for (const t of tiles) {
      const key = t.serviceTypeId ?? "all";
      items.push({
        label: t.name,
        checked: !hidden.includes(key),
        onSelect: () => setHidden(key, !hidden.includes(key)),
      });
    }
    items.push({ separator: true });
    items.push({ label: "Show all", disabled: hidden.length === 0, onSelect: showAll });
    return items;
    // `setHidden` closes over `hidden`, which IS a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, tiles, hidden]);

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


  return (
    <section data-testid="history-trends" className="su-card flex flex-col gap-4 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-baseline gap-2">
          {/* A card TITLE, not a label. The mockup leads the page with it and
              every other card on the page now titles itself the same way. */}
          <h3 className="text-body font-semibold text-fg">Trends</h3>
          {milestonesFailed && (
            <span data-milestones-failed className="text-caption2 text-warn-11">milestones unavailable</span>
          )}
          {sound && soundUnavailable && (
            <span data-sound-unavailable className="text-caption2 text-warn-11">sound summary unavailable</span>
          )}
        </span>
        <div className="flex items-center gap-2">
        {/* What is plotted. Two options, so buttons rather than a menu that has
            to be opened to see them — the same shape as the range beside it. */}
        <div role="group" aria-label="Trend measure" className="flex items-center gap-1 rounded-lg border border-line p-0.5">
          {MEASURES.map((m) => (
            <button
              key={m.key}
              type="button"
              data-trend-measure={m.key}
              aria-pressed={measure === m.key}
              onClick={() => pickMeasure(m.key)}
              className={cn(
                "touch-target rounded-md px-2 py-0.5 text-caption2 transition-colors",
                measure === m.key ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill hover:text-fg",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
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
      </div>

      {/* What the card is, in one line. The tiles and the plot below it answer
          two different questions and neither says which recordings it read, so
          without this the "avg peak" on a tile is a number with no window. On
          its own row rather than beside the title: the measure and range
          controls take that space. */}
      <p data-trends-subtitle className="-mt-3 text-caption2 text-fg-subtle">
        {sound ? "Peak level" : "Peak attendance"} per service type, last {TREND_WINDOW} recordings each
        {" · milestones from your list and series changes"}
      </p>

      {tiles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-caption1 text-fg-muted">
          {sound && soundUnavailable
            ? "The sound summary could not be read — see the server log for the reason."
            : sound
              ? "No sound recorded yet — a trend needs at least one service with a meter running."
              : "No attendance recorded yet — a trend needs at least one service with a people counter running."}
        </p>
      ) : (
        <>
          {/* The SHOWN types only. A hidden type disappearing from the tiles as
              well as from the plot is the point — the tiles were the one place
              it stayed, so "hide" hid half of it. The legend below keeps a
              dimmed entry, which is how it comes back. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shownTiles.map((t) => (
              <div
                key={t.serviceTypeId ?? "all"}
                data-trend-tile={t.serviceTypeId ?? "all"}
                onContextMenu={(e) => openMenu(t.serviceTypeId ?? "all", e)}
                // Sparkline LEFT, figures RIGHT. Stacked, the tile was three
                // rows of equal weight and the average did not lead.
                className="flex items-center gap-3 rounded-lg border border-line bg-fill/40 px-3 py-2.5"
              >
                <Sparkline
                  values={t.recent.map((d) => d.v)}
                  color={colorOf(t.serviceTypeId ?? "")}
                  width={90}
                  height={34}
                  label={`${t.name}: the ${sound ? "loudest" : "busiest"} service of each of the last ${t.recent.length} days it recorded`}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-caption2 text-fg-subtle">
                  {t.name} · avg {sound ? "peak level" : "peak"}
                </span>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span data-trend-average className="font-mono text-[20px] font-medium leading-[24px] tabular-nums text-fg">
                    {t.average == null ? "—" : fmtValue(t.average)}
                  </span>
                  {/* No change until there is something to compare against. A
                      tile with one window of recordings says so rather than
                      printing a figure derived from nothing. */}
                  {t.change != null ? (
                    // In the SERIES colour, not red/green. The sign already
                    // carries the direction; what the tile has to say at a
                    // glance is which line on the plot below it belongs to.
                    <span
                      data-trend-change
                      className="text-caption1"
                      style={{ color: colorOf(t.serviceTypeId ?? "") }}
                    >
                      {pct(t.change)}{" "}
                      {/* The REAL count, never the window it would like to
                          have. A tile comparing against four days says four. */}
                      <span className="text-fg-subtle">vs prior {t.priorCount}</span>
                    </span>
                  ) : (
                    <span data-trend-change className="text-caption1 text-fg-subtle">
                      {/* A type with nothing under THIS measure keeps its tile
                          and says so, rather than vanishing when you switch —
                          which reads as the service type having disappeared. */}
                      {t.average != null
                        ? "no prior window yet"
                        // A tile with no level because the SUMMARY would not
                        // load is not a service type that recorded no sound.
                        // Same lie as the empty plot's, one level down.
                        : sound
                          ? soundUnavailable ? "sound unavailable" : "no sound recorded"
                          : "no attendance recorded"}
                    </span>
                  )}
                </div>
                </div>
              </div>
            ))}
          </div>

          <HistoryChart
            series={series}
            items={[]}
            // A trend has no service window, so nothing is hatched: every point
            // on it is a whole service, and there is no "before the service".
            window={{ startedAt: null, endedAt: null }}
            // A dB axis is banded the way the sound chart's is — a multiple of
            // ten wide, never anchored at zero, because 0 dB is not a floor a
            // sound chart has.
            yScale={sound ? { kind: "db" } : { kind: "count", banded: true }}
            xAxis="date"
            milestones={milestones}
            // NO at-rest figures. The strip carried Services / Average peak /
            // Busiest, which is a fourth summary of the same recordings the
            // tiles above it already summarise per service type — and a blend
            // across types, which is the statistic the tiles exist to avoid.
            // The strip still answers a HOVER: what a point on a line is, and
            // which recording it belongs to.
            figures={[]}
            onToggleSeries={(id) => {
              const err = toggleHidden(id);
              if (err) toast.error(`Couldn't remember that: ${err.message}`);
            }}
            onSeriesContextMenu={openMenu}
            ariaLabel={
              sound
                ? `Peak level per recording over the last ${weeks} weeks`
                : `Peak attendance per recording over the last ${weeks} weeks`
            }
            emptyNote={
              sound
                ? "No sound recorded in this range — try a longer one."
                : "No recordings in this range — try a longer one."
            }
          />
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </section>
  );
}
