import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { ChevronLeftIcon, ChevronRightIcon, Trash2Icon, UsersIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows } from "../../components/ui";

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

// Which chart series/overlays and summary cards to surface, mirroring the SPL
// tab's metric picker. Attendance has a fixed, small set (not arbitrary per-item
// columns), so the keys are enumerated here and grouped for the picker UI. The
// chart "attendance" series is the per-service (baselined) value stored in each
// sample; the day total is a scalar summary card, not a drawable series.
// "Attendance" = people in the room (occupancy series/peak — the real count).
// "Total entries" = the cumulative door count (double-counts re-entries).
const CHART_METRICS = [
  { key: "occupancy", label: "Attendance" },
  { key: "attendance", label: "Total entries" },
  { key: "avg", label: "Avg attendance" },
  { key: "markers", label: "Plan items" },
] as const;
const STAT_METRICS = [
  { key: "peak", label: "Peak attendance" },
  { key: "lowest", label: "Lowest attendance" },
  { key: "entries", label: "Total entries" },
  { key: "dayTotal", label: "Total entries (day)" },
  { key: "samples", label: "Samples" },
] as const;
const ALL_METRIC_KEYS = [...CHART_METRICS.map((m) => m.key), ...STAT_METRICS.map((m) => m.key)];
const METRICS_STORAGE_KEY = "attendance:visibleMetrics";

function loadVisibleMetrics(): string[] {
  try {
    const raw = localStorage.getItem(METRICS_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((k) => ALL_METRIC_KEYS.includes(k));
    }
  } catch {
    /* fall through to default */
  }
  // Default: the real attendance (in-room) + avg + plan markers, and Peak/Lowest
  // attendance + samples. "Total entries" (cumulative) stays off unless picked.
  return ["occupancy", "avg", "markers", "peak", "lowest", "samples"];
}

/**
 * Attendance — browse past services and their recorded attendance/occupancy
 * trend. One record per PCO service-time occurrence (same scheme as SPL History),
 * grouped by day with prev/next-day navigation. The detail view graphs attendance
 * and in-room occupancy throughout the service.
 */

/** Per-service attendance for a sample series: value minus the first sample (the
 *  count when this service's recording began). Robust whether samples were stored
 *  raw-cumulative or already-baselined (first ≈ 0), so a service that wasn't reset
 *  off the prior service still reads its own count. */
export function perServiceAttendance(v: number, samples: AttendanceSample[]): number {
  return Math.max(0, v - (samples[0]?.attendance ?? 0));
}
/** Per-service PEAK attendance from a record's samples (max − first). Falls back to
 *  the stored field when there are no samples. */
export function servicePeakAttendance(rec: ServiceAttendance): number {
  const s = rec.samples;
  if (!s || s.length === 0) return rec.peakAttendance;
  let max = s[0].attendance;
  for (const x of s) if (x.attendance > max) max = x.attendance;
  return perServiceAttendance(max, s);
}

