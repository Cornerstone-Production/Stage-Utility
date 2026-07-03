import { useEffect, useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, Trash2Icon, ClockIcon, CopyIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows, Button, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";

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

/** Derived service-level timing from a record. */
function summarize(rec: ServiceTimeline) {
  const items = rec.items;
  const firstStart = items[0]?.startedAt ?? rec.startedAt;
  const scheduled = rec.serviceTimeStartsAt;
  let lateStartSec: number | null = null;
  if (scheduled && firstStart) {
    const d = (Date.parse(firstStart) - Date.parse(scheduled)) / 1000;
    if (Number.isFinite(d)) lateStartSec = d;
  }
  let planned = 0;
  let actual = 0;
  let plannedKnown = false;
  for (const it of items) {
    if (it.plannedLengthSec != null) { planned += it.plannedLengthSec; plannedKnown = true; }
    if (it.actualDurationSec != null) actual += it.actualDurationSec;
  }
  return { lateStartSec, planned: plannedKnown ? planned : null, actual, firstStart };
}

/** Mean per-item over/under (seconds) + how many ran over, for items with both
 *  planned and actual times. */
function overrunStats(tl: ServiceTimeline) {
  const deltas = tl.items
    .filter((it) => it.plannedLengthSec != null && it.actualDurationSec != null)
    .map((it) => (it.actualDurationSec as number) - (it.plannedLengthSec as number));
  if (!deltas.length) return { avg: null as number | null, over: 0, total: 0 };
  return { avg: deltas.reduce((a, b) => a + b, 0) / deltas.length, over: deltas.filter((d) => d > 0).length, total: deltas.length };
}

/** Baptism sessions that overlap a service's recorded window. */
function linkedBaptisms(all: BaptismSession[], tl: ServiceTimeline): BaptismSession[] {
  const ds = Date.parse(tl.startedAt);
  const de = tl.endedAt ? Date.parse(tl.endedAt) : ds + 6 * 3600 * 1000;
  return all.filter((b) => {
    const bs = Date.parse(b.startedAt);
    const be = Date.parse(b.finishedAt);
    return Number.isFinite(bs) && Number.isFinite(be) && bs <= de && be >= ds;
  });
}
function baptismTotals(sessions: BaptismSession[]) {
  const people = sessions.reduce((a, b) => a + b.people.length, 0);
  const ms = sessions.reduce((a, b) => a + b.people.reduce((x, p) => x + p.testimonyMs + p.baptizeMs, 0), 0);
  return { people, sec: ms / 1000 };
}

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
    L.push(`Peak attendance ${att.peakAttendance.toLocaleString()} · Peak in-room ${att.peakOccupancy.toLocaleString()}${avgOcc != null ? ` · Avg in-room ${avgOcc.toLocaleString()}` : ""}`);
  }
  if (spl && spl.items.length) {
    L.push("", "AUDIO — peak SPL (dB)");
    spl.items.forEach((it, i) => {
      if (it.maxSpl != null) L.push(`${i + 1}. ${it.title || "—"}  ${it.maxSpl.toFixed(1)}`);
    });
  }
  if (baptisms.length) {
    const t = baptismTotals(baptisms);
    L.push("", "BAPTISMS");
    L.push(`${t.people} baptized · total ${fmtDur(t.sec)}`);
  }
  return L.join("\n");
}

/**
 * Service history — the ACTUAL recorded rundown for past services: when each item
 * went live and how long it ran vs its planned length, plus whether the service
 * started late and total over/under. One record per PCO service-time occurrence
 * (same scheme as SPL History / Attendance), grouped by day.
 */
