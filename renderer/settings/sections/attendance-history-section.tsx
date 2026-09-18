import { useMemo } from "react";

import { toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import {
  CustomizePopover,
  HistoryChart,
  addDefaultOnce,
  serviceWindowOf,
  useStoredKeys,
  type ChartSeries,
  type LaneItem,
} from "./history-chart";

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

// `average` is new, and a new default reaches nobody who already has a stored
// selection — the stored list wins and cannot name a key that did not exist
// when it was written. Added once, at module load so it lands before the first
// read, and never again: re-adding it every load would undo an untick.
addDefaultOnce(METRICS_STORAGE_KEY, "average");

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
/**
 * ENTRIES is `rec.peakAttendance` — the recorder's own in-service figure, and
 * nothing derived.
 *
 * There used to be a `servicePeakAttendance(rec)` here that took the maximum
 * across EVERY sample and subtracted the first. That runs the door count on
 * through the post-service taper, so it answered "how many people came in at
 * any point around this service" — which is not a figure an operator wants
 * under any label. On the 17 Sep Salt Company recording it read 2,061 against
 * a recorded 1,727.
 *
 * Every other surface in the app already reads the stored field: the
 * `servicePeakAttendance` LAYOUT metric, on dashboards and custom layouts,
 * resolves to `rec.peakAttendance` (use-people-count-state.ts), so History's
 * card was the one place quoting a different number under the same word.
 *
 * `perServiceAttendance` above stays: baselining each SAMPLE is what the
 * chart's entries series needs, and it is a different question.
 */

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
export function averageOccupancy(rec: ServiceAttendance): number | null {
  const inService = rec.samples.filter((s) => !s.phase);
  // No in-service samples at all is NOT "average the ramp instead". It is a
  // record that is still arriving, or one that never went live — the real case
  // being the "arriving" row History shows up to an hour before the start. Peak
  // reads 0 and Lowest reads — for that record, so an Average of 400 taken off
  // the ramp is the one figure claiming a service happened.
  //
  // A LEGACY record — written before the phase tags existed — has no phase on
  // ANY sample, so every one of them is in-service by this test and it reads
  // exactly as it always did. That needs no second branch, and the branch that
  // used to be here (fall back to every sample) was unreachable for legacy
  // records and wrong for the arriving one.
  if (!inService.length) return null;
  return Math.round(inService.reduce((s, p) => s + p.occupancy, 0) / inService.length);
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

  // EVERY series the section offers, each carrying whether it is on. The chart
  // draws the on ones and lists them ALL in the legend, which is what lets the
  // legend turn one back on — see ChartSeries.on. The ids are the stored
  // preference keys, so a legend click and a Customize tick are one action over
  // one store and the two cannot disagree.
  const series: ChartSeries[] = [
    {
      id: "occupancy",
      label: "Attendance",
      color: "var(--color-green-9)",
      role: "primary",
      fill: true,
      on: shows("occupancy"),
      points: points.map((p) => ({ t: p.t, v: p.occupancy })),
    },
    {
      id: "attendance",
      label: "Total entries",
      color: "var(--color-accent)",
      role: "secondary",
      dashed: true,
      on: shows("attendance"),
      points: points.map((p) => ({ t: p.t, v: p.attendance })),
    },
  ];
  // A reference line, drawn as a two-point series rather than as its own kind of
  // overlay — it shares the y scale, so it is a series by any other name. ABSENT
  // rather than off when there is no average to reference: a legend entry that
  // cannot be turned on is a dead control.
  if (avgOccupancy != null && points.length > 1) {
    series.push({
      id: "avg",
      // "Avg", not "Avg 1,164": the strip prints the label and the value side by
      // side, and a label carrying the number read "AVG 1,164  1,164".
      label: "Avg",
      color: "var(--color-green-11)",
      role: "secondary",
      dashed: true,
      on: shows("avg"),
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
    entries: detail.peakAttendance, // people who came in during the service
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
      // ONE window for both charts — see service-window.ts. Sound had its own
      // and never hatched.
      window={serviceWindowOf({ timeline, attendance: detail })}
      yScale={{ kind: "count" }}
      figures={figures}
      live={detail.endedAt == null}
      ariaLabel="Attendance and in-room occupancy over the service, with the plan's items"
      onToggleSeries={toggleMetric}
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
