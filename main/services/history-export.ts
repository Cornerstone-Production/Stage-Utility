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

import { autoFilterFeature } from "./xlsx-autofilter.js";

import { attendanceStore } from "./attendance-store.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { splHistoryStore } from "./spl-history-store.js";

export type HistorySheet = "services" | "attendance" | "items" | "spl";

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
  const [attendance, timelines, spls] = await Promise.all([
    attendanceStore.list(),
    serviceTimelineStore.list(),
    splHistoryStore.list(),
  ]);

  const att = attendance.filter((a) => inRange(a.serviceDate, from, to));
  const tl = timelines.filter((t) => inRange(t.serviceDate, from, to));
  const spl = spls.filter((s) => inRange(s.serviceDate, from, to));

  type Timeline = (typeof tl)[number];
  type Attendance = (typeof att)[number];

  const sheets: ReturnType<typeof sheet>[] = [];

  // About sheet — always included so the file is self-describing. Label/value
  // pairs rather than a table, so it is built directly instead of via `sheet()`.
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
    // One row per plan item, not per metric: the old shape repeated an item once
    // for every metric the meter reported, which made comparing metrics a matter of
    // reading down 200 rows. Metrics become column pairs instead, so a single row
    // holds everything measured for that item and the columns line up for sorting.
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
      // Chronological, then plan order — a sheet meant for analysis should not
      // arrive in whatever order the store happened to hold.
      .sort((a, b) => a.s.serviceDate.localeCompare(b.s.serviceDate) || a.it.sequence - b.it.sequence);
    const metricColumns = metricKeys.flatMap((key): Column<(typeof rows)[number]>[] => [
      { header: `${key} Max`, width: 12, value: ({ s, it }) => statOf(s, it, key)?.max ?? null },
      { header: `${key} Leq`, width: 12, value: ({ s, it }) => statOf(s, it, key)?.leq ?? null },
    ]);
    sheets.push(
      sheet<(typeof rows)[number]>(
        "SPL",
        [
          { header: "Date", width: 12, value: ({ s }) => s.serviceDate },
          { header: "Service type", width: 20, value: ({ s }) => s.serviceTypeName ?? s.serviceTypeId ?? "" },
          { header: "#", width: 6, value: ({ it }) => it.sequence },
          { header: "Item", width: 40, value: ({ it }) => itemLabel(it.title, it.itemType) },
          ...metricColumns,
          { header: "Samples", width: 10, value: ({ it }) => it.sampleCount },
        ],
        rows,
      ),
    );
  }

  return writeXlsxFile(sheets, { features: [autoFilterFeature] }).toBuffer();
}
