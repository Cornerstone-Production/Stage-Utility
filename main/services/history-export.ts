// history-export.ts — Builds a multi-sheet .xlsx export of service history.
//
// The Settings/History export panel picks a date range and which sheets to
// include; this assembles them from the three history stores (attendance,
// timeline, SPL) as tidy data — one observation per row, every sheet sharing a
// leading date/type/serviceKey so the result pivots cleanly in Excel/Sheets.
//
// Sheets are declared as column lists rather than built cell-by-cell: the header
// row, the widths and the per-row values all come from one place, so a column
// cannot drift out of step with its heading.

import writeXlsxFile, { type Cell, type Row } from "write-excel-file/node";

import { tableFeature, type TableSpec } from "./xlsx-table.js";
import { appTimeZone } from "./app-timezone.js";

import { attendanceStore } from "./attendance-store.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { splHistoryStore } from "./spl-history-store.js";
import { baptismStore } from "./baptism-store.js";

export type HistorySheet = "services" | "attendance" | "items" | "spl" | "baptisms";

export interface HistoryExportOptions {
  from?: string | null; // YYYY-MM-DD inclusive
  to?: string | null; // YYYY-MM-DD inclusive
  include: HistorySheet[];
}

const inRange = (date: string, from?: string | null, to?: string | null): boolean =>
  (!from || date >= from) && (!to || date <= to);

