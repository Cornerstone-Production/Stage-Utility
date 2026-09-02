// The Overview's derived numbers, in ONE place.
//
// These were computed inside service-history-section's component, which was fine
// while History was the only surface showing them. Home's idle state shows the
// same headline figures, and a second implementation is how two screens come to
// disagree about the same number - the exact failure overview-scope.ts already
// exists to prevent for the scope filters.
//
// Everything here is pure: give it the records and the scope, get the figures.
// No hooks, no fetching - both callers already hold the data.

import { inTrendScope, inAverageScope } from "./overview-scope";
import type { SplServiceSummary } from "@main/types/stage";
import { combineLeq, leqOf } from "@main/services/spl-leq";
import { formatClock } from "../../lib/clock-format";

export function fmtTime(iso: string | null): string {
  return formatClock(iso);
}

/** Short local date label ("Jul 5") for a YYYY-MM-DD service date. */
export function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One point on the attendance trend chart — a service occurrence with its peak
 *  in-room count and the day it happened (for the axis labels). */
export interface TrendPoint {
  day: string;
  value: number;
  parts?: { label: string; value: number }[];
  live?: boolean;
  /** That day's service Leq in dB for the chosen metric, or null when nothing was
   *  recorded. Null rather than 0 — the SPL line breaks over a gap instead of
   *  diving to the floor and inventing a silent Sunday. */
  spl?: number | null;
}

/** A trend indicator: which direction the latest value moved vs the mean of the
 *  prior window, and whether that direction is good or bad for THIS metric.
 *  `null` when there isn't enough prior data to judge honestly. */
export type TrendTone = "good" | "bad" | "neutral";
export interface Trend { dir: "up" | "down"; tone: TrendTone; pct: number | null; priorCount: number }

/**
 * Compare the latest value in a chronological series to the mean of the prior
 * window (everything before it, capped at `window`). Returns null when there's
 * no prior data — so we never fake a direction. `higherIsBetter` maps the raw
 * up/down direction onto good/bad for the metric (attendance up = good; overrun
 * up = bad). Values within `deadband` (fractional) of the prior mean read neutral.
 */
export function computeTrend(series: number[], higherIsBetter: boolean, opts?: { window?: number; deadband?: number }): Trend | null {
  if (series.length < 2) return null;
  const window = opts?.window ?? 4;
  const deadband = opts?.deadband ?? 0.02;
  const latest = series[series.length - 1];
  const prior = series.slice(Math.max(0, series.length - 1 - window), series.length - 1);
  if (prior.length === 0) return null;
  const priorMean = prior.reduce((a, b) => a + b, 0) / prior.length;
  const diff = latest - priorMean;
  const pct = priorMean !== 0 ? diff / Math.abs(priorMean) : null;
  const dir: "up" | "down" = diff >= 0 ? "up" : "down";
  const withinDeadband = pct != null && Math.abs(pct) < deadband;
  const tone: TrendTone = withinDeadband ? "neutral" : (dir === "up") === higherIsBetter ? "good" : "bad";
  return { dir, tone, pct, priorCount: prior.length };
}

/**
 * The SPL equivalent of `Trend`: the latest settled weekend's level against the
 * prior window, as a DIFFERENCE IN DECIBELS.
 *
 * Not a percentage, which is what `Trend` reports. dB is a logarithmic scale, so
 * "+2% of 84 dB" is not a statement about loudness — the honest comparison
 * between two levels is their difference, and 3 dB means the same thing whether
 * the room was at 80 or at 100. No tone either: a louder weekend is not a worse
 * one, and colouring it would editorialise about a mix decision.
 */
export interface SplDelta {
  /**
   * "flat" below the deadband, not just "up" or "down" left uncoloured.
   *
   * `Trend` has the same problem — a change inside ITS deadband is still
   * `dir: "up"` or `"down"`, just with `tone: "neutral"` — and gets away with
   * it because the neutral GREY carries the "this doesn't mean anything"
   * signal on its own. `SplDelta` is deliberately never coloured at all (a
   * louder weekend is not a worse one), so its arrow has nothing to soften
   * it: a `▼` next to a sub-tenth-of-a-dB reading of room noise reads as a
   * real, judged direction with no visual hedge attached. Flat removes the
   * arrow instead of relying on a colour this type refuses to have.
   */
  dir: "up" | "down" | "flat";
  /** Signed: the latest level minus the prior window's Leq. */
  db: number;
  priorCount: number;
}

