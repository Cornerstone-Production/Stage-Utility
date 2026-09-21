import { errorMessage } from "@main/services/errors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { linkBaptisms, baptismStats } from "../../lib/link-baptisms";
import { cn } from "../../lib/cn";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip } from "../../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { hostTimeZone } from "@main/services/app-timezone";
import { useStageState } from "../../main/use-stage-state";
import { ClockIcon, ChevronRightIcon, DownloadIcon } from "lucide-react";

import { invoke, onNotification } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { useServerNow } from "@renderer/lib/server-clock";
import { Popover as PopoverPrimitive } from "radix-ui";

import { confirm, EmptyState, SkeletonRows, Button, toast, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { prefersReducedMotion } from "../../lib/reduced-motion";
import { HistoryCalendar } from "../../components/history-calendar";
import { AttendanceDetail, averageOccupancy } from "./attendance-history-section";
import { SplDetail, SPL_METRICS_STORAGE_KEY, primaryMetricOf } from "./spl-history-section";
import { RecordingDot, RecordingPill, ServiceHeader, overrunStats, serviceRowFigures } from "./history-service-header";
import { useStoredKeysVersion } from "./history-chart";
import { TrendsCard } from "./history-trends/trends-card";
import { appZoneOf, trendClock, type TrendClock, type TrendRecording } from "./history-trends/trends";
import {
  summarize,
  fmtDur,
  fmtDelta,
  fmtTime,

  isCountedItem,
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

/**
 * A row's surface, now that the list is a CARD.
 *
 * Recessed, not another `su-card`. The rows carried the page's own card
 * treatment while they sat flat on the page, which was right then — the one
 * column an operator reads down should not be the only thing not on a surface.
 * Inside a card, a card inside a card flattens the nesting instead, and the
 * recessed fill is what the Stat tiles and the time editor already use for the
 * same reason. Both row shapes — the normal one and the arrival-only one — read
 * it, so they cannot drift apart.
 */
const ROW_SURFACE =
  "flex items-center gap-1 rounded-lg border border-line bg-fill/40 pr-1.5 transition-colors hover:bg-fill";

/**
 * The grid every row in the Recorded services list shares WITH ITS HEADER.
 *
 * One string, used by both, because the header only means anything if it sits
 * over the columns it names. Two declarations of the same track list is how a
 * heading ends up one column left of its figures.
 *
 * Below `sm` the four figure columns and the chevron are dropped and the row
 * stacks: six 88px columns do not fit a phone, and a squashed "1,1…" is worse
 * than a figure you open the service to read.
 */
const ROW_GRID =
  "grid grid-cols-[1fr_1fr] items-center gap-x-3 gap-y-1 "
  + "sm:grid-cols-[104px_minmax(0,1fr)_repeat(4,84px)_20px] sm:gap-y-0";

/**
 * The four figure columns, in order, with the heading each one carries.
 *
 * Keyed, not positional. `serviceRowFigures` drops `vs plan` on a live
 * recording and whenever the plan total is unknown, so taking the figures in
 * order slid Peak dB under the "VS PLAN" heading on exactly the rows an
 * operator is most likely to be looking at.
 *
 * `caption` is what goes UNDER the value when the figure has no `sub` of its
 * own. For the level it is the METRIC — "LAeq", "SPL A Fast" — because which
 * meter reading this is matters more on a row than repeating the heading above
 * it; `serviceRowFigures` labels it "Peak <metric>", and the heading has
 * already said "peak".
 */
const ROW_COLUMNS: {
  key: string;
  heading: string;
  color?: string;
  caption: (label?: string) => string;
}[] = [
  // IN ROOM, both times, because the app tracks two attendance numbers and
  // "Peak / peak" named neither of them. The value is `peakOccupancy` — the most
  // people in the room at once — and the other is `peakAttendance`, the
  // cumulative door count, which double-counts anyone who steps out and back.
  // The service page's header has had them the wrong way round once already and
  // its `attendance` KPI carries the note about it; this is the same number that
  // KPI shows, said in the words that tell it apart.
  { key: "attendance", heading: "In room", color: "var(--color-green-9)", caption: () => "peak in room" },
  { key: "actual", heading: "Ran", caption: (label) => label ?? "ran" },
  { key: "vs-plan", heading: "vs plan", caption: () => "vs plan" },
  { key: "level", heading: "Peak dB", caption: (label) => label?.replace(/^Peak\s+/i, "") ?? "dB" },
];

/** The column heading row, drawn once per day group. 10px uppercase, over the
 *  same tracks the rows use — see ROW_GRID. */
function ServiceRowHeader() {
  return (
    <div
      data-row-header
      aria-hidden
      className={cn(ROW_GRID, "max-sm:hidden px-3 pb-0.5 text-[10px] uppercase tracking-wider text-fg-subtle")}
    >
      <span>When</span>
      <span>Service</span>
      {ROW_COLUMNS.map((c) => (
        <span key={c.key}>{c.heading}</span>
      ))}
      <span />
    </div>
  );
}

/** "September 2026" from a `YYYY-MM`. The list's header names the month the
 *  calendar beside it is showing, in the same words the calendar uses. */
function fmtMonth(ym: string | null): string {
  if (!ym) return "all dates";
  const d = new Date(`${ym}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return ym;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** The anchor a calendar day scrolls to. One definition, read by the element
 *  that carries the id and by the scroll that looks it up — two spellings is
 *  how a control that "works" scrolls to nothing. */
function dayGroupId(day: string): string {
  return `history-day-${day}`;
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
/** The three loads the page opens with. Named so a failure can be attributed to
 *  one of them rather than to "history". */
type HistoryLoad = "timeline" | "attendance" | "spl";

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
  const [detail, setDetail] = useState<ServiceTimeline | null>(null);
  // The matching attendance + SPL records (same serviceKey) for the combined report.
  const [attendance, setAttendance] = useState<ServiceAttendance | null>(null);
  const [spl, setSpl] = useState<ServiceSplHistory | null>(null);
  // Baptism sessions (cross-linked to a service by time overlap).
  const [baptisms, setBaptisms] = useState<BaptismSession[]>([]);
  // Attendance records for all services — the day rows and the Trends card are
  // both built from these.
  const [attList, setAttList] = useState<ServiceAttendance[]>([]);
  /** One level per service — the sound measure on Trends, and each day row's
   *  peak. A summary, not the archive: see splHistoryStore.summary(). */
  const [splList, setSplList] = useState<SplServiceSummary[]>([]);

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

  /**
   * Which of the three history loads FAILED, as opposed to came back empty.
   *
   * All three used to `.catch(() => set…([]))`, which is the same shape three
   * times and the same lie three times: a server that was down, or a request
   * that timed out, read as "No service timings recorded yet" and "No sound
   * recorded yet". Three found, three changed. Each failure now names itself on
   * a `[history]` line AND is visible on the surface it starved:
   *
   *   timeline / attendance   the empty state says the history could not be read
   *   spl                     the Trends card says the sound summary is missing
   */
  const [loadFailed, setLoadFailed] = useState<ReadonlySet<HistoryLoad>>(new Set());
  // Stable, all three of them: `reload` closes over these and the mount effect
  // closes over `reload`, so anything rebuilt per render would make the effect
  // a dependency of every render and reload the whole history on each one.
  // Functional setState throughout, so none of them needs the current value.
  const noteFailure = useCallback((which: HistoryLoad, what: string, err: unknown) => {
    logToServer("history", `could not read ${what}: ${errorMessage(err)}`);
    setLoadFailed((prev) => (prev.has(which) ? prev : new Set(prev).add(which)));
  }, []);
  /** A load that came back clears its own failure, so a retry that works stops
   *  the page saying otherwise. */
  const noteLoaded = useCallback((which: HistoryLoad) =>
    setLoadFailed((prev) => {
      if (!prev.has(which)) return prev;
      const next = new Set(prev);
      next.delete(which);
      return next;
    }), []);

  const reload = useCallback(() => {
    invoke<ServiceTimeline[]>("serviceTimeline:list")
      .then((l) => {
        setList(l);
        noteLoaded("timeline");
      })
      .catch((e) => {
        setList([]);
        noteFailure("timeline", "the service timings", e);
      });
  }, [noteFailure, noteLoaded]);
  useEffect(() => {
    reload();
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((a) => {
        setAttList(a ?? []);
        noteLoaded("attendance");
      })
      .catch((e) => {
        setAttList([]);
        noteFailure("attendance", "the attendance history", e);
      });
    invoke<SplServiceSummary[]>("spl:getSummary")
      .then((r) => {
        setSplList(r ?? []);
        noteLoaded("spl");
      })
      .catch((e) => {
        setSplList([]);
        noteFailure("spl", "the sound summary", e);
      });
  }, [reload, noteFailure, noteLoaded]);

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

  /**
   * Planning Center's times for the ACTIVE plan, straight off the live channel.
   *
   * The Trends card needs them to answer one question: is another service still
   * to come today? Without it a Sunday between the 11 o'clock and the 6 reads as
   * a finished two-service day and is compared against whole three-service ones
   * — the collapse the partial-day rule exists to prevent.
   *
   * `pco:live` carries `planTimes` in EVERY mode, and the SSE hello burst
   * replays the current frame on subscribe, so this is populated without asking
   * for anything: no extra request, no new route.
   */
  const [planTimes, setPlanTimes] = useState<{ timeType: string; startsAt: string }[]>([]);
  useEffect(
    () =>
      onNotification("pco:live", (p) => {
        const times = (p as { planTimes?: { timeType: string; startsAt: string }[] } | null)?.planTimes;
        setPlanTimes(times ?? []);
      }),
    [],
  );

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
          // HAS IT ENDED. The same test the row beside it calls `live`, off the
          // same record: the timeline when there is one, otherwise the arrival
          // ramp's own. A trend counts a running service either way — see
          // `countedFor` in trends.ts — so this does not decide whether it is on
          // the line. It decides which BASIS the day is compared against, which
          // is `stateOf`'s question.
          complete: r.timeline ? r.timeline.endedAt != null : r.attendance?.endedAt != null,
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
  // The SERVER's clock: every figure this feeds is measured against a
  // server-stamped `startedAt`, so a console whose clock has drifted would add
  // the drift to the in-progress item's elapsed time.
  //
  // READS the page's clock, and something else has to have FED it. That holds on
  // every page inside the operator shell, whose context bar feeds it from
  // `pco:live`. It does NOT hold on `/history`, which is chromeless and carries
  // no context bar: nothing in that subtree feeds the clock, so it falls back to
  // the host's — the same answer this had before, and no worse, but not the
  // correction this comment would otherwise promise. The fix is a server-stamped
  // field on the hello frame, which is its own change.
  const nowTick = useServerNow(1000, detailLive || listLive);

  /**
   * The zone every "what day is it" here is answered in — the operator's
   * setting, from the server, NOT the browser's.
   *
   * A browser cannot ask for the app's zone, so `appTimeZone()` in here would
   * answer the wrong question: a kiosk running UTC would decide Sunday ended at
   * 7pm, which is the failure this repo has actually been bitten by. The server
   * publishes both halves of its own answer on stage state — the setting and
   * the host clock it falls back to — and `appZoneOf` reads them in that order.
   * This browser's zone is the last resort, for the render before state lands.
   */
  const { state: stageState } = useStageState();
  const zone = appZoneOf(stageState, hostTimeZone());
  /** Rebuilt on every tick the page already takes, so "still to come" stops
   *  being true the moment the day's last service time passes. */
  const clock = useMemo<TrendClock>(
    () => trendClock(nowTick, zone, planTimes),
    [nowTick, zone, planTimes],
  );

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

  // The calendar and the day list are GLOBAL — every service type, so you can
  // navigate to any of them. Nothing on this page scopes to one type any more:
  // the Overview card did, and the Trends card answers the per-type question
  // better, with a line each instead of a picker.
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
    // Scroll to the day's group rather than filtering the list down to it. In a
    // frame, because the group may not be rendered yet — picking a day in a
    // month the list has not drawn is a state change first and a scroll second.
    //
    // Guarded, not assumed: jsdom has no scrollIntoView and a Pi's browser is
    // not a place to find out. A day that cannot be scrolled to is still
    // selected and still ringed.
    requestAnimationFrame(() => {
      const el = document.getElementById(dayGroupId(d));
      el?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
  };

  /**
   * The month the calendar is showing, `YYYY-MM`. The calendar owns which month
   * is up — it is the thing with the chevrons — and reports it here, because
   * the list beside it shows that month rather than one day.
   */
  const [viewMonth, setViewMonth] = useState<string | null>(null);

  /**
   * The VISIBLE MONTH's services, newest first, grouped by day.
   *
   * Not the selected day's. A list that showed one day meant paging the
   * calendar to read a month, and the calendar is right there — the month is
   * the unit an operator actually reads. Picking a day now scrolls to its
   * group and rings it rather than hiding the other fifteen services.
   *
   * `filtered` is already newest-first, so the groups come out newest-first and
   * so do the services within each one.
   */
  const monthGroups = useMemo(() => {
    const month = viewMonth ?? day?.slice(0, 7) ?? null;
    if (!month) return [];
    const byDay = new Map<string, HistoryRow[]>();
    for (const s of filtered) {
      if (!s.serviceDate.startsWith(`${month}-`)) continue;
      const list = byDay.get(s.serviceDate);
      if (list) list.push(s);
      else byDay.set(s.serviceDate, [s]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, services]) => ({ date, services }));
  }, [filtered, viewMonth, day]);

  /** Every service in the visible month, flat — the header's count, and what
   *  the per-row SPL fetch below asks for. */
  const monthServices = useMemo(() => monthGroups.flatMap((g) => g.services), [monthGroups]);

  /**
   * The SPL record behind each of the VISIBLE MONTH's rows, so a row's peak
   * level is the same figure the service page's header quotes.
   *
   * Per month rather than for the whole history on purpose: `spl:getSummary`
   * (already loaded, above) carries a service-level Leq per metric and no PEAK
   * at all, so a row built from it would be labelled "Peak" and be showing an
   * energy average. The full record is the only thing that has the peak, and a
   * month is a dozen or so of them — not a year of them.
   *
   * A FAILED read and a service that recorded no sound are told apart. Both
   * used to land as `null`, which `servicePeakLevel` reads as "no sound
   * recorded" — so a server that was down, or a request that timed out, told
   * the operator their meter had not been recording. `"error"` is its own
   * state, the row says "sound unavailable", and the reason is logged per key.
   */
  type RowSpl = ServiceSplHistory | null | "error";
  const [splByKey, setSplByKey] = useState<Map<string, RowSpl>>(new Map());
  // The key list, as a stable string: `monthServices` is a fresh array every
  // render and would refetch the month's SPL on each one.
  const monthKeys = monthServices.map((s) => s.serviceKey).join("|");
  useEffect(() => {
    const keys = monthKeys ? monthKeys.split("|") : [];
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
            logToServer("history", `could not read the sound record for ${key}: ${errorMessage(err)}`);
            return [key, "error"] as const;
          }),
      ),
    ).then((pairs) => {
      if (!cancelled) setSplByKey(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [monthKeys, reloadKey]);

  // Per-day service counts for the calendar (respects the type filter).
  const dateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of filtered) m.set(s.serviceDate, (m.get(s.serviceDate) ?? 0) + 1);
    return m;
  }, [filtered]);


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
    // A failed READ is not an empty history. Both used to say "nothing has been
    // recorded yet", which sends an operator to look at a recorder that is fine.
    const unread = loadFailed.has("timeline") || loadFailed.has("attendance");
    return (
      <div className="py-8">
        <EmptyState
          icon={<ClockIcon />}
          title={unread ? "The recorded history could not be read" : "No service timings recorded yet"}
          hint={
            unread
              ? "The server did not answer. Nothing has been lost — reload the page, and see the server log for the reason."
              : "Item timings are captured automatically while a service runs in Planning Center Live — when each item goes live and how long it runs versus its planned length."
          }
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
        <SoundSection spl={spl} timeline={detail} attendance={attendance} />
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
        <SoundSection spl={spl} timeline={detail} attendance={attendance} />
      </div>
    );
  }

  // ── List view: services for the selected day. ──
  return (
    <div className="flex flex-col gap-3">
      {/* Trends LEADS the page. It is the defining view of the tab: what a month
          of Sundays did, per service type, with the dates that explain a step
          marked under the axis. Below it, the calendar and the recorded-services
          list answer the narrower question of one day.
          There is no Overview card between them any more. Its five figures were
          an all-time blend across a service type, and every one of them — start,
          length, overrun, peak, level — is on the service page's own KPI row
          against the service it belongs to, where it means something specific.
          Export moved into the Recorded services header; it is not removed. */}
      <TrendsCard recordings={trendRecordings} clock={clock} soundUnavailable={loadFailed.has("spl")} />

      {/* Calendar (sticky) beside the month's services. The calendar decides
          which month both of them are about. There is no "Selected: …" summary
          card under it any more: the same two facts are the list's own header,
          and the day's services are one scroll away rather than hidden behind
          the other fifteen. */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[320px_1fr] sm:items-start">
        <div className="sm:sticky sm:top-0 flex flex-col gap-3">
          <HistoryCalendar
            counts={dateCounts}
            selected={day}
            onPick={pickDay}
            onMonthChange={setViewMonth}
            zone={zone}
          />
        </div>

        {/* A CARD, like Trends above it and the calendar beside it — same
            border, radius and padding. It was flat on the page, so the one
            column an operator reads down was the only thing on the tab that did
            not sit on a surface. */}
        {/* `gap-3`, one card gap, between the header and the day groups and
            between one day group and the next. It is the clearance the selected
            day's ring stands in — see the ring's own note below — and 8px was
            less than the ring's own 12px inset, so the ring had nowhere to be. */}
        <section data-services-card className="su-card min-w-0 flex flex-col gap-3 px-4 py-3.5">
          {/* The card's own header: what the list is, what it is showing, and
              the Export control. Export used to be a full-width disclosure of
              its own above the calendar — a builder for a thing you do twice a
              year, given the width of the page. It is the same builder, behind
              a button, beside the list it exports. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-body font-semibold text-fg">Recorded services</h3>
            <div className="flex items-center gap-3">
              <span data-list-showing className="text-caption2 text-fg-subtle">
                Showing {fmtMonth(viewMonth ?? day?.slice(0, 7) ?? null)} · {monthServices.length}
                {` service${monthServices.length === 1 ? "" : "s"}`}
              </span>
              <ExportPopover
                from={expFrom}
                to={expTo}
                sheets={expSheets}
                onFrom={setExpFrom}
                onTo={setExpTo}
                onToggleSheet={toggleSheet}
                onDownload={downloadExport}
              />
            </div>
          </div>
          {monthGroups.map((group, gi) => (
            <div
              key={group.date}
              id={dayGroupId(group.date)}
              data-day-group={group.date}
              // The SELECTED day's group is ringed, which is what clicking a
              // calendar cell now does — with a scroll to it. It used to filter
              // the list down to that day, which meant paging the calendar to
              // read a month with the month right there beside it.
              className={cn(
                "flex scroll-mt-4 flex-col gap-2 rounded-xl",
                // 12px of air between the ring and what it rings; at 8px the day
                // label and the rows touched the ring's edge.
                //
                // THE VERTICAL INSET IS REAL SPACE, NOT BORROWED. `-m-3` pulled
                // all four edges back, so the ring drew 12px outside its own box
                // into whatever sat next to it: the card's header and the Export
                // button above, the next day group below, the card's own bottom
                // padding at the end of a month. Every one of those gaps is
                // smaller than 12px, so the ring touched all of them at once.
                // Only the SIDES still borrow, from the card's 16px of padding,
                // which leaves 4px and keeps every row aligned with the rows of
                // the days above and below it — a selected group indented 12px
                // from its neighbours is the other way this reads as broken.
                day === group.date && "bg-accent/6 ring-1 ring-accent/35 -mx-3 px-3 py-3",
              )}
            >
              <span className="text-caption1 text-fg-muted">{fmtDay(group.date)}</span>
              {/* The column header, ONCE for the whole list, under the first
                  day label — the mockup's shape. Repeating it under every day
                  made the column names the loudest thing in a month of
                  services: eight repetitions of "WHEN SERVICE PEAK RAN VS PLAN
                  PEAK DB" between nine rows.
                  The row's figures vary (a live recording has no `vs plan`), so
                  a row that has nothing for a column prints a dash under the
                  heading rather than closing the gap and sliding the rest
                  left — see ROW_COLUMNS. */}
              {gi === 0 && <ServiceRowHeader />}
              {group.services.map((row) => {
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
                <div key={row.serviceKey} className={ROW_SURFACE}>
                  <button className="flex flex-1 min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={() => setSelectedKey(row.serviceKey)}>
                    <div className="flex flex-col min-w-0">
                      <span className="text-body font-medium text-fg truncate">{row.planTitle ?? row.serviceKey}</span>
                      <span className="text-caption2 text-fg-subtle truncate">{caption}</span>
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-caption1 text-fg-subtle tabular-nums">
                      recording since <span className="font-mono text-accent">{fmtTime(att.startedAt)}</span>
                    </span>
                    <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-fg-faint" />
                  </button>
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
            // The item count whether or not it is recording. The subtitle used
            // to read "recording\u2026" instead while a record was open, which is
            // the one thing on the row the pill beside the title already says \u2014
            // and it cost the reader the only place the row says how many items
            // have run so far.
            const under = [s.seriesTitle, itemCount].filter(Boolean).join(" \u00b7 ");
            // FIXED columns, so the header above the group lines up with every
            // row under it. The figures are picked by key rather than taken in
            // order: a live recording has no `vs plan`, and closing the gap
            // slid Peak dB under the "VS PLAN" heading. A column with nothing
            // in it prints a dash.
            const byKey = new Map(shownFigures.map((f) => [f.key, f]));
            return (
              <div key={s.serviceKey} className={ROW_SURFACE}>
                <button
                  data-history-row={s.serviceKey}
                  className={cn(ROW_GRID, "min-w-0 flex-1 px-3 py-2.5 text-left")}
                  onClick={() => setSelectedKey(s.serviceKey)}
                >
                  {/* WHEN: the time, big, with the service type under it. Mono,
                      so a column of rows lines up on the colon, and in the
                      operator's own 12- or 24-hour format.
                      The "8:00 early" chip that used to sit beside it is gone:
                      it is not in the mockup, and it is one of the six KPIs on
                      the service page's own header, where it has the room to
                      say what it is measured against. */}
                  <span data-row-when className="flex min-w-0 flex-col">
                    {/* The live DOT rides with the start time, and the pill in
                        the SERVICE column says the word.
                        Not redundant — belt and braces on purpose. SERVICE is
                        the grid's only flexible track and it resolves to ZERO
                        between 640 and about 1,150px wide, where the pill is
                        clipped away with the plan title beside it. WHEN is a
                        fixed 104px and is the leftmost column, so it is the one
                        place a marker cannot be squeezed out of. Six pixels
                        beside a 42px time, rather than the 84px pill that used
                        to live here and truncated "Weekend" to "W…". */}
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-footnote font-semibold tabular-nums text-fg">
                        {started.value}
                      </span>
                      {live && <RecordingDot label="recording" />}
                    </span>
                    <span className="truncate text-[11px] text-fg-subtle">{s.serviceTypeName ?? ""}</span>
                  </span>
                  {/* SERVICE: the plan title — with the recording pill after it
                      while the record is open — then its series and item count.
                      The pill sat in the WHEN column beside the service type,
                      where the two of them shared 104px: the pill does not
                      shrink, so the type took what was left and "Weekend" read
                      as "W…". It belongs here anyway. It says what is happening
                      to this RECORDING, and it is where the service page and the
                      arrival page both put it — after the title. */}
                  <span data-row-service className="flex min-w-0 flex-col">
                    {/* `overflow-hidden`, because the pill does not shrink. The
                        SERVICE track is the only flexible one, and between 640
                        and about 1,150px wide it resolves to ZERO — the plan
                        title has been clipped to nothing there since the row
                        grid was built. A fixed-width pill in a zero-width cell
                        paints over the figure in the next column instead of
                        being clipped with the title beside it. */}
                    <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
                      <span className="truncate text-footnote font-medium text-fg">{s.planTitle ?? s.serviceKey}</span>
                      {live && <RecordingPill />}
                    </span>
                    {under && <span className="truncate text-[11px] text-fg-subtle">{under}</span>}
                  </span>
                  {ROW_COLUMNS.map((col) => {
                    const f = byKey.get(col.key);
                    return (
                      <span key={col.key} data-row-figure={col.key} className="flex min-w-0 flex-col">
                        <span
                          className="truncate font-mono text-footnote tabular-nums"
                          style={{ color: f?.color ?? col.color ?? "var(--color-fg)" }}
                        >
                          {f?.value ?? "—"}
                        </span>
                        {/* The caption UNDER the value, the way the mockup has
                            it. `sub` wins when there is one: it is the only
                            thing that says WHY there is no number — "no sound
                            recorded", "sound unavailable" — and a bare dash
                            sends an operator to look at a meter that is fine. */}
                        <span
                          data-row-figure-note
                          className="truncate text-[10px] uppercase tracking-wider text-fg-subtle"
                        >
                          {f?.sub ?? col.caption(f?.label)}
                        </span>
                      </span>
                    );
                  })}
                  {/* The row opens a page. Nothing on it said so — the whole
                      card was clickable and looked like a read-only summary. */}
                  <ChevronRightIcon aria-hidden className="size-4 self-center justify-self-end text-fg-faint" />
                </button>
              </div>
            );
              })}
            </div>
          ))}
          {monthGroups.length === 0 && (
            <p className="text-caption1 text-fg-subtle">No services recorded in this month.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The Export builder, behind a button in the Recorded services header.
 *
 * Unchanged in what it does — a date range, a set of sheets, and a download of
 * the same `/api/history/export.xlsx`. It was a full-width disclosure of its
 * own above the calendar, which gave a thing done twice a year the width of
 * the page and put it between the trends and the services. Beside the list it
 * exports is where it belongs.
 *
 * Read-only safe, so it is offered on the public /history page too — exporting
 * reads; it does not touch a record.
 */
function ExportPopover({
  from,
  to,
  sheets,
  onFrom,
  onTo,
  onToggleSheet,
  onDownload,
}: {
  from: string;
  to: string;
  sheets: Set<string>;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onToggleSheet: (id: string) => void;
  onDownload: () => void;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label="Export"
        className={cn(
          "touch-target inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-field px-2 py-0.5",
          "text-caption2 text-fg-muted hover:bg-fill hover:text-fg",
          "focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
          "data-[state=open]:border-focus data-[state=open]:text-fg",
        )}
      >
        <DownloadIcon className="size-3" /> Export
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label="Export"
          className={cn(
            "z-50 w-80 overflow-hidden rounded-md border border-line-strong bg-popover shadow-md backdrop-blur-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <div className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] flex-col gap-3 overflow-y-auto p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
                From
                <input
                  type="date"
                  value={from}
                  onChange={(e) => onFrom(e.target.value)}
                  className="rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg"
                />
              </label>
              <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
                To
                <input
                  type="date"
                  value={to}
                  onChange={(e) => onTo(e.target.value)}
                  className="rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg"
                />
              </label>
              <span className="self-end pb-1.5 text-caption2 text-fg-subtle">Blank = all dates.</span>
            </div>
            {/* Each option is a whole selectable row rather than a bare control
                in a column: the hint sits under its label instead of trailing
                off it, and the target is big enough to hit on a tablet next to
                a console. */}
            <div className="flex flex-col gap-1">
              {EXPORT_SHEETS.map((s) => {
                const on = sheets.has(s.id);
                return (
                  <label
                    key={s.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                      on ? "border-accent/40 bg-accent/8" : "border-transparent hover:bg-fill",
                    )}
                  >
                    <Checkbox checked={on} onCheckedChange={() => onToggleSheet(s.id)} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-footnote text-fg">{s.label}</span>
                      <span className="block text-caption2 text-fg-subtle">{s.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div>
              <Button variant="accent" size="small" disabled={sheets.size === 0} onClick={onDownload}>
                <DownloadIcon className="size-3.5" /> Download .xlsx
              </Button>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * The Sound card, identical in the full detail view and in the arrival-only
 * view — the two callers passed the same three props to the same markup
 * verbatim, which is how a fix to one of them (the KEYED BY THE RECORD note
 * below explains a real bug) would land in one copy and not the other.
 */
function SoundSection({
  spl,
  timeline,
  attendance,
}: {
  spl: ServiceSplHistory | null;
  timeline: ServiceTimeline | null;
  attendance: ServiceAttendance | null;
}) {
  return (
    <SectionCard id="history-sound" title="Sound">
      {spl ? (
        <SplDetail
          // KEYED BY THE RECORD. The section fetches the raw series on
          // mount; without a key React keeps the same component across a
          // service switch and the previous service's line stays on screen
          // until the new fetch lands.
          key={spl.serviceKey}
          detail={spl}
          timeline={timeline}
          attendance={attendance}
        />
      ) : (
        <p className="text-caption1 text-fg-muted">No sound recorded for this service.</p>
      )}
    </SectionCard>
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
