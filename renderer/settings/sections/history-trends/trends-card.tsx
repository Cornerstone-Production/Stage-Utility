// trends-card.tsx — the card that leads All services.
//
// One tile per service type (a sparkline of the last eight recorded days, the
// latest of those days, the change against the seven beside it), then one
// full-width chart across the chosen range with every type on it and milestones
// under the axis.
//
// A DAY, not a recording, is the unit everywhere here — and what a day is worth
// differs by measure: attendance adds that day's services up, sound takes the
// loudest of them, because decibels do not add. See DAY_FIGURE in trends.ts.
//
// EVERYTHING HERE IS COMPUTED FROM RECORDS THE PAGE ALREADY HOLDS. The list
// loads `serviceTimeline:list` and `attendance:listSummaries` to draw the calendar
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
//
// THE CHANGE LABEL'S OWN WIDTH IS THE SAME BLIND SPOT: the tests below assert
// its TEXT ("+13% vs 12 prior services"), never whether it fits the tile
// without wrapping — jsdom cannot measure that. It is one clause shorter than
// the label it replaced, but that is an expectation, not something this
// session drove in a browser to confirm.

import { useEffect, useMemo, useState } from "react";

import { cn } from "../../../lib/cn";
import { errorMessage } from "@main/services/errors";
import { invoke } from "../../../lib/api";
import { logToServer } from "../../../lib/client-log";
import { HistoryChart, useStoredKeys, type ChartMilestone, type StripHover } from "../history-chart";
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
  dailyValues,
  RANGE_WEEKS,
  rangeLabel,
  rangeSpan,
  weeksOf,
  trendMilestones,
  typeTrends,
  withinRange,
  type RangeWeeks,
  type StoredMilestone,
  type TrendClock,
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
    const raw = localStorage.getItem(RANGE_KEY) ?? "";
    // The stored value is the choice's own spelling — "8" or "all" — so a
    // browser that kept "16" from before All existed still reads as 16.
    const hit = (RANGE_WEEKS as readonly (number | string)[]).find((w) => String(w) === raw);
    return (hit as RangeWeeks | undefined) ?? DEFAULT_RANGE_WEEKS;
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
 * How many decimals a measure prints. Whole people; tenths of a decibel.
 *
 * ONE definition, read by the tile's headline AND by its change, so the change
 * is always exactly the difference between the two figures it came from. Two
 * precisions is how "+1" ends up beside two numbers that are equal on screen.
 */
const DECIMALS: Record<TrendMeasure, number> = { attendance: 0, sound: 1 };

/**
 * Decimal places a tile's CHANGE PERCENTAGE prints at.
 *
 * A SEPARATE decision from DECIMALS, even though today's values match it:
 * DECIMALS answers "how precisely does this measure's own unit print," and
 * reusing it here would let a third measure inherit a percentage precision
 * nobody actually chose for it. Keyed by TrendMeasure for the same reason
 * DECIMALS is, and the same reason DAY_FIGURE and COMPARABLE_ABOVE are in
 * trends.ts: a third measure cannot be added without deciding it.
 *
 * Attendance: whole points. A congregation runs from dozens to thousands, so
 * a point of percentage is already a handful of people — finer than that is
 * false precision on a figure nobody can act on to that resolution.
 *
 * Sound: tenths. Decibels live in a narrow band, roughly 60 to 110, so most
 * real swings across a service are a few percent or less. Whole-percent
 * rounding would print "0%" for a change the absolute figure used to show as
 * real movement — a quarter of a decibel against a 90 dB basis is 0.3%.
 */
const PCT_DECIMALS: Record<TrendMeasure, number> = { attendance: 0, sound: 1 };

/**
 * "Sep 20" from a `YYYY-MM-DD`.
 *
 * The same words and the same order the chart's date axis uses under it, so the
 * date on a tile and the date under the node it names read alike. Parsed at
 * local midnight, not as a bare ISO date: `new Date("2026-09-20")` is UTC and
 * lands on the 19th west of Greenwich.
 */
