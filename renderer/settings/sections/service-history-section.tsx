import { useEffect, useMemo, useRef, useState } from "react";
import { linkBaptisms, baptismStats } from "../../lib/link-baptisms";
import { cn } from "../../lib/cn";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip } from "../../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { Trash2Icon, ClockIcon, CopyIcon, GitMergeIcon, DownloadIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows, Button, Collapsible, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { HistoryCalendar } from "../../components/history-calendar";
import { AttendanceDetail, servicePeakAttendance } from "./attendance-history-section";
import { SplDetail } from "./spl-history-section";
import { inTrendScope, inAverageScope } from "./overview-scope";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
/** Short local date label ("Jul 5") for a YYYY-MM-DD service date. */
function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One point on the attendance trend chart — a service occurrence with its peak
 *  in-room count and the day it happened (for the axis labels). */
interface TrendPoint { day: string; value: number; parts?: { label: string; value: number }[]; live?: boolean }

/** A trend indicator: which direction the latest value moved vs the mean of the
 *  prior window, and whether that direction is good or bad for THIS metric.
 *  `null` when there isn't enough prior data to judge honestly. */
type TrendTone = "good" | "bad" | "neutral";
interface Trend { dir: "up" | "down"; tone: TrendTone; pct: number | null; priorCount: number }

/**
 * Compare the latest value in a chronological series to the mean of the prior
 * window (everything before it, capped at `window`). Returns null when there's
 * no prior data — so we never fake a direction. `higherIsBetter` maps the raw
 * up/down direction onto good/bad for the metric (attendance up = good; overrun
 * up = bad). Values within `deadband` (fractional) of the prior mean read neutral.
 */