/**
 * Compare the latest level in a chronological series of weekend Leqs to the
 * ENERGY average of the prior window.
 *
 * Deliberately not `computeTrend`, which takes an arithmetic mean of the prior
 * window: the arithmetic mean of decibels is not the average level and
 * understates it whenever the material is dynamic — see main/services/spl-leq.ts
 * for the arithmetic and for how far out it lands. Same window and the same
 * shape of answer; different maths, because the unit is different.
 *
 * `null` where `computeTrend` returns null: no prior weekend to compare against.
 *
 * `deadbandDb` defaults to 0.5 — below a just-noticeable difference for most
 * listeners, and comfortably inside the week-to-week noise of a room mixed by
 * the same person to the same target. Below it, `dir` reads "flat".
 */
export function computeSplDelta(levels: readonly number[], window = 4, deadbandDb = 0.5): SplDelta | null {
  const latest = levels[levels.length - 1];
  // `leqOf` below already screens the PRIOR window for non-finite values; the
  // latest reading was never screened the same way, so one bad sample here
  // (a metric key present but empty, a NaN from upstream) produced `db: NaN`
  // and rendered as "vs the prior N Weekends" — a real-looking comparison
  // built on an unreal number.
  if (!Number.isFinite(latest)) return null;
  const prior = levels.slice(Math.max(0, levels.length - 1 - window), levels.length - 1);
  const priorLeq = leqOf(prior);
  if (priorLeq == null) return null;
  const db = latest - priorLeq;
  const dir: SplDelta["dir"] = Math.abs(db) < deadbandDb ? "flat" : db >= 0 ? "up" : "down";
  return { dir, db, priorCount: prior.length };
}

