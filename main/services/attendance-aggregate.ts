// attendance-aggregate.ts — combining and re-deriving attendance records.
//
// Two paths put two recordings of one service's attendance together: History's
// "merge into" (history-edit.ts), which repairs a service split in two on one
// box, and an archive import (archive/merge-records.ts), which fills one box's
// gaps from another box's recording of the same service. Both have to solve the
// same problem first, and this is the one place that solves it.
//
// Each record stores `attendance` as the raw daily counter minus ITS OWN
// baseline: the counter's value when that record began (attendance-recorder.ts).
// Two records are therefore in two frames, and a sample from one cannot sit
// beside a sample from the other until both are shifted into a common one. The
// history merge learned that from a cliff to zero at the seam; the import merge
// had never shifted at all, so two boxes' series interleaved twenty people
// apart and the curve saw-toothed across the whole overlap.
//
// Pure: no stores, no recorders, no logging. A caller that cannot align two
// records is told so and says it on its own tag.

import type { AttendanceSample, ServiceAttendance } from "../types/history.js";

/** The slice of a record these functions read. Archive records arrive from a
 *  bundle unvalidated, so every field is treated as possibly absent. */
export interface AttendanceFrame {
  samples?: AttendanceSample[];
  attendanceBaseline?: number | null;
}

/** A baseline that can be shifted by: a finite number. Anything else — null,
 *  absent, or a non-number in an imported record — is unknown, and an unknown
 *  baseline means no shift, never a NaN one. */
function baselineOf(r: AttendanceFrame): number | null {
  const b = r.attendanceBaseline;
  return typeof b === "number" && Number.isFinite(b) ? b : null;
}

/** Oldest first. By time where both stamps parse, by text otherwise, so a record
 *  with a stamp Date cannot read still sorts the same way every time. */
function byTime(a: AttendanceSample, b: AttendanceSample): number {
  const ta = Date.parse(a.t);
  const tb = Date.parse(b.t);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return a.t < b.t ? -1 : a.t > b.t ? 1 : 0;
}

/** Converts a value from one record's frame into another's. */
export type FrameShift = (v: number) => number;

/** Two series in one frame, and how each record's values convert into it. */
export interface AlignedAttendance {
  /** Both series, shifted into one frame, oldest first. Every sample is a new
   *  object, so re-basing the result cannot reach into either input record —
   *  the stores hand out their live records. */
  samples: AttendanceSample[];
  /** The raw counter the merged samples are measured from. */
  attendanceBaseline: number | null;
  /**
   * "aligned": both series are in one frame — both baselines were known and
   * both are in the earlier one, or one side had no samples to place.
   * "unknown": both sides have samples and one has no usable baseline, so
   * neither was shifted. The result is what the two records held, side by
   * side, and the caller says so.
   */
  frames: "aligned" | "unknown";
  /** Converts a value recorded in `into`'s frame into the merged one. */
  intoShift: FrameShift;
  /** Converts a value recorded in `from`'s frame into the merged one. */
  fromShift: FrameShift;
}

/**
 * Put two recordings of one service's attendance into ONE frame and union them.
 *
 * Both are shifted into the EARLIER of the two baselines, not into `into`'s.
 * `into` is not necessarily the later record — History offers every same-day
 * recording as a merge target, and an archive's box may have started first —
 * and shifting into the later frame makes an offset negative, which a clamp at
 * zero would turn into deleted attendees. A common floor makes both shifts
 * non-negative, so a bad offset surfaces as a wrong number rather than as lost
 * data. The shift is exact: both baselines are the raw daily counter at their
 * own record's start, so their difference IS the offset.
 *
 * A sample stamped at the same instant on both sides is kept once, `into`'s.
 */
export function alignAttendance(into: AttendanceFrame, from: AttendanceFrame): AlignedAttendance {
  const intoBase = baselineOf(into);
  const fromBase = baselineOf(from);
  const known = intoBase != null && fromBase != null;
  const base = known ? Math.min(intoBase, fromBase) : (intoBase ?? fromBase);
  const by = (own: number | null) => (known && own != null ? own - (base as number) : 0);
  const intoBy = by(intoBase);
  const fromBy = by(fromBase);

  const shifted = (list: AttendanceSample[] | undefined, n: number) =>
    (list ?? []).map((s) => ({ ...s, attendance: s.attendance + n }));
  const mine = shifted(into.samples, intoBy);
  const seen = new Set(mine.map((s) => s.t));
  const theirs = shifted(from.samples, fromBy).filter((s) => !seen.has(s.t));

  const placed = known || mine.length === 0 || (from.samples ?? []).length === 0;
  return {
    samples: [...mine, ...theirs].sort(byTime),
    attendanceBaseline: base,
    frames: placed ? "aligned" : "unknown",
    intoShift: (v) => v + intoBy,
    fromShift: (v) => v + fromBy,
  };
}

/** The figures a History row, Trends and the exports read off a record. */
export type AttendanceStats = Pick<
  ServiceAttendance,
  "peakAttendance" | "peakOccupancy" | "minOccupancy" | "lastAttendance" | "lastOccupancy"
>;

/** The samples the figures are taken over: the service proper. */
export function inServiceSamples(samples: AttendanceSample[]): AttendanceSample[] {
  return samples.filter((x) => !x.phase);
}

/**
 * Peak, lowest and last, from a series already in its record's frame.
 *
 * Peak/Lowest/Last reflect the SERVICE, not the pre-service arrival ramp or the
 * post-service emptying room — those tagged samples still draw the curve but
 * must not drag the floor or the last figure toward an empty room. Falls back to
 * every sample when a record has no in-service samples at all. Attendance is
 * clamped at zero only against a negative left by a hand-edited window.
 */
export function attendanceStats(samples: AttendanceSample[]): AttendanceStats {
  const svc = inServiceSamples(samples);
  const stat = svc.length ? svc : samples;
  const perSvc = (v: number) => Math.max(0, v);
  const last = stat.at(-1);
  return {
    peakAttendance: stat.reduce((m, x) => Math.max(m, perSvc(x.attendance)), 0),
    peakOccupancy: stat.reduce((m, x) => Math.max(m, x.occupancy), 0),
    minOccupancy: stat.length ? stat.reduce((m, x) => Math.min(m, x.occupancy), stat[0].occupancy) : null,
    lastAttendance: last ? perSvc(last.attendance) : 0,
    lastOccupancy: last ? last.occupancy : 0,
  };
}

/** Re-derive attendance aggregates from the (possibly trimmed or merged) sample
 *  series, in place. totalAttendance is a raw daily counter that cannot be
 *  reconstructed from baselined samples, so it is left as it is. */
export function recomputeAttendance(att: ServiceAttendance): void {
  const s = att.samples;
  // Per-service attendance = value − first sample (the count when this window
  // began), so a service not reset off the prior one reads its own count; on a
  // trim, the new first in-window sample re-baselines automatically.
  const base = s.length ? s[0].attendance : 0;
  // attendanceBaseline is the RAW daily counter at this record's start — that is
  // what the recorder writes and what a merge needs to convert between two
  // records' frames. Advancing it by the same amount the samples are about to be
  // re-based by keeps raw = sample + baseline true.
  att.attendanceBaseline = (att.attendanceBaseline ?? 0) + base;
  if (base !== 0) for (const x of s) x.attendance -= base;
  Object.assign(att, attendanceStats(s));
}
