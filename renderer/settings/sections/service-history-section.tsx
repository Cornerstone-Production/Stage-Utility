import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Trash2Icon, ClockIcon, CopyIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows, Button, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { HistoryCalendar } from "../../components/history-calendar";
import { AttendanceDetail } from "./attendance-history-section";
import { SplDetail } from "./spl-history-section";

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
/** Short local date label ("Jul 5") for a YYYY-MM-DD service date. */
function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Selectable Overview metrics (the operator picks which to show; persisted per-browser).
const OVERVIEW_METRICS = [
  { key: "services", label: "Services" },
  { key: "avgLength", label: "Avg length" },
  { key: "avgStart", label: "Avg start" },
  { key: "avgInRoom", label: "Avg in-room" },
  { key: "avgAttendance", label: "Avg attendance" },
  { key: "highestAttended", label: "Highest attended" },
  { key: "lowestAttended", label: "Lowest attended" },
  { key: "longest", label: "Longest service" },
  { key: "shortest", label: "Shortest service" },
  { key: "avgOverrun", label: "Avg overrun" },
] as const;
const OVERVIEW_KEYS = OVERVIEW_METRICS.map((m) => m.key) as string[];
const OVERVIEW_STORE_KEY = "history:overviewMetrics";
function loadOverviewMetrics(): string[] {
  try {
    const raw = localStorage.getItem(OVERVIEW_STORE_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((k) => OVERVIEW_KEYS.includes(k));
    }
  } catch {
    /* default */
  }
  return ["services", "avgLength", "avgStart", "avgInRoom"];
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
    if (isBufferItem(it.title)) continue; // post-service padding — never counted in timing
    if (it.plannedLengthSec != null) { planned += it.plannedLengthSec; plannedKnown = true; }
    if (it.actualDurationSec != null) actual += it.actualDurationSec;
  }
  return { lateStartSec, planned: plannedKnown ? planned : null, actual, firstStart };
}

/** Mean per-item over/under (seconds) + how many ran over, for items with both
 *  planned and actual times. */
