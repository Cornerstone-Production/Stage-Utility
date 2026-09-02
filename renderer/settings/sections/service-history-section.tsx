import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { linkBaptisms, baptismStats } from "../../lib/link-baptisms";
import { cn } from "../../lib/cn";
import { AttendanceTrendChart } from "../../components/attendance-trend-chart";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip } from "../../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { Trash2Icon, ClockIcon, CopyIcon, GitMergeIcon, DownloadIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows, Button, Collapsible, toast } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { HistoryCalendar } from "../../components/history-calendar";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { AttendanceDetail, servicePeakAttendance } from "./attendance-history-section";
import { SplDetail } from "./spl-history-section";
import {
  computeOverview,
  summarize,
  fmtDur,
  fmtDelta,
  fmtTime,
  shortDay,
  isCountedItem,
  trendColor,
  type OverviewData,
  type Trend,
  type TrendTone,
} from "./overview-data";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}



/** Tailwind text color for a trend tone (semantic status tokens). */

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
  // An explicit Overview scope, which STICKS. Without it the scope was derived from
  // selectedKey — but opening a service hides the overview, and going back cleared
  // the selection, so the scope snapped straight back to the day's newest service.
  // On a day with a morning weekend service and an evening event you could never
  // get the weekend overview to stay up. Null = follow the old derivation.
  const [overviewType, setOverviewType] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceTimeline | null>(null);
  // The matching attendance + SPL records (same serviceKey) for the combined report.
  const [attendance, setAttendance] = useState<ServiceAttendance | null>(null);
  const [spl, setSpl] = useState<ServiceSplHistory | null>(null);
  // Baptism sessions (cross-linked to a service by time overlap).
  const [baptisms, setBaptisms] = useState<BaptismSession[]>([]);
  // Attendance records for all services — for the Overview card's avg in-room.
  const [attList, setAttList] = useState<ServiceAttendance[]>([]);
  /** One level per service — the SPL trend line's data. A summary, not the
   *  archive: see splHistoryStore.summary(). */
  const [splList, setSplList] = useState<SplServiceSummary[]>([]);
  const [splTrend, setSplTrend] = useState<{ shown: boolean; metric: string | null }>({
    shown: false,
    metric: null,
  });

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

  /** Persist a trend-line preference and apply it immediately. Optimistic, then
   *  reconciled with what the server actually stored — the same shape every other
   *  setting in this app is written with. */
  function saveSplTrend(patch: { shown?: boolean; metric?: string | null }) {
    setSplTrend((prev) => ({ ...prev, ...patch }));
    invoke<{ shown: boolean; metric: string | null }>("spl:setTrendPrefs", patch)
      .then((p) => setSplTrend(p))
      .catch(() => {
        toast.error("Could not save the SPL trend setting");
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
    invoke<SplServiceSummary[]>("spl:getSummary")
      .then((r) => setSplList(r ?? []))
      .catch(() => setSplList([]));
    invoke<{ shown: boolean; metric: string | null }>("spl:getTrendPrefs")
      .then((p) => setSplTrend(p))
      .catch(() => {
        /* the chart draws without the line; the toggle is still offered */
      });
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
    if (overviewType) return overviewType;
    if (selectedKey) {
      const s = (list ?? []).find((x) => x.serviceKey === selectedKey);
      if (s) return s.serviceTypeId;
    }
    if (day) {
      const s = (list ?? []).find((x) => x.serviceDate === day);
      if (s) return s.serviceTypeId;
    }
    return (list ?? [])[0]?.serviceTypeId ?? null;
  }, [overviewType, selectedKey, day, list]);
  /** Every service type in the history, for the Overview scope picker. Only worth
   *  showing when there is more than one — a single-type church should not see a
   *  control with one option in it. */
  const serviceTypes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of list ?? []) {
      if (s.serviceTypeId && !seen.has(s.serviceTypeId)) {
        seen.set(s.serviceTypeId, s.serviceTypeName ?? s.serviceTypeId);
      }
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [list]);

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
  // Delegates to the shared derivation - Home shows the same headline figures,
  // and two implementations is how two screens come to disagree about one number.
  const overview = useMemo<OverviewData>(
    () =>
      computeOverview(list, attList, day, activeType, activeTypeName, { splList, splMetric: splTrend.metric }),
    [list, attList, day, activeType, activeTypeName, splList, splTrend.metric],
  );

  async function deleteService(key: string, title: string) {
    // Names all three, because it deletes all three. It always meant to: the
    // timing, SPL and attendance records are one recording split across three
    // stores, and a dialog that promised only the timings while the other two
    // silently stayed behind was the more honest half of a real bug.
    if (!(await confirm({
      title: "Delete recording?",
      message: `Delete the recording for "${title}" — service timings, SPL and attendance? This can't be undone. The raw samples in the data archive are kept.`,
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    setList((prev) => (prev ? prev.filter((s) => s.serviceKey !== key) : prev));
    if (selectedKey === key) setSelectedKey(null);
    try {
      await invoke("serviceTimeline:delete", { serviceKey: key });
    } catch (e) {
      // Say why. The row reappearing on its own — which is all this used to do —
      // reads as a glitch, and the most likely reason for a refusal is one the
      // operator can act on: the service is still recording.
      reload();
      toast.error(`Couldn't delete that recording: ${errorMessage(e)}`);
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
        toast.error(`Couldn't update times: ${errorMessage(e)}`);
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
        toast.error(`Merge failed: ${errorMessage(e)}`);
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
            Overview{activeTypeName ? ` · ${activeTypeName}` : ""}{day ? ` · through ${fmtDay(day)}` : " · all time"}
          </span>
          {serviceTypes.length > 1 && (
            <select
              value={overviewType ?? ""}
              onChange={(e) => setOverviewType(e.target.value || null)}
              aria-label="Overview service type"
              className="h-6 rounded-md border border-line-strong bg-field px-1.5 text-caption2 text-fg focus:border-focus focus:outline-none"
            >
              <option value="">Follow selection</option>
              {serviceTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
        </div>
        <OverviewBlend overview={overview} splTrend={splTrend} onSplTrend={saveSplTrend} />
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
              // su-card, like every other top-level box on this page (Export, the
              // Overview, the calendar, the selected-day summary). These rows had
              // their own `bg-gray-2` + `rounded-lg` treatment, so the one column
              // an operator actually reads down was the one thing that did not
              // match the surface around it. The recessed grey is still right for
              // the Stat tiles and the time editor — those sit INSIDE a card, and
              // giving them the parent's surface would flatten the nesting.
              <div key={s.serviceKey} className="flex items-center gap-1 su-card pr-1.5 hover:bg-fill transition-colors">
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

/** "+12%" / "−12%" — the sign+magnitude spelling every percentage trend uses.
 *  `fallback` covers "there's a direction but no percentage" (a zero prior
 *  mean — `computeTrend` already turns that case into `pct: null`). */
function fmtTrendPct(pct: number | null, fallback = ""): string {
  return pct != null ? `${pct >= 0 ? "+" : "−"}${Math.round(Math.abs(pct) * 100)}%` : fallback;
}

/** "vs the prior 4 Weekends" / "vs the prior 1 Weekend" — the tail every
 *  trend readout in the Overview ends with, once for both of them rather than
 *  copied into the attendance trend and the SPL delta separately. */
function vsPrior(priorCount: number, scopeName: string | null): string {
  const noun = scopeName ?? "service";
  return `vs the prior ${priorCount} ${noun}${priorCount === 1 ? "" : "s"}`;
}

/**
 * Real triangle glyph (▲/▼) + trailing text, in a semantic status color.
 *
 * The one spelling of "direction + color + words": the attendance trend, the
 * SPL delta beneath it, and this instrument strip's own cell were three
 * copies of the same markup, and `SplDelta`'s arrow shipped hard-coded to
 * `trendColor("neutral")` in one of the three while the other two still took
 * a `tone`.
 *
 * `dir` is optional so a caller can render NO arrow at all — `SplDelta.dir`
 * has a third state, "flat", for exactly that: a change too small to be a
 * real direction, drawn with no glyph rather than an uncoloured, misleading
 * one (this block is never coloured by tone, so a wrong arrow here has
 * nothing else to soften it).
 */
function TrendChip({
  dir,
  tone,
  text,
  className,
}: {
  dir?: "up" | "down";
  tone: TrendTone;
  text: string;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1.5 text-caption1", trendColor(tone), className)}>
      {dir && <span aria-hidden="true">{dir === "up" ? "▲" : "▼"}</span>}
      {text && <span>{text}</span>}
    </span>
  );
}

/** The Overview blend: a lead stat (avg attendance) with a colored trend line, a
 *  real attendance trend chart, and a divided instrument stat strip below.
 *
 *  Exported for its own tests: the History section around it fetches, and the
 *  parts worth guarding — the right-click menu against the chart's hover, and
 *  whether the SPL summary is there at all — are in this component alone. */
export function OverviewBlend({
  overview,
  splTrend,
  onSplTrend,
}: {
  overview: OverviewData;
  splTrend: { shown: boolean; metric: string | null };
  onSplTrend: (patch: { shown?: boolean; metric?: string | null }) => void;
}) {
  /** Where the chart's right-click menu is, or null. */
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number } | null>(null);
  /** The menu the chart offers: the line on or off, and which metric it plots.
   *  The metric list comes from the data in scope — see OverviewData.splMetrics —
   *  so it offers exactly the metrics there is something to draw for. */
  const chartMenuItems: ContextMenuItem[] = [
    {
      label: "SPL trend line",
      checked: splTrend.shown,
      onSelect: () => onSplTrend({ shown: !splTrend.shown }),
    },
  ];
  if (splTrend.shown && overview.splMetrics.length > 0) {
    chartMenuItems.push({
      label: "Metric",
      items: overview.splMetrics.map((m) => ({
        label: m,
        checked: overview.splMetric === m,
        onSelect: () => {
          onSplTrend({ metric: m });
          setChartMenu(null);
        },
      })),
    });
  }

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
            <TrendChip
              dir={overview.attTrend.dir}
              tone={overview.attTrend.tone}
              text={`${fmtTrendPct(overview.attTrend.pct, "changed")} ${vsPrior(overview.attTrend.priorCount, overview.scopeName)}`}
              className="mt-2"
            />
          )}
          {/* The level, read the same way, so the SPL line has a summary of its
              own instead of one attendance figure over a chart with two series
              in it. Present only when the line is drawn AND there is a level to
              report — no dash, which would read as a measured silence. */}
          {splTrend.shown && overview.avgSpl != null && (
            <div className="mt-5" data-testid="spl-summary">
              <div className="flex items-center gap-1.5 text-caption1 uppercase tracking-[0.08em] text-fg-muted">
                {/* The series' own colour, the same dot the chart's tooltip
                    carries, so this says which line it is summarising without
                    needing a legend. */}
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--su-ok-9)" }} />
                Avg SPL
              </div>
              <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums text-[2.5rem] leading-none font-medium text-fg tracking-tight">
                <span>{overview.avgSpl.toFixed(1)}</span>
                <span className="text-caption1 font-normal text-fg-muted">dB</span>
              </div>
              {overview.splDelta && (
                // NEUTRAL, always — see SplDelta. A louder weekend is not a
                // worse one, so this never goes red. Decibels, not a
                // percentage: a percentage of a logarithmic quantity says
                // nothing about how loud it was. The sign comes from `dir`,
                // never recomputed from `db` — one fact, one place to read it,
                // so the glyph and the sign can't disagree about which way a
                // level moved.
                <TrendChip
                  dir={overview.splDelta.dir === "flat" ? undefined : overview.splDelta.dir}
                  tone="neutral"
                  text={`${overview.splDelta.dir === "up" ? "+" : overview.splDelta.dir === "down" ? "−" : "±"}${Math.abs(overview.splDelta.db).toFixed(1)} dB ${vsPrior(overview.splDelta.priorCount, overview.scopeName)}`}
                  className="mt-2"
                />
              )}
            </div>
          )}
        </div>
        <div
          className="flex-1 min-w-0 md:max-w-[640px]"
          onContextMenu={(e) => {
            e.preventDefault();
            setChartMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <AttendanceTrendChart
            points={overview.attPoints}
            splLabel={splTrend.shown ? overview.splMetric : null}
            // The chart tracked the pointer underneath the menu it had just
            // opened: the tooltip drew through the menu and moved as you
            // reached for an item.
            hoverSuppressed={chartMenu != null}
          />
        </div>
        {chartMenu && (
          <ContextMenu
            x={chartMenu.x}
            y={chartMenu.y}
            items={chartMenuItems}
            onClose={() => setChartMenu(null)}
          />
        )}
      </div>
      {/* Wrapping grid so the readouts never collide: 2 cols on mobile, 3 at sm,
          all at lg. Value + trend can wrap within a cell rather than overrun. */}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-5">
        {strip.map((s) => (
          <div key={s.k} className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">{s.k}</div>
            <div className={`mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-mono tabular-nums text-lg ${s.accent ?? "text-fg"}`}>
              <span>{s.v}</span>
              {s.trend && (
                <TrendChip dir={s.trend.dir} tone={s.trend.tone} text={s.trendLabel ?? fmtTrendPct(s.trend.pct)} />
              )}
            </div>
          </div>
        ))}
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
