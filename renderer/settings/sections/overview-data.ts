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
export interface TrendPoint { day: string; value: number; parts?: { label: string; value: number }[]; live?: boolean }

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
  now = Date.now(),
): OverviewData {
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
      };
    });
  // Stats are computed over SETTLED weekends only. A weekend still recording has
  // a partial total, so folding it in would understate the average, misreport the
  // peak, and fake a downward trend for the first half of the morning.
  const settledPoints = attPoints.filter((p) => !p.live);
  const settledSeries = settledPoints.map((p) => p.value);
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
