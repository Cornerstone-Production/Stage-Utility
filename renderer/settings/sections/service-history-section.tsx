import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useRef, useState } from "react";
import { linkBaptisms, baptismStats } from "../../lib/link-baptisms";
import { cn } from "../../lib/cn";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip } from "../../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { Trash2Icon, ClockIcon, DownloadIcon, EllipsisIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows, Button, Collapsible, toast, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { HistoryCalendar } from "../../components/history-calendar";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { useContextMenuTrigger } from "../../components/ui/context-menu-trigger";
import { useCoarsePointer } from "../../lib/use-media-query";
import { AttendanceDetail, averageOccupancy } from "./attendance-history-section";
import { SplDetail, SPL_METRICS_STORAGE_KEY, primaryMetricOf } from "./spl-history-section";
import { RecordingPill, ServiceHeader, overrunStats, serviceRowFigures } from "./history-service-header";
import { useStoredKeysVersion } from "./history-chart";
import { TrendsCard } from "./history-trends/trends-card";
import type { TrendRecording } from "./history-trends/trends";
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

/** ISO → local "HH:MM:SS", for an item field. Seconds, unlike the service window
 *  above: an item's whole point is its DURATION, and a minute-resolution field
 *  cannot say "two minutes" about something that started at 20:15:33. */
function toItemTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Local "HH:MM[:SS]" on the same local DAY as `anchorIso` → ISO.
 *
 * Anchored on the item's OWN recorded stamp rather than the record's
 * serviceDate, so an item that ran after midnight keeps its own date instead of
 * being dragged back to the day the service started on.
 */
function fromItemTimeInput(anchorIso: string | null, hhmmss: string): string | undefined {
  if (!hhmmss) return undefined;
  const anchor = anchorIso ? new Date(anchorIso) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) return undefined;
  const [h, m, sec] = hhmmss.split(":");
  const d = new Date(anchor);
  d.setHours(Number(h), Number(m), Number(sec ?? 0), 0);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A row's identity in the edit-times form. An item can run twice in one record,
 *  so the id alone would stack two rows' fields on top of each other. */
function rowKey(it: ServiceTimelineItem): string {
  return `${it.itemId}:${it.sequence}`;
}

/** "recorded 11:22, edited to 2:00" — the durations, which is what the operator
 *  changed. Falls back to the stamps when either side is still open and there is
 *  no duration to compare.
 *
 *  Exported so a test can assert the string: a Radix tooltip's text is in the
 *  DOM only while it is open, and opening one needs a pointer jsdom has not got. */
export function editedTooltip(it: ServiceTimelineItem): string {
  const was = it.editedFrom;
  if (!was) return "";
  if (was.actualDurationSec != null && it.actualDurationSec != null) {
    return `recorded ${fmtDur(was.actualDurationSec)}, edited to ${fmtDur(it.actualDurationSec)}`;
  }
  const span = (start: string, end: string | null) => `${fmtTime(start)}–${end ? fmtTime(end) : "still running"}`;
  return `recorded ${span(was.startedAt, was.endedAt)}, edited to ${span(it.startedAt, it.endedAt)}`;
}






/** One record's share of a Rebuild from raw — mirrors RebuiltRecord in
 *  main/services/history-edit.ts. */
interface RebuiltRecord {
  rebuilt: boolean;
  items: number;
  missing: boolean;
}
interface RebuildOutcome {
  timeline: RebuiltRecord;
  spl: RebuiltRecord;
  attendance: RebuiltRecord;
  failed: string[];
}

/** The three legs and the noun each one counts, in the order they are reported. */
const REBUILD_LEGS = [
  ["timeline", "item timings"],
  ["spl", "SPL items"],
  ["attendance", "attendance samples"],
] as const;

/**
 * What a rebuild actually did, in a sentence.
 *
 * Says what was LEFT ALONE, not only what was derived. A bare count read as an
 * achievement even for a record the raw layer had nothing for — which is how a
 * rebuild that changed nothing once reported "Rebuilt: 12 items".
 */
export function describeRebuild(out: RebuildOutcome): string {
  const done = REBUILD_LEGS.filter(([k]) => out[k].rebuilt).map(([k, noun]) => `${out[k].items} ${noun}`);
  const left = REBUILD_LEGS.filter(([k]) => !out[k].rebuilt && !out[k].missing).map(([, noun]) => noun);
  const parts = [done.length ? `Rebuilt: ${done.join(", ")}` : "Nothing was rebuilt"];
  if (left.length) parts.push(`left alone: ${left.join(", ")}`);
  if (out.failed.length) parts.push(`could not save: ${out.failed.join(", ")}`);
  return parts.join(" · ");
}

