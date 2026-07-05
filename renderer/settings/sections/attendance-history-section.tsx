import { useEffect, useMemo, useState } from "react";
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
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/**
 * Attendance — browse past services and their recorded attendance/occupancy
 * trend. One record per PCO service-time occurrence (same scheme as SPL History),
 * grouped by day with prev/next-day navigation. The detail view graphs attendance
 * and in-room occupancy throughout the service.
 */
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

  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      setTimeline(null);
      return;
    }
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

  useEffect(() => {
    if (day == null && days.length > 0) setDay(days[0]);
  }, [days, day]);

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
    // PCO plan-item markers (from the matching timeline record) + the service's
    // mean in-room occupancy, overlaid on the trend.
    const markers = (timeline?.items ?? [])
      .filter((it) => it.title && it.startedAt)
      .map((it) => ({ t: it.startedAt, label: it.title }));
    const avgOccupancy = detail.samples.length
      ? Math.round(detail.samples.reduce((s, p) => s + p.occupancy, 0) / detail.samples.length)
      : null;
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

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Peak attendance" value={detail.peakAttendance} accent="text-blue-11" />
          <Stat label="Peak in-room" value={detail.peakOccupancy} accent="text-green-11" />
          <Stat label="Lowest in-room" value={detail.minOccupancy ?? null} accent="text-amber-11" />
          <Stat label="Latest in-room" value={detail.lastOccupancy} accent="text-gray-12" />
          <Stat label="Samples" value={detail.samples.length} accent="text-gray-12" />
        </div>

        <AttendanceChart samples={detail.samples} markers={markers} avgOccupancy={avgOccupancy} />
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
                <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">peak </span><span className="text-blue-11">{s.peakAttendance.toLocaleString()}</span></span>
                <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">room </span><span className="text-green-11">{s.peakOccupancy.toLocaleString()}</span></span>
              </span>
            </button>
            <button
              className="shrink-0 rounded-md p-2 text-gray-9 hover:bg-gray-4 hover:text-red-11 transition-colors"
              onClick={() => deleteService(s.serviceKey, s.planTitle ?? s.serviceKey)}
              aria-label={`Delete recording for ${s.planTitle ?? "service"}`}
              title="Delete recording"
            >
              <Trash2Icon className="size-4" />
            </button>
          </div>
        ))}
        {dayServices.length === 0 && <p className="text-caption1 text-gray-9">No services on this day.</p>}
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
}: {
  samples: AttendanceSample[];
  markers?: { t: string; label: string }[];
  avgOccupancy?: number | null;
}) {
  if (samples.length < 2) {
    return (
      <div className="rounded-lg border border-dashed border-gray-a5 px-4 py-10 text-center text-caption1 text-gray-9">
        Not enough samples yet to graph — the trend fills in as the service runs.
      </div>
    );
  }
  const W = 600, H = 240, padL = 40, padR = 12, padT = 16, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = samples.length;
  const maxV = Math.max(1, ...samples.map((s) => Math.max(s.attendance, s.occupancy)));
  const t0 = Date.parse(samples[0].t);
  const t1 = Date.parse(samples[n - 1].t);
  const span = t1 - t0 || 1;
  const xt = (iso: string) => padL + ((Date.parse(iso) - t0) / span) * plotW;
  const y = (v: number) => padT + plotH - (v / maxV) * plotH;
  const line = (key: "attendance" | "occupancy") =>
    samples.map((s) => `${xt(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const yTicks = [0, Math.round(maxV / 2), maxV];
  const inRange = markers.filter((m) => {
    const mt = Date.parse(m.t);
    return Number.isFinite(mt) && mt >= t0 - 1000 && mt <= t1 + 1000;
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-caption2 flex-wrap text-gray-11">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-blue-9" /> Attendance</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-green-9" /> In room</span>
        {avgOccupancy != null && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 border-t border-dashed border-green-9" /> Avg in room {avgOccupancy.toLocaleString()}</span>}
        {inRange.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 border-t border-dashed border-gray-8" /> Plan items</span>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-5 bg-gray-2 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }} role="img" aria-label="Attendance and in-room occupancy over the service, with plan-item markers">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="var(--gray-a4)" strokeWidth={1} />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--gray-9)">{t}</text>
            </g>
          ))}
          {/* PCO plan-item markers */}
          {inRange.map((m, i) => {
            const mx = xt(m.t);
            return (
              <g key={`${m.t}-${i}`}>
                <line x1={mx} y1={padT} x2={mx} y2={padT + plotH} stroke="var(--gray-a6)" strokeWidth={1} strokeDasharray="3 3" />
                <text x={mx + 2} y={padT + 8} fontSize={9} fill="var(--gray-10)" transform={`rotate(90 ${mx + 2} ${padT + 8})`}>
                  {m.label.length > 22 ? `${m.label.slice(0, 21)}…` : m.label}
                </text>
              </g>
            );
          })}
          {/* service-average in-room reference */}
          {avgOccupancy != null && (
            <line x1={padL} y1={y(avgOccupancy)} x2={W - padR} y2={y(avgOccupancy)} stroke="var(--green-9)" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
          )}
          <text x={padL} y={H - 8} textAnchor="start" fontSize={10} fill="var(--gray-9)">{fmtTime(samples[0].t)}</text>
          <text x={W - padR} y={H - 8} textAnchor="end" fontSize={10} fill="var(--gray-9)">{fmtTime(samples[n - 1].t)}</text>
          <polyline points={line("occupancy")} fill="none" stroke="var(--green-9)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <polyline points={line("attendance")} fill="none" stroke="var(--blue-9)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