function overrunStats(tl: ServiceTimeline) {
  const deltas = tl.items
    .filter((it) => !isBufferItem(it.title) && it.plannedLengthSec != null && it.actualDurationSec != null)
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
  // Attendance records for all services — for the Overview card's avg in-room.
  const [attList, setAttList] = useState<ServiceAttendance[]>([]);
  const [day, setDay] = useState<string | null>(null);
  // Active service-type filter (serviceTypeId), or null for all types.
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // Editing the service window (times) in the detail view.
  const [editingTimes, setEditingTimes] = useState(false);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // Which Overview metrics to show (persisted), and whether the picker is open.
  const [overviewMetrics, setOverviewMetrics] = useState<string[]>(loadOverviewMetrics);
  const [customizing, setCustomizing] = useState(false);
  function toggleOverviewMetric(key: string) {
    setOverviewMetrics((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try {
        localStorage.setItem(OVERVIEW_STORE_KEY, JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      return next;
    });
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
  }, [selectedKey, reloadKey]);

  // Distinct service types present, labeled by their PCO name (a record with the
  // name wins over the bare id fallback). Drives the filter; only shown at 2+ types.
  const typeOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of list ?? []) {
      if (!s.serviceTypeId) continue;
      if (s.serviceTypeName) byId.set(s.serviceTypeId, s.serviceTypeName);
      else if (!byId.has(s.serviceTypeId)) byId.set(s.serviceTypeId, s.serviceTypeId);
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [list]);

  // Records scoped to the active service-type filter (null = all types).
  const filtered = useMemo(
    () => (list ?? []).filter((s) => !typeFilter || s.serviceTypeId === typeFilter),
    [list, typeFilter],
  );

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const s of filtered) set.add(s.serviceDate);
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [filtered]);

  // Auto-select the newest day; also re-select when the filter drops the current day.
  useEffect(() => {
    if (days.length > 0 && (day == null || !days.includes(day))) setDay(days[0]);
  }, [days, day]);

  const dayServices = useMemo(() => filtered.filter((s) => s.serviceDate === day), [filtered, day]);
  // Per-day service counts for the calendar dots (respects the type filter).
  const dateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of filtered) m.set(s.serviceDate, (m.get(s.serviceDate) ?? 0) + 1);
    return m;
  }, [filtered]);

  // Overview stats, cumulative THROUGH the selected day (serviceDate <= day) so
  // picking a past date shows how things looked as of then; scoped to the type
  // filter so a Youth service's numbers don't blend into Sunday's. Finished only.
  const overview = useMemo(() => {
    const asOf = day;
    const inScope = (typeId: string | null, date: string, ended: unknown) =>
      ended != null && (!typeFilter || typeId === typeFilter) && (!asOf || date <= asOf);
    const tl = (list ?? []).filter((t) => inScope(t.serviceTypeId, t.serviceDate, t.endedAt));
    const att = attList.filter((a) => inScope(a.serviceTypeId, a.serviceDate, a.endedAt));
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const sums = tl.map((t) => ({ t, s: summarize(t) }));
    const lens = sums.filter((x) => x.s.actual > 0);
    const punct = sums.map((x) => x.s.lateStartSec).filter((v): v is number => v != null);
    const overruns = sums.map((x) => (x.s.planned != null ? x.s.actual - x.s.planned : null)).filter((v): v is number => v != null);
    const occ = att.filter((a) => a.peakOccupancy > 0);
    const pk = att.filter((a) => a.peakAttendance > 0);
    const maxOcc = occ.length ? occ.reduce((m, a) => (a.peakOccupancy > m.peakOccupancy ? a : m)) : null;
    const minOcc = occ.length ? occ.reduce((m, a) => (a.peakOccupancy < m.peakOccupancy ? a : m)) : null;
    const longest = lens.length ? lens.reduce((m, x) => (x.s.actual > m.s.actual ? x : m)) : null;
    const shortest = lens.length ? lens.reduce((m, x) => (x.s.actual < m.s.actual ? x : m)) : null;
    const startFmt = (sec: number) => (sec >= 0 ? `${fmtDur(sec)} late` : `${fmtDur(-sec)} early`);
    const avgPunct = mean(punct);
    const avgOverrun = mean(overruns);
    const num = (n: number | null) => (n != null ? n.toLocaleString() : "—");
    return {
      services: { value: tl.length.toLocaleString(), accent: "text-gray-12" },
      avgLength: { value: fmtDur(mean(lens.map((x) => x.s.actual))), accent: "text-blue-11" },
      avgStart: { value: avgPunct != null ? startFmt(avgPunct) : "—", accent: avgPunct != null && avgPunct > 60 ? "text-amber-11" : "text-gray-12" },
      avgInRoom: { value: num(mean(occ.map((a) => a.peakOccupancy))), accent: "text-green-11" },
      avgAttendance: { value: num(mean(pk.map((a) => a.peakAttendance))), accent: "text-blue-11" },
      highestAttended: { value: maxOcc ? maxOcc.peakOccupancy.toLocaleString() : "—", sub: maxOcc ? shortDay(maxOcc.serviceDate) : undefined, accent: "text-green-11" },
      lowestAttended: { value: minOcc ? minOcc.peakOccupancy.toLocaleString() : "—", sub: minOcc ? shortDay(minOcc.serviceDate) : undefined, accent: "text-amber-11" },
      longest: { value: longest ? fmtDur(longest.s.actual) : "—", sub: longest ? shortDay(longest.t.serviceDate) : undefined, accent: "text-gray-12" },
      shortest: { value: shortest ? fmtDur(shortest.s.actual) : "—", sub: shortest ? shortDay(shortest.t.serviceDate) : undefined, accent: "text-gray-12" },
      avgOverrun: { value: avgOverrun != null ? fmtDelta(avgOverrun) : "—", accent: avgOverrun != null && avgOverrun > 0 ? "text-red-11" : "text-gray-12" },
    } as Record<string, { value: string; sub?: string; accent: string }>;
  }, [list, attList, day, typeFilter]);

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
    // Projected end = actual start + planned length; actual end = the record's
    // finalized end (else the last item that closed). Shown as card subscripts.
    const firstStartMs = Date.parse(sum.firstStart);
    const projectedEnd =
      sum.planned != null && Number.isFinite(firstStartMs)
        ? new Date(firstStartMs + sum.planned * 1000).toISOString()
        : null;
    // Actual end excludes the trailing buffer — the service really ended at the last counted item.
    const actualEnd = [...detail.items].reverse().find((it) => !isBufferItem(it.title) && it.endedAt)?.endedAt ?? detail.endedAt ?? null;
    const actualSub = [
      totalDelta != null ? `${fmtDelta(totalDelta)} vs plan` : null,
      actualEnd ? `ended ${fmtTime(actualEnd)}` : null,
    ].filter(Boolean).join(" · ") || undefined;
    const det = detail; // narrow for the async handler
    const linkedBap = linkedBaptisms(baptisms, detail);
    const bapTot = baptismTotals(linkedBap);
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
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="filled" size="small" onClick={startEditTimes} tooltip="Fix the recorded start/end (trims samples + items outside the window)">
              <ClockIcon className="size-3.5 text-gray-9" /> Edit times
            </Button>
            <Button variant="filled" size="small" onClick={copyReport} tooltip="Copy a full text report (timing + attendance + audio)">
              <CopyIcon className="size-3.5 text-gray-9" /> Copy report
            </Button>
          </div>
        </div>
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
          <Stat label="Actual" value={fmtDur(sum.actual)} accent="text-blue-11" sub={actualSub} />
          <Stat label="Avg overrun" value={over.avg != null ? fmtDelta(over.avg) : "—"} accent={over.avg != null && over.avg > 0 ? "text-red-11" : "text-gray-12"} sub={over.total ? `${over.over} of ${over.total} over` : undefined} />
        </div>

        <div className="flex flex-col rounded-lg border border-gray-5 overflow-hidden">
          <div className="grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem_4.5rem] gap-2 px-3 py-1.5 bg-gray-3 text-caption2 font-medium text-gray-10">
            <span>#</span><span>Item</span><span className="text-right">Plan</span><span className="text-right">Actual</span><span className="text-right">Δ</span><span className="text-right">Ended</span>
          </div>
          {detail.items.map((it, i) => {
            const itemLive = it.endedAt == null;
            const buffer = isBufferItem(it.title); // shown, but not counted in totals
            const delta = it.plannedLengthSec != null && it.actualDurationSec != null ? it.actualDurationSec - it.plannedLengthSec : null;
            const deltaColor = delta == null ? "text-gray-9" : delta > 30 ? "text-red-11" : delta < -30 ? "text-blue-11" : "text-gray-11";
            return (
              <div key={it.itemId} className={`grid grid-cols-[1.6rem_1fr_4rem_4rem_4rem_4.5rem] gap-2 px-3 py-1.5 text-caption1 tabular-nums ${i % 2 ? "bg-gray-2" : "bg-gray-1"} ${buffer ? "opacity-55" : ""}`}>
                <span className="text-gray-9">{i + 1}</span>
                <span className="text-gray-12 truncate">
                  {it.title || "—"}
                  {itemLive && <span className="ml-1.5 text-[10px] text-red-11">live</span>}
                  {buffer && <span className="ml-1.5 text-[10px] italic text-gray-9">not counted</span>}
                </span>
                <span className="text-right text-gray-10">{buffer ? "—" : fmtDur(it.plannedLengthSec)}</span>
                <span className="text-right text-gray-12">{itemLive ? "—" : fmtDur(it.actualDurationSec)}</span>
                <span className={`text-right ${deltaColor}`}>{buffer || itemLive ? "" : fmtDelta(delta)}</span>
                <span className="text-right text-gray-9 whitespace-nowrap">{it.endedAt ? fmtTime(it.endedAt) : "—"}</span>
              </div>
            );
          })}
        </div>

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
  return (
    <div className="flex flex-col gap-3">
      {typeOptions.length >= 2 && (
        <div className="flex flex-wrap gap-1.5">
          <TypeChip active={typeFilter === null} onClick={() => setTypeFilter(null)}>All</TypeChip>
          {typeOptions.map((o) => (
            <TypeChip key={o.id} active={typeFilter === o.id} onClick={() => setTypeFilter(o.id)}>
              {o.name}
            </TypeChip>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <HistoryCalendar counts={dateCounts} selected={day} onPick={setDay} />
        <div className="flex-1 min-w-0 rounded-xl border border-gray-5 bg-gray-2 p-3 flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="text-caption2 text-gray-9">
              Overview{day ? ` · through ${fmtDay(day)}` : " · all time"}
            </span>
            <button
              className="text-caption2 text-gray-10 hover:text-gray-12 transition-colors"
              onClick={() => setCustomizing((v) => !v)}
            >
              {customizing ? "Done" : "Customize"}
            </button>
          </div>
          {customizing && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {OVERVIEW_METRICS.map((m) => (
                <TypeChip key={m.key} active={overviewMetrics.includes(m.key)} onClick={() => toggleOverviewMetric(m.key)}>
                  {m.label}
                </TypeChip>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 flex-1 content-center">
            {OVERVIEW_METRICS.filter((m) => overviewMetrics.includes(m.key)).map((m) => {
              const d = overview[m.key];
              return <OStat key={m.key} label={m.label} value={d.value} accent={d.accent} sub={d.sub} />;
            })}
            {overviewMetrics.length === 0 && <span className="text-caption1 text-gray-9 col-span-full">No metrics selected — hit Customize.</span>}
          </div>
        </div>
      </div>
      {day && <span className="text-body font-medium text-gray-12">{fmtDay(day)}</span>}

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

/** Service-type filter chip (shown only when 2+ types have recordings). */
function TypeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${
        active ? "border-blue-7 bg-blue-3 text-blue-11" : "border-gray-5 bg-gray-2 text-gray-10 hover:bg-gray-3"
      }`}
    >
      {children}
    </button>
  );
}

/** Compact label/value for the Overview card (no border — the card frames them). */
function OStat({ label, value, accent, sub }: { label: string; value: string; accent: string; sub?: string }) {
  return (
    <div className="flex flex-col">
      <div className="text-caption2 text-gray-9">{label}</div>
      <div className={`text-title3 font-semibold tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="text-caption2 text-gray-9 truncate">{sub}</div>}
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