/** Baptism sessions that overlap a service's recorded window. */
/** A plain-text service report combining timing + attendance + audio + baptisms (shareable). */
export function buildReport(tl: ServiceTimeline, att: ServiceAttendance | null, spl: ServiceSplHistory | null, baptisms: BaptismSession[] = []): string {
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
    // `averageOccupancy`, the SAME derivation the Attendance card's Average
    // figure uses. This averaged every sample instead, which is the bug that
    // function was written to fix — the arrival ramp and the emptying-room
    // taper are both long and both near-empty, so the mean lands BELOW the
    // recorded low. On the 17 Sep recording the pasted report said "Avg in-room
    // 781" for a service whose Lowest was 933, under a card reading 1,164. The
    // card was fixed and this copy drifted on.
    const avgOcc = averageOccupancy(att);
    L.push("", "ATTENDANCE");
    // Attendance is people in the room; entries is how many came in during the
    // service. This had them swapped — a pasted report said "Peak attendance
    // 2,061 · Peak in-room 1,196" for a service that recorded a peak of 1,196
    // in the room and 1,727 through the doors. Both are the recorder's own
    // stored fields, so the report and the screen cannot disagree.
    L.push(`Peak attendance ${att.peakOccupancy.toLocaleString()} · Entries ${att.peakAttendance.toLocaleString()}${avgOcc != null ? ` · Avg in-room ${avgOcc.toLocaleString()}` : ""}`);
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
/**
 * One row in the day list — a service occurrence with EITHER (or both) of its
 * two possible records. A timeline record starts when the first PCO item goes
 * live; the attendance recorder opens its own record an hour earlier, at the
 * start of the pre-service arrival ramp (see attendance-recorder.ts), so a
 * service that hasn't gone live yet has attendance but no timeline. Union'd on
 * `serviceKey` so that service is still one row, not a missing one.
 */
interface HistoryRow {
  serviceKey: string;
  serviceDate: string;
  serviceTypeId: string | null;
  serviceTypeName?: string | null;
  planTitle: string | null;
  startsAt: string | null;
  timeline: ServiceTimeline | null;
  attendance: ServiceAttendance | null;
}

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
  /**
   * The Overview's level preference. Only `metric` is read now — `shown` gated a
   * trend line on a chart this page no longer draws, and then a figure that has
   * no reason to be hidden. It is not deleted: it is the operator's own stored
   * choice, and deleting somebody's data to tidy something up is not a thing
   * this repo does. Nothing writes it any more. Same treatment as
   * settings.splVisibleMetrics, for the same reason.
   */
  const [splTrend, setSplTrend] = useState<{ shown: boolean; metric: string | null }>({
    shown: false,
    metric: null,
  });

  // A live-updating mirror of selectedKey for the service-timeline:history
  // handler below, which subscribes once (empty deps) and would otherwise only
  // ever see the selectedKey from the render it mounted in.
  const selectedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  const [day, setDay] = useState<string | null>(null);
  // Editing the service window (times) in the detail view.
  const [editingTimes, setEditingTimes] = useState(false);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  /** Per-row time fields, keyed by rowKey(), holding ONLY what the operator has
   *  typed. A row with no entry renders from the record, so a save (or another
   *  operator's edit arriving over SSE) drops through without clobbering a row
   *  being typed in elsewhere in the table. */
  const [itemTimeDraft, setItemTimeDraft] = useState<Record<string, { start: string; end: string }>>({});
  /** Rows with a save in flight, so a double-click cannot send two. */
  const [itemTimeSaving, setItemTimeSaving] = useState<Set<string>>(new Set());
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
      setDetail((d) => {
        if (d && d.serviceKey === rec.serviceKey) return rec;
        // The service just went live — its timeline record now exists where a
        // moment ago there was only an attendance one. If that's the record
        // open right now (as the attendance-only branch, `d` still null), swap
        // straight to the full detail instead of leaving it stuck showing the
        // arrival-only view.
        if (d == null && selectedKeyRef.current === rec.serviceKey) return rec;
        return d;
      });
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
  // One row per service occurrence — the union of timeline records and any
  // attendance record with no timeline record of the same serviceKey (the
  // arrival ramp, recorded before the first PCO item goes live). See
  // HistoryRow above. Everything the day list, the calendar and the service-type
  // picker are built from; the Overview's computed averages are NOT — those stay
  // on `computeOverview(list, attList, …)` below, over settled timeline records
  // only, exactly as before this change.
  const rows = useMemo<HistoryRow[]>(() => {
    const tlKeys = new Set((list ?? []).map((t) => t.serviceKey));
    const tlRows: HistoryRow[] = (list ?? []).map((t) => ({
      serviceKey: t.serviceKey,
      serviceDate: t.serviceDate,
      serviceTypeId: t.serviceTypeId,
      serviceTypeName: t.serviceTypeName,
      planTitle: t.planTitle,
      startsAt: t.serviceTimeStartsAt ?? t.startedAt,
      timeline: t,
      attendance: attList.find((a) => a.serviceKey === t.serviceKey) ?? null,
    }));
    const attOnlyRows: HistoryRow[] = attList
      .filter((a) => !tlKeys.has(a.serviceKey))
      .map((a) => ({
        serviceKey: a.serviceKey,
        serviceDate: a.serviceDate,
        serviceTypeId: a.serviceTypeId,
        serviceTypeName: a.serviceTypeName,
        planTitle: a.planTitle,
        startsAt: a.serviceTimeStartsAt ?? a.startedAt,
        timeline: null,
        attendance: a,
      }));
    return [...tlRows, ...attOnlyRows].sort((a, b) => Date.parse(b.startsAt ?? "") - Date.parse(a.startsAt ?? ""));
  }, [list, attList]);
  /**
   * The same recordings, reduced to what the Trends card draws from.
   *
   * Derived from `rows` rather than fetched: the list already holds every
   * timeline record and every attendance record, and a trend is those grouped
   * by service type instead of by day. There is no route for trend data and
   * there does not need to be one.
   *
   * A row with no attendance record carries a null peak and is not plotted — a
   * service nobody counted is not a service of zero people.
   */
  /** The rows AND the Trends card's sound measure follow the Sound card's
   *  metric choice, which lives in localStorage and is written by a component
   *  React knows nothing about — the same dependency the service header carries
   *  for the same reason. Declared here, above every reader: it is a `const`,
   *  so a use further up the body is a temporal-dead-zone throw, not a stale
   *  value. */
  const metricsVersion = useStoredKeysVersion(SPL_METRICS_STORAGE_KEY);

  const trendRecordings = useMemo<TrendRecording[]>(
    () => {
      // Read so the subscription is not "unused". The VALUE is never wanted;
      // the hook's own state update is what re-renders when Customize writes a
      // different metric, and without it the chart and the rows would go on
      // quoting the old metric's peak until the page was reopened.
      void metricsVersion;
      const splByKey = new Map(splList.map((x) => [x.serviceKey, x]));
      return rows.map((r) => {
        // The SPL SUMMARY, not the record. It is already loaded for this page,
        // it carries a peak per metric (see SplServiceSummary.metrics), and the
        // trend plots one point per recording across up to 52 weeks — fetching
        // every full record for that would be hundreds of files to answer one
        // number each. The primary-metric rule is the rows' own, imported, so
        // the chart and a row cannot name different metrics.
        const summary = splByKey.get(r.serviceKey);
        const metric = summary ? primaryMetricOf(Object.keys(summary.metrics)) : null;
        return {
          serviceKey: r.serviceKey,
          serviceTypeId: r.serviceTypeId,
          serviceTypeName: r.serviceTypeName ?? null,
          serviceDate: r.serviceDate,
          t: Date.parse(r.startsAt ?? `${r.serviceDate}T00:00:00`),
          seriesTitle: r.timeline?.seriesTitle ?? r.attendance?.seriesTitle ?? null,
          peakOccupancy: r.attendance && r.attendance.peakOccupancy > 0 ? r.attendance.peakOccupancy : null,
          peakDb: (metric && summary ? summary.metrics[metric]?.max : null) ?? null,
        };
      });
    },
    [rows, splList, metricsVersion],
  );

  /** The row for the current selection, if any — known synchronously from `list`/
   *  `attList` (no fetch to wait on), so it tells the detail view whether a
   *  timeline record is ever coming for this key without racing `detail`'s own
   *  async load (see the `!detail && attendance` branch below). */
  const selectedRow = useMemo(
    () => rows.find((r) => r.serviceKey === selectedKey) ?? null,
    [rows, selectedKey],
  );

  // Live also while the open detail is an attendance-only record (no timeline
  // yet) — `detail` stays null for that branch, so its liveness comes from
  // `attendance` instead, but only when `detail` really has nothing to say
  // (an attendance-only selection never populates `detail` at all).
  const detailLive = detail != null ? detail.endedAt == null : attendance != null && attendance.endedAt == null;
  const listLive = rows.some((r) => (r.timeline ?? r.attendance)?.endedAt == null);
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
  // day's service), and defaults to the most recent service's type (rows is sorted
  // newest-first; `day` auto-selects the newest day, so this lands on "most recent"
  // out of the box). Keeps each type's averages separate without a manual filter.
  const activeType = useMemo<string | null>(() => {
    if (overviewType) return overviewType;
    if (selectedKey) {
      const s = rows.find((x) => x.serviceKey === selectedKey);
      if (s) return s.serviceTypeId;
    }
    if (day) {
      const s = rows.find((x) => x.serviceDate === day);
      if (s) return s.serviceTypeId;
    }
    return rows[0]?.serviceTypeId ?? null;
  }, [overviewType, selectedKey, day, rows]);
  /** Every service type in the history, for the Overview scope picker. Only worth
   *  showing when there is more than one — a single-type church should not see a
   *  control with one option in it. */
  const serviceTypes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of rows) {
      if (s.serviceTypeId && !seen.has(s.serviceTypeId)) {
        seen.set(s.serviceTypeId, s.serviceTypeName ?? s.serviceTypeId);
      }
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const activeTypeName = useMemo<string | null>(() => {
    if (!activeType) return null;
    const s = rows.find((x) => x.serviceTypeId === activeType);
    return s?.serviceTypeName ?? activeType;
  }, [rows, activeType]);

  // All services — the calendar and day list stay global so you can navigate to any
  // service; only the overview scopes to activeType (below).
  const filtered = rows;

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const s of filtered) set.add(s.serviceDate);
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [filtered]);

  // Follow the newest day until the operator picks one; also re-select when the
  // filter drops the current day. FOLLOW, not select-once: the timeline list and
  // the attendance list arrive separately, and the newest day can change when the
  // second one lands — today's arrival ramp is an attendance-only day that did not
  // exist when the timeline list chose yesterday. A day the operator clicked is
  // theirs and is left alone.
  const [dayPicked, setDayPicked] = useState(false);
  useResyncOn([days, day, dayPicked], () => {
    if (days.length === 0) return;
    if (day == null || !days.includes(day) || (!dayPicked && day !== days[0])) setDay(days[0]);
  });
  const pickDay = (d: string) => {
    setDayPicked(true);
    setDay(d);
  };

  const dayServices = useMemo(() => filtered.filter((s) => s.serviceDate === day), [filtered, day]);

  /**
   * The SPL record behind each of the SELECTED DAY's rows, so a row's peak
   * level is the same figure the service page's header quotes.
   *
   * Per day rather than for the whole history on purpose: `spl:getSummary`
   * (already loaded, above) carries a service-level Leq per metric and no PEAK
   * at all, so a row built from it would be labelled "Peak" and be showing an
   * energy average. The full record is the only thing that has the peak, and a
   * day is one to four of them — not a year of them.
   *
   * A FAILED read and a service that recorded no sound are told apart. Both
   * used to land as `null`, which `servicePeakLevel` reads as "no sound
   * recorded" — so a server that was down, or a request that timed out, told
   * the operator their meter had not been recording. `"error"` is its own
   * state, the row says "sound unavailable", and the reason is logged per key.
   */
  type RowSpl = ServiceSplHistory | null | "error";
  const [splByKey, setSplByKey] = useState<Map<string, RowSpl>>(new Map());
  // The key list, as a stable string: `dayServices` is a fresh array every
  // render and would refetch the day's SPL on each one.
  const dayKeys = dayServices.map((s) => s.serviceKey).join("|");
  useEffect(() => {
    const keys = dayKeys ? dayKeys.split("|") : [];
    // Nothing to fetch, and nothing to clear: every lookup is by serviceKey, so
    // a map left over from the previous day can only ever miss. Clearing it here
    // would be a setState in an effect body — a cascading render — to no end.
    if (!keys.length) return;
    let cancelled = false;
    Promise.all(
      keys.map((key) =>
        invoke<ServiceSplHistory | null>("spl:getHistory", { serviceKey: key })
          .then((rec) => [key, rec] as const)
          .catch((err): readonly [string, RowSpl] => {
            // One line per key that failed, not one for the batch: a day where
            // one of three services will not load is a different problem from a
            // day where none of them will, and the line has to say which.
            console.warn(`[history] could not read the sound record for ${key}: ${errorMessage(err)}`);
            return [key, "error"] as const;
          }),
      ),
    ).then((pairs) => {
      if (!cancelled) setSplByKey(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [dayKeys, reloadKey]);

  // Per-day service counts for the calendar (respects the type filter).
  const dateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of filtered) m.set(s.serviceDate, (m.get(s.serviceDate) ?? 0) + 1);
    return m;
  }, [filtered]);

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
    // deleteServiceRecords removes the attendance record too (same serviceKey,
    // one of the three stores it always names in the confirm dialog above) — if
    // this row is attendance-only, it would otherwise resurrect itself the
    // instant `rows` recomputes, from an attList entry nothing ever cleared.
    setAttList((prev) => prev.filter((a) => a.serviceKey !== key));
    if (selectedKey === key) setSelectedKey(null);
    try {
      await invoke("serviceTimeline:delete", { serviceKey: key });
    } catch (e) {
      // Say why. The row reappearing on its own — which is all this used to do —
      // reads as a glitch, and the most likely reason for a refusal is one the
      // operator can act on: the service is still recording.
      reload();
      invoke<ServiceAttendance[]>("attendance:listHistory")
        .then((a) => setAttList(a ?? []))
        .catch(() => {
          /* the optimistic removal above just stays applied */
        });
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

  if (rows.length === 0) {
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
    // The service-level timing figures live in the header now — `serviceKpis`
    // derives every one of them from the record, so nothing here recomputes
    // them. Leaving the tiles in place beside the header put Started, Planned,
    // Actual and Avg overrun on screen twice.
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
      setItemTimeDraft({}); // rows render from the record until they are typed in
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
    async function rebuildFromRaw() {
      if (!(await confirm({
        title: "Rebuild from raw?",
        message:
          "Recomputes this recording's item timings, sound levels and attendance from the raw rows in the data archive. Your per-item time corrections are kept — they sit over the rebuilt run. The raw rows themselves are not touched.",
        confirmLabel: "Rebuild",
        destructive: true,
      }))) return;
      try {
        const out = await invoke<RebuildOutcome>("history:rebuild", { serviceKey: det.serviceKey });
        setReloadKey((k) => k + 1);
        // Names what was LEFT ALONE as well as what was derived. A count on its
        // own read as an achievement even for a record the raw layer had
        // nothing for, which is exactly how a rebuild that changed nothing
        // reported "Rebuilt: 12 items".
        const msg = describeRebuild(out);
        if (out.failed.length) toast.error(msg);
        else toast.success(msg);
      } catch (e) {
        // Say why. The most likely refusal — the service is still recording —
        // is one the operator can act on.
        toast.error(`Rebuild failed: ${errorMessage(e)}`);
      }
    }
    async function doResetPacing() {
      if (!(await confirm({
        title: "Reset pacing?",
        message: "Items before now stop counting toward the pacing readout. The recording itself is untouched.",
        confirmLabel: "Reset pacing",
      }))) return;
      try {
        await invoke("serviceTimeline:resetPacing");
        toast.success("Pacing reset");
        // Broadcasts service-timeline:history → detail refreshes via the SSE handler.
      } catch (e) {
        toast.error(`Couldn't reset pacing: ${errorMessage(e)}`);
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
    /** The values a row's two fields show: what has been typed, else the record. */
    function draftFor(it: ServiceTimelineItem): { start: string; end: string } {
      return itemTimeDraft[rowKey(it)] ?? { start: toItemTimeInput(it.startedAt), end: toItemTimeInput(it.endedAt) };
    }
    function setDraft(it: ServiceTimelineItem, patch: Partial<{ start: string; end: string }>) {
      const key = rowKey(it);
      setItemTimeDraft((d) => ({ ...d, [key]: { ...draftFor(it), ...patch } }));
    }
    function itemTimesDirty(it: ServiceTimelineItem): boolean {
      const d = itemTimeDraft[rowKey(it)];
      if (!d) return false;
      return d.start !== toItemTimeInput(it.startedAt) || d.end !== toItemTimeInput(it.endedAt);
    }

    /**
     * Save ONE row.
     *
     * Per row rather than one Save for the whole table, unlike the service
     * window form above it. That form posts a single request carrying both of
     * its fields; item corrections are one request per row, so a single Save
     * would fan out N of them and could half-succeed — and there is no honest
     * thing to put in the toast when it does. The counted checkbox in the same
     * row already commits on its own for the same reason.
     */
    async function saveItemTimes(it: ServiceTimelineItem) {
      const key = rowKey(it);
      if (itemTimeSaving.has(key)) return;
      const d = draftFor(it);
      // The RECORDED stamps — what the fields are compared against, and the anchor
      // for the date an HH:MM:SS is put back onto.
      const wasStart = it.editedFrom?.startedAt ?? it.startedAt;
      const wasEnd = it.editedFrom?.endedAt ?? it.endedAt;
      /**
       * null for a field that still reads what was recorded.
       *
       * Not merely tidy: the fields carry whole seconds and the recorder writes
       * milliseconds, so sending an untouched Started back put a 0.9s override on
       * it — the row was marked edited for a field nobody touched, and Reset had
       * something to undo that had never been done. A blank field clears the
       * override too, rather than meaning midnight.
       *
       * `recorded` being null means the recorder never wrote that stamp — an item
       * still on air has no end — so there is nothing for a typed value to match
       * and ANY typed value is an edit. Comparing against the start instead, as
       * this used to, meant typing the item's own start time into its empty Ended
       * field silently cleared the field rather than saving it. The start is
       * still the DATE the time is put back onto, which is all it was ever good
       * for here.
       */
      const field = (typed: string, recorded: string | null) => {
        if (!typed) return null;
        if (recorded != null && typed === toItemTimeInput(recorded)) return null;
        return fromItemTimeInput(recorded ?? it.startedAt, typed) ?? null;
      };
      const startedAt = field(d.start, wasStart);
      const endedAt = field(d.end, wasEnd);
      setItemTimeSaving((s) => new Set(s).add(key));
      try {
        const saved = await invoke<ServiceTimeline>("history:setItemTimes", {
          serviceKey: det.serviceKey,
          itemId: it.itemId,
          sequence: it.sequence,
          startedAt,
          endedAt,
        });
        // Drop the draft so the row re-renders from the record.
        setItemTimeDraft((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        // Render what the ROUTE answered rather than waiting for the broadcast.
        // The answer is the authority — it is the record the server actually
        // stored, overlay applied — and relying on the SSE push meant the row
        // sat on its old value for as long as the round trip took, and did not
        // update at all on a client whose stream had dropped. The push still
        // arrives and still agrees; this just does not need it.
        if (saved && typeof saved === "object" && Array.isArray(saved.items)) setDetail(saved);
        toast.success("Item times updated");
      } catch (e) {
        toast.error(`Couldn't update this item: ${errorMessage(e)}`);
      } finally {
        setItemTimeSaving((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    }

    /** Clear a row's override: the recorded times come back. */
    async function resetItemTimes(it: ServiceTimelineItem) {
      const key = rowKey(it);
      try {
        const saved = await invoke<ServiceTimeline>("history:setItemTimes", {
          serviceKey: det.serviceKey,
          itemId: it.itemId,
          sequence: it.sequence,
          startedAt: null,
          endedAt: null,
        });
        // Reset discards what was typed as well as what was stored — that is what
        // makes it reachable on a dirty row: "put it back" has to work while the
        // fields are mid-edit, which is exactly when an operator wants it.
        setItemTimeDraft((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        if (saved && typeof saved === "object" && Array.isArray(saved.items)) setDetail(saved);
        toast.success("Item times reset to the recording");
      } catch (e) {
        toast.error(`Couldn't reset this item: ${errorMessage(e)}`);
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
    // Mobile drops #, Plan, Started and Ended (see the max-sm:hidden cells) so the
    // item name isn't crushed; sm+ shows the full grid. Templates must match the
    // visible cells. Started and Ended are wider in edit mode because they hold an
    // HH:MM:SS field there rather than a formatted time.
    const gridCols = editingTimes
      ? "grid-cols-[1.4rem_1fr_3.5rem_3rem] sm:grid-cols-[1.4rem_1.6rem_1fr_4rem_4rem_4rem_7rem_7rem]"
      : "grid-cols-[1fr_3.5rem_3rem] sm:grid-cols-[1.6rem_1fr_4rem_4rem_4rem_4.5rem_4.5rem]";
    // Series · service type · date · time, in one muted line. Blank parts drop
    // out rather than leaving a dangling separator.
    const metaLine = [
      detail.seriesTitle,
      detail.serviceTypeName,
      fmtDate(detail.startedAt),
      fmtTime(detail.serviceTimeStartsAt ?? detail.startedAt),
    ].filter(Boolean).join(" · ");
    return (
      <div className="flex flex-col gap-4">
        <ServiceHeader
          timeline={detail}
          attendance={attendance}
          spl={spl}
          now={nowTick}
          readOnly={readOnly}
          meta={metaLine}
          onBack={() => setSelectedKey(null)}
          onEditTimes={startEditTimes}
          onCopyReport={copyReport}
          onMerge={mergeCandidates.length > 0 ? () => { setMerging((v) => !v); setEditingTimes(false); } : undefined}
          onRebuild={rebuildFromRaw}
          onDelete={() => void deleteService(det.serviceKey, det.planTitle ?? det.serviceKey)}
          onResetPacing={doResetPacing}
        />
        {merging && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-warn-9/40 bg-warn-9/8 p-3">
            <label className="flex flex-col gap-1 text-caption2 text-fg-muted">
              Merge this recording into
              <Select value={mergeTarget} onValueChange={setMergeTarget}>
                <SelectTrigger className="h-auto rounded-md border-line-strong bg-field px-2 py-1 text-caption1 text-fg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Select a service…</SelectItem>
                  {mergeCandidates.map((s) => (
                    <SelectItem key={s.serviceKey} value={s.serviceKey}>
                      {(s.planTitle ?? s.serviceKey)}{fmtTime(s.serviceTimeStartsAt ?? s.startedAt) ? ` · ${fmtTime(s.serviceTimeStartsAt ?? s.startedAt)}` : ""} · {s.items.length} items
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button variant="accent" size="small" disabled={!mergeTarget} onClick={doMerge}>Merge + delete this</Button>
            <Button variant="transparent" size="small" onClick={() => setMerging(false)}>Cancel</Button>
            <span className="text-caption2 text-fg-muted flex-1 min-w-[14rem]">
              Moves this recording's items + attendance samples into the chosen service (matching items aren't duplicated), then deletes this record. For reuniting a service split across two records (e.g. one that overran into the next occurrence).
            </span>
          </div>
        )}
        {editingTimes && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-fill/40 p-3">
            <label className="flex flex-col gap-1 text-caption2 text-fg-muted">
              Start
              <input type="time" value={editStart} onChange={(e) => setEditStart(e.target.value)} className="rounded-md border border-line-strong bg-field px-2 py-1 font-mono tabular-nums text-caption1 text-fg" />
            </label>
            <label className="flex flex-col gap-1 text-caption2 text-fg-muted">
              End
              <input type="time" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} className="rounded-md border border-line-strong bg-field px-2 py-1 font-mono tabular-nums text-caption1 text-fg" />
            </label>
            <Button variant="accent" size="small" onClick={saveTimes}>Save</Button>
            <Button variant="transparent" size="small" onClick={() => setEditingTimes(false)}>Cancel</Button>
            <Button variant="transparent" size="small" onClick={recalc} tooltip="Re-derive peak/min from samples without changing the window">Recalculate</Button>
            <span className="text-caption2 text-fg-muted flex-1 min-w-[14rem]">
              Trims attendance samples + SPL/timing items outside the window and recomputes peak, min, and durations. Applies to all three records for this service. Each item's own Started and Ended are editable in the table below — save a row to correct it, Reset to put the recorded times back; neighbouring items do not move. <strong className="font-medium text-fg">Rebuild from raw</strong>, in the header above, goes further: it discards the stored summaries and derives them again from the archived rows, keeping your item corrections.
            </span>
          </div>
        )}

        {/* Three cards under the header, one per nav anchor. The links are real
            anchors and the header is sticky; what keeps a jump from landing the
            heading UNDER the header is the scrolling pane's own scroll padding,
            measured from this header (shell.tsx). */}
        <SectionCard id="history-rundown" title="Rundown">
        {/* The app's type scale, not the table's own: 10px uppercase headers
            over 13px rows, every number mono and tabular so the columns line up
            down the page. The marks — live, not counted, edited — and the two
            row buttons were each on a bespoke 10px; they are on the scale's
            11px caption now. Nothing about what the table DOES changed. */}
        <div className="flex flex-col overflow-hidden rounded-lg border border-line">
          <div
            data-testid="rundown-header"
            className={`grid ${gridCols} gap-2 border-b border-line bg-fill px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle`}
          >
            {editingTimes && (
              <Tooltip label="Whether this item counts toward the service timers">
                <span className="text-center">✓</span>
              </Tooltip>
            )}
            <span className="max-sm:hidden">#</span><span>Item</span><span className="text-right max-sm:hidden">Plan</span><span className="text-right">Actual</span><span className="text-right">Δ</span><span className="text-right max-sm:hidden">Started</span><span className="text-right max-sm:hidden">Ended</span>
          </div>
          {detail.items.map((it, i) => {
            const itemLive = it.endedAt == null;
            const counted = isCountedItem(it, detail); // buffer + pre-service shown but not totaled
            const delta = it.plannedLengthSec != null && it.actualDurationSec != null ? it.actualDurationSec - it.plannedLengthSec : null;
            const deltaColor = delta == null ? "text-fg-subtle" : delta > 30 ? "text-danger-11" : delta < -30 ? "text-accent" : "text-fg-muted";
            // `editedFrom` is set by the server's overlay and only on a row that
            // actually differs from what was recorded — the marker cannot lie.
            const edited = it.editedFrom != null;
            const draft = draftFor(it);
            const dirty = itemTimesDirty(it);
            const saving = itemTimeSaving.has(rowKey(it));
            return (
              // Keyed by sequence too: a plan item can run twice in one record
              // (reprised, or a second service caught before the split), and a
              // duplicate React key drops the second row's state onto the first.
              <div key={`${it.itemId}:${it.sequence}`} className={`grid ${gridCols} items-center gap-2 px-3 py-1.5 text-footnote ${i % 2 ? "bg-fill/40" : ""} ${counted ? "" : "opacity-55"}`}>
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
                <span className="font-mono tabular-nums text-fg-subtle max-sm:hidden">{i + 1}</span>
                <span className="truncate text-fg">
                  {it.title || "—"}
                  {itemLive && <span className="ml-1.5 text-caption2 text-live-11">live</span>}
                  {!counted && <span className="ml-1.5 text-caption2 italic text-fg-subtle">not counted</span>}
                  {edited && (
                    <Tooltip label={editedTooltip(it)}>
                      <span className="ml-1.5 text-caption2 italic text-warn-11">edited</span>
                    </Tooltip>
                  )}
                  {editingTimes && dirty && (
                    <button
                      className="ml-2 rounded-md border border-accent px-1.5 py-px align-middle text-caption2 text-accent hover:bg-accent/10 max-sm:hidden"
                      disabled={saving}
                      aria-label={`Save times — ${it.title || "item"}`}
                      onClick={() => void saveItemTimes(it)}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  )}
                  {/* Offered whenever the row IS edited, dirty or not. Hidden
                      while dirty, an operator who started retyping had no way
                      back to the recording without first undoing their own
                      typing — and mid-edit is exactly when "put it back" is
                      wanted. Reset discards the draft along with the override. */}
                  {editingTimes && edited && (
                    <button
                      className="ml-2 rounded-md border border-line-strong px-1.5 py-px align-middle text-caption2 text-fg-muted hover:bg-fill max-sm:hidden"
                      aria-label={`Reset times — ${it.title || "item"}`}
                      onClick={() => void resetItemTimes(it)}
                    >
                      Reset
                    </button>
                  )}
                </span>
                <span className="text-right font-mono tabular-nums text-fg-muted max-sm:hidden">{counted ? fmtDur(it.plannedLengthSec) : "—"}</span>
                <span className="text-right font-mono tabular-nums text-fg">{itemLive ? "—" : fmtDur(it.actualDurationSec)}</span>
                <span className={`text-right font-mono tabular-nums ${deltaColor}`}>{!counted || itemLive ? "" : fmtDelta(delta)}</span>
                {editingTimes ? (
                  <>
                    {/* `placeholder` and `title` both: a time input shows no
                        placeholder in any browser that renders it natively, so
                        the hover text is the one an operator actually reads.
                        Clearing ONE field is how a single override is dropped
                        without touching the other — Reset drops both. */}
                    <input
                      type="time"
                      step="1"
                      aria-label={`Started — ${it.title || "item"}`}
                      placeholder="clear to use the recorded start"
                      title="Clear this field to go back to the recorded start"
                      value={draft.start}
                      onChange={(e) => setDraft(it, { start: e.target.value })}
                      className="max-sm:hidden rounded-md border border-line-strong bg-field px-1.5 py-0.5 font-mono tabular-nums text-caption2 text-fg"
                    />
                    <input
                      type="time"
                      step="1"
                      aria-label={`Ended — ${it.title || "item"}`}
                      placeholder="clear to use the recorded end"
                      title="Clear this field to go back to the recorded end"
                      value={draft.end}
                      onChange={(e) => setDraft(it, { end: e.target.value })}
                      className="max-sm:hidden rounded-md border border-line-strong bg-field px-1.5 py-0.5 font-mono tabular-nums text-caption2 text-fg"
                    />
                  </>
                ) : (
                  <>
                    <span className="whitespace-nowrap text-right font-mono tabular-nums text-fg-muted max-sm:hidden">{it.startedAt ? fmtTime(it.startedAt) : "—"}</span>
                    <span className="whitespace-nowrap text-right font-mono tabular-nums text-fg-muted max-sm:hidden">{it.endedAt ? fmtTime(it.endedAt) : "—"}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
        </SectionCard>

        {/* Baptism timings sit with the rundown above rather than after the audio:
            they are timing data, and on a baptism weekend they explain the overrun
            in the table right above them. Only rendered when a session links, so a
            normal service is unchanged — which is also why it is not in the
            section nav: a nav entry that is there most weeks and gone the rest
            reads as a bug. */}
        {linkedBap.length > 0 && (
          <SectionCard title="Baptisms">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Baptized" value={String(bapStats.people)} accent="text-fg" />
              <Stat label="Total time" value={fmtDur(bapStats.totalSec)} accent="text-accent" />
              <Stat label="Testimony total" value={fmtDur(bapStats.testimonySec)} accent="text-fg" />
              <Stat label="Baptism total" value={fmtDur(bapStats.baptismSec)} accent="text-fg" />
              <Stat label="Avg testimony" value={fmtDur(bapStats.avgTestimonySec)} accent="text-fg" />
              <Stat label="Avg baptism" value={fmtDur(bapStats.avgBaptismSec)} accent="text-fg" />
            </div>
            <span className="text-caption2 text-fg-subtle">Per-person splits are in the Baptisms tab.</span>
          </SectionCard>
        )}

        {/* Full attendance + sound detail for the same service occurrence — one
            place for everything about this service. Each is PR 1's chart module
            with its own strip and Customize; nothing here restyles them. */}
        <SectionCard id="history-attendance" title="Attendance">
          {attendance ? (
            <AttendanceDetail detail={attendance} timeline={detail} />
          ) : (
            <p className="text-caption1 text-fg-muted">No attendance recorded for this service.</p>
          )}
        </SectionCard>
        <SectionCard id="history-sound" title="Sound">
          {spl ? (
            <SplDetail
              // KEYED BY THE RECORD. The section fetches the raw series on
              // mount; without a key React keeps the same component across a
              // service switch and the previous service's line stays on screen
              // until the new fetch lands.
              key={spl.serviceKey}
              detail={spl}
              timeline={detail}
              attendance={attendance}
            />
          ) : (
            <p className="text-caption1 text-fg-muted">No sound recorded for this service.</p>
          )}
        </SectionCard>
      </div>
    );
  }

  // ── Detail: a service that is only in the middle of its pre-service arrival
  // ramp — attendance recording has started, but the first PCO item hasn't
  // gone live yet, so there is no timeline record (and no rundown, stats or
  // report to build from one). `selectedRow` (built synchronously from
  // `list`/`attList`, no fetch involved) is what tells this apart from "the
  // timeline record for this key just hasn't loaded yet" — that case falls
  // through to the list view below until `detail` resolves, exactly as before.
  if (!detail && attendance && selectedRow && !selectedRow.timeline) {
    const live = attendance.endedAt == null;
    const lastOccupancy = attendance.samples[attendance.samples.length - 1]?.occupancy ?? 0;
    const statusText = live ? `${lastOccupancy.toLocaleString()} in the room now` : "no items recorded";
    return (
      <div className="flex flex-col gap-4">
        <button className="self-start text-caption1 text-accent hover:underline" onClick={() => setSelectedKey(null)}>
          ← All services
        </button>
        {/* The same vocabulary as a service's own page — the green `recording`
            pill, "Sound", and cards — rather than the red LIVE badge and
            border-t dividers this page kept while the other one moved on. It
            has no rundown and no KPIs to show, so it is not the ServiceHeader;
            it is the two cards that page shares with it. */}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 text-title3 font-semibold text-fg">
            <span className="truncate">{attendance.planTitle ?? attendance.serviceKey}</span>
            {live && <RecordingPill />}
          </span>
          <span className="text-caption1 text-fg-muted">
            {fmtDate(attendance.startedAt)}
            {live
              ? ` · arriving · recording since ${fmtTime(attendance.startedAt)} · ${statusText}`
              : ` · recorded ${fmtTime(attendance.startedAt)}–${fmtTime(attendance.endedAt as string)} · ${statusText}`}
          </span>
        </div>
        <p className="text-caption1 text-fg-muted">
          Item timings appear here when the first item goes live in Planning Center.
        </p>
        <SectionCard id="history-attendance" title="Attendance">
          <AttendanceDetail detail={attendance} timeline={null} />
        </SectionCard>
        <SectionCard id="history-sound" title="Sound">
          {spl ? (
            <SplDetail
              // KEYED BY THE RECORD. The section fetches the raw series on
              // mount; without a key React keeps the same component across a
              // service switch and the previous service's line stays on screen
              // until the new fetch lands.
              key={spl.serviceKey}
              detail={spl}
              timeline={detail}
              attendance={attendance}
            />
          ) : (
            <p className="text-caption1 text-fg-muted">No sound recorded for this service.</p>
          )}
        </SectionCard>
      </div>
    );
  }

  // ── List view: services for the selected day. ──
  return (
    <div className="flex flex-col gap-3">
      {/* Trends LEADS the page. It is the defining view of the tab: what a month
          of Sundays did, per service type, with the dates that explain a step
          marked under the axis. Everything below it — the Overview blend, the
          calendar and the day list — answers a narrower question. */}
      <TrendsCard recordings={trendRecordings} />

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
            <Select value={overviewType ?? ""} onValueChange={(v) => setOverviewType(v || null)}>
              <SelectTrigger aria-label="Overview service type" className="h-6 px-1.5 text-caption2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Follow selection</SelectItem>
                {serviceTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <OverviewBlend overview={overview} onSplTrend={saveSplTrend} />
      </div>

      {/* Calendar (sticky) + selected-day detail. */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[320px_1fr] sm:items-start">
        <div className="sm:sticky sm:top-0 flex flex-col gap-3">
          <HistoryCalendar counts={dateCounts} selected={day} onPick={pickDay} />
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
          {/* The day heading — the list is grouped by day, and this is the one
              group the calendar has selected. */}
          {day && <span className="text-body font-semibold text-fg">{fmtDay(day)}</span>}
          {dayServices.map((row) => {
            // Attendance-only rows (arrival ramp, no timeline record yet) have no
            // items and no rundown to summarize — a separate, simpler card.
            if (!row.timeline) {
              const att = row.attendance!;
              const rowLive = att.endedAt == null;
              const lastOccupancy = att.samples[att.samples.length - 1]?.occupancy ?? 0;
              const caption = rowLive
                ? `${fmtTime(row.startsAt)} · arriving · ${lastOccupancy.toLocaleString()} in the room`
                : `${fmtTime(row.startsAt)} · no items recorded`;
              return (
                <div key={row.serviceKey} className="flex items-center gap-1 su-card pr-1.5 hover:bg-fill transition-colors">
                  <button className="flex flex-1 min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={() => setSelectedKey(row.serviceKey)}>
                    <div className="flex flex-col min-w-0">
                      <span className="text-body font-medium text-fg truncate">{row.planTitle ?? row.serviceKey}</span>
                      <span className="text-caption2 text-fg-subtle truncate">{caption}</span>
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-caption1 text-fg-subtle tabular-nums">
                      recording since <span className="font-mono text-accent">{fmtTime(att.startedAt)}</span>
                    </span>
                  </button>
                  {!readOnly && (
                    <Tooltip label="Delete recording">
                      <button
                        className="touch-target shrink-0 rounded-md p-2 text-fg-subtle hover:bg-fill hover:text-danger-11 transition-colors"
                        onClick={() => deleteService(row.serviceKey, row.planTitle ?? row.serviceKey)}
                        aria-label={`Delete recording for ${row.planTitle ?? "service"}`}
                      >
                        <Trash2Icon className="size-4" />
                      </button>
                    </Tooltip>
                  )}
                </div>
              );
            }
            const s = row.timeline;
            const live = s.endedAt == null;
            // The figures are the SERVICE PAGE's own, picked out of serviceKpis
            // by key — a row and the page it opens cannot quote two different
            // peaks for one recording. Live rows count up: `serviceKpis` passes
            // `now` into `summarize`, which adds the in-progress item's elapsed.
            const splRow = splByKey.get(s.serviceKey) ?? null;
            const { started, figures } = serviceRowFigures(
              s,
              row.attendance,
              splRow === "error" ? null : splRow,
              live ? nowTick : undefined,
            );
            // A read that FAILED says so, rather than borrowing the sentence
            // for a service that genuinely recorded no sound.
            const shownFigures =
              splRow === "error"
                ? figures.map((f) =>
                  f.key === "level" ? { ...f, value: "—", sub: "sound unavailable" } : f,
                )
                : figures;
            const itemCount = `${s.items.length} item${s.items.length === 1 ? "" : "s"}`;
            const under = [s.seriesTitle, live ? "recording\u2026" : itemCount].filter(Boolean).join(" \u00b7 ");
            return (
              // su-card, like every other top-level box on this page (Export, the
              // Overview, the calendar, the selected-day summary). These rows had
              // their own `bg-gray-2` + `rounded-lg` treatment, so the one column
              // an operator actually reads down was the one thing that did not
              // match the surface around it. The recessed grey is still right for
              // the Stat tiles and the time editor — those sit INSIDE a card, and
              // giving them the parent's surface would flatten the nesting.
              <div key={s.serviceKey} className="flex items-center gap-1 su-card pr-1.5 hover:bg-fill transition-colors">
                <button
                  data-history-row={s.serviceKey}
                  className="flex flex-1 min-w-0 flex-col gap-2 px-3 py-2.5 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  onClick={() => setSelectedKey(s.serviceKey)}
                >
                  <div className="flex min-w-0 flex-col">
                    {/* Time and service type, then the plan title, then the
                        series and how many items ran. The time is mono so a
                        column of rows lines up on the colon. */}
                    <span className="flex items-baseline gap-2 text-caption2 text-fg-subtle">
                      <span className="font-mono tabular-nums text-fg-muted">{started.value}</span>
                      {s.serviceTypeName && <span className="truncate">{s.serviceTypeName}</span>}
                      {started.sub && <span className="truncate text-warn-11">{started.sub}</span>}
                      {live && <RecordingPill />}
                    </span>
                    <span className="truncate text-body font-medium text-fg">{s.planTitle ?? s.serviceKey}</span>
                    {under && <span className="truncate text-caption2 text-fg-subtle">{under}</span>}
                  </div>
                  {/* The row's figures, on the stat strip's vocabulary at the
                      row's scale: an 11px uppercase label over a mono value.
                      `shrink-0` and a scroller, like the strip — a squashed
                      "1,1\u2026" is worse than one you have to scroll to. */}
                  <span className="flex shrink-0 items-start gap-0 overflow-x-auto sm:justify-end">
                    {shownFigures.map((f, fi) => (
                      <span
                        key={f.key}
                        data-row-figure={f.key}
                        className={cn("flex shrink-0 flex-col gap-0.5 px-3 last:pr-0", fi > 0 && "border-l border-line")}
                      >
                        <span className="whitespace-nowrap text-[10px] uppercase tracking-wider text-fg-subtle">{f.label}</span>
                        <span
                          className="whitespace-nowrap font-mono text-footnote tabular-nums"
                          style={{ color: f.color ?? "var(--color-fg)" }}
                        >
                          {f.value}
                        </span>
                        {/* WHY there is no number. The row stripped this, so a
                            "—" under Peak level had no reason beside it and an
                            operator whose own Customize had hidden every metric
                            was told nothing at all. */}
                        {f.sub && (
                          <span data-row-figure-note className="whitespace-nowrap text-[10px] text-fg-subtle">
                            {f.sub}
                          </span>
                        )}
                      </span>
                    ))}
                  </span>
                </button>
                {!readOnly && (
                  <Tooltip label="Delete recording">
                    <button
                      className="touch-target shrink-0 rounded-md p-2 text-fg-subtle hover:bg-fill hover:text-danger-11 transition-colors"
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
          {dayServices.length === 0 && <p className="text-caption1 text-fg-subtle">No services on this day.</p>}
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

/**
 * "vs the prior 4 recordings" — the tail every trend readout in the Overview
 * ends with.
 *
 * "recordings", not the service type's own name. The name is a PROPER NOUN and
 * pluralising it produced "vs the prior 2 The Salt Companys", which is what was
 * on screen. The scope is already named on the heading above the card, so
 * repeating it in the tail bought nothing even when it read correctly.
 */
function vsPrior(priorCount: number): string {
  return `vs the prior ${priorCount} recording${priorCount === 1 ? "" : "s"}`;
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
  onSplTrend,
}: {
  overview: OverviewData;
  /** Writes the metric choice. The card reads the CHOSEN metric back through
   *  `overview.splMetric`, which is derived from it, so the preference itself is
   *  not a prop — one direction each way. */
  onSplTrend: (patch: { metric?: string | null }) => void;
}) {
  /** Where the chart's right-click (or long-press) menu is, or null. */
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number } | null>(null);
  const chartTrigger = useContextMenuTrigger((pt) => setChartMenu(pt));
  // A mouse user already has the right-click; the corner button only appears
  // where a touch has no other way in.
  const isCoarse = useCoarsePointer();
  /**
   * The one thing the menu still offers: which Smaart metric the level below is
   * read from. The list comes from the data in scope — see
   * OverviewData.splMetrics — so it offers exactly the metrics there is
   * something to report for, and there is no menu at all when there are none.
   *
   * The "Sound summary" toggle that used to sit above it is gone. It gated a
   * trend LINE on an attendance chart this card no longer draws, and after the
   * trim it gated the level block instead — a switch whose only visible effect
   * was to hide a figure, advertised by a sentence of prose above the timings
   * telling the operator to right-click. The prose went with it; the figure
   * shows whenever there is one.
   */
  const chartMenuItems: ContextMenuItem[] = overview.splMetrics.length > 0
    ? [
      {
        label: "Metric",
        items: overview.splMetrics.map((m) => ({
          label: m,
          checked: overview.splMetric === m,
          onSelect: () => {
            onSplTrend({ metric: m });
            setChartMenu(null);
          },
        })),
      },
    ]
    : [];

  /** The level renders when there IS one. No dash and no sentence when there is
   *  not — a dash reads as a measured silence, and prose explaining an absence
   *  is bigger than the thing it explains. */
  const showsLevel = overview.avgSpl != null;

  // TIMINGS ONLY. Attendance moved out of this card entirely: Trends, at the
  // top of the page, plots it per service type over a chosen range with
  // milestones under it, and this card plotted the same quantity over a
  // different window with a different average — two charts of attendance on one
  // screen that did not agree. Peak attendance went with it for the same reason;
  // a day-list row carries each service's own peak.
  const strip: { k: string; v: string; accent?: string; trend?: Trend | null; trendLabel?: string }[] = [
    { k: "Services", v: overview.services },
    { k: "Avg length", v: overview.avgLength },
    { k: "Avg start", v: overview.avgStart, accent: overview.avgStartEarly ? "text-ok-11" : overview.avgStartLate ? "text-warn-11" : undefined },
    { k: "Avg overrun", v: overview.avgOverrun, trend: overview.overrunTrend, trendLabel: overview.overrunTrend ? (overview.overrunTrend.tone === "bad" ? "worse" : overview.overrunTrend.tone === "good" ? "better" : "steady") : undefined },
  ];
  return (
    <div className="su-card px-5 py-5 flex flex-col">
      <div
        className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between md:gap-8"
        onContextMenu={chartTrigger.onContextMenu}
        onPointerDown={chartTrigger.onPointerDown}
        onPointerMove={chartTrigger.onPointerMove}
        onPointerUp={chartTrigger.onPointerUp}
        onPointerCancel={chartTrigger.onPointerCancel}
        onClickCapture={chartTrigger.onClickCapture}
        style={chartTrigger.style}
      >
        {/* The level, and nothing about attendance. Trends owns attendance over
            time; this card owns how the services themselves RAN, plus how loud
            they were, which Trends does not plot. */}
        {showsLevel && overview.avgSpl != null ? (
          <div className="shrink-0" data-testid="spl-summary">
            <div className="text-caption1 uppercase tracking-[0.08em] text-fg-muted">Avg SPL</div>
            <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums text-[2.5rem] leading-none font-medium text-fg tracking-tight">
              <span>{overview.avgSpl.toFixed(1)}</span>
              <span className="text-caption1 font-normal text-fg-muted">dB</span>
            </div>
            {overview.splDelta && (
              // NEUTRAL, always — see SplDelta. A louder weekend is not a worse
              // one, so this never goes red. Decibels, not a percentage: a
              // percentage of a logarithmic quantity says nothing about how loud
              // it was. The sign comes from `dir`, never recomputed from `db` —
              // one fact, one place to read it, so the glyph and the sign cannot
              // disagree about which way a level moved.
              <TrendChip
                dir={overview.splDelta.dir === "flat" ? undefined : overview.splDelta.dir}
                tone="neutral"
                text={`${overview.splDelta.dir === "up" ? "+" : overview.splDelta.dir === "down" ? "−" : "±"}${Math.abs(overview.splDelta.db).toFixed(1)} dB ${vsPrior(overview.splDelta.priorCount)}`}
                className="mt-2"
              />
            )}
          </div>
        ) : null}
        {isCoarse && chartMenuItems.length > 0 && (
          <button
            type="button"
            aria-label="Overview options"
            className="grid size-11 shrink-0 place-items-center self-start rounded-md text-fg-subtle opacity-80 hover:bg-fill-active hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setChartMenu({ x: r.right, y: r.bottom });
            }}
          >
            <span className="grid size-8 place-items-center rounded-md bg-bg/80 backdrop-blur">
              <EllipsisIcon className="size-4" />
            </span>
          </button>
        )}
        {chartMenu && chartMenuItems.length > 0 && (
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
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
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

/**
 * One card on a service's page — Rundown, Attendance, Sound (and Baptisms on
 * the weekends it applies).
 *
 * `id` is the anchor the header's nav links to and the element its
 * IntersectionObserver watches, so a card without one is simply not in the nav.
 *
 * No scroll margin of its own: the scrolling pane reserves the sticky header's
 * height as scroll PADDING (shell.tsx), which covers an anchor jump to a card
 * and also the things nobody would put a margin on — a focused time field
 * inside this card, a find-in-page hit. Carrying both would add up and land
 * every jump a header's height too low.
 */
function SectionCard({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section
      id={id}
      aria-label={title}
      className="su-card flex flex-col gap-3 px-4 py-4 max-sm:px-3"
    >
      <h2 className="text-subheadline font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, accent, sub }: { label: string; value: string; accent: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-fill/40 px-3 py-2">
      <div className="text-caption2 uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className={`font-mono text-title3 font-medium tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="text-caption2 text-fg-subtle">{sub}</div>}
    </div>
  );
}