const durationSec = (startedAt: string | null | undefined, endedAt: string | null | undefined): number | null => {
  if (!startedAt || !endedAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : null;
};

/** Everything a cell can hold here. Dates are already ISO strings in the stores. */
type Scalar = string | number | null | undefined;

interface Column<T> {
  header: string;
  width: number;
  value: (row: T) => Scalar;
}

/** A cell needs an explicit type; blank and absent both render as an empty cell. */
function cell(v: Scalar): Cell {
  if (v == null || v === "") return null;
  return typeof v === "number" ? { value: v, type: Number } : { value: String(v), type: String };
}

/** "9:00 AM" from an ISO occurrence start, for telling same-day services apart. */
function serviceTimeLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  // Explicitly the APP's zone. Formatting in the server's locale meant a UTC host
  // exported a 10:30 service as "3:30 PM" — the column that exists to tell a 9am
  // from an 11am was naming neither.
  return new Date(t).toLocaleTimeString("en-US", {
    timeZone: appTimeZone(),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Songs are prefixed so a filter on the Item column isolates them — the recorded
 *  item type is what makes that possible, and it is absent on anything captured
 *  before the recorder began storing it, which reads as an ordinary item. */
function itemLabel(title: string, itemType?: string | null): string {
  return itemType === "song" ? `SONG: ${title}` : title;
}

/** A sheet is its bold header row followed by one row per record. */
function sheet<T>(name: string, columns: Column<T>[], rows: T[]) {
  return {
    sheet: name,
    columns: columns.map((c) => ({ width: c.width })),
    // Keep the headings visible while scrolling a few hundred rows.
    stickyRowsCount: 1,
    data: [
      columns.map((c): Cell => ({ value: c.header, type: String, fontWeight: "bold" })),
      ...rows.map((r): Row => columns.map((c) => cell(c.value(r)))),
    ],
  };
}

/**
 * Name the download after what is IN it. Previously every export was named for
 * the day it was made, so a full-year export and a single Sunday were
 * indistinguishable once saved.
 */
export function historyFileName(from?: string | null, to?: string | null): string {
  const span = from && to ? (from === to ? from : `${from}_to_${to}`) : from ? `from-${from}` : to ? `through-${to}` : "all-dates";
  return `stage-utility-history-${span}.xlsx`;
}

/** Assemble the workbook and return its bytes. */
export async function buildHistoryWorkbook(opts: HistoryExportOptions): Promise<Buffer> {
  const { from, to, include } = opts;
  const [attendance, timelines, spls, baptismSessions] = await Promise.all([
    attendanceStore.list(),
    serviceTimelineStore.list(),
    splHistoryStore.list(),
    baptismStore.listSessions(),
  ]);

  const att = attendance.filter((a) => inRange(a.serviceDate, from, to));
  const tl = timelines.filter((t) => inRange(t.serviceDate, from, to));
  const spl = spls.filter((s) => inRange(s.serviceDate, from, to));

  type Timeline = (typeof tl)[number];
  type Attendance = (typeof att)[number];

  const sheets: ReturnType<typeof sheet>[] = [];
  // Which sheets are datasets. The About page is label/value pairs, so it gets no
  // table — Excel would happily make one and name its columns after the first row.
  const tabular: boolean[] = [];

  // About sheet — always included so the file is self-describing. Label/value
  // pairs rather than a table, so it is built directly instead of via `sheet()`.
  tabular.push(false);
  sheets.push({
    sheet: "About",
    columns: [{ width: 22 }, { width: 60 }],
    // Label/value pairs rather than a table, so nothing to freeze or filter.
    stickyRowsCount: 0,
    data: (
      [
        ["Stage Utility", "Service history export"],
        ["Generated", new Date().toISOString()],
        ["Date range", `${from || "earliest"} → ${to || "latest"}`],
        ["Sheets", include.join(", ") || "(none)"],
        ["Services in range", String(tl.length || att.length)],
      ] as const
    ).map(([label, value]): Row => [{ value: label, type: String, fontWeight: "bold" }, cell(value)]),
  });

  if (include.includes("services")) {
    // One row per service — union of timeline + attendance keyed by serviceKey.
    const byKey = new Map<string, { t?: Timeline; a?: Attendance }>();
    for (const t of tl) (byKey.get(t.serviceKey) ?? byKey.set(t.serviceKey, {}).get(t.serviceKey)!).t = t;
    for (const a of att) (byKey.get(a.serviceKey) ?? byKey.set(a.serviceKey, {}).get(a.serviceKey)!).a = a;
    const rows = [...byKey.values()].sort((x, y) =>
      (x.t?.serviceDate ?? x.a?.serviceDate ?? "").localeCompare(y.t?.serviceDate ?? y.a?.serviceDate ?? ""),
    );
    // A service is present if either store saw it, so the shared fields read
    // from whichever arrived — timeline first.
    const meta = (r: { t?: Timeline; a?: Attendance }) => (r.t ?? r.a)!;
    tabular.push(true);
    sheets.push(
      sheet<{ t?: Timeline; a?: Attendance }>(
        "Services",
        [
          { header: "Date", width: 12, value: (r) => meta(r).serviceDate },
          { header: "Scheduled", width: 20, value: (r) => meta(r).serviceTimeStartsAt ?? meta(r).startedAt ?? "" },
          { header: "Service type", width: 20, value: (r) => meta(r).serviceTypeName ?? meta(r).serviceTypeId ?? "" },
          { header: "Plan", width: 26, value: (r) => meta(r).planTitle ?? "" },
          { header: "Series", width: 22, value: (r) => meta(r).seriesTitle ?? "" },
          { header: "Started", width: 20, value: (r) => r.t?.startedAt ?? r.a?.startedAt ?? "" },
          { header: "Ended", width: 20, value: (r) => r.t?.endedAt ?? r.a?.endedAt ?? "" },
          {
            header: "Duration (s)",
            width: 12,
            value: (r) => durationSec(r.t?.startedAt ?? r.a?.startedAt, r.t?.endedAt ?? r.a?.endedAt),
          },
          { header: "Items", width: 8, value: (r) => (r.t ? r.t.items.length : null) },
          { header: "Peak attendance", width: 15, value: (r) => r.a?.peakAttendance ?? null },
          { header: "Peak in-room", width: 14, value: (r) => r.a?.peakOccupancy ?? null },
          { header: "Lowest in-room", width: 15, value: (r) => r.a?.minOccupancy ?? null },
          { header: "Total attendance", width: 16, value: (r) => r.a?.totalAttendance ?? null },
        ],
        rows,
      ),
    );
  }

  if (include.includes("attendance")) {
    // One row per attendance poll sample.
    const rows = att
      .flatMap((a) => a.samples.map((s) => ({ a, s })))
      .sort((x, y) => x.a.serviceDate.localeCompare(y.a.serviceDate) || x.s.t.localeCompare(y.s.t));
    tabular.push(true);
    sheets.push(
      sheet<(typeof rows)[number]>(
        "Attendance polls",
        [
          { header: "Date", width: 12, value: ({ a }) => a.serviceDate },
          { header: "Service type", width: 20, value: ({ a }) => a.serviceTypeName ?? a.serviceTypeId ?? "" },
          { header: "Timestamp", width: 22, value: ({ s }) => s.t },
          { header: "Attendance", width: 12, value: ({ s }) => s.attendance },
          { header: "In-room", width: 10, value: ({ s }) => s.occupancy },
          { header: "Phase", width: 10, value: ({ s }) => s.phase ?? "in-service" },
        ],
        rows,
      ),
    );
  }

  if (include.includes("items")) {
    // One row per PCO plan item (timing).
    const rows = tl
      .flatMap((t) => t.items.map((it) => ({ t, it })))
      .sort((a, b) => a.t.serviceDate.localeCompare(b.t.serviceDate) || a.it.sequence - b.it.sequence);
    tabular.push(true);
    sheets.push(
      sheet<(typeof rows)[number]>(
        "PCO items",
        [
          { header: "Date", width: 12, value: ({ t }) => t.serviceDate },
          { header: "Service type", width: 20, value: ({ t }) => t.serviceTypeName ?? t.serviceTypeId ?? "" },
          { header: "#", width: 6, value: ({ it }) => it.sequence },
          { header: "Item", width: 32, value: ({ it }) => it.title },
          { header: "Planned (s)", width: 12, value: ({ it }) => it.plannedLengthSec },
          { header: "Actual (s)", width: 12, value: ({ it }) => it.actualDurationSec },
          {
            header: "Delta (s)",
            width: 10,
            value: ({ it }) =>
              it.plannedLengthSec != null && it.actualDurationSec != null
                ? it.actualDurationSec - it.plannedLengthSec
                : null,
          },
          { header: "Pre-service", width: 12, value: ({ it }) => (it.preService ? "yes" : "") },
          { header: "Started", width: 22, value: ({ it }) => it.startedAt },
          { header: "Ended", width: 22, value: ({ it }) => it.endedAt ?? "" },
        ],
        rows,
      ),
    );
  }

  if (include.includes("spl")) {
    // Records made before per-metric stats existed hold a single metric in
    // maxSpl/leqSpl, named by the capture's own metricKey — so they still have a
    // column to land in rather than exporting as blanks.
    const statOf = (s: (typeof spl)[number], it: (typeof s.items)[number], key: string) =>
      it.metrics?.[key] ?? (s.metricKey === key ? { max: it.maxSpl, leq: it.leqSpl ?? null } : null);
    const metricKeys = [
      ...new Set(
        spl.flatMap((s) => [
          ...s.items.flatMap((it) => Object.keys(it.metrics ?? {})),
          ...(s.items.some((it) => it.maxSpl != null) && s.metricKey ? [s.metricKey] : []),
        ]),
      ),
    ].sort();
    const rows = spl
      .flatMap((s) => s.items.map((it) => ({ s, it })))
      // Chronological, then service, then plan order — a sheet meant for analysis
      // should not arrive in whatever order the store happened to hold.
      .sort(
        (a, b) =>
          a.s.serviceDate.localeCompare(b.s.serviceDate) ||
          (a.s.serviceTimeStartsAt ?? "").localeCompare(b.s.serviceTimeStartsAt ?? "") ||
          a.it.sequence - b.it.sequence,
      );

    // Identifying columns, shared by both shapes. Service time is what separates a
    // 9am from an 11am on the same date — without it the two are identical rows.
    const idColumns: Column<(typeof rows)[number]>[] = [
      { header: "Date", width: 12, value: ({ s }) => s.serviceDate },
      { header: "Service time", width: 13, value: ({ s }) => serviceTimeLabel(s.serviceTimeStartsAt) },
      { header: "Service type", width: 20, value: ({ s }) => s.serviceTypeName ?? s.serviceTypeId ?? "" },
      { header: "#", width: 6, value: ({ it }) => it.sequence },
      { header: "Item", width: 40, value: ({ it }) => itemLabel(it.title, it.itemType) },
    ];

    // WIDE — one row per item, every metric side by side. For reading, and for
    // comparing metrics on a single line.
    tabular.push(true);
    sheets.push(
      sheet<(typeof rows)[number]>(
        "SPL",
        [
          ...idColumns,
          ...metricKeys.flatMap((key): Column<(typeof rows)[number]>[] => [
            { header: `${key} Max`, width: 12, value: ({ s, it }) => statOf(s, it, key)?.max ?? null },
            { header: `${key} Leq`, width: 12, value: ({ s, it }) => statOf(s, it, key)?.leq ?? null },
          ]),
          { header: "Samples", width: 10, value: ({ it }) => it.sampleCount },
        ],
        rows,
      ),
    );

    // LONG — one row per item per metric. Harder to read, but it is the shape a
    // PivotTable wants: Metric becomes a field you drag, so any arrangement of
    // metric against date, service or item is a drag rather than a fresh export.
    // Combinations with no reading are dropped; a blank row is noise in a pivot.
    const longRows = rows.flatMap(({ s, it }) =>
      metricKeys
        .map((metric) => ({ s, it, metric, stat: statOf(s, it, metric) }))
        .filter((r) => r.stat && (r.stat.max != null || r.stat.leq != null)),
    );
    tabular.push(true);
    sheets.push(
      sheet<(typeof longRows)[number]>(
        "SPL data",
        [
          ...(idColumns as unknown as Column<(typeof longRows)[number]>[]),
          { header: "Metric", width: 16, value: (r) => r.metric },
          { header: "Max", width: 10, value: (r) => r.stat?.max ?? null },
          { header: "Leq", width: 10, value: (r) => r.stat?.leq ?? null },
          { header: "Samples", width: 10, value: ({ it }) => it.sampleCount },
        ],
        longRows,
      ),
    );
  }

  // Each sheet's shape, in sheet order, so the table parts name their columns
  // exactly as row 1 does. Derived from what was just built rather than read back
  // out of the XML, where the header strings are not resolvable yet.
  const specs: TableSpec[] = sheets.map((s, i) => ({
    headers: tabular[i]
      ? (s.data[0] ?? []).map((c) => (c && typeof c === "object" && "value" in c ? String(c.value ?? "") : ""))
      : [],
    rowCount: tabular[i] ? Math.max(0, s.data.length - 1) : 0,
  }));
  if (include.includes("baptisms")) {
    // One row per person, not per session: the timings are per person, and a
    // session is just when the operator started and stopped. Sessions carry the
    // service they were recorded in, so these line up with the other sheets by
    // date and time rather than needing to be matched by hand.
    const sessions = baptismSessions.filter((b) => inRange((b.startedAt ?? "").slice(0, 10), from, to));
    const byKey = new Map(tl.map((t) => [t.serviceKey, t]));
    const rows = sessions
      .flatMap((b) => b.people.map((p, i) => ({ b, p, n: i + 1 })))
      .sort((a, z) => a.b.startedAt.localeCompare(z.b.startedAt) || a.n - z.n);
    tabular.push(true);
    sheets.push(
      sheet<(typeof rows)[number]>(
        "Baptisms",
        [
          { header: "Date", width: 12, value: ({ b }) => (b.startedAt ?? "").slice(0, 10) },
          {
            header: "Service time",
            width: 13,
            value: ({ b }) => serviceTimeLabel(byKey.get(b.serviceKey ?? "")?.serviceTimeStartsAt),
          },
          { header: "Service type", width: 20, value: ({ b }) => byKey.get(b.serviceKey ?? "")?.serviceTypeName ?? "" },
          { header: "Session", width: 22, value: ({ b }) => b.title ?? "" },
          { header: "#", width: 6, value: (r) => r.n },
          { header: "Testimony (s)", width: 14, value: ({ p }) => Math.round(p.testimonyMs / 1000) },
          { header: "Baptism (s)", width: 13, value: ({ p }) => Math.round(p.baptizeMs / 1000) },
          { header: "Total (s)", width: 11, value: ({ p }) => Math.round((p.testimonyMs + p.baptizeMs) / 1000) },
        ],
        rows,
      ),
    );
  }

  return writeXlsxFile(sheets, { features: [tableFeature(specs)] }).toBuffer();
}