function fmtDayShort(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * "22 prior services" — what a tile's percentage change was measured against.
 *
 * ONE shape for both comparison modes. The two-clause label this replaced —
 * "first 2 services, 11 days" beside "11 full days" — spelled out in words
 * which basis was in use, because the day count alone could not tell them
 * apart: eleven prior days reads the same whether the tile is comparing
 * first-twos or whole totals. Counting the basis in SERVICES instead carries
 * that distinction on its own — the same eleven prior days is 22 services
 * under a first-two basis, and however many those eleven days actually ran
 * under a whole-day one — so the number differs correctly between the two
 * modes and the sentence around it never has to say which produced it. See
 * `priorServiceCount` in trends.ts for how the count itself is taken.
 *
 * "prior service" rather than "prior services" only at exactly one, which
 * MIN_PRIOR_DAYS keeps out of reach today but costs nothing to spell right.
 *
 * Exported for its own test: the number has to stay honest about a thin
 * comparison, and the sentence around it is what a browser will not always
 * show in full.
 */
export function basisLabel(priorServices: number): string {
  return `${priorServices} prior service${priorServices === 1 ? "" : "s"}`;
}

/** Round to a measure's own precision. */
function atPrecision(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * The signed percentage `rawLatest` differs from `rawBasis`, taking BOTH to
 * `dp` — the same rounding the tile's two figures print at — before dividing.
 * Null when the basis, at that rounding, is zero or negative.
 *
 * ROUNDED FIRST is not optional. A percentage taken from the raw figures
 * prints a residual off two numbers that read identically on screen — see
 * `latestRaw` in trends.ts, which names this as the bug the card's
 * percentage had before it was dropped for an absolute figure for a while.
 * Two displayed-equal numbers must come out at exactly 0%.
 *
 * The null case does not fire for attendance or sound today — every basis
 * that reaches here already cleared COMPARABLE_ABOVE in trends.ts — but a
 * division is a new failure mode a subtraction never had, and a future
 * signed measure that sets its own floor at or below zero must not have a
 * percentage printed against it anyway.
 */
export function pctChange(rawLatest: number, rawBasis: number, dp: number): number | null {
  const basis = atPrecision(rawBasis, dp);
  if (basis <= 0) return null;
  const latest = atPrecision(rawLatest, dp);
  return ((latest - basis) / basis) * 100;
}

/**
 * "+8%" / "−8%" / "0%" — `pct` printed at `dp` decimal places.
 *
 * Signed the way this card's absolute change used to be, and unsigned at
 * exactly zero for the same reason: a sign in front of zero claims a
 * direction the number denies.
 */
export function pctLabel(pct: number, dp: number): string {
  const v = atPrecision(pct, dp);
  const body = Math.abs(v).toFixed(dp);
  if (v === 0) return `${body}%`;
  return `${v > 0 ? "+" : "−"}${body}%`;
}

/**
 * "prior window averaged 0" when a real prior value exists but the change
 * figure still came out null (pctChange's basis rounded to zero or below),
 * "no prior window yet" when there is no prior value at all — two different
 * facts a caller's own null-change fallback must not collapse into one
 * caption. Shared because the SAME shape lives in two Trends cards: this
 * one's own tiles below, and baptisms/trends-card.tsx's four. Each caller
 * still decides its own wording for "no LATEST value either" — that part is
 * not the same shape (this card names which measure is missing; the
 * Baptisms one has only one measure to be missing).
 */
export function noPriorCaption(hasPrior: boolean): string {
  return hasPrior ? "prior window averaged 0" : "no prior window yet";
}

export function TrendsCard({
  recordings,
  /**
   * What the card knows about NOW — see TrendClock.
   *
   * Passed in rather than read here, because "what day is it" belongs to the
   * APP's zone and a browser cannot ask for that: the zone is a server setting.
   * Omitted (a test, or a surface with no live state) means the card judges every
   * day by its recordings alone.
   */
  clock = null,
  /** The page's SPL summary load failed, so `peakDb` is null everywhere for a
   *  reason that has nothing to do with what was recorded. Without this the
   *  sound measure reads "No sound recorded yet" at a church that records it
   *  every week. */
  soundUnavailable = false,
}: {
  recordings: TrendRecording[];
  clock?: TrendClock | null;
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
  /**
   * What the pointer is on, taken OUT of the chart — see HistoryChart.onHover.
   *
   * The chart used to print this itself, in a box laid over the top-left of the
   * plot. Narrowed to its text and made see-through it was still in front of the
   * line, and the top-left is where a rising line ends up. It goes on the card's
   * subtitle row instead: a line that is already there, already one line high,
   * and already the place the card explains itself.
   */
  const [hover, setHover] = useState<StripHover | null>(null);

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
  /** How many decimals this measure prints — see DECIMALS. */
  const dp = DECIMALS[measure];
  /** How many decimals this measure's CHANGE PERCENTAGE prints — see
   *  PCT_DECIMALS, a separate decision from `dp`. */
  const pctDp = PCT_DECIMALS[measure];
  /** Counts read with separators; levels read to a tenth of a decibel, which is
   *  the precision the change beside them is worth quoting to. */
  const fmtValue = (v: number) =>
    sound ? `${atPrecision(v, dp).toFixed(dp)} dB` : atPrecision(v, dp).toLocaleString();

  // THE RANGE GOVERNS BOTH. The tile's comparison basis and the chart's domain
  // come from one control, so a tile is measured against exactly the days drawn
  // under it and the relationship needs no explaining.
  const tiles = useMemo(
    () => typeTrends(recordings, { measure, weeks: weeksOf(weeks), clock: clock ?? undefined }),
    [recordings, measure, weeks, clock],
  );
  const ranged = useMemo(
    () => withinRange(recordings, weeksOf(weeks), measure),
    [recordings, weeks, measure],
  );

  /**
   * One colour per service type, stable across measure, range and sort.
   *
   * The ORDER a type is first seen in decides its colour, and that order is the
   * tiles' — by the figure each tile shows, highest first — so the weekend
   * service leads in the palette's lead colour and a once-a-year type does not
   * take the green because its id sorts early. Sorting by id gave a church its
   * midweek service in green and its weekend in the third colour.
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
    return order.map((key, i) => {
      const days = dailyValues(byType.get(key) ?? [], measure, clock);
      return {
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
      // One node per DAY, at the figure that day is worth — see DAY_FIGURE.
      // Three Sunday services plotted as three points drew a sawtooth — 9am
      // 1,400, 11am 700, 6pm 1,100 and back again, every week — in which a real
      // week-to-week trend was invisible. The individual recordings were also
      // drawn, as scatter dots; they read as noise nobody could name and are
      // gone. The SAME call the tiles make, so the last node on a line and the
      // number on the tile above it cannot differ.
      points: days.map((d) => ({ t: d.t, v: d.v })),
      // The final segment draws dashed with its node marked while the day it
      // runs into is still going — see TrendState. A glance then reads "not done
      // yet" rather than "collapsed", which is what a solid line into a Sunday
      // with one of three services done actually draws.
      //
      // Off the LAST PLOTTED DAY, not off the tile's state: the tile falls back
      // to an older day when today has nothing finished yet, and reading its
      // state here would dash a day that ended weeks ago.
      provisional: days[days.length - 1]?.provisional === true,
      format: fmtValue,
      };
    });
    // `fmtValue` is a fresh closure every render; what it depends on is the
    // measure, which IS a dependency. `colorOf` reads `colorIndexes`, which is
    // one too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranged, tiles, hidden, measure, colorIndexes, clock]);

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
              {rangeLabel(w)}
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* ONE ROW, TWO JOBS. At rest it says what the card is: what a DAY is
          worth under this measure, and how many days a tile draws — without it
          the figure on a tile is a number with no window, and "added up"
          against "the loudest" is the whole difference between the two
          measures. Under the pointer the same row becomes the chart's readout,
          so nothing is laid over the plot and the whole line stays visible.
          `truncate`, so it is one line in both states: a readout that wrapped
          would push the plot down under the cursor, which is the motion the old
          overlay existed to avoid. On its own row rather than beside the title —
          the measure and range controls take that space, and a readout up there
          would push them. */}
      <p
        data-trends-subtitle
        // A POLITE LIVE REGION, as the strip this replaced was. Its whole job in
        // the second state is to answer "what is under the pointer", and a
        // screen reader that is never told the row changed hears the at-rest
        // sentence forever. `polite`, so the announcement queues behind whatever
        // is being read rather than interrupting it, and the at-rest sentence is
        // not announced on arrival because a live region only reports CHANGES.
        role="status"
        aria-live="polite"
        className="-mt-3 truncate text-caption2 text-fg-subtle"
      >
        {hover != null ? (
          <span data-trends-readout>
            <span className="font-mono tabular-nums text-fg">{hover.time}</span>
            {/* Each visible type in its OWN colour — the same colour as its
                line, its tile and its legend swatch, which is what tells you
                which of three lines you are reading. */}
            {/* Keyed by POSITION, not by label: two service types can carry the
                same name, and a duplicate key drops one of them. */}
            {hover.values.map((v, i) => (
              <span key={i} data-readout-series={v.label} style={{ color: v.color }}>
                {" · "}
                {v.label} <span className="font-mono tabular-nums">{v.value}</span>
              </span>
            ))}
          </span>
        ) : (
          <>
            {sound
              ? "Peak level per service type, each day's loudest recording"
              : "Attendance per service type, each day's services added up"}
            {/* THE RANGE, not a fixed window. The sentence used to say "last 8
                days" — the sparkline's window — while the tile beside it
                compared 11 and the chart drew everything: three numbers on one
                card describing one thing, no two agreeing. */}
            {` · ${rangeSpan(weeks)}, drawn and compared · milestones from your list and series changes`}
          </>
        )}
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
                  label={`${t.name}: ${sound ? "the loudest recording" : "every service added up"} on each of the last ${t.recent.length} days it recorded`}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                {/* WHAT THE NUMBER IS, not what it averages. "avg peak" named a
                    mean over the whole window; the figure under it is now ONE
                    day — the latest this type recorded — so the label says which
                    day, and how that day's recordings came to one number. Under
                    sound they cannot be added, so it says "peak" there and
                    "total" for attendance. */}
                {/* WHICH day, on the tile. "latest day" is a relative phrase and
                    a type that has not recorded for three weeks shows a
                    three-week-old figure under it with nothing on screen saying
                    so. The date is pinned and the NAME truncates, so on a narrow
                    tile the date is the last thing lost rather than the first. */}
                <span className="flex items-baseline gap-1.5 text-caption2 text-fg-subtle">
                  <span className="truncate">
                    {t.name} · latest day {sound ? "peak" : "total"}
                  </span>
                  {t.latestDate && (
                    <span data-trend-latest-date className="shrink-0 tabular-nums">
                      {fmtDayShort(t.latestDate)}
                    </span>
                  )}
                </span>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span data-trend-latest className="font-mono text-[20px] font-medium leading-[24px] tabular-nums text-fg">
                    {t.latest == null ? "—" : fmtValue(t.latest)}
                  </span>
                  {/* No change until there is something to compare against. A
                      tile with one window of recordings says so rather than
                      printing a figure derived from nothing. */}
                  {(() => {
                    const pct = t.latestRaw != null && t.priorAverageRaw != null
                      ? pctChange(t.latestRaw, t.priorAverageRaw, dp)
                      : null;
                    // UP is good and DOWN is not, so the change is green or red
                    // rather than the series colour — the series colour is
                    // already carried by the sparkline beside it, and spending
                    // it twice on one tile leaves the direction, which is the
                    // thing being read, with no colour at all.
                    return pct != null ? (
                      <span
                        data-trend-change
                        className={cn("text-caption1", pct >= 0 ? "text-ok-11" : "text-danger-11")}
                      >
                        {pctLabel(pct, pctDp)}{" "}
                        {/* THE REAL number of prior SERVICES that fed the
                            average, never the count it would like to have had
                            — a comparison resting on 12 services says 12. See
                            `priorServiceCount` in trends.ts. */}
                        <span className="text-fg-subtle">vs {basisLabel(t.priorServiceCount)}</span>
                      </span>
                    ) : (
                      <span data-trend-change className="text-caption1 text-fg-subtle">
                        {/* A type with nothing under THIS measure keeps its tile
                            and says so, rather than vanishing when you switch —
                            which reads as the service type having disappeared.
                            noPriorCaption splits the OTHER reason pct can be
                            null: a real prior window that pctChange refused to
                            divide by is not the same fact as no prior window
                            existing at all — currently unreachable here (every
                            basis that reaches this tile already cleared
                            COMPARABLE_ABOVE in trends.ts), landed anyway so
                            the two Trends cards cannot drift apart. */}
                        {t.latest != null
                          ? noPriorCaption(t.priorAverage != null)
                          // A tile with no level because the SUMMARY would not
                          // load is not a service type that recorded no sound.
                          // Same lie as the empty plot's, one level down.
                          : sound
                            ? soundUnavailable ? "sound unavailable" : "no sound recorded"
                            : "no attendance recorded"}
                      </span>
                    );
                  })()}
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
            figures={[]}
            // So there is no strip at all, and the hover comes back here to be
            // drawn on the subtitle row. See `hover` above.
            onHover={setHover}
            onToggleSeries={(id) => {
              const err = toggleHidden(id);
              if (err) toast.error(`Couldn't remember that: ${err.message}`);
            }}
            onSeriesContextMenu={openMenu}
            ariaLabel={
              sound
                ? `The loudest recording of each day over the last ${weeks} weeks`
                : `Each day's services added up over the last ${weeks} weeks`
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