export function AttendanceHistorySection() {
  const [list, setList] = useState<ServiceAttendance[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceAttendance | null>(null);
  // The matching service-timeline record (same serviceKey) for PCO item markers.
  const [timeline, setTimeline] = useState<ServiceTimeline | null>(null);
  const [day, setDay] = useState<string | null>(null);

  function reload() {
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((l) => setList(l))
      .catch(() => setList([]));
  }
  useEffect(() => {
    reload();
  }, []);

  // Live updates while a service is recording — refresh the open detail/list.
  useEffect(() => {
    return onNotification("attendance:history", (p) => {
      const rec = p as ServiceAttendance | null;
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
  }, []);

  // Keep the open service's PCO item markers fresh as items go live.
  useEffect(() => {
    return onNotification("service-timeline:history", (p) => {
      const rec = p as ServiceTimeline | null;
      if (!rec) return;
      setTimeline((t) => (selectedKey && rec.serviceKey === selectedKey ? rec : t));
    });
  }, [selectedKey]);

  // Clearing is synchronous, so it happens in the same render the selection
  // clears — the panel never shows the old service's numbers under no selection.
  useResyncOn([selectedKey], () => {
    if (!selectedKey) {
      setDetail(null);
      setTimeline(null);
    }
  });

  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    invoke<ServiceAttendance | null>("attendance:getHistory", { serviceKey: selectedKey })
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null));
    // Best-effort: the matching timeline record drives PCO plan-item markers.
    invoke<ServiceTimeline | null>("serviceTimeline:get", { serviceKey: selectedKey })
      .then((t) => !cancelled && setTimeline(t))
      .catch(() => !cancelled && setTimeline(null));
    return () => {
      cancelled = true;
    };
  }, [selectedKey]);

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const s of list ?? []) set.add(s.serviceDate);
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [list]);

  useResyncOn([days, day], () => {
    if (day == null && days.length > 0) setDay(days[0]);
  });

  const dayServices = useMemo(() => (list ?? []).filter((s) => s.serviceDate === day), [list, day]);

  async function deleteService(key: string, title: string) {
    if (!(await confirm({ title: "Delete recording?", message: `Delete the attendance recording for "${title}"? This can't be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    setList((prev) => (prev ? prev.filter((s) => s.serviceKey !== key) : prev));
    if (selectedKey === key) setSelectedKey(null);
    try {
      await invoke("attendance:deleteHistory", { serviceKey: key });
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
          icon={<UsersIcon />}
          title="No attendance recorded yet"
          hint="Attendance is recorded while a service runs in Planning Center Live with the SenSource people counter connected."
        />
      </div>
    );
  }

  // ── Detail view: one service's attendance trend + summary. ──
  if (detail) {
    const live = detail.endedAt == null;
    return (
      <div className="flex flex-col gap-4">
        <button className="self-start text-caption1 text-blue-11 hover:underline" onClick={() => setSelectedKey(null)}>
          ← All services
        </button>
        <div className="flex flex-col">
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
        <AttendanceDetail detail={detail} timeline={timeline} />
      </div>
    );
  }

  // ── List view: services for the selected day, with day navigation. ──
  const dayIdx = day ? days.indexOf(day) : -1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <button
          className="rounded-md border border-gray-5 p-1.5 text-gray-11 enabled:hover:bg-gray-3 disabled:opacity-40"
          disabled={dayIdx < 0 || dayIdx >= days.length - 1}
          onClick={() => setDay(days[dayIdx + 1])}
          aria-label="Earlier day"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="text-body font-medium text-gray-12">{day ? fmtDay(day) : "—"}</span>
        <button
          className="rounded-md border border-gray-5 p-1.5 text-gray-11 enabled:hover:bg-gray-3 disabled:opacity-40"
          disabled={dayIdx <= 0}
          onClick={() => setDay(days[dayIdx - 1])}
          aria-label="Later day"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {dayServices.map((s) => (
          <div key={s.serviceKey} className="flex items-center gap-1 rounded-lg border border-gray-5 bg-gray-2 pr-1.5 hover:bg-gray-3 transition-colors">
            <button className="flex flex-1 min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={() => setSelectedKey(s.serviceKey)}>
              <div className="flex flex-col min-w-0">
                <span className="text-body font-medium text-gray-12 truncate">{s.planTitle ?? s.serviceKey}</span>
                <span className="text-caption2 text-gray-9 truncate">
                  {fmtTime(s.serviceTimeStartsAt ?? s.startedAt) ? `${fmtTime(s.serviceTimeStartsAt ?? s.startedAt)} · ` : ""}
                  {s.seriesTitle ? `${s.seriesTitle} · ` : ""}
                  {s.endedAt == null ? "recording…" : `${s.samples.length} samples`}
                </span>
              </div>
              <span className="shrink-0 tabular-nums text-caption1 text-right">
                <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">peak </span><span className="text-blue-11">{servicePeakAttendance(s).toLocaleString()}</span></span>
                <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">room </span><span className="text-green-11">{s.peakOccupancy.toLocaleString()}</span></span>
              </span>
            </button>
            <Tooltip label="Delete recording">
              <button
                className="shrink-0 rounded-md p-2 text-gray-9 hover:bg-gray-4 hover:text-red-11 transition-colors"
                onClick={() => deleteService(s.serviceKey, s.planTitle ?? s.serviceKey)}
                aria-label={`Delete recording for ${s.planTitle ?? "service"}`}
              >
                <Trash2Icon className="size-4" />
              </button>
            </Tooltip>
          </div>
        ))}
        {dayServices.length === 0 && <p className="text-caption1 text-gray-9">No services on this day.</p>}
      </div>
    </div>
  );
}

/** The full attendance detail — metric picker + summary cards + trend chart — for
 *  one service record. Extracted so the unified History tab can embed it directly.
 *  `timeline` (same serviceKey) supplies the PCO plan-item markers on the chart. */
export function AttendanceDetail({ detail, timeline }: { detail: ServiceAttendance; timeline: ServiceTimeline | null }) {
  const [visible, setVisible] = useState<string[]>(loadVisibleMetrics);
  const shows = (k: string) => visible.includes(k);
  function toggleMetric(key: string) {
    setVisible((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try {
        localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* best-effort persist */
      }
      return next;
    });
  }
  // PCO plan-item markers + the service's mean in-room occupancy, overlaid on the trend.
  const markers = (timeline?.items ?? [])
    .filter((it) => it.title && it.startedAt)
    .map((it) => ({ t: it.startedAt, label: it.title }));
  const avgOccupancy = detail.samples.length
    ? Math.round(detail.samples.reduce((s, p) => s + p.occupancy, 0) / detail.samples.length)
    : null;
  // Attendance is cumulative; show it per-service (each sample minus the first) so a
  // service not reset off the prior one still reads its own count on the chart + peak.
  const attSamples = detail.samples.map((s) => ({ t: s.t, attendance: perServiceAttendance(s.attendance, detail.samples), occupancy: s.occupancy, phase: s.phase }));
  const statValues: Record<string, { value: number | null; accent: string }> = {
    peak: { value: detail.peakOccupancy, accent: "text-green-11" }, // peak people in the room = real attendance
    lowest: { value: detail.minOccupancy ?? null, accent: "text-amber-11" },
    entries: { value: servicePeakAttendance(detail), accent: "text-blue-11" }, // cumulative door count
    dayTotal: { value: detail.totalAttendance ?? null, accent: "text-blue-11" },
    samples: { value: detail.samples.length, accent: "text-gray-12" },
  };
  const shownStats = STAT_METRICS.filter((m) => shows(m.key));
  const colClass =
    shownStats.length >= 6 ? "sm:grid-cols-6"
    : shownStats.length === 5 ? "sm:grid-cols-5"
    : shownStats.length === 4 ? "sm:grid-cols-4"
    : "sm:grid-cols-3";
  return (
    <div className="flex flex-col gap-4">
      <MetricPicker visible={visible} onToggle={toggleMetric} />
      {shownStats.length > 0 && (
        <div className={`grid grid-cols-2 gap-2 ${colClass}`}>
          {shownStats.map((m) => (
            <Stat key={m.key} label={m.label} value={statValues[m.key].value} accent={statValues[m.key].accent} />
          ))}
        </div>
      )}
      <AttendanceChart
        samples={attSamples}
        markers={shows("markers") ? markers : []}
        avgOccupancy={shows("avg") ? avgOccupancy : null}
        showAttendance={shows("attendance")}
        showOccupancy={shows("occupancy")}
        serviceStartedAt={detail.serviceStartedAt ?? null}
        serviceEndedAt={detail.endedAt}
      />
    </div>
  );
}

/** Toggle chips for which chart series/overlays and summary cards to surface —
 *  mirrors the SPL tab's picker. Persisted per-browser (view preference, not a
 *  live-display setting), grouped so the two kinds read distinctly. */
function MetricPicker({ visible, onToggle }: { visible: string[]; onToggle: (key: string) => void }) {
  const Chip = ({ k, label }: { k: string; label: string }) => {
    const on = visible.includes(k);
    return (
      <button
        onClick={() => onToggle(k)}
        className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${
          on ? "border-blue-7 bg-blue-3 text-blue-11" : "border-gray-5 bg-gray-2 text-gray-10 hover:bg-gray-3"
        }`}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <span className="text-caption2 text-gray-9">Chart</span>
        <div className="flex flex-wrap gap-1.5">
          {CHART_METRICS.map((m) => <Chip key={m.key} k={m.key} label={m.label} />)}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-caption2 text-gray-9">Summary</span>
        <div className="flex flex-wrap gap-1.5">
          {STAT_METRICS.map((m) => <Chip key={m.key} k={m.key} label={m.label} />)}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | null; accent: string }) {
  return (
    <div className="rounded-lg border border-gray-5 bg-gray-2 px-3 py-2">
      <div className="text-caption2 text-gray-9">{label}</div>
      <div className={`text-title3 font-semibold tabular-nums ${accent}`}>{value == null ? "—" : value.toLocaleString()}</div>
    </div>
  );
}

/** Dependency-free SVG line chart of attendance + in-room occupancy over time,
 *  with optional PCO plan-item markers (vertical lines at item start times) and a
 *  service-average in-room reference line. X is time-based so markers align with
 *  the curve even though samples aren't perfectly evenly spaced. */
function AttendanceChart({
  samples,
  markers = [],
  avgOccupancy = null,
  showAttendance = true,
  showOccupancy = true,
  serviceStartedAt = null,
  serviceEndedAt = null,
}: {
  samples: AttendanceSample[];
  markers?: { t: string; label: string }[];
  avgOccupancy?: number | null;
  showAttendance?: boolean;
  showOccupancy?: boolean;
  /** Service-proper window (the band between the arrival ramp and the taper). */
  serviceStartedAt?: string | null;
  serviceEndedAt?: string | null;
}) {
  // Hover tooltip state — declared before the early return (Rules of Hooks).
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (samples.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-gray-a5 px-4 py-10 text-center text-caption1 text-gray-9">
        Not enough samples yet to graph — the trend fills in as the service runs.
      </div>
    );
  }
  const W = 600, H = 264, padL = 40, padR = 12, padT = 16, padB = 50;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = samples.length;
  const dataMax = Math.max(1, ...samples.map((s) => Math.max(showAttendance ? s.attendance : 0, showOccupancy ? s.occupancy : 0)));
  // Nice round y-axis (0 / mid / top) in 1·2·5×10ⁿ steps with headroom — matches the
  // custom-layout people-graph so the two charts read consistently (0/500/1000, not
  // 0/531/1062).
  const niceStep = (target: number) => {
    const x = target > 1 ? target : 1;
    const pow = Math.pow(10, Math.floor(Math.log10(x)));
    const nn = x / pow;
    const m = nn <= 1 ? 1 : nn <= 2 ? 2 : nn <= 5 ? 5 : 10;
    return Math.max(1, Math.round(m * pow));
  };
  let step = niceStep(dataMax / 2);
  let hi = 2 * step;
  while (hi <= dataMax) { step = niceStep(step + 1); hi = 2 * step; }
  const yTicks = [0, step, hi];
  const t0 = Date.parse(samples[0].t);
  const t1 = Date.parse(samples[n - 1].t);
  const span = t1 - t0 || 1;
  const xt = (iso: string) => padL + ((Date.parse(iso) - t0) / span) * plotW;
  const y = (v: number) => padT + plotH - (v / hi) * plotH;
  const line = (key: "attendance" | "occupancy") =>
    samples.map((s) => `${xt(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const area = (key: "attendance" | "occupancy") =>
    `${padL},${padT + plotH} ${line(key)} ${W - padR},${padT + plotH}`;
  const inRange = markers.filter((m) => {
    const mt = Date.parse(m.t);
    return Number.isFinite(mt) && mt >= t0 - 1000 && mt <= t1 + 1000;
  });

  // Service-proper window: the arrival ramp sits left of it and the emptying-room
  // taper to the right, so those tails get dimmed while the service band stays clear.
  const clampX = (v: number) => Math.max(padL, Math.min(W - padR, v));
  const sStart = serviceStartedAt ? Date.parse(serviceStartedAt) : NaN;
  const sEnd = serviceEndedAt ? Date.parse(serviceEndedAt) : NaN;
  const bandX0 = Number.isFinite(sStart) ? clampX(xt(serviceStartedAt as string)) : null;
  const bandX1 = Number.isFinite(sEnd) ? clampX(xt(serviceEndedAt as string)) : null;
  const hasPre = bandX0 != null && bandX0 > padL + 1;
  const hasPost = bandX1 != null && bandX1 < W - padR - 1;
  // PCO item times for the x-axis — thinned left→right so close items don't overlap
  // (the NAME stays on the vertical marker line; only the time drops to the axis).
  const axisTimes: { x: number; t: string }[] = [];
  let lastAxisX = -Infinity;
  for (const m of [...inRange].sort((a, b) => xt(a.t) - xt(b.t))) {
    const mx = xt(m.t);
    if (mx - lastAxisX >= 30 && mx > padL + 22 && mx < W - padR - 22) {
      axisTimes.push({ x: mx, t: m.t });
      lastAxisX = mx;
    }
  }
  // Vertical NAME labels for items that start close together (e.g. "MEDIA" +
  // "VIDEO: Pre-roll") would stack illegibly. Draw a label only if it clears the
  // last drawn one; collided labels are HIDDEN — their marker line stays, and the
  // names are surfaced in the hover tooltip so nothing is lost.
  const LABEL_GAP = 13;
  const labelDrawn = new Set<number>();
  {
    let lastX = -Infinity;
    for (const { i, mx } of inRange.map((m, i) => ({ i, mx: xt(m.t) })).sort((a, b) => a.mx - b.mx)) {
      if (mx - lastX >= LABEL_GAP) {
        labelDrawn.add(i);
        lastX = mx;
      }
    }
  }

  // Hover tooltip: map the pointer to the nearest sample and show its values + time.
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const vbX = ((e.clientX - r.left) / r.width) * W;
    const targetT = t0 + ((vbX - padL) / plotW) * span;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(Date.parse(samples[i].t) - targetT);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover(best);
  }
  const hs = hover != null ? samples[hover] : null;
  const hx = hs ? xt(hs.t) : 0;
  // Plan items at the crosshair — surfaces any name the thinning above hid, so a
  // cluster's overlapping labels are still discoverable ("so you know it's there").
  const hoverItems = (() => {
    if (!hs || inRange.length === 0) return [] as typeof inRange;
    let nx = 0;
    let nd = Infinity;
    for (const m of inRange) {
      const d = Math.abs(xt(m.t) - hx);
      if (d < nd) { nd = d; nx = xt(m.t); }
    }
    if (nd > 18) return [] as typeof inRange;
    return [...inRange].filter((m) => Math.abs(xt(m.t) - nx) <= LABEL_GAP).sort((a, b) => xt(a.t) - xt(b.t));
  })();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-caption2 flex-wrap text-gray-11">
        {showOccupancy && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-green-9" /> Attendance</span>}
        {showAttendance && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-blue-9" /> Total entries</span>}
        {avgOccupancy != null && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 border-t border-dashed border-green-9" /> Avg attendance {avgOccupancy.toLocaleString()}</span>}
        {inRange.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 border-t border-dashed border-gray-8" /> Plan items</span>}
        {(hasPre || hasPost) && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-gray-a4" /> Before / after service</span>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-5 bg-gray-2 p-2">
        <svg ref={svgRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }} role="img" aria-label="Attendance and in-room occupancy over the service, with plan-item markers">
          <defs>
            <linearGradient id="attFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--blue-9)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--blue-9)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="occFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--green-9)" stopOpacity={0.20} />
              <stop offset="100%" stopColor="var(--green-9)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {/* nice round gridlines */}
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="var(--gray-a4)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--gray-9)">{t.toLocaleString()}</text>
            </g>
          ))}
          {/* dim the pre-service arrival ramp / post-service taper (outside the service band) */}
          {hasPre && <rect x={padL} y={padT} width={(bandX0 as number) - padL} height={plotH} fill="var(--gray-a3)" />}
          {hasPost && <rect x={bandX1 as number} y={padT} width={W - padR - (bandX1 as number)} height={plotH} fill="var(--gray-a3)" />}
          {hasPre && <line x1={bandX0 as number} y1={padT} x2={bandX0 as number} y2={padT + plotH} stroke="var(--green-8)" strokeWidth={1} opacity={0.6} vectorEffect="non-scaling-stroke" />}
          {hasPost && <line x1={bandX1 as number} y1={padT} x2={bandX1 as number} y2={padT + plotH} stroke="var(--amber-8)" strokeWidth={1} opacity={0.6} vectorEffect="non-scaling-stroke" />}
          {/* PCO plan-item markers — item NAME on the line; the time drops to the x-axis */}
          {inRange.map((m, i) => {
            const mx = xt(m.t);
            return (
              <g key={`${m.t}-${i}`}>
                <line x1={mx} y1={padT} x2={mx} y2={padT + plotH} stroke="var(--gray-a6)" strokeWidth={1} strokeDasharray="3 3" />
                {labelDrawn.has(i) && (
                  <text x={mx + 2} y={padT + 8} fontSize={9} fill="var(--gray-10)" transform={`rotate(90 ${mx + 2} ${padT + 8})`}>
                    {m.label.length > 22 ? `${m.label.slice(0, 21)}…` : m.label}
                  </text>
                )}
              </g>
            );
          })}
          {/* filled areas (attendance sits above occupancy, so paint it first/behind) */}
          {showAttendance && <polygon points={area("attendance")} fill="url(#attFill)" />}
          {showOccupancy && <polygon points={area("occupancy")} fill="url(#occFill)" />}
          {/* service-average in-room reference */}
          {avgOccupancy != null && (
            <line x1={padL} y1={y(avgOccupancy)} x2={W - padR} y2={y(avgOccupancy)} stroke="var(--green-9)" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} vectorEffect="non-scaling-stroke" />
          )}
          {/* Service start/end times — vertical (matching the item times) but in a
              distinct, brighter tone so they read as boundaries, not plan items. */}
          <text x={padL} y={padT + plotH + 6} fontSize={9} fill="var(--su-fg-muted)" transform={`rotate(90 ${padL} ${padT + plotH + 6})`}>{fmtTime(samples[0].t)}</text>
          <text x={W - padR} y={padT + plotH + 6} fontSize={9} fill="var(--su-fg-muted)" transform={`rotate(90 ${W - padR} ${padT + plotH + 6})`}>{fmtTime(samples[n - 1].t)}</text>
          {/* PCO item times on the x-axis (thinned), each ticking up to its marker line */}
          {axisTimes.map((a, i) => (
            <g key={`axt-${i}`}>
              <line x1={a.x} y1={padT + plotH} x2={a.x} y2={padT + plotH + 3} stroke="var(--gray-a6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={a.x} y={padT + plotH + 6} fontSize={9} fill="var(--su-fg-subtle)" transform={`rotate(90 ${a.x} ${padT + plotH + 6})`}>{fmtTime(a.t)}</text>
            </g>
          ))}
          {showOccupancy && <polyline points={line("occupancy")} fill="none" stroke="var(--green-9)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
          {showAttendance && <polyline points={line("attendance")} fill="none" stroke="var(--blue-9)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
          {/* hover crosshair + tooltip */}
          {hs && (
            <g pointerEvents="none">
              <line x1={hx} y1={padT} x2={hx} y2={padT + plotH} stroke="var(--gray-a7)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              {showOccupancy && <circle cx={hx} cy={y(hs.occupancy)} r={3} fill="var(--green-9)" />}
              {showAttendance && <circle cx={hx} cy={y(hs.attendance)} r={3} fill="var(--blue-9)" />}
              {(() => {
                const rows: { t: string; kind: "time" | "val" | "item" }[] = [{ t: fmtTime(hs.t), kind: "time" }];
                if (showOccupancy) rows.push({ t: `Attendance ${hs.occupancy.toLocaleString()}`, kind: "val" });
                if (showAttendance) rows.push({ t: `Entries ${hs.attendance.toLocaleString()}`, kind: "val" });
                for (const m of hoverItems) rows.push({ t: `▸ ${m.label.length > 24 ? `${m.label.slice(0, 23)}…` : m.label}`, kind: "item" });
                const boxW = Math.min(W - padL - padR, Math.max(96, Math.round(Math.max(...rows.map((r) => r.t.length)) * 5) + 14));
                const boxH = 6 + rows.length * 12;
                const bx = Math.min(Math.max(hx + 6, padL), W - padR - boxW);
                return (
                  <g>
                    <rect x={bx} y={padT + 2} width={boxW} height={boxH} rx={4} fill="var(--gray-1)" stroke="var(--gray-6)" opacity={0.97} />
                    {rows.map((ln, i) => (
                      <text key={i} x={bx + 6} y={padT + 14 + i * 12} fontSize={9} fill={ln.kind === "time" ? "var(--gray-9)" : ln.kind === "item" ? "var(--gray-11)" : "var(--gray-12)"}>{ln.t}</text>
                    ))}
                  </g>
                );
              })()}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