/** Seconds → "m:ss" (or "h:mm:ss"). */
export function fmtDur(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Signed seconds → "+m:ss" / "−m:ss" (over/under planned). */
export function fmtDelta(sec: number | null): string {
  if (sec == null) return "";
  const s = Math.round(sec);
  const sign = s > 0 ? "+" : s < 0 ? "−" : "±";
  const a = Math.abs(s);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** Trailing "Stream Buffer"-type padding items — post-service, often left running
 *  long, so they're excluded from all timing math (kept visible but not counted). */
export function isBufferItem(title: string | null | undefined): boolean {
  return (title ?? "").toUpperCase().includes("BUFFER");
}

/** Pre-service items (Doors, Pre-roll, …). Prefers the recorder's position-based
 *  flag (above the SERVICE START header — robust to early/late/storm-delayed starts);
 *  falls back to "went live before the scheduled time" for records made before it. */
export function isPreServiceItem(it: ServiceTimelineItem, rec: ServiceTimeline): boolean {
  if (typeof it.preService === "boolean") return it.preService;
  if (!rec.serviceTimeStartsAt || !it.startedAt) return false;
  const s = Date.parse(it.startedAt);
  const svc = Date.parse(rec.serviceTimeStartsAt);
  return Number.isFinite(s) && Number.isFinite(svc) && s < svc;
}

/** Whether an item counts toward the service timers. A per-item user override (the
 *  checkbox) wins; otherwise the auto default excludes buffer + pre-service items. */
export function isCountedItem(it: ServiceTimelineItem, rec: ServiceTimeline): boolean {
  if (typeof it.counted === "boolean") return it.counted;
  return !isBufferItem(it.title) && !isPreServiceItem(it, rec);
}

/** Derived service-level timing from a record. */
export function summarize(rec: ServiceTimeline, now = Date.now()) {
  const counted = rec.items.filter((it) => isCountedItem(it, rec));
  // "Started" = when the service proper began (first counted item), not doors.
  const firstStart = counted[0]?.startedAt ?? rec.items[0]?.startedAt ?? rec.startedAt;
  const scheduled = rec.serviceTimeStartsAt;
  let lateStartSec: number | null = null;
  if (scheduled && firstStart) {
    const d = (Date.parse(firstStart) - Date.parse(scheduled)) / 1000;
    if (Number.isFinite(d)) lateStartSec = d;
  }
  let planned = 0;
  let actual = 0;
  let plannedKnown = false;
  for (const it of counted) {
    if (it.plannedLengthSec != null) { planned += it.plannedLengthSec; plannedKnown = true; }
    if (it.actualDurationSec != null) actual += it.actualDurationSec;
    else if (it.endedAt == null && it.startedAt) {
      // Live (in-progress) item: count its elapsed time so "Actual" ticks up live.
      const el = (now - Date.parse(it.startedAt)) / 1000;
      if (Number.isFinite(el) && el > 0) actual += el;
    }
  }
  return { lateStartSec, planned: plannedKnown ? planned : null, actual, firstStart };
}

/** Computed Overview blend data (lead stat + strip + chart series + trends). */
export interface OverviewData {
  avgAttendance: string;
  attTrend: Trend | null;
  attPoints: TrendPoint[];
  services: string;
  avgLength: string;
  avgStart: string;
  avgStartEarly: boolean;
  avgStartLate: boolean;
  avgOverrun: string;
  overrunTrend: Trend | null;
  peakAttendance: string;
  peakSub?: string;
  /** The service type these figures are scoped to, for the labels. The overview
   *  has always filtered by activeType; the labels said "weekend" regardless, so
   *  an Events night showed Events numbers under a Weekend heading. */
  scopeName: string | null;
  /** Metric keys with a level behind them, in scope, sorted — what the "Metric"
   *  submenu offers. Built from the data rather than a fixed list because which
   *  metrics exist is Smaart's business, not this app's. */
  splMetrics: string[];
  /** The metric `attPoints[].spl` was filled from: the caller's choice when it
   *  is one of `splMetrics`, else the preferred default, else null. */
  splMetric: string | null;
  /** Average weekend level in dB for `splMetric` across settled weekends,
   *  ENERGY-averaged. Null when nothing in scope carries a level: the caller
   *  omits the whole readout rather than printing a dash, the same way the chart
   *  breaks its line instead of drawing a silent Sunday. */
  avgSpl: number | null;
  /** That level against the prior window, in dB. Null on the same terms
   *  `attTrend` is: not enough prior weekends to compare honestly. */
  splDelta: SplDelta | null;
}

/**
 * The metric to plot when nobody has chosen one.
 *
 * An LAeq-style key first: the trend line answers "how loud was the service",
 * and an equivalent-continuous A-weighted level is the number that means that.
 * A "SPL A"-style key is the fallback because it is what most Smaart setups
 * report; anything else only if the meter reports nothing more familiar.
 *
 * Case-insensitive and substring-matched, because Smaart names these itself and
 * the exact spelling varies ("LAeq 10", "LAeq10", "SPL A Slow").
 */
export function preferredSplMetric(keys: readonly string[]): string | null {
  return (
    keys.find((k) => /laeq/i.test(k)) ??
    keys.find((k) => /leq/i.test(k)) ??
    keys.find((k) => /spl\s*a/i.test(k)) ??
    keys[0] ??
    null
  );
}

/**
 * Every Overview figure, for a set of records scoped to a service type and date.
 *
 * `asOf` is the day the caller is looking at (History's selected day; today for
 * Home). `activeType`/`activeTypeName` scope to a service type, because the
 * figures have always been per-type even when the labels were not.
 */
export function computeOverview(
  list: ServiceTimeline[] | null,
  attList: ServiceAttendance[],
  day: string | null,
  activeType: string | null,
  activeTypeName: string | null,
  /**
   * The optional extras, as a bag rather than three more positional arguments.
   *
   * `now` sat sixth, so reaching the SPL parameters meant passing it — and the
   * only honest value at a call site is `Date.now()`, which inside a useMemo is
   * an impure call the lint rule rejects. Named, a caller passes what it has and
   * the clock keeps defaulting itself inside.
   */
  opts: { now?: number; splList?: readonly SplServiceSummary[]; splMetric?: string | null } = {},
): OverviewData {
  const now = opts.now ?? Date.now();
  const splList = opts.splList ?? [];
  const splMetric = opts.splMetric ?? null;
  const asOf = day;
  const tl = (list ?? []).filter((t) => inAverageScope(t, activeType, asOf));
  const att = attList.filter((a) => inTrendScope(a, activeType, asOf));
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const sums = tl.map((t) => ({ t, s: summarize(t, now) }));
  const lens = sums.filter((x) => x.s.actual > 0);
  const punct = sums.map((x) => x.s.lateStartSec).filter((v): v is number => v != null);
  const overruns = sums.map((x) => (x.s.planned != null ? x.s.actual - x.s.planned : null)).filter((v): v is number => v != null);
  // "Attendance" = peak people in the room (peakOccupancy).
  const occ = att.filter((a) => a.peakOccupancy > 0);
  const startFmt = (sec: number) => (sec >= 0 ? `${fmtDur(sec)} late` : `${fmtDur(-sec)} early`);
  const avgPunct = mean(punct);
  const avgOverrun = mean(overruns);

  // ── The SPL line ───────────────────────────────────────────────────────────
  // Scoped the same way the attendance points are, then folded to one level per
  // DATE so the two series share an x axis exactly. Several services on a Sunday
  // combine by energy, weighted by samples — the same rule that built each
  // service's own level, applied once more.
  const splInScope = splList.filter((r) => inTrendScope(r, activeType, asOf));
  const splMetrics = [...new Set(splInScope.flatMap((r) => Object.keys(r.metrics)))].sort();
  // The caller's choice only if it is really there. A metric saved into a layout
  // months ago can be one this meter no longer reports, and honouring it would
  // draw an empty line with no way to tell that from a quiet room.
  const chosenMetric =
    splMetric && splMetrics.includes(splMetric) ? splMetric : preferredSplMetric(splMetrics);
  const splByDate = new Map<string, { leq: number; count: number }[]>();
  // The same records, restricted to the ones `inAverageScope` calls settled —
  // SplServiceSummary carries its own endedAt now (main/types/history.ts), so
  // this reads whether THAT recording finished, never whether the occupancy
  // sensor saw anything for the date. Folded separately from splByDate above:
  // avgSpl/splDelta must not see a still-live record's climbing partial level,
  // but the CHART keeps drawing it — that coupling to attPoints stays, because
  // one point per weekend on a shared x axis is what the chart needs the
  // attendance points for in the first place.
  const splByDateSettled = new Map<string, { leq: number; count: number }[]>();
  if (chosenMetric) {
    for (const r of splInScope) {
      const m = r.metrics[chosenMetric];
      if (!m) continue;
      const arr = splByDate.get(r.serviceDate);
      if (arr) arr.push(m);
      else splByDate.set(r.serviceDate, [m]);
      if (inAverageScope(r, activeType, asOf)) {
        const settledArr = splByDateSettled.get(r.serviceDate);
        if (settledArr) settledArr.push(m);
        else splByDateSettled.set(r.serviceDate, [m]);
      }
    }
  }

  // One point per WEEKEND (service date): value = TOTAL attendance across that
  // day's services (the headline weekend number), with a per-service breakdown
  // for the tooltip. So 3 weekends of 2 services each read as 3 dots, not 6.
  const byDate = new Map<string, ServiceAttendance[]>();
  for (const a of [...occ].sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt))) {
    const arr = byDate.get(a.serviceDate);
    if (arr) arr.push(a);
    else byDate.set(a.serviceDate, [a]);
  }
  const attPoints: TrendPoint[] = [...byDate.keys()]
    .sort((x, y) => Date.parse(x) - Date.parse(y))
    .map((d) => {
      const svcs = byDate.get(d)!;
      return {
        day: d,
        value: svcs.reduce((s, a) => s + a.peakOccupancy, 0),
        parts: svcs.map((a) => ({ label: fmtTime(a.serviceTimeStartsAt ?? a.startedAt) || "service", value: a.peakOccupancy })),
        // A weekend is "live" while any of its services is still recording — its
        // total is a partial that will keep climbing.
        live: svcs.some((a) => a.endedAt == null),
        // Undefined when no metric is chosen at all, null when this date has no
        // reading for it. The chart tells those apart: no metric draws no line;
        // a gap breaks the line it is already drawing.
        spl: chosenMetric ? combineLeq(splByDate.get(d) ?? []) : undefined,
      };
    });
  // Stats are computed over SETTLED weekends only. A weekend still recording has
  // a partial total, so folding it in would understate the average, misreport the
  // peak, and fake a downward trend for the first half of the morning.
  const settledPoints = attPoints.filter((p) => !p.live);
  const settledSeries = settledPoints.map((p) => p.value);
  // The SPL series' OWN settled dates — NOT attPoints's. Coupling this to
  // attendance dropped a weekend Smaart recorded whenever the occupancy sensor
  // recorded nothing for it (offline, a genuine zero, or no SenSource at all):
  // a site with Smaart and no SenSource got no SPL summary whatsoever.
  // Chronological, so the last entry is genuinely the latest SETTLED weekend
  // carrying a level, not whichever date attPoints happened to end on.
  // ENERGY-averaged, one entry per WEEKEND — `mean()` above is exactly the
  // wrong helper for decibels (main/services/spl-leq.ts).
  const settledSplDates = [...splByDateSettled.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  const settledSpl = settledSplDates
    .map((d) => combineLeq(splByDateSettled.get(d)!))
    .filter((v): v is number => v != null);
  // Lead stat + peak are WEEKEND totals now, to stay coherent with the chart.
  const avgAttendance = mean(settledSeries);
  const peakWeekend = settledPoints.length ? settledPoints.reduce((m, p) => (p.value > m.value ? p : m)) : null;
  // Overrun series (chronological) for its own trend indicator.
  const overrunChron = [...sums]
    .sort((a, b) => Date.parse(a.t.startedAt) - Date.parse(b.t.startedAt))
    .map((x) => (x.s.planned != null ? x.s.actual - x.s.planned : null))
    .filter((v): v is number => v != null);

  // Attendance up = good; overrun up = bad.
  const attTrend = computeTrend(settledSeries, true);
  const overrunTrend = computeTrend(overrunChron, false);

  return {
    // Lead stat.
    avgAttendance: avgAttendance != null ? avgAttendance.toLocaleString() : "—",
    attTrend,
    attPoints,
    // Instrument strip.
    services: tl.length.toLocaleString(),
    avgLength: fmtDur(mean(lens.map((x) => x.s.actual))),
    avgStart: avgPunct != null ? startFmt(avgPunct) : "—",
    avgStartEarly: avgPunct != null && avgPunct < 0,
    avgStartLate: avgPunct != null && avgPunct > 60,
    avgOverrun: avgOverrun != null ? fmtDelta(avgOverrun) : "—",
    overrunTrend,
    peakAttendance: peakWeekend ? peakWeekend.value.toLocaleString() : "—",
    peakSub: peakWeekend ? shortDay(peakWeekend.day) : undefined,
    scopeName: activeTypeName,
    splMetrics,
    splMetric: chosenMetric,
    avgSpl: leqOf(settledSpl),
    splDelta: computeSplDelta(settledSpl),
  };
}

/**
 * The colour a trend's tone reads in.
 *
 * Here rather than in either consumer: service-history had it as a function and
 * Home's TrendArrow had the same mapping as three cn() conditionals, so "what
 * colour is a bad trend" had two answers in two files.
 */
export function trendColor(tone: TrendTone): string {
  return tone === "good" ? "text-ok-11" : tone === "bad" ? "text-warn-11" : "text-fg-subtle";
}
