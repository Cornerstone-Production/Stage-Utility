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

/** A number that arithmetic can use, or null. Imported records are
 *  unvalidated, and a string or NaN that reaches a sum poisons every figure
 *  after it ("12" + 0 is "120"). */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Oldest first. By time where both stamps parse, by text otherwise, so a record
 *  with a stamp Date cannot read still sorts the same way every time. */
function byTime(a: AttendanceSample, b: AttendanceSample): number {
  const ta = Date.parse(a.t);
  const tb = Date.parse(b.t);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (a.t === b.t) return 0;
  return a.t < b.t ? -1 : 1;
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
   * side, and the caller says so. Its baseline is `into`'s, never adopted
   * from `from`: stamping a known baseline on a mixed series would make the
   * next merge of it shift samples that were never in that frame.
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
 * A sample whose attendance is not a number is carried as it is, never shifted:
 * the stored records are the operator's, and this deletes nothing from them.
 *
 * A baseline that is a finite number is trusted here. Records a Recalculate,
 * window edit or merge touched in v1.9.3 or v1.9.4 (fixed in v1.10.0) may
 * carry an already-baselined value there (normally 0), which shifts wrongly.
 * The archive import checks for that first (implausibleBaseline in
 * archive/merge-records.ts) and does not align such a record. History's merge
 * does not: a window trim leaves the same gap to totalAttendance as that bug,
 * and History's merge is the repair tool, which has always trusted it.
 */
export function alignAttendance(into: AttendanceFrame, from: AttendanceFrame): AlignedAttendance {
  const intoBase = finiteOrNull(into.attendanceBaseline);
  const fromBase = finiteOrNull(from.attendanceBaseline);
  const intoList = Array.isArray(into.samples) ? into.samples : [];
  const fromList = Array.isArray(from.samples) ? from.samples : [];

  let base: number | null;
  let intoBy = 0;
  let fromBy = 0;
  let frames: AlignedAttendance["frames"] = "aligned";
  if (intoBase != null && fromBase != null) {
    base = Math.min(intoBase, fromBase);
    intoBy = intoBase - base;
    fromBy = fromBase - base;
  } else if (intoList.length && fromList.length) {
    base = intoBase;
    frames = "unknown";
  } else {
    base = intoList.length ? intoBase : fromBase;
  }

  const shifted = (list: AttendanceSample[], n: number) =>
    list.map((s) => (finiteOrNull(s.attendance) == null ? { ...s } : { ...s, attendance: s.attendance + n }));
  const mine = shifted(intoList, intoBy);
  const seen = new Set(mine.map((s) => s.t));
  const theirs = shifted(fromList, fromBy).filter((s) => !seen.has(s.t));

  return {
    samples: [...mine, ...theirs].sort(byTime),
    attendanceBaseline: base,
    frames,
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
  const nonNegative = (v: number) => Math.max(0, v);
  // A reading that is not a number is passed over rather than let NaN or a
  // string into a figure.
  const att = stat.map((x) => finiteOrNull(x.attendance)).filter((v): v is number => v != null);
  const occ = stat.map((x) => finiteOrNull(x.occupancy)).filter((v): v is number => v != null);
  return {
    peakAttendance: att.reduce((m, v) => Math.max(m, nonNegative(v)), 0),
    peakOccupancy: occ.reduce((m, v) => Math.max(m, v), 0),
    minOccupancy: occ.length ? Math.min(...occ) : null,
    lastAttendance: att.length ? nonNegative(att[att.length - 1]) : 0,
    lastOccupancy: occ.length ? occ[occ.length - 1] : 0,
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