function computeTrend(series: number[], higherIsBetter: boolean, opts?: { window?: number; deadband?: number }): Trend | null {
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

/** Tailwind text color for a trend tone (semantic status tokens). */
function trendColor(tone: TrendTone): string {
  return tone === "good" ? "text-ok-11" : tone === "bad" ? "text-warn-11" : "text-fg-subtle";
}

/** Computed Overview blend data (lead stat + strip + chart series + trends). */
interface OverviewData {
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

/** ISO → local "HH:MM" for a <input type="time">, or "" if absent/invalid. */
function toTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** Local "HH:MM" on the record's service date → ISO, or undefined if blank/invalid. */
function fromTimeInput(serviceDate: string, hhmm: string): string | undefined {
  if (!hhmm) return undefined;
  const d = new Date(`${serviceDate}T${hhmm}:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Seconds → "m:ss" (or "h:mm:ss"). */
function fmtDur(sec: number | null): string {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}
/** Signed seconds → "+m:ss" / "−m:ss" (over/under planned). */
function fmtDelta(sec: number | null): string {
  if (sec == null) return "";
  const s = Math.round(sec);
  const sign = s > 0 ? "+" : s < 0 ? "−" : "±";
  const a = Math.abs(s);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** Trailing "Stream Buffer"-type padding items — post-service, often left running
 *  long, so they're excluded from all timing math (kept visible but not counted). */
function isBufferItem(title: string | null | undefined): boolean {
  return (title ?? "").toUpperCase().includes("BUFFER");
}

/** Pre-service items (Doors, Pre-roll, …). Prefers the recorder's position-based
 *  flag (above the SERVICE START header — robust to early/late/storm-delayed starts);
 *  falls back to "went live before the scheduled time" for records made before it. */
function isPreServiceItem(it: ServiceTimelineItem, rec: ServiceTimeline): boolean {
  if (typeof it.preService === "boolean") return it.preService;
  if (!rec.serviceTimeStartsAt || !it.startedAt) return false;
  const s = Date.parse(it.startedAt);
  const svc = Date.parse(rec.serviceTimeStartsAt);
  return Number.isFinite(s) && Number.isFinite(svc) && s < svc;
}

/** Whether an item counts toward the service timers. A per-item user override (the
 *  checkbox) wins; otherwise the auto default excludes buffer + pre-service items. */
function isCountedItem(it: ServiceTimelineItem, rec: ServiceTimeline): boolean {
  if (typeof it.counted === "boolean") return it.counted;
  return !isBufferItem(it.title) && !isPreServiceItem(it, rec);
}

/** Derived service-level timing from a record. */
function summarize(rec: ServiceTimeline, now = Date.now()) {
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

/** Mean per-item over/under (seconds) + how many ran over, for items with both
 *  planned and actual times. */
function overrunStats(tl: ServiceTimeline) {
  const deltas = tl.items
    .filter((it) => isCountedItem(it, tl) && it.plannedLengthSec != null && it.actualDurationSec != null)
    .map((it) => (it.actualDurationSec as number) - (it.plannedLengthSec as number));
  if (!deltas.length) return { avg: null as number | null, over: 0, total: 0 };
  return { avg: deltas.reduce((a, b) => a + b, 0) / deltas.length, over: deltas.filter((d) => d > 0).length, total: deltas.length };
}

/** Baptism sessions that overlap a service's recorded window. */
/** A plain-text service report combining timing + attendance + audio + baptisms (shareable). */
function buildReport(tl: ServiceTimeline, att: ServiceAttendance | null, spl: ServiceSplHistory | null, baptisms: BaptismSession[] = []): string {
  const sum = summarize(tl);
  const o = overrunStats(tl);
  const L: string[] = [];
  L.push(tl.planTitle ?? tl.serviceKey);
  const meta = [tl.seriesTitle, fmtDate(tl.startedAt), fmtTime(tl.serviceTimeStartsAt ?? tl.startedAt)].filter(Boolean).join(" · ");
  if (meta) L.push(meta);
  L.push("", "TIMING");
  L.push(`Started ${fmtTime(sum.firstStart)}${sum.lateStartSec != null ? ` (${fmtDelta(sum.lateStartSec)} ${sum.lateStartSec >= 0 ? "late" : "early"})` : ""}`);
  L.push(`Planned ${fmtDur(sum.planned)} · Actual ${fmtDur(sum.actual)}${sum.planned != null ? ` (${fmtDelta(sum.actual - sum.planned)})` : ""}`);
  if (o.avg != null) L.push(`Avg item overrun ${fmtDelta(o.avg)} (${o.over} of ${o.total} over)`);
  L.push("", "RUNDOWN");
  tl.items.forEach((it, i) => {
    const d = it.plannedLengthSec != null && it.actualDurationSec != null ? (it.actualDurationSec as number) - (it.plannedLengthSec as number) : null;
    L.push(`${i + 1}. ${it.title || "—"}  plan ${fmtDur(it.plannedLengthSec)}  actual ${it.endedAt == null ? "(live)" : fmtDur(it.actualDurationSec)}${d != null ? `  ${fmtDelta(d)}` : ""}`);
  });
  if (att) {
    const avgOcc = att.samples.length ? Math.round(att.samples.reduce((s, p) => s + p.occupancy, 0) / att.samples.length) : null;
    L.push("", "ATTENDANCE");
    L.push(`Peak attendance ${servicePeakAttendance(att).toLocaleString()} · Peak in-room ${att.peakOccupancy.toLocaleString()}${avgOcc != null ? ` · Avg in-room ${avgOcc.toLocaleString()}` : ""}`);
  }
  if (spl && spl.items.length) {
    L.push("", "AUDIO — peak SPL (dB)");
    spl.items.forEach((it, i) => {
      if (it.maxSpl != null) L.push(`${i + 1}. ${it.title || "—"}  ${it.maxSpl.toFixed(1)}`);
    });
  }
  if (baptisms.length) {
    // The same figures the section shows, so a pasted report and the screen agree.
    const t = baptismStats(baptisms);
    L.push("", "BAPTISMS");
    L.push(`${t.people} baptized · total ${fmtDur(t.totalSec)}`);
    L.push(`testimony ${fmtDur(t.testimonySec)} (avg ${fmtDur(t.avgTestimonySec)})`);
    L.push(`baptism ${fmtDur(t.baptismSec)} (avg ${fmtDur(t.avgBaptismSec)})`);
  }
  return L.join("\n");
}

/**
 * Service history — the ACTUAL recorded rundown for past services: when each item
 * went live and how long it ran vs its planned length, plus whether the service
 * started late and total over/under. One record per PCO service-time occurrence
 * (same scheme as SPL History / Attendance), grouped by day.
 */
const EXPORT_SHEETS: { id: string; label: string; hint: string }[] = [
  { id: "services", label: "Services summary", hint: "one row per service" },
  { id: "attendance", label: "Attendance polls", hint: "every poll sample" },
  { id: "items", label: "PCO item timings", hint: "planned vs actual per item" },
  { id: "spl", label: "SPL", hint: "max + Leq per item; a second sheet for pivots" },
  { id: "baptisms", label: "Baptisms", hint: "testimony + baptism splits, per person" },
];

export function ServiceHistorySection({ readOnly = false }: { readOnly?: boolean } = {}) {
  const [list, setList] = useState<ServiceTimeline[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceTimeline | null>(null);
  // The matching attendance + SPL records (same serviceKey) for the combined report.
  const [attendance, setAttendance] = useState<ServiceAttendance | null>(null);
  const [spl, setSpl] = useState<ServiceSplHistory | null>(null);
  // Baptism sessions (cross-linked to a service by time overlap).
  const [baptisms, setBaptisms] = useState<BaptismSession[]>([]);
  // Attendance records for all services — for the Overview card's avg in-room.
  const [attList, setAttList] = useState<ServiceAttendance[]>([]);
  const [day, setDay] = useState<string | null>(null);
  // Editing the service window (times) in the detail view.
  const [editingTimes, setEditingTimes] = useState(false);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // Export builder: date range + which sheets. None checked by default — the user
  // picks what they want. Read-only, so it's available on the public /history page too.
  const [expFrom, setExpFrom] = useState("");
  const [expTo, setExpTo] = useState("");
  const [expSheets, setExpSheets] = useState<Set<string>>(new Set());
  function toggleSheet(id: string) {
    setExpSheets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function downloadExport() {
    const params = new URLSearchParams();
    if (expFrom) params.set("from", expFrom);
    if (expTo) params.set("to", expTo);
    params.set("include", [...expSheets].join(","));
    window.location.assign(`/api/history/export?${params.toString()}`);
  }

  function reload() {
    invoke<ServiceTimeline[]>("serviceTimeline:list")
      .then((l) => setList(l))
      .catch(() => setList([]));
  }
  useEffect(() => {
    reload();
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((a) => setAttList(a ?? []))
      .catch(() => setAttList([]));
  }, []);

  // Live updates while a service is recording — refresh the open detail/list, the
  // attendance chart (samples), and SPL, all without a page reload.
  useEffect(() => {
    const offTl = onNotification("service-timeline:history", (p) => {
      const rec = p as ServiceTimeline | null;
      if (!rec) return;
      setList((prev) => {
        if (!prev) return prev;
        const i = prev.findIndex((s) => s.serviceKey === rec.serviceKey);
        if (i === -1) return [rec, ...prev];
        const next = prev.slice();
        next[i] = rec;
        return next;
      });
      setDetail((d) => (d && d.serviceKey === rec.serviceKey ? rec : d));
    });
    const offAtt = onNotification("attendance:history", (p) => {
      const rec = p as ServiceAttendance | null;
      if (!rec) return;
      setAttList((prev) => {
        const i = prev.findIndex((a) => a.serviceKey === rec.serviceKey);
        if (i === -1) return [rec, ...prev];
        const next = prev.slice();
        next[i] = rec;
        return next;
      });
      setAttendance((a) => (a && a.serviceKey === rec.serviceKey ? rec : a));
    });
    const offSpl = onNotification("spl:history", (p) => {
      const rec = p as ServiceSplHistory | null;
      if (!rec) return;
      setSpl((s) => (s && s.serviceKey === rec.serviceKey ? rec : s));
    });
    return () => { offTl(); offAtt(); offSpl(); };
  }, []);

  // While a service is still recording — the open detail OR any row in the day
  // list — tick every second so the live "Actual"/"running" durations count up
  // between attendance/timeline broadcasts. (The Overview trend includes the
  // recording service; its computed stats stay over finished ones.)
  const detailLive = detail != null && detail.endedAt == null;
  const listLive = (list ?? []).some((t) => t.endedAt == null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!detailLive && !listLive) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [detailLive, listLive]);

  // Synchronous, so the panel clears in the same render the selection does —
  // it never shows the previous service's numbers under an empty selection.
  useResyncOn([selectedKey], () => {
    if (!selectedKey) {
      setDetail(null);
      setAttendance(null);
      setSpl(null);
    }
  });

  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    invoke<ServiceTimeline | null>("serviceTimeline:get", { serviceKey: selectedKey })
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null));
    // Best-effort: pull the matching attendance + SPL records for the full report.
    invoke<ServiceAttendance | null>("attendance:getHistory", { serviceKey: selectedKey })
      .then((a) => !cancelled && setAttendance(a))
      .catch(() => !cancelled && setAttendance(null));
    invoke<ServiceSplHistory | null>("spl:getHistory", { serviceKey: selectedKey })
      .then((s) => !cancelled && setSpl(s))
      .catch(() => !cancelled && setSpl(null));
    // Baptism sessions are cross-linked to the service by time overlap.
    invoke<BaptismSession[]>("baptism:sessions")
      .then((b) => !cancelled && setBaptisms(b))
      .catch(() => !cancelled && setBaptisms([]));
    return () => {
      cancelled = true;
    };
  }, [selectedKey, reloadKey]);

  // The service type the overview reflects — derived, not user-picked. It follows
  // whatever you've selected (a drilled-in service, else the selected calendar
  // day's service), and defaults to the most recent service's type (list is sorted
  // newest-first; `day` auto-selects the newest day, so this lands on "most recent"
  // out of the box). Keeps each type's averages separate without a manual filter.
  const activeType = useMemo<string | null>(() => {
    if (selectedKey) {
      const s = (list ?? []).find((x) => x.serviceKey === selectedKey);
      if (s) return s.serviceTypeId;
    }
    if (day) {
      const s = (list ?? []).find((x) => x.serviceDate === day);
      if (s) return s.serviceTypeId;
    }
    return (list ?? [])[0]?.serviceTypeId ?? null;
  }, [selectedKey, day, list]);
  const activeTypeName = useMemo<string | null>(() => {
    if (!activeType) return null;
    const s = (list ?? []).find((x) => x.serviceTypeId === activeType);
    return s?.serviceTypeName ?? activeType;
  }, [list, activeType]);

  // All services — the calendar and day list stay global so you can navigate to any
  // service; only the overview scopes to activeType (below).
  const filtered = useMemo(() => list ?? [], [list]);

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const s of filtered) set.add(s.serviceDate);
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [filtered]);

  // Auto-select the newest day; also re-select when the filter drops the current day.
  useResyncOn([days, day], () => {
    if (days.length > 0 && (day == null || !days.includes(day))) setDay(days[0]);
  });

  const dayServices = useMemo(() => filtered.filter((s) => s.serviceDate === day), [filtered, day]);
  // Per-day service counts for the calendar (respects the type filter).
  const dateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of filtered) m.set(s.serviceDate, (m.get(s.serviceDate) ?? 0) + 1);
    return m;
  }, [filtered]);

  // Per-day attendance intensity (0..1) for the calendar heatmap: a day's peak
  // in-room count, normalized to the busiest recorded day. Global (all types) — the
  // calendar is a stable navigation surface; the overview does the type scoping.
  const dateIntensity = useMemo(() => {
    const peak = new Map<string, number>();
    for (const a of attList) {
      if (a.peakOccupancy <= 0) continue;
      peak.set(a.serviceDate, Math.max(peak.get(a.serviceDate) ?? 0, a.peakOccupancy));
    }
    const max = Math.max(0, ...peak.values());
    const m = new Map<string, number>();
    if (max > 0) for (const [d, v] of peak) m.set(d, v / max);
    return m;
  }, [attList]);

  // Small summary shown beneath the calendar for the selected day: how many
  // services + their average peak in-room (scoped to the active type filter).
  const daySummary = useMemo(() => {
    if (!day) return null;
    const count = dayServices.length;
    const occ = attList.filter((a) => a.serviceDate === day && a.peakOccupancy > 0);
    const avg = occ.length ? Math.round(occ.reduce((s, a) => s + a.peakOccupancy, 0) / occ.length) : null;
    return { count, avg };
  }, [day, dayServices, attList]);

  // Overview stats, cumulative THROUGH the selected day (serviceDate <= day) so
  // picking a past date shows how things looked as of then; scoped to the type
  // filter so a Youth service's numbers don't blend into Sunday's.
  // Produces the blend's lead stat, the instrument strip, and the attendance
  // trend chart series — plus honest trend indicators (latest vs prior window).
  //
  // The chart INCLUDES the service recording right now (its point climbs through
  // the morning); every computed stat — average, peak, trend direction — is taken
  // over finished services only, so a partial peak can't drag the headline number
  // down and then "recover" by noon. See overview-scope.ts.
  const overview = useMemo<OverviewData>(() => {
    const asOf = day;
    const tl = (list ?? []).filter((t) => inAverageScope(t, activeType, asOf));
    const att = attList.filter((a) => inTrendScope(a, activeType, asOf));
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const sums = tl.map((t) => ({ t, s: summarize(t) }));
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
  }, [list, attList, day, activeType, activeTypeName]);

  async function deleteService(key: string, title: string) {
    if (!(await confirm({ title: "Delete recording?", message: `Delete the service-timing recording for "${title}"? This can't be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    setList((prev) => (prev ? prev.filter((s) => s.serviceKey !== key) : prev));
    if (selectedKey === key) setSelectedKey(null);
    try {
      await invoke("serviceTimeline:delete", { serviceKey: key });
    } catch {
      reload();
    }
  }

  if (list === null) {
    return (
      <div className="py-6">
        <SkeletonRows rows={5} />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={<ClockIcon />}
          title="No service timings recorded yet"
          hint="Item timings are captured automatically while a service runs in Planning Center Live — when each item goes live and how long it runs versus its planned length."
        />
      </div>
    );
  }

  // ── Detail: one service's actual rundown. ──
  if (detail) {
    const live = detail.endedAt == null;
    const sum = summarize(detail, live ? nowTick : undefined);
    const totalDelta = sum.planned != null ? sum.actual - sum.planned : null;
    const over = overrunStats(detail);
    // Projected end = actual start + planned length; actual end = the record's
    // finalized end (else the last item that closed). Shown as card subscripts.
    const firstStartMs = Date.parse(sum.firstStart);
    const projectedEnd =
      sum.planned != null && Number.isFinite(firstStartMs)
        ? new Date(firstStartMs + sum.planned * 1000).toISOString()
        : null;
    // Actual end = the last COUNTED item's end (excludes trailing buffer / pre-service).
    const actualEnd = [...detail.items].reverse().find((it) => isCountedItem(it, detail) && it.endedAt)?.endedAt ?? detail.endedAt ?? null;
    const actualSub = [
      totalDelta != null ? `${fmtDelta(totalDelta)} vs plan` : null,
      actualEnd ? `ended ${fmtTime(actualEnd)}` : null,
    ].filter(Boolean).join(" · ") || undefined;
    const det = detail; // narrow for the async handler
    const linkedBap = linkBaptisms(baptisms, detail);
    const bapStats = baptismStats(linkedBap);
    async function copyReport() {
      const ok = await copyText(buildReport(det, attendance, spl, linkedBap));
      if (ok) toast.success("Report copied to clipboard");
      else toast.error("Couldn't copy the report");
    }
    function startEditTimes() {
      setEditStart(toTimeInput(det.startedAt));
      setEditEnd(toTimeInput(det.endedAt));
      setEditingTimes(true);
    }
    async function saveTimes() {
      try {
        await invoke("history:editWindow", {
          serviceKey: det.serviceKey,
          startedAt: fromTimeInput(det.serviceDate, editStart),
          endedAt: fromTimeInput(det.serviceDate, editEnd),
        });
        setEditingTimes(false);
        setReloadKey((k) => k + 1);
        toast.success("Service times updated");
      } catch (e) {
        toast.error(`Couldn't update times: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    async function recalc() {
      try {
        await invoke("history:recalcAttendance", { serviceKey: det.serviceKey });
        setReloadKey((k) => k + 1);
        toast.success("Attendance recalculated");
      } catch {
        toast.error("Recalculate failed");
      }
    }
    // Other same-day recordings this one could merge into (fix a mis-split service).
    const mergeCandidates = (list ?? []).filter((s) => s.serviceKey !== det.serviceKey && s.serviceDate === det.serviceDate);
    async function doMerge() {
      const tgt = mergeCandidates.find((s) => s.serviceKey === mergeTarget);
      if (!tgt) return;
      if (!(await confirm({
        title: `Merge into "${tgt.planTitle ?? "the selected service"}"?`,
        message: "This recording's items + attendance samples move into the selected service (matching items aren't duplicated), then THIS record is deleted. Use to reunite a service that was split across two records.",
        confirmLabel: "Merge + delete this",
        destructive: true,
      }))) return;
      try {
        await invoke("history:merge", { sourceKey: det.serviceKey, targetKey: mergeTarget });
        setMerging(false);
        setMergeTarget("");
        setSelectedKey(mergeTarget); // jump to the record we merged into
        reload(); // drop the now-deleted source from the list (avoid a dead row)
        setReloadKey((k) => k + 1);
        toast.success("Merged");
      } catch (e) {
        toast.error(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    async function toggleCounted(item: ServiceTimelineItem) {
      // Broadcasts service-timeline:history → detail refreshes via the SSE handler.
      try {
        await invoke("history:setItemCounted", { serviceKey: det.serviceKey, itemId: item.itemId, counted: !isCountedItem(item, det) });
      } catch {
        toast.error("Couldn't update");
      }
    }
    // The include/exclude checkbox column only shows while editing times.
    // Mobile drops #, Plan, and Ended (see the max-sm:hidden cells) so the item name
    // isn't crushed; sm+ shows the full grid. Templates must match the visible cells.
    const gridCols = editingTimes
      ? "grid-cols-[1.4rem_1fr_3.5rem_3rem] sm:grid-cols-[1.4rem_1.6rem_1fr_4rem_4rem_4rem_4.5rem]"
      : "grid-cols-[1fr_3.5rem_3rem] sm:grid-cols-[1.6rem_1fr_4rem_4rem_4rem_4.5rem]";
    return (
      <div className="flex flex-col gap-4">
        <button className="self-start text-caption1 text-accent hover:underline" onClick={() => setSelectedKey(null)}>
          ← All services
        </button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col min-w-0">
            <span className="text-title3 font-semibold text-gray-12">
              {detail.planTitle ?? detail.serviceKey}
              {live && <span className="ml-2 align-middle rounded-full bg-red-9 px-2 py-0.5 text-[10px] font-semibold text-white">LIVE</span>}
            </span>
            <span className="text-caption1 text-gray-9">
              {detail.seriesTitle ? `${detail.seriesTitle} · ` : ""}
              {fmtDate(detail.startedAt)}
              {fmtTime(detail.serviceTimeStartsAt ?? detail.startedAt) ? ` · ${fmtTime(detail.serviceTimeStartsAt ?? detail.startedAt)}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap sm:shrink-0">
            {!readOnly && (
              <Button variant="filled" size="small" onClick={startEditTimes} tooltip="Fix the recorded start/end (trims samples + items outside the window)">
                <ClockIcon className="size-3.5 text-gray-9" /> Edit times
              </Button>
            )}
            <Button variant="filled" size="small" onClick={copyReport} tooltip="Copy a full text report (timing + attendance + audio)">
              <CopyIcon className="size-3.5 text-gray-9" /> Copy report
            </Button>
            {!readOnly && mergeCandidates.length > 0 && (
              <Button variant="filled" size="small" onClick={() => { setMerging((v) => !v); setEditingTimes(false); }} tooltip="Merge this recording into another service (fixes a split service), then delete this one">
                <GitMergeIcon className="size-3.5 text-gray-9" /> Merge…
              </Button>
            )}
          </div>
        </div>
        {merging && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-amber-6 bg-amber-2/40 p-3">
            <label className="flex flex-col gap-1 text-caption2 text-gray-9">
              Merge this recording into
              <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} className="rounded-md border border-gray-5 bg-gray-1 px-2 py-1 text-caption1 text-gray-12">
                <option value="">Select a service…</option>
                {mergeCandidates.map((s) => (
                  <option key={s.serviceKey} value={s.serviceKey}>
                    {(s.planTitle ?? s.serviceKey)}{fmtTime(s.serviceTimeStartsAt ?? s.startedAt) ? ` · ${fmtTime(s.serviceTimeStartsAt ?? s.startedAt)}` : ""} · {s.items.length} items
                  </option>
                ))}
              </select>
            </label>
            <Button variant="accent" size="small" disabled={!mergeTarget} onClick={doMerge}>Merge + delete this</Button>
            <Button variant="transparent" size="small" onClick={() => setMerging(false)}>Cancel</Button>
            <span className="text-caption2 text-gray-9 flex-1 min-w-[14rem]">
              Moves this recording's items + attendance samples into the chosen service (matching items aren't duplicated), then deletes this record. For reuniting a service split across two records (e.g. one that overran into the next occurrence).
            </span>
          </div>
        )}
        {editingTimes && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-5 bg-gray-2 p-3">
            <label className="flex flex-col gap-1 text-caption2 text-gray-9">
              Start
              <input type="time" value={editStart} onChange={(e) => setEditStart(e.target.value)} className="rounded-md border border-gray-5 bg-gray-1 px-2 py-1 text-caption1 text-gray-12" />
            </label>
            <label className="flex flex-col gap-1 text-caption2 text-gray-9">
              End
              <input type="time" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} className="rounded-md border border-gray-5 bg-gray-1 px-2 py-1 text-caption1 text-gray-12" />
            </label>
            <Button variant="accent" size="small" onClick={saveTimes}>Save</Button>
            <Button variant="transparent" size="small" onClick={() => setEditingTimes(false)}>Cancel</Button>
            <Button variant="transparent" size="small" onClick={recalc} tooltip="Re-derive peak/min from samples without changing the window">Recalculate</Button>
            <span className="text-caption2 text-gray-9 flex-1 min-w-[14rem]">
              Trims attendance samples + SPL/timing items outside the window and recomputes peak, min, and durations. Applies to all three records for this service.
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Started" value={fmtTime(sum.firstStart)} accent={sum.lateStartSec != null && sum.lateStartSec > 60 ? "text-amber-11" : "text-gray-12"} sub={sum.lateStartSec != null ? (sum.lateStartSec >= 0 ? `${fmtDelta(sum.lateStartSec)} late` : `${fmtDelta(sum.lateStartSec)} early`) : undefined} />
          <Stat label="Planned" value={fmtDur(sum.planned)} accent="text-gray-12" sub={projectedEnd ? `ends ${fmtTime(projectedEnd)}` : undefined} />
          <Stat label="Actual" value={fmtDur(sum.actual)} accent="text-accent" sub={actualSub} />
          <Stat label="Avg overrun" value={over.avg != null ? fmtDelta(over.avg) : "—"} accent={over.avg != null && over.avg > 0 ? "text-red-11" : "text-gray-12"} sub={over.total ? `${over.over} of ${over.total} over` : undefined} />
        </div>

        <div className="flex flex-col rounded-lg border border-gray-5 overflow-hidden">
          <div className={`grid ${gridCols} gap-2 px-3 py-1.5 bg-gray-3 text-caption2 font-medium text-gray-10`}>
            {editingTimes && (
              <Tooltip label="Whether this item counts toward the service timers">
                <span className="text-center">✓</span>
              </Tooltip>
            )}
            <span className="max-sm:hidden">#</span><span>Item</span><span className="text-right max-sm:hidden">Plan</span><span className="text-right">Actual</span><span className="text-right">Δ</span><span className="text-right max-sm:hidden">Ended</span>
          </div>
          {detail.items.map((it, i) => {
            const itemLive = it.endedAt == null;
            const counted = isCountedItem(it, detail); // buffer + pre-service shown but not totaled
            const delta = it.plannedLengthSec != null && it.actualDurationSec != null ? it.actualDurationSec - it.plannedLengthSec : null;
            const deltaColor = delta == null ? "text-gray-9" : delta > 30 ? "text-red-11" : delta < -30 ? "text-blue-11" : "text-gray-11";
            return (
              <div key={it.itemId} className={`grid ${gridCols} gap-2 px-3 py-1.5 text-caption1 tabular-nums items-center ${i % 2 ? "bg-gray-2" : "bg-gray-1"} ${counted ? "" : "opacity-55"}`}>
                {editingTimes && (
                  <Tooltip
                    label={counted ? "Counted in the service timers — click to exclude" : "Excluded from the service timers — click to include"}
                  >
                    <Checkbox
                      checked={counted}
                      onCheckedChange={() => toggleCounted(it)}
                      className="justify-self-center"
                      aria-label={counted ? "Counted in the service timers" : "Excluded from the service timers"}
                    />
                  </Tooltip>
                )}
                <span className="text-gray-9 max-sm:hidden">{i + 1}</span>
                <span className="text-gray-12 truncate">
                  {it.title || "—"}
                  {itemLive && <span className="ml-1.5 text-[10px] text-red-11">live</span>}
                  {!counted && <span className="ml-1.5 text-[10px] italic text-gray-9">not counted</span>}
                </span>
                <span className="text-right text-gray-10 max-sm:hidden">{counted ? fmtDur(it.plannedLengthSec) : "—"}</span>
                <span className="text-right text-gray-12">{itemLive ? "—" : fmtDur(it.actualDurationSec)}</span>
                <span className={`text-right ${deltaColor}`}>{!counted || itemLive ? "" : fmtDelta(delta)}</span>
                <span className="text-right text-gray-9 whitespace-nowrap max-sm:hidden">{it.endedAt ? fmtTime(it.endedAt) : "—"}</span>
              </div>
            );
          })}
        </div>

        {/* Baptism timings sit with the rundown above rather than after the audio:
            they are timing data, and on a baptism weekend they explain the overrun
            in the table right above them. Only rendered when a session links, so a
            normal service is unchanged. */}
        {linkedBap.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-gray-4 pt-4">
            <span className="text-body font-semibold text-gray-12">Baptisms</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Baptized" value={String(bapStats.people)} accent="text-gray-12" />
              <Stat label="Total time" value={fmtDur(bapStats.totalSec)} accent="text-accent" />
              <Stat label="Testimony total" value={fmtDur(bapStats.testimonySec)} accent="text-gray-12" />
              <Stat label="Baptism total" value={fmtDur(bapStats.baptismSec)} accent="text-gray-12" />
              <Stat label="Avg testimony" value={fmtDur(bapStats.avgTestimonySec)} accent="text-gray-12" />
              <Stat label="Avg baptism" value={fmtDur(bapStats.avgBaptismSec)} accent="text-gray-12" />
            </div>
            <span className="text-caption2 text-gray-9">Per-person splits are in the Baptisms tab.</span>
          </div>
        )}

        {/* Full attendance + audio detail for the same service occurrence — one place
            for everything about this service (rundown above, the rest folded in here). */}
        <div className="flex flex-col gap-2 border-t border-gray-4 pt-4">
          <span className="text-body font-semibold text-gray-12">Attendance</span>
          {attendance ? (
            <AttendanceDetail detail={attendance} timeline={detail} />
          ) : (
            <p className="text-caption1 text-gray-9">No attendance recorded for this service.</p>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-gray-4 pt-4">
          <span className="text-body font-semibold text-gray-12">Audio (SPL)</span>
          {spl ? (
            <SplDetail detail={spl} />
          ) : (
            <p className="text-caption1 text-gray-9">No SPL recorded for this service.</p>
          )}
        </div>
      </div>
    );
  }

  // ── List view: services for the selected day. ──
  return (
    <div className="flex flex-col gap-3">
      {/* Export builder — a collapsed disclosure so it never crowds the overview.
          Read-only, so it's available on the public /history page too. */}
      <Collapsible label="Export" summary="date range · pick sheets" className="su-card px-4 py-2.5">
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
              From
              <input
                type="date"
                value={expFrom}
                onChange={(e) => setExpFrom(e.target.value)}
                className="rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg"
              />
            </label>
            <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
              To
              <input
                type="date"
                value={expTo}
                onChange={(e) => setExpTo(e.target.value)}
                className="rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg"
              />
            </label>
            <span className="self-end pb-1.5 text-caption2 text-fg-subtle">Blank = all dates.</span>
          </div>
          {/* Each option is a whole selectable row rather than a bare control in a
              column: the hint sits under its label instead of trailing off it, and
              the target is big enough to hit on a tablet next to a console. */}
          <div className="flex flex-col gap-1">
            {EXPORT_SHEETS.map((s) => {
              const on = expSheets.has(s.id);
              return (
                <label
                  key={s.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                    on ? "border-accent/40 bg-accent/8" : "border-transparent hover:bg-fill",
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={() => toggleSheet(s.id)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-footnote text-fg">{s.label}</span>
                    <span className="block text-caption2 text-fg-subtle">{s.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div>
            <Button variant="accent" size="small" disabled={expSheets.size === 0} onClick={downloadExport}>
              <DownloadIcon className="size-3.5" /> Download .xlsx
            </Button>
          </div>
        </div>
      </Collapsible>
      {/* Overview blend — full width. Lead stat + real trend chart, then a divided
          instrument strip. Scoped to the active service type (from the selection /
          most-recent), labeled so the numbers are never a silent blend of types. */}
      <div className="flex flex-col gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
          Overview{activeTypeName ? ` · ${activeTypeName}` : ""}{day ? ` · through ${fmtDay(day)}` : " · all time"}
        </span>
        <OverviewBlend overview={overview} />
      </div>

      {/* Calendar (sticky) + selected-day detail. */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[320px_1fr] sm:items-start">
        <div className="sm:sticky sm:top-0 flex flex-col gap-3">
          <HistoryCalendar counts={dateCounts} intensity={dateIntensity} selected={day} onPick={setDay} />
          {day && daySummary && (
            <div className="su-card px-4 py-3 text-caption1 text-fg-muted">
              Selected: <span className="font-mono tabular-nums text-fg">{shortDay(day)}</span>
              {" · "}
              <span className="font-mono tabular-nums text-fg">{daySummary.count}</span>
              {` service${daySummary.count === 1 ? "" : "s"}`}
              {daySummary.avg != null && (
                <>
                  {" · "}
                  <span className="font-mono tabular-nums text-fg">{daySummary.avg.toLocaleString()}</span>
                  {" avg"}
                </>
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 flex flex-col gap-2">
          {day && <span className="text-body font-semibold text-gray-12">{fmtDay(day)}</span>}
          {dayServices.map((s) => {
            const live = s.endedAt == null;
            // Live rows count up (summarize adds the in-progress item's elapsed);
            // finished rows show the settled total.
            const sum = summarize(s, live ? nowTick : undefined);
            const totalDelta = sum.planned != null ? sum.actual - sum.planned : null;
            return (
              <div key={s.serviceKey} className="flex items-center gap-1 rounded-lg border border-gray-5 bg-gray-2 pr-1.5 hover:bg-gray-3 transition-colors">
                <button className="flex flex-1 min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={() => setSelectedKey(s.serviceKey)}>
                  <div className="flex flex-col min-w-0">
                    <span className="text-body font-medium text-gray-12 truncate">{s.planTitle ?? s.serviceKey}</span>
                    <span className="text-caption2 text-gray-9 truncate">
                      {fmtTime(s.serviceTimeStartsAt ?? s.startedAt) ? `${fmtTime(s.serviceTimeStartsAt ?? s.startedAt)} · ` : ""}
                      {s.endedAt == null ? "recording…" : `${s.items.length} items`}
                    </span>
                  </div>
                  <span className="shrink-0 tabular-nums text-caption1 text-right">
                    {sum.lateStartSec != null && sum.lateStartSec >= 30 && <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">late </span><span className="text-amber-11">{fmtDelta(sum.lateStartSec)}</span></span>}
                    <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">{live ? "running " : "ran "}</span><span className="text-accent">{fmtDur(sum.actual)}</span></span>
                    {/* Delta vs plan only once finished — a live "−38:45" (most of
                        the plan not yet run) reads as misleading. */}
                    {!live && totalDelta != null && <span className="ml-3 whitespace-nowrap"><span className={totalDelta > 0 ? "text-red-11" : "text-gray-11"}>{fmtDelta(totalDelta)}</span></span>}
                  </span>
                </button>
                {!readOnly && (
                  <Tooltip label="Delete recording">
                    <button
                      className="shrink-0 rounded-md p-2 text-gray-9 hover:bg-gray-4 hover:text-red-11 transition-colors"
                      onClick={() => deleteService(s.serviceKey, s.planTitle ?? s.serviceKey)}
                      aria-label={`Delete recording for ${s.planTitle ?? "service"}`}
                    >
                      <Trash2Icon className="size-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
            );
          })}
          {dayServices.length === 0 && <p className="text-caption1 text-gray-9">No services on this day.</p>}
        </div>
      </div>
    </div>
  );
}

/** Real triangle glyph (▲/▼) trend indicator + optional label, in a semantic
 *  status color. Renders nothing when there wasn't enough prior data. */
function TrendChip({ trend, label }: { trend: Trend | null; label?: string }) {
  if (!trend) return null;
  const glyph = trend.dir === "up" ? "▲" : "▼";
  const text =
    label != null
      ? label
      : trend.pct != null
        ? `${trend.pct >= 0 ? "+" : "−"}${Math.round(Math.abs(trend.pct) * 100)}%`
        : "";
  return (
    <span className={`inline-flex items-center gap-1 text-caption1 ${trendColor(trend.tone)}`}>
      <span aria-hidden="true">{glyph}</span>
      {text && <span>{text}</span>}
    </span>
  );
}

/** The Overview blend: a lead stat (avg attendance) with a colored trend line, a
 *  real attendance trend chart, and a divided instrument stat strip below. */
function OverviewBlend({ overview }: { overview: OverviewData }) {
  const strip: { k: string; v: string; accent?: string; trend?: Trend | null; trendLabel?: string }[] = [
    { k: "Services", v: overview.services },
    { k: "Avg length", v: overview.avgLength },
    { k: "Avg start", v: overview.avgStart, accent: overview.avgStartEarly ? "text-ok-11" : overview.avgStartLate ? "text-warn-11" : undefined },
    { k: "Avg overrun", v: overview.avgOverrun, trend: overview.overrunTrend, trendLabel: overview.overrunTrend ? (overview.overrunTrend.tone === "bad" ? "worse" : overview.overrunTrend.tone === "good" ? "better" : "steady") : undefined },
    { k: "Peak attendance", v: overview.peakAttendance },
  ];
  return (
    <div className="su-card px-5 py-5 flex flex-col">
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between md:gap-8">
        <div className="shrink-0">
          <div className="text-caption1 uppercase tracking-[0.08em] text-fg-muted">
            Avg {overview.scopeName ?? "service"}
          </div>
          <div className="mt-1 font-mono tabular-nums text-[2.5rem] leading-none font-medium text-fg tracking-tight">
            {overview.avgAttendance}
          </div>
          {overview.attTrend && (
            <div className={`mt-2 flex items-center gap-1.5 text-caption1 ${trendColor(overview.attTrend.tone)}`}>
              <span aria-hidden="true">{overview.attTrend.dir === "up" ? "▲" : "▼"}</span>
              <span>
                {overview.attTrend.pct != null
                  ? `${overview.attTrend.pct >= 0 ? "+" : "−"}${Math.round(Math.abs(overview.attTrend.pct) * 100)}%`
                  : "changed"}{" "}
                vs the prior {overview.attTrend.priorCount}{" "}
                {overview.scopeName ?? "service"}
                {overview.attTrend.priorCount === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 md:max-w-[640px]">
          <AttendanceTrendChart points={overview.attPoints} />
        </div>
      </div>
      {/* Wrapping grid so the readouts never collide: 2 cols on mobile, 3 at sm,
          all at lg. Value + trend can wrap within a cell rather than overrun. */}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-5">
        {strip.map((s) => (
          <div key={s.k} className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">{s.k}</div>
            <div className={`mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-mono tabular-nums text-lg ${s.accent ?? "text-fg"}`}>
              <span>{s.v}</span>
              {s.trend && <TrendChip trend={s.trend} label={s.trendLabel} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Real attendance trend chart (SVG): a baseline, the per-service polyline, the
 *  latest point marked, and first/last date labels. The hero of the blend — not
 *  decorative. Falls back to a quiet note when there isn't enough to plot. */
function AttendanceTrendChart({ points }: { points: TrendPoint[] }) {
  const W = 640;
  const H = 130;
  const padTop = 16;
  const padBottom = 26;
  const padX = 10;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <div className="flex h-[130px] items-center justify-center text-caption1 text-fg-subtle">
        Not enough services yet to chart a trend.
      </div>
    );
  }
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - padX * 2);
  const y = (v: number) => padTop + (1 - (v - min) / range) * (H - padTop - padBottom);
  const poly = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1].value);
  const latest = points[points.length - 1].value;
  const hp = hover != null ? points[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const hy = hp ? y(hp.value) : 0;
  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        onPointerMove={(e) => {
          const svg = svgRef.current;
          if (!svg) return;
          const r = svg.getBoundingClientRect();
          const frac = (e.clientX - r.left) / r.width; // 0..1 across the plotted width
          setHover(Math.min(points.length - 1, Math.max(0, Math.round(frac * (points.length - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Attendance trend across recent services"
      >
        <line x1={0} y1={H - padBottom} x2={W} y2={H - padBottom} stroke="var(--su-line)" />
        <polyline points={poly} fill="none" stroke="var(--su-accent)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {/* The newest point is hollow while its service is still recording — that
            total is a partial and will keep climbing, so it must not read as a
            settled weekend. */}
        {points[points.length - 1].live ? (
          <circle cx={lastX} cy={lastY} r={4} fill="var(--su-bg)" stroke="var(--su-accent)" strokeWidth={2} />
        ) : (
          <circle cx={lastX} cy={lastY} r={4} fill="var(--su-accent)" />
        )}
        {hp && (
          <g pointerEvents="none">
            <line x1={hx} y1={padTop} x2={hx} y2={H - padBottom} stroke="var(--su-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={hx} cy={hy} r={4} fill="var(--su-accent)" stroke="var(--su-bg)" strokeWidth={1.5} />
          </g>
        )}
        <text x={padX} y={H - 8} fontFamily="var(--font-mono)" fontSize={11} fill="var(--su-fg-subtle)">{shortDay(points[0].day)}</text>
        <text x={W - padX} y={H - 8} textAnchor="end" fontFamily="var(--font-mono)" fontSize={11} fill="var(--su-fg-subtle)">{shortDay(points[points.length - 1].day)}</text>
      </svg>
      {/* Hover tooltip — HTML overlay positioned by % so its text isn't stretched
          by the chart's non-uniform (preserveAspectRatio="none") X scale. */}
      {hp && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line-strong bg-popover px-2 py-1 shadow-md backdrop-blur-xl"
          style={{ left: `${(hx / W) * 100}%`, top: `${Math.max(hy - 8, 4)}px` }}
        >
          <div className="font-mono text-caption2 tabular-nums text-fg-subtle whitespace-nowrap">
            {shortDay(hp.day)}{hp.live ? " · recording" : ""}
          </div>
          <div className="font-mono text-caption1 font-medium tabular-nums text-fg text-center">{hp.value.toLocaleString()}</div>
          {hp.parts && hp.parts.length > 1 && (
            <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
              {hp.parts.map((p, i) => (
                <div key={i} className="flex items-center justify-between gap-3 font-mono text-caption2 tabular-nums text-fg-muted whitespace-nowrap">
                  <span>{p.label}</span>
                  <span>{p.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Latest attendance, pinned above the most recent point (hidden while
          hovering so it doesn't collide with the tooltip). Only this one value —
          labeling every point would clutter. */}
      {!hp && (
        <span
          className="pointer-events-none absolute right-1 font-mono text-caption1 font-medium tabular-nums text-fg"
          style={{ top: `${Math.max(0, lastY - 20)}px` }}
        >
          {latest.toLocaleString()}
        </span>
      )}
    </div>
  );
}


function Stat({ label, value, accent, sub }: { label: string; value: string; accent: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-5 bg-gray-2 px-3 py-2">
      <div className="text-caption2 text-gray-9">{label}</div>
      <div className={`text-title3 font-semibold tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="text-caption2 text-gray-9">{sub}</div>}
    </div>
  );
}
