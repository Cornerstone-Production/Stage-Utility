// history-export.ts — Builds a multi-sheet .xlsx export of service history.
//
// The Settings/History export panel picks a date range and which sheets to
// include; this assembles them from the three history stores (attendance,
// timeline, SPL) as tidy data — one observation per row, every sheet sharing a
// leading date/type/serviceKey so the result pivots cleanly in Excel/Sheets.

import ExcelJS from "exceljs";

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

  const wb = new ExcelJS.Workbook();
  wb.creator = "Stage Utility";
  wb.created = new Date();

  // About sheet — always included so the file is self-describing.
  const about = wb.addWorksheet("About");
  about.columns = [{ width: 22 }, { width: 60 }];
  about.addRows([
    ["Stage Utility", "Service history export"],
    ["Generated", new Date().toISOString()],
    ["Date range", `${from || "earliest"} → ${to || "latest"}`],
    ["Sheets", include.join(", ") || "(none)"],
    ["Services in range", String(tl.length || att.length)],
  ]);
  about.getColumn(1).font = { bold: true };

  if (include.includes("services")) {
    // One row per service — union of timeline + attendance keyed by serviceKey.
    const byKey = new Map<string, { t?: (typeof tl)[number]; a?: (typeof att)[number] }>();
    for (const t of tl) (byKey.get(t.serviceKey) ?? byKey.set(t.serviceKey, {}).get(t.serviceKey)!).t = t;
    for (const a of att) (byKey.get(a.serviceKey) ?? byKey.set(a.serviceKey, {}).get(a.serviceKey)!).a = a;
    const ws = wb.addWorksheet("Services");
    ws.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Scheduled", key: "time", width: 20 },
      { header: "Service type", key: "type", width: 20 },
      { header: "Plan", key: "plan", width: 26 },
      { header: "Series", key: "series", width: 22 },
      { header: "Started", key: "started", width: 20 },
      { header: "Ended", key: "ended", width: 20 },
      { header: "Duration (s)", key: "dur", width: 12 },
      { header: "Items", key: "items", width: 8 },
      { header: "Peak attendance", key: "peakAtt", width: 15 },
      { header: "Peak in-room", key: "peakOcc", width: 14 },
      { header: "Lowest in-room", key: "minOcc", width: 15 },
      { header: "Total attendance", key: "totalAtt", width: 16 },
    ];
    const rows = [...byKey.values()].sort((x, y) =>
      (x.t?.serviceDate ?? x.a?.serviceDate ?? "").localeCompare(y.t?.serviceDate ?? y.a?.serviceDate ?? ""),
    );
    for (const { t, a } of rows) {
      const meta = t ?? a!;
      ws.addRow({
        date: meta.serviceDate,
        time: meta.serviceTimeStartsAt ?? meta.startedAt ?? "",
        type: meta.serviceTypeName ?? meta.serviceTypeId ?? "",
        plan: meta.planTitle ?? "",
        series: meta.seriesTitle ?? "",
        started: t?.startedAt ?? a?.startedAt ?? "",
        ended: t?.endedAt ?? a?.endedAt ?? "",
        dur: durationSec(t?.startedAt ?? a?.startedAt, t?.endedAt ?? a?.endedAt),
        items: t ? t.items.length : null,
        peakAtt: a?.peakAttendance ?? null,
        peakOcc: a?.peakOccupancy ?? null,
        minOcc: a?.minOccupancy ?? null,
        totalAtt: a?.totalAttendance ?? null,
      });
    }
    ws.getRow(1).font = { bold: true };
  }

  if (include.includes("attendance")) {
    // One row per attendance poll sample.
    const ws = wb.addWorksheet("Attendance polls");
    ws.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Service type", key: "type", width: 20 },
      { header: "Service key", key: "key", width: 34 },
      { header: "Timestamp", key: "t", width: 22 },
      { header: "Attendance", key: "att", width: 12 },
      { header: "In-room", key: "occ", width: 10 },
      { header: "Phase", key: "phase", width: 10 },
    ];
    for (const a of att) {
      for (const s of a.samples) {
        ws.addRow({
          date: a.serviceDate,
          type: a.serviceTypeName ?? a.serviceTypeId ?? "",
          key: a.serviceKey,
          t: s.t,
          att: s.attendance,
          occ: s.occupancy,
          phase: s.phase ?? "in-service",
        });
      }
    }
    ws.getRow(1).font = { bold: true };
  }

  if (include.includes("items")) {
    // One row per PCO plan item (timing).
    const ws = wb.addWorksheet("PCO items");
    ws.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Service type", key: "type", width: 20 },
      { header: "Service key", key: "key", width: 34 },
      { header: "#", key: "seq", width: 6 },
      { header: "Item", key: "title", width: 32 },
      { header: "Planned (s)", key: "planned", width: 12 },
      { header: "Actual (s)", key: "actual", width: 12 },
      { header: "Delta (s)", key: "delta", width: 10 },
      { header: "Pre-service", key: "pre", width: 12 },
      { header: "Started", key: "started", width: 22 },
      { header: "Ended", key: "ended", width: 22 },
    ];
    for (const t of tl) {
      for (const it of t.items) {
        const delta =
          it.plannedLengthSec != null && it.actualDurationSec != null
            ? it.actualDurationSec - it.plannedLengthSec
            : null;
        ws.addRow({
          date: t.serviceDate,
          type: t.serviceTypeName ?? t.serviceTypeId ?? "",
          key: t.serviceKey,
          seq: it.sequence,
          title: it.title,
          planned: it.plannedLengthSec,
          actual: it.actualDurationSec,
          delta,
          pre: it.preService ? "yes" : "",
          started: it.startedAt,
          ended: it.endedAt ?? "",
        });
      }
    }
    ws.getRow(1).font = { bold: true };
  }

  if (include.includes("spl")) {
    // One row per SPL metric per plan item.
    const ws = wb.addWorksheet("SPL");
    ws.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Service type", key: "type", width: 20 },
      { header: "Service key", key: "key", width: 34 },
      { header: "#", key: "seq", width: 6 },
      { header: "Item", key: "title", width: 32 },
      { header: "Metric", key: "metric", width: 16 },
      { header: "Max (dB)", key: "max", width: 10 },
      { header: "Avg (dB)", key: "avg", width: 10 },
      { header: "Samples", key: "count", width: 10 },
    ];
    for (const s of spl) {
      for (const it of s.items) {
        const metrics = Object.entries(it.metrics ?? {});
        if (metrics.length === 0) {
          ws.addRow({
            date: s.serviceDate,
            type: s.serviceTypeName ?? s.serviceTypeId ?? "",
            key: s.serviceKey,
            seq: it.sequence,
            title: it.title,
            metric: s.metricKey ?? "SPL",
            max: it.maxSpl,
            avg: it.avgSpl,
            count: it.sampleCount,
          });
          continue;
        }
        for (const [metric, stat] of metrics) {
          ws.addRow({
            date: s.serviceDate,
            type: s.serviceTypeName ?? s.serviceTypeId ?? "",
            key: s.serviceKey,
            seq: it.sequence,
            title: it.title,
            metric,
            max: stat.max,
            avg: stat.avg,
            count: stat.count,
          });
        }
      }
    }
    ws.getRow(1).font = { bold: true };
  }

  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