export function ServiceHistorySection() {
  const [list, setList] = useState<ServiceTimeline[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceTimeline | null>(null);
  // The matching attendance + SPL records (same serviceKey) for the combined report.
  const [attendance, setAttendance] = useState<ServiceAttendance | null>(null);
  const [spl, setSpl] = useState<ServiceSplHistory | null>(null);
  // Baptism sessions (cross-linked to a service by time overlap).
  const [baptisms, setBaptisms] = useState<BaptismSession[]>([]);
  const [day, setDay] = useState<string | null>(null);

  function reload() {
    invoke<ServiceTimeline[]>("serviceTimeline:list")
      .then((l) => setList(l))
      .catch(() => setList([]));
  }
  useEffect(() => {
    reload();
  }, []);

  // Live updates while a service is recording — refresh the open detail/list.
  useEffect(() => {
    return onNotification("service-timeline:history", (p) => {
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
  }, []);

  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      setAttendance(null);
      setSpl(null);
      return;
    }
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
    const sum = summarize(detail);
    const totalDelta = sum.planned != null ? sum.actual - sum.planned : null;
    const over = overrunStats(detail);
    const det = detail; // narrow for the async handler
    const linkedBap = linkedBaptisms(baptisms, detail);
    const bapTot = baptismTotals(linkedBap);
    async function copyReport() {
      const ok = await copyText(buildReport(det, attendance, spl, linkedBap));
      if (ok) toast.success("Report copied to clipboard");
      else toast.error("Couldn't copy the report");
    }
    const avgOcc = attendance && attendance.samples.length
      ? Math.round(attendance.samples.reduce((s, p) => s + p.occupancy, 0) / attendance.samples.length)
      : null;
    return (
      <div className="flex flex-col gap-4">
        <button className="self-start text-caption1 text-blue-11 hover:underline" onClick={() => setSelectedKey(null)}>
          ← All services
        </button>
        <div className="flex items-start justify-between gap-3">
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
          <Button variant="filled" size="small" onClick={copyReport} tooltip="Copy a full text report (timing + attendance + audio)">
            <CopyIcon className="size-3.5 text-gray-9" /> Copy report
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Started" value={fmtTime(sum.firstStart)} accent={sum.lateStartSec != null && sum.lateStartSec > 60 ? "text-amber-11" : "text-gray-12"} sub={sum.lateStartSec != null ? (sum.lateStartSec >= 0 ? `${fmtDelta(sum.lateStartSec)} late` : `${fmtDelta(sum.lateStartSec)} early`) : undefined} />
          <Stat label="Planned" value={fmtDur(sum.planned)} accent="text-gray-12" />
          <Stat label="Actual" value={fmtDur(sum.actual)} accent="text-blue-11" sub={totalDelta != null ? `${fmtDelta(totalDelta)} vs plan` : undefined} />
          <Stat label="Avg overrun" value={over.avg != null ? fmtDelta(over.avg) : "—"} accent={over.avg != null && over.avg > 0 ? "text-red-11" : "text-gray-12"} sub={over.total ? `${over.over} of ${over.total} over` : undefined} />
        </div>

        <div className="flex flex-col rounded-lg border border-gray-5 overflow-hidden">
          <div className="grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 bg-gray-3 text-caption2 font-medium text-gray-10">
            <span>#</span><span>Item</span><span className="text-right">Plan</span><span className="text-right">Actual</span><span className="text-right">Δ</span>
          </div>
          {detail.items.map((it, i) => {
            const itemLive = it.endedAt == null;
            const delta = it.plannedLengthSec != null && it.actualDurationSec != null ? it.actualDurationSec - it.plannedLengthSec : null;
            const deltaColor = delta == null ? "text-gray-9" : delta > 30 ? "text-red-11" : delta < -30 ? "text-blue-11" : "text-gray-11";
            return (
              <div key={it.itemId} className={`grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem] gap-2 px-3 py-1.5 text-caption1 tabular-nums ${i % 2 ? "bg-gray-2" : "bg-gray-1"}`}>
                <span className="text-gray-9">{i + 1}</span>
                <span className="text-gray-12 truncate">{it.title || "—"}{itemLive && <span className="ml-1.5 text-[10px] text-red-11">live</span>}</span>
                <span className="text-right text-gray-10">{fmtDur(it.plannedLengthSec)}</span>
                <span className="text-right text-gray-12">{itemLive ? "—" : fmtDur(it.actualDurationSec)}</span>
                <span className={`text-right ${deltaColor}`}>{itemLive ? "" : fmtDelta(delta)}</span>
              </div>
            );
          })}
        </div>

        {/* Combined report: attendance + audio for the same service occurrence. */}
        {attendance && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption1 font-medium text-gray-11">Attendance</span>
            <div className="flex flex-wrap gap-2 text-caption1 tabular-nums">
              <span className="rounded-md border border-gray-5 bg-gray-2 px-2.5 py-1"><span className="text-gray-9">Peak attendance </span><span className="text-blue-11">{attendance.peakAttendance.toLocaleString()}</span></span>
              <span className="rounded-md border border-gray-5 bg-gray-2 px-2.5 py-1"><span className="text-gray-9">Peak in-room </span><span className="text-green-11">{attendance.peakOccupancy.toLocaleString()}</span></span>
              {avgOcc != null && <span className="rounded-md border border-gray-5 bg-gray-2 px-2.5 py-1"><span className="text-gray-9">Avg in-room </span><span className="text-gray-12">{avgOcc.toLocaleString()}</span></span>}
            </div>
          </div>
        )}
        {spl && spl.items.some((it) => it.maxSpl != null) && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption1 font-medium text-gray-11">Audio — peak SPL</span>
            <div className="flex flex-col rounded-lg border border-gray-5 overflow-hidden">
              {spl.items.filter((it) => it.maxSpl != null).map((it, i) => (
                <div key={it.itemId} className={`grid grid-cols-[1fr_5rem] gap-2 px-3 py-1.5 text-caption1 tabular-nums ${i % 2 ? "bg-gray-2" : "bg-gray-1"}`}>
                  <span className="text-gray-12 truncate">{it.title || "—"}</span>
                  <span className="text-right text-amber-11">{(it.maxSpl as number).toFixed(1)} dB</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {linkedBap.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption1 font-medium text-gray-11">Baptisms</span>
            <div className="flex flex-wrap gap-2 text-caption1 tabular-nums">
              <span className="rounded-md border border-gray-5 bg-gray-2 px-2.5 py-1"><span className="text-gray-9">Baptized </span><span className="text-gray-12">{bapTot.people}</span></span>
              <span className="rounded-md border border-gray-5 bg-gray-2 px-2.5 py-1"><span className="text-gray-9">Total time </span><span className="text-gray-12">{fmtDur(bapTot.sec)}</span></span>
            </div>
            <span className="text-caption2 text-gray-9">Per-person testimony/baptism splits are in the Baptisms tab.</span>
          </div>
        )}
      </div>
    );
  }

  // ── List view: services for the selected day. ──
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
        {dayServices.map((s) => {
          const sum = summarize(s);
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
                  {sum.lateStartSec != null && sum.lateStartSec > 60 && <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">late </span><span className="text-amber-11">{fmtDelta(sum.lateStartSec)}</span></span>}
                  <span className="ml-3 whitespace-nowrap"><span className="text-gray-9">ran </span><span className="text-blue-11">{fmtDur(sum.actual)}</span></span>
                  {totalDelta != null && <span className="ml-3 whitespace-nowrap"><span className={totalDelta > 0 ? "text-red-11" : "text-gray-11"}>{fmtDelta(totalDelta)}</span></span>}
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
          );
        })}
        {dayServices.length === 0 && <p className="text-caption1 text-gray-9">No services on this day.</p>}
      </div>
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
