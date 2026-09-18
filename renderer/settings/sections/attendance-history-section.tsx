import { useMemo } from "react";

import { toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import { CustomizePopover, HistoryChart, useStoredKeys, type ChartSeries, type LaneItem } from "./history-chart";

// Which chart series/overlays and at-rest figures to surface. Attendance has a
// fixed, small set (not arbitrary per-item columns), so the keys are enumerated
// here and grouped for the Customize popover.
//
// THE KEYS ARE THE ONES THE CHIP ROW STORED, deliberately: the chips are gone but
// their localStorage entry is not, so an operator who had turned Total entries on
// still has it on. `average` is the one new key, and only new selections carry it.
//
// The chart "attendance" series is the per-service (baselined) value stored in
// each sample; the day total is a scalar figure, not a drawable series.
// "Attendance" = people in the room (occupancy series/peak — the real count).
// "Total entries" = the cumulative door count (double-counts re-entries).
const CHART_METRICS = [
  { key: "occupancy", label: "Attendance" },
  { key: "attendance", label: "Total entries" },
  { key: "avg", label: "Avg attendance" },
  { key: "markers", label: "Plan items" },
] as const;
const STAT_METRICS = [
  { key: "peak", label: "Peak" },
  { key: "lowest", label: "Lowest" },
  { key: "average", label: "Average" },
  { key: "entries", label: "Entries" },
  { key: "dayTotal", label: "Day total" },
  { key: "samples", label: "Samples" },
] as const;
const ALL_METRIC_KEYS = [...CHART_METRICS.map((m) => m.key), ...STAT_METRICS.map((m) => m.key)];
const METRICS_STORAGE_KEY = "attendance:visibleMetrics";
/** The real attendance (in-room) + avg + the item lane, and the four figures the
 *  spec names: peak, lowest in service, average, samples. "Total entries"
 *  (cumulative) stays off unless picked. */
const DEFAULT_METRICS = ["occupancy", "avg", "markers", "peak", "lowest", "average", "samples"];

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

/**
 * Mean in-room occupancy while the SERVICE was running.
 *
 * In-service samples only — the ones with no `phase`. The arrival ramp and the
 * emptying-room taper are both long and both near-empty, and averaging them in
 * put this figure BELOW the recorded low: peak 1,196, lowest 933, "average"
 * 781. Peak and Lowest have always been in-service (the recorder derives them
 * that way, and AttendanceSample's own doc says only unphased samples feed
 * Peak/Lowest/Avg); the average was the one that did not agree with them.
 *
 * Records written before the phase tags existed have no phase on any sample, so
 * every sample counts — the same answer those records gave before.
 */
function averageOccupancy(rec: ServiceAttendance): number | null {
  const inService = rec.samples.filter((s) => !s.phase);
  const use = inService.length ? inService : rec.samples;
  if (!use.length) return null;
  return Math.round(use.reduce((s, p) => s + p.occupancy, 0) / use.length);
}

/** The full attendance detail — the chart module, its stat strip and its
 *  Customize popover — for one service record. Extracted so the unified History
 *  tab can embed it directly. `timeline` (same serviceKey) supplies the plan
 *  items that fill the chart's item lane. */
export function AttendanceDetail({ detail, timeline }: { detail: ServiceAttendance; timeline: ServiceTimeline | null }) {
  const [visible, storeMetric] = useStoredKeys(METRICS_STORAGE_KEY, ALL_METRIC_KEYS, DEFAULT_METRICS);
  const shows = (k: string) => visible.includes(k);
  /** The toggle takes effect either way; a browser that refused to REMEMBER it
   *  says so rather than quietly forgetting the choice at the next reload. */
  function toggleMetric(key: string) {
    const err = storeMetric(key);
    if (err) toast.error(`Could not remember that choice: ${errorMessage(err)}`);
  }

  const avgOccupancy = averageOccupancy(detail);
  // Attendance is cumulative; plot it per-service (each sample minus the first) so
  // a service not reset off the prior one still reads its own count.
  const points = useMemo(
    () =>
      detail.samples.map((s) => ({
        t: Date.parse(s.t),
        occupancy: s.occupancy,
        attendance: perServiceAttendance(s.attendance, detail.samples),
      })).filter((p) => Number.isFinite(p.t)),
    [detail.samples],
  );

  const series: ChartSeries[] = [];
  if (shows("occupancy")) {
    series.push({
      id: "occupancy",
      label: "Attendance",
      color: "var(--green-9)",
      role: "primary",
      fill: true,
      points: points.map((p) => ({ t: p.t, v: p.occupancy })),
    });
  }
  if (shows("attendance")) {
    series.push({
      id: "entries",
      label: "Total entries",
      color: "var(--color-accent)",
      role: "secondary",
      dashed: true,
      points: points.map((p) => ({ t: p.t, v: p.attendance })),
    });
  }
  if (shows("avg") && avgOccupancy != null && points.length > 1) {
    // A reference line, drawn as a two-point series rather than as its own kind
    // of overlay — it shares the y scale, so it is a series by any other name.
    series.push({
      id: "avg",
      // "Avg", not "Avg 1,164": the strip prints the label and the value side by
      // side, and a label carrying the number read "AVG 1,164  1,164".
      label: "Avg",
      color: "var(--green-11)",
      role: "secondary",
      dashed: true,
      // Two points two hours apart. Without this the default sampling-gap rule
      // broke it into two single-point runs and drew two dots at the edges of
      // the plot instead of a reference line.
      gapMs: Infinity,
      points: [
        { t: points[0].t, v: avgOccupancy },
        { t: points[points.length - 1].t, v: avgOccupancy },
      ],
    });
  }

  const items: LaneItem[] = shows("markers")
    ? (timeline?.items ?? []).filter((it) => it.startedAt).map((it) => ({
      itemId: it.itemId,
      title: it.title,
      sequence: it.sequence,
      startedAt: it.startedAt,
      endedAt: it.endedAt,
      preService: it.preService ?? false,
      plannedSec: it.plannedLengthSec,
      actualSec: it.actualDurationSec,
    }))
    : [];

  const values: Record<string, number | null> = {
    peak: detail.peakOccupancy, // peak people in the room = real attendance
    lowest: detail.minOccupancy ?? null,
    average: avgOccupancy,
    entries: servicePeakAttendance(detail), // cumulative door count
    dayTotal: detail.totalAttendance ?? null,
    samples: detail.samples.length,
  };
  const colors: Record<string, string> = {
    peak: "var(--color-ok-11)",
    lowest: "var(--color-warn-11)",
    entries: "var(--color-accent)",
    dayTotal: "var(--color-accent)",
  };
  const figures = STAT_METRICS.filter((m) => shows(m.key)).map((m) => ({
    key: m.key,
    label: m.label,
    value: values[m.key] == null ? "—" : (values[m.key] as number).toLocaleString(),
    color: colors[m.key],
  }));

  return (
    <HistoryChart
      series={series}
      items={items}
      window={{ startedAt: detail.serviceStartedAt ?? null, endedAt: detail.endedAt }}
      yScale={{ kind: "count" }}
      figures={figures}
      live={detail.endedAt == null}
      ariaLabel="Attendance and in-room occupancy over the service, with the plan's items"
      customize={
        <CustomizePopover
          label="Customize attendance"
          groups={[
            { id: "series", label: "Chart", options: CHART_METRICS.map((m) => ({ ...m })) },
            { id: "figures", label: "Figures", options: STAT_METRICS.map((m) => ({ ...m })) },
          ]}
          selected={visible}
          onToggle={toggleMetric}
        />
      }
    />
  );
}
